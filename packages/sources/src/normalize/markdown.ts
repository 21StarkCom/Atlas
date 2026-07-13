/**
 * The Markdown normalizer (`text/markdown`).
 *
 * Markdown IS text: the canonical rendition is the decoded Markdown SOURCE preserved
 * verbatim (headings, links, fenced blocks intact) — the contract's `char-offset`
 * locator addresses positions in that text. So this shares the strict-decode core with
 * the `text` normalizer; only the rejection's `format` tag differs. Keeping the source
 * verbatim (rather than rendering to prose) is what makes the rendition deterministic
 * and faithful — no synthesis, no HTML rendering, no locale-dependent transformation.
 */
import { normalizePlainText } from "./text.js";
import type { NormalizeOutcome } from "./media.js";

/** Normalize a `text/markdown` source (`char-offset` locator; no media gaps). */
export function normalizeMarkdown(bytes: Uint8Array): NormalizeOutcome {
  return normalizePlainText("markdown", bytes);
}
