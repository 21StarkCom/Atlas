/**
 * Host-independent unit checks for three wing round-2 findings:
 *   - `formats.signatureMatches` is ENCODING-AWARE (a valid UTF-16 BOM text is accepted,
 *     not rejected by a raw-byte NUL heuristic; a malformed/binary source is rejected);
 *   - `parseWorkerControl` STRICTLY validates every field of every control kind;
 *   - `resolveLimits` validates + clamps caller overrides (never raises/disables a cap).
 */
import { describe, expect, it } from "vitest";
import { signatureMatches, decodeTextStrict } from "../src/formats.js";
import { parseWorkerControl } from "../src/index.js";
import { resolveLimits } from "../src/index.js";
import { DEFAULT_SANDBOX_LIMITS, SANDBOX_LIMIT_CEILINGS } from "../src/index.js";

/** Encode a string as UTF-16LE bytes with a BOM. */
function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[2 + i * 2 + 1] = (c >> 8) & 0xff;
  }
  return out;
}
/** Encode a string as UTF-16BE bytes with a BOM. */
function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = (c >> 8) & 0xff;
    out[2 + i * 2 + 1] = c & 0xff;
  }
  return out;
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("signatureMatches — encoding aware (finding 8)", () => {
  it("accepts valid UTF-16LE / UTF-16BE BOM text as markdown/text", () => {
    for (const fmt of ["markdown", "text"] as const) {
      expect(signatureMatches(fmt, utf16le("# Hello, world\nsome prose"))).toBe(true);
      expect(signatureMatches(fmt, utf16be("# Hello, world\nsome prose"))).toBe(true);
    }
  });

  it("still accepts plain UTF-8 (with and without a BOM)", () => {
    expect(signatureMatches("text", enc("plain utf-8 text"))).toBe(true);
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("bom utf-8")]);
    expect(signatureMatches("markdown", withBom)).toBe(true);
  });

  it("rejects a malformed UTF-16 source (odd length / embedded NUL character)", () => {
    // Odd-length UTF-16 body (a dangling half code unit) — malformed.
    expect(signatureMatches("text", new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
    // UTF-16LE BOM followed by a NUL character (00 00) — not text.
    expect(signatureMatches("text", new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00]))).toBe(false);
  });

  it("rejects binary content mislabeled as text (raw NUL bytes, no BOM)", () => {
    expect(signatureMatches("text", new Uint8Array([0x00, 0x01, 0x02, 0x00]))).toBe(false);
  });

  it("validates pdf/html by signature regardless of extension", () => {
    expect(signatureMatches("pdf", enc("%PDF-1.7"))).toBe(true);
    expect(signatureMatches("pdf", enc("not a pdf"))).toBe(false);
    expect(signatureMatches("html", enc("<!DOCTYPE html><html>"))).toBe(true);
    expect(signatureMatches("html", enc("plain"))).toBe(false);
  });
});

describe("decodeTextStrict — FATAL encoding validation (finding 8)", () => {
  it("decodes valid UTF-8 (with and without a BOM) losslessly", () => {
    const d1 = decodeTextStrict(enc("héllo — wörld ✓"));
    expect(d1.ok && d1.text).toBe("héllo — wörld ✓");
    expect(d1.ok && d1.encoding).toBe("utf-8");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("bom text")]);
    const d2 = decodeTextStrict(withBom);
    expect(d2.ok && d2.text).toBe("bom text");
  });

  it("decodes valid UTF-16LE / UTF-16BE BOM text losslessly", () => {
    const le = decodeTextStrict(utf16le("# Hello ✓"));
    expect(le.ok && le.text).toBe("# Hello ✓");
    expect(le.ok && le.encoding).toBe("utf-16le");
    const be = decodeTextStrict(utf16be("# Hello ✓"));
    expect(be.ok && be.text).toBe("# Hello ✓");
    expect(be.ok && be.encoding).toBe("utf-16be");
  });

  it("FAILS (does not lossily accept) invalid byte sequences", () => {
    // Lone UTF-8 continuation byte — invalid, would non-fatally decode to U+FFFD.
    expect(decodeTextStrict(new Uint8Array([0x80])).ok).toBe(false);
    // Truncated multi-byte UTF-8 sequence.
    expect(decodeTextStrict(new Uint8Array([0xe2, 0x28, 0xa1])).ok).toBe(false);
    // 0xFF/0xFE mid-stream (not a BOM position) — invalid UTF-8.
    expect(decodeTextStrict(new Uint8Array([0x41, 0xff, 0x42])).ok).toBe(false);
    // Odd-length UTF-16 body (dangling half code unit).
    expect(decodeTextStrict(new Uint8Array([0xff, 0xfe, 0x41])).ok).toBe(false);
  });
});

