/**
 * Host-independent format-detection unit checks (v2 #334: the worker protocol +
 * sandbox-limit halves died with the jail):
 *   - `formats.signatureMatches` is ENCODING-AWARE (a valid UTF-16 BOM text is accepted,
 *     not rejected by a raw-byte NUL heuristic; a malformed/binary source is rejected);
 *   - `decodeTextStrict` is the single FATAL decode seam (invalid ⇒ reject, never U+FFFD).
 */
import { describe, expect, it } from "vitest";
import { signatureMatches, decodeTextStrict } from "../src/formats.js";

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
