/**
 * Supported source formats + their content signatures, transcribed from
 * `docs/specs/normalization-contract.md §1` (SSOT). The worker validates the
 * content SIGNATURE before parse (signature first, extension second — a mismatch is
 * a `signature-mismatch` rejection, never a guess).
 *
 * Only the detection surface Task 2.3's worker needs lives here (signature +
 * canonical media token + per-format raw-byte ceiling). Task 2.4 owns the full
 * per-format normalizers, encodings, and locator schemes; it consumes this module.
 */

/** The four V1 source formats (`normalization-contract.md §1`). */
export type SourceFormat = "markdown" | "text" | "pdf" | "html";

/** The ordered, exhaustive format token set. */
export const SOURCE_FORMATS: readonly SourceFormat[] = ["markdown", "text", "pdf", "html"];

/** Stable canonical media type per format — the token that composes into a `contentId`. */
export const CANONICAL_MEDIA_TYPE: Record<SourceFormat, string> = {
  markdown: "text/markdown",
  text: "text/plain",
  pdf: "application/pdf",
  html: "text/html",
};

/** Per-format raw-input ceiling in bytes (`normalization-contract.md §1 maxBytes`). */
export const MAX_BYTES: Record<SourceFormat, number> = {
  markdown: 5_242_880, // 5 MiB
  text: 5_242_880, // 5 MiB
  pdf: 52_428_800, // 50 MiB
  html: 10_485_760, // 10 MiB
};

/** Encode a literal string to bytes once (module-level, reused). */
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** ASCII/UTF-8 bytes of the PDF magic. */
const PDF_MAGIC = enc("%PDF-");
/** HTML doctype/root signatures (case-insensitive), from the contract. */
const HTML_SIGS = ["<!doctype html", "<html"];

/** True if `bytes` begins with `prefix`. */
function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/** The detected leading BOM (if any) — governs how the text heuristic decodes. */
type Bom = "utf8" | "utf16le" | "utf16be" | null;

/** Detect a leading UTF-8 / UTF-16 BOM. */
function detectBom(bytes: Uint8Array): Bom {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
  return null;
}

/** Strip a leading UTF-8/UTF-16 BOM so a byte-level scan sees the content start. */
function afterBom(bytes: Uint8Array): Uint8Array {
  const bom = detectBom(bytes);
  if (bom === "utf8") return bytes.subarray(3);
  if (bom === "utf16le" || bom === "utf16be") return bytes.subarray(2);
  return bytes;
}

/** Byte-swap a UTF-16BE body to LE (so we never depend on the optional `utf-16be` ICU label). */
function swapUtf16BE(body: Uint8Array): Uint8Array {
  const n = body.length - (body.length % 2);
  const swapped = new Uint8Array(body.length);
  for (let i = 0; i < n; i += 2) {
    swapped[i] = body[i + 1]!;
    swapped[i + 1] = body[i]!;
  }
  if (n !== body.length) swapped[n] = body[n]!;
  return swapped;
}

/** Decode UTF-16 (LE, or BE via byte-swap) with the non-fatal decoder (heuristic use). */
function decodeUtf16(body: Uint8Array, littleEndian: boolean): string {
  const src = littleEndian ? body : swapUtf16BE(body);
  return new TextDecoder("utf-16le", { fatal: false }).decode(src);
}

/**
 * The text encodings the normalization contract accepts for the `markdown`/`text`
 * formats: UTF-8 (with/without BOM) and UTF-16 (LE/BE, BOM-designated). Everything else
 * is `unsupported-encoding`.
 */
export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";

/** The result of a FATAL text decode: the exact decoded text + its encoding, or a failure. */
export type StrictDecode = { readonly ok: true; readonly text: string; readonly encoding: TextEncoding } | { readonly ok: false };

/**
 * FATALLY decode `bytes` under one of the contract's accepted text encodings (wing
 * round-3 finding 8: the worker previously decoded NON-fatally, so malformed or
 * unsupported byte sequences became LOSSY `U+FFFD`-riddled "clean" output). A leading
 * BOM selects UTF-16LE / UTF-16BE / UTF-8; otherwise UTF-8 is assumed. The decode uses
 * `{ fatal: true }`, so an invalid sequence (a lone UTF-8 continuation byte, an
 * unpaired surrogate, an odd-length UTF-16 body, …) makes this return `{ ok: false }`
 * — which the worker maps to a typed `unsupported-encoding` rejection, NEVER a lossy
 * clean rendition. This is the single strict-decode seam both the worker and Task 2.4
 * consume, so there is one owner of "is this a supported, losslessly-decodable text".
 */