describe("parseWorkerControl — strict validation (finding 13)", () => {
  const digest = "sha256:" + "a".repeat(64);

  it("accepts a well-formed clean attestation with an explicit gaps array", () => {
    const c = parseWorkerControl(JSON.stringify({ kind: "clean", attestation: { scannerRulesetVersion: 1, scannedBytes: 10, clean: true, outputDigest: digest }, gaps: [] }));
    expect(c.kind).toBe("clean");
    if (c.kind === "clean") expect(c.gaps).toEqual([]);
  });

  it("REJECTS a clean message that OMITS the gaps array (finding 6 — no silent coercion to [])", () => {
    // A clean message with NO `gaps` field was silently coerced to `gaps: []`, turning
    // dropped media-gap metadata into a faithful-looking success. It must now be rejected.
    expect(() => parseWorkerControl(JSON.stringify({ kind: "clean", attestation: { scannerRulesetVersion: 1, scannedBytes: 10, clean: true, outputDigest: digest } }))).toThrow(/gaps must be an explicit array/);
    // A non-array gaps is likewise rejected.
    expect(() => parseWorkerControl(JSON.stringify({ kind: "clean", attestation: { scannerRulesetVersion: 1, scannedBytes: 10, clean: true, outputDigest: digest }, gaps: {} }))).toThrow(/gaps must be an explicit array/);
    // An explicit non-empty, well-formed gaps array is still accepted (order preserved).
    const c = parseWorkerControl(JSON.stringify({ kind: "clean", attestation: { scannerRulesetVersion: 1, scannedBytes: 10, clean: true, outputDigest: digest }, gaps: [{ kind: "image-no-alt", locator: "dom:/html[1]/body[1]/img[1]" }] }));
    expect(c.kind).toBe("clean");
    if (c.kind === "clean") expect(c.gaps).toEqual([{ kind: "image-no-alt", locator: "dom:/html[1]/body[1]/img[1]" }]);
  });

  it("rejects a clean message with a missing/short/oddly-typed digest", () => {
    expect(() => parseWorkerControl(JSON.stringify({ kind: "clean", attestation: { scannerRulesetVersion: 1, scannedBytes: 10, clean: true } }))).toThrow();
    expect(() => parseWorkerControl(JSON.stringify({ kind: "clean", attestation: { scannerRulesetVersion: 1, scannedBytes: 10, clean: true, outputDigest: "sha256:beef" } }))).toThrow();
  });

  it("rejects a clean message whose `clean` is not exactly true or bytes not a count", () => {
    expect(() => parseWorkerControl(JSON.stringify({ kind: "clean", attestation: { scannerRulesetVersion: 1, scannedBytes: -1, clean: true, outputDigest: digest } }))).toThrow();
    expect(() => parseWorkerControl(JSON.stringify({ kind: "clean", attestation: { scannerRulesetVersion: 1, scannedBytes: 10, clean: "yes", outputDigest: digest } }))).toThrow();
  });

  it("rejects unknown kinds, bad scan-rejection codes, and unknown normalization codes/formats", () => {
    expect(() => parseWorkerControl(JSON.stringify({ kind: "totally-made-up" }))).toThrow();
    expect(() => parseWorkerControl(JSON.stringify({ kind: "scan-rejection", code: "nope", scannerRulesetVersion: 1 }))).toThrow();
    expect(() => parseWorkerControl(JSON.stringify({ kind: "normalization-rejection", rejection: { code: "bogus", format: "text" } }))).toThrow();
    expect(() => parseWorkerControl(JSON.stringify({ kind: "normalization-rejection", rejection: { code: "too-large", format: "docx" } }))).toThrow();
  });

  it("accepts a valid scan-rejection and normalization-rejection", () => {
    expect(parseWorkerControl(JSON.stringify({ kind: "scan-rejection", code: "secret-detected", scannerRulesetVersion: 2 })).kind).toBe("scan-rejection");
    expect(parseWorkerControl(JSON.stringify({ kind: "normalization-rejection", rejection: { code: "too-large", format: "pdf", detail: "big" } })).kind).toBe("normalization-rejection");
  });

  it("rejects non-JSON and non-object control blobs", () => {
    expect(() => parseWorkerControl("not json")).toThrow();
    expect(() => parseWorkerControl("[1,2,3]")).toThrow();
    expect(() => parseWorkerControl("42")).toThrow();
  });
});

