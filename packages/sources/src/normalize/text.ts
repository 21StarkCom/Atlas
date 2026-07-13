/**
 * The plain-text normalizer (`text/plain`) — and the shared strict-decode core the
 * `markdown` normalizer reuses (`normalization-contract.md` `text`/`markdown`).
 *
 * Both formats accept the same encoding set (UTF-8 with/without BOM, UTF-16 LE/BE by
 * BOM) and use the `char-offset` locator scheme. Decoding is FATAL via the single
 * {@link decodeTextStrict} seam in `../formats.js`: a malformed or unsupported byte
 * sequence yields a typed `unsupported-encoding` rejection, NEVER a lossy
 * `U+FFFD`-riddled "clean" rendition. The decoded text is kept VERBATIM (the BOM is
 * already stripped by the strict decoder) — no line-ending munging, locale formatting,
 * or other transformation — so identical bytes deterministically yield identical text.
 */
import { decodeTextStrict } from "../formats.js";
import type { SourceFormat } from "../formats.js";
import type { NormalizeOutcome } from "./media.js";

/**
 * Decode + normalize a UTF text source under the accepted encoding set. Shared by the
 * `text` and `markdown` formats (the `format` parameter only tags the rejection). An
 * empty document (zero decoded characters) is `no-extractable-text` per the contract
 * ("… an empty document yields no text layer").
 */
export function normalizePlainText(format: SourceFormat, bytes: Uint8Array): NormalizeOutcome {
  const dec = decodeTextStrict(bytes);
  if (!dec.ok) {
    return {
      ok: false,
      rejection: { code: "unsupported-encoding", format, detail: "input is not valid UTF-8 / UTF-16 text" },
    };
  }
  if (dec.text.length === 0) {
    return { ok: false, rejection: { code: "no-extractable-text", format, detail: "empty document" } };
  }
  return { ok: true, text: dec.text, gaps: [] };
}

/** Normalize a `text/plain` source (`char-offset` locator; no media gaps). */
export function normalizeText(bytes: Uint8Array): NormalizeOutcome {
  return normalizePlainText("text", bytes);
}