export function decodeTextStrict(bytes: Uint8Array): StrictDecode {
  const bom = detectBom(bytes);
  try {
    if (bom === "utf16le" || bom === "utf16be") {
      const body = bytes.subarray(2);
      if (body.length % 2 !== 0) return { ok: false }; // dangling half code unit
      const src = bom === "utf16le" ? body : swapUtf16BE(body);
      const text = new TextDecoder("utf-16le", { fatal: true }).decode(src);
      return { ok: true, text, encoding: bom === "utf16le" ? "utf-16le" : "utf-16be" };
    }
    const body = bom === "utf8" ? bytes.subarray(3) : bytes;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return { ok: true, text, encoding: "utf-8" };
  } catch {
    return { ok: false };
  }
}

/**
 * Heuristic "is this decodable text" test for the `utf8-text` signature of the
 * markdown/text formats — ENCODING-AWARE (wing round-2 finding: a valid UTF-16 BOM
 * text was rejected because the BOM was stripped before a raw-byte NUL heuristic
 * that legitimate UTF-16 always trips — every ASCII code unit carries a `0x00`).
 *
 *   - **UTF-16 (BOM present):** the content is 16-bit code units, so a raw `0x00`
 *     byte is NORMAL. Decode as UTF-16 and reject only a genuine NUL *character*
 *     (U+0000) or a decode dominated by U+FFFD replacements (binary mislabeled as
 *     text) — that is the real "extension lie", not the encoding.
 *   - **UTF-8 / no BOM:** a text source carries no `0x00` byte in its leading window
 *     (binary content does). This is the conservative `utf8-text` signature the
 *     contract names.
 *
 * SCOPE (wing round-3 finding 8): this is the format-SHAPE gate — "is this plausibly a
 * text container vs binary / a `%PDF`/`<html>` lie". It is deliberately NOT the encoding
 * validator: whether the bytes are actually a *supported, losslessly-decodable* encoding
 * is decided by the FATAL {@link decodeTextStrict} the worker runs during normalization,
 * which maps an invalid/unsupported sequence to a typed `unsupported-encoding` rejection
 * (never a lossy `U+FFFD` "clean" rendition). So a NUL-free-but-invalid byte soup passes
 * this coarse gate and is then rejected `unsupported-encoding` downstream — by design.
 */
function looksTextual(bytes: Uint8Array): boolean {
  const bom = detectBom(bytes);
  if (bom === "utf16le" || bom === "utf16be") {
    const body = bytes.subarray(2);
    // An odd-length UTF-16 body is malformed (a dangling half code unit).
    if (body.length % 2 !== 0) return false;
    const text = decodeUtf16(body.subarray(0, 8192), bom === "utf16le");
    if (text.length === 0 && body.length > 0) return false;
    let replacements = 0;
    for (const ch of text) {
      if (ch === "\u0000") return false; // a real NUL character means not text
      if (ch === "\uFFFD") replacements++; // U+FFFD replacement char
    }
    // A high replacement ratio means the bytes are not really UTF-16 text.
    return replacements === 0 || replacements / text.length < 0.1;
  }
  const window = afterBom(bytes).subarray(0, 8192);
  for (const b of window) {
    if (b === 0x00) return false;
  }
  return true;
}

/**
 * Validate the content SIGNATURE against the declared `format`. Returns `true` when
 * the bytes match; `false` is a `signature-mismatch` (an extension lie). Detection
 * is by content, so a `.pdf` whose bytes are not `%PDF-` fails here.
 */
export function signatureMatches(format: SourceFormat, bytes: Uint8Array): boolean {
  switch (format) {
    case "pdf":
      return startsWith(bytes, PDF_MAGIC);
    case "html": {
      // Case-insensitive prefix (after optional BOM + leading whitespace).
      const head = new TextDecoder("utf-8", { fatal: false })
        .decode(afterBom(bytes).subarray(0, 512))
        .trimStart()
        .toLowerCase();
      return HTML_SIGS.some((sig) => head.startsWith(sig));
    }
    case "markdown":
    case "text":
      return looksTextual(bytes);
  }
}