describe("resolveLimits — validate + clamp overrides (finding 12)", () => {
  it("falls back to the default for NaN / Infinity / negative / zero / non-integer / missing", () => {
    const r = resolveLimits({
      cpuSeconds: Number.NaN,
      maxAddressSpaceBytes: Number.POSITIVE_INFINITY,
      maxFileSizeBytes: -5,
      maxOpenFiles: 0,
      wallClockMs: 1.5e-3,
    });
    expect(r.cpuSeconds).toBe(DEFAULT_SANDBOX_LIMITS.cpuSeconds);
    expect(r.maxAddressSpaceBytes).toBe(DEFAULT_SANDBOX_LIMITS.maxAddressSpaceBytes);
    expect(r.maxFileSizeBytes).toBe(DEFAULT_SANDBOX_LIMITS.maxFileSizeBytes);
    expect(r.maxOpenFiles).toBe(DEFAULT_SANDBOX_LIMITS.maxOpenFiles);
    expect(r.wallClockMs).toBe(DEFAULT_SANDBOX_LIMITS.wallClockMs);
  });

  it("clamps an over-large override down to the DEFAULT cap — an override may only lower, never raise (finding 6)", () => {
    // Even a value between the default and the (higher) absolute ceiling must collapse
    // to the default: the API contract is that an override only ever TIGHTENS a cap.
    const r = resolveLimits({ maxOutputBytes: 999 * 1024 * 1024 * 1024, cpuSeconds: 10_000 });
    expect(r.maxOutputBytes).toBe(DEFAULT_SANDBOX_LIMITS.maxOutputBytes);
    expect(r.cpuSeconds).toBe(DEFAULT_SANDBOX_LIMITS.cpuSeconds);
    // A value strictly between default and ceiling is STILL clamped down to the default.
    const between = (DEFAULT_SANDBOX_LIMITS.cpuSeconds + SANDBOX_LIMIT_CEILINGS.cpuSeconds) / 2;
    expect(resolveLimits({ cpuSeconds: between }).cpuSeconds).toBe(DEFAULT_SANDBOX_LIMITS.cpuSeconds);
    // The default is itself never above the absolute ceiling (defence in depth).
    expect(DEFAULT_SANDBOX_LIMITS.maxOutputBytes).toBeLessThanOrEqual(SANDBOX_LIMIT_CEILINGS.maxOutputBytes);
  });

  it("honours a legitimate LOWER override", () => {
    const r = resolveLimits({ maxOutputBytes: 1024, wallClockMs: 5_000 });
    expect(r.maxOutputBytes).toBe(1024);
    expect(r.wallClockMs).toBe(5_000);
  });

  it("with no overrides returns exactly the defaults", () => {
    expect(resolveLimits()).toEqual(DEFAULT_SANDBOX_LIMITS);
  });
});
