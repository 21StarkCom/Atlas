/**
 * `contracts.canonical.test` — the process-seam serialization contract.
 *
 * Asserts byte-identical output across key insertion orders and Unicode forms,
 * and the number/undefined rules. Canonicalization is a pure function of its
 * input, so "byte-identical across processes" reduces to "byte-identical across
 * calls with equal data" — which is what we verify here.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalSerialize,
  canonicalStringify,
  newRunId,
  saltedOpaqueId,
  parseSourceHandle,
  serializeContentId,
  serializeRenditionId,
  isUlid,
} from "../src/index.js";

const dec = new TextDecoder();
const bytes = (v: unknown) => dec.decode(canonicalSerialize(v));

// "cafe" + combining acute accent (U+0301). NFC folds it to U+00E9.
const ACCENTED = "café";
const ACUTE_E = "é"; // precomposed e-acute (single code point)

describe("canonicalSerialize — key ordering", () => {
  it("is byte-identical regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 9, y: 8, x: 7 } };
    const b = { c: { x: 7, y: 8, z: 9 }, a: 2, b: 1 };
    expect(bytes(a)).toBe(bytes(b));
    // ...and sorted by UTF-16 code unit.
    expect(bytes(a)).toBe('{"a":2,"b":1,"c":{"x":7,"y":8,"z":9}}');
  });

  it("sorts keys deterministically at every nesting depth", () => {
    const one = { outer: { m: [{ q: 1, p: 2 }], k: true }, first: "x" };
    const two = { first: "x", outer: { k: true, m: [{ p: 2, q: 1 }] } };
    expect(bytes(one)).toBe(bytes(two));
  });
});

describe("canonicalSerialize — Unicode NFC", () => {
  it("collapses NFC vs NFD forms of the same string to identical bytes", () => {
    const nfc = ACCENTED.normalize("NFC");
    const nfd = ACCENTED.normalize("NFD");
    expect(nfc).not.toBe(nfd); // genuinely different code-unit sequences
    expect(bytes({ v: nfc })).toBe(bytes({ v: nfd }));
  });

  it("normalizes object KEYS too, not just values", () => {
    const nfc = { [ACUTE_E.normalize("NFC")]: 1 };
    const nfd = { [ACUTE_E.normalize("NFD")]: 1 };
    expect(Object.keys(nfc)[0]).not.toBe(Object.keys(nfd)[0]);
    expect(bytes(nfc)).toBe(bytes(nfd));
  });

  it("handles mixed Hebrew/English content stably", () => {
    const s = "אריה Aryeh"; // "אריה Aryeh"
    expect(bytes({ name: s })).toBe(bytes({ name: s.normalize("NFD") }));
  });

  it("orders keys by their NFC form, not the raw code units (cross-process byte-identity)", () => {
    // "é" precomposed (U+00E9 = 0xE9) sorts AFTER "z" (0x7A) by raw code unit,
    // but "é" decomposed ("e"+U+0301, first unit 0x65) sorts BEFORE "z". If keys
    // were sorted before NFC normalization the two forms would emit members in
    // different orders; normalizing first makes both identical.
    const nfc = { z: 1, [ACUTE_E.normalize("NFC")]: 2 };
    const nfd = { z: 1, [ACUTE_E.normalize("NFD")]: 2 };
    expect(bytes(nfc)).toBe(bytes(nfd));
    // é (NFC 0xE9) sorts after z, so key order is z then é.
    expect(bytes(nfc)).toBe(`{"z":1,${JSON.stringify(ACUTE_E.normalize("NFC"))}:2}`);
  });

  it("rejects distinct keys that collapse to the same NFC key", () => {
    const clash = { [ACUTE_E.normalize("NFC")]: 1, [ACUTE_E.normalize("NFD")]: 2 };
    // Both keys normalize to the same NFC "é" — an ambiguous object, not a merge.
    expect(() => canonicalSerialize(clash)).toThrow(/duplicate object key/);
  });
});

describe("canonicalSerialize — number + undefined rules", () => {
  it("rejects NaN and Infinity", () => {
    expect(() => canonicalSerialize({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalSerialize({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalSerialize(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("omits undefined-valued keys (never emits null for them)", () => {
    expect(bytes({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("keeps explicit null (null is meaningful)", () => {
    expect(bytes({ a: null })).toBe('{"a":null}');
  });

  it("rejects undefined inside an array rather than coercing to null", () => {
    expect(() => canonicalSerialize([1, undefined, 3])).toThrow(/undefined/);
  });

  it("uses shortest round-trip number form", () => {
    expect(bytes({ x: 1.5, y: 100, z: 0 })).toBe('{"x":1.5,"y":100,"z":0}');
  });

  it("canonicalStringify matches the decoded bytes", () => {
    const v = { z: 1, a: 2 };
    expect(canonicalStringify(v)).toBe(bytes(v));
  });
});

describe("ids — ULID mint", () => {
  it("mints 26-char sortable ULIDs that pass isUlid", () => {
    const id = newRunId();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it("mints distinct ids and rejects malformed ones", () => {
    expect(newRunId()).not.toBe(newRunId());
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("01J9Z8Q0000000000000000000")).toBe(true);
  });
});

describe("ids — source handle round-trip (D3)", () => {
  const h = "a".repeat(64);

  it("parses and re-serializes a contentId", () => {
    const s = `sha256:${h}:text/markdown`;
    const c = parseSourceHandle(s);
    expect(c.kind).toBe("content");
    if (c.kind === "content") expect(serializeContentId(c)).toBe(s);
  });

  it("parses and re-serializes a renditionId", () => {
    const s = `sha256:${h}:text/markdown:3:7`;
    const r = parseSourceHandle(s);
    expect(r.kind).toBe("rendition");
    if (r.kind === "rendition") {
      expect(r.extractorVersion).toBe(3);
      expect(r.normalizerVersion).toBe(7);
      expect(serializeRenditionId(r)).toBe(s);
    }
  });

  it("rejects bad prefixes, non-hex hashes, and wrong arity", () => {
    expect(() => parseSourceHandle(`md5:${h}:text/markdown`)).toThrow();
    expect(() => parseSourceHandle(`sha256:XYZ:text/markdown`)).toThrow();
    expect(() => parseSourceHandle(`sha256:${h}:text/markdown:3`)).toThrow();
    expect(() => parseSourceHandle(`sha256:${h}:notamediatype`)).toThrow();
  });
});

describe("ids — saltedOpaqueId (§5.1)", () => {
  const salt = new Uint8Array(32).fill(7);

  it("is deterministic and shaped like the contract examples", () => {
    const a = saltedOpaqueId("note", "note/2026/x", salt);
    const b = saltedOpaqueId("note", "note/2026/x", salt);
    expect(a).toBe(b);
    expect(a).toMatch(/^n_[0-9a-f]{16}$/);
    expect(saltedOpaqueId("source", "source/y", salt)).toMatch(/^s_[0-9a-f]{16}$/);
  });

  it("changes with salt, kind, and natural id (NUL domain separation)", () => {
    const other = new Uint8Array(32).fill(9);
    expect(saltedOpaqueId("note", "x", salt)).not.toBe(saltedOpaqueId("note", "x", other));
    // Domain separator keeps kind/id boundaries unambiguous.
    expect(saltedOpaqueId("note", " a", salt)).not.toBe(saltedOpaqueId("note", "a", salt));
  });
});
