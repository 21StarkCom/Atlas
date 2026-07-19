/**
 * `workflows/reverify-match` — the DETERMINISTIC quote re-anchor matcher (Task 4.7).
 *
 * The rendition-upgrade / evidence-staleness protocol (design §"Rendition-upgrade /
 * evidence-staleness protocol") re-anchors each affected evidence head against the NEW
 * rendition by "re-locating the recorded `quoteHash` in the new normalized text". This
 * module is that re-location: given the exact quoted span an evidence head recorded
 * (recovered + hash-verified from the pinned old rendition) and the new rendition's
 * normalized text, it decides the {@link ReanchorMatch} class the classifier
 * ({@link import("./reverify.js").classifyReanchor}) turns into a verification verdict:
 *
 *   - `exact`      → a single occurrence at the SAME position ⇒ auto `valid`;
 *   - `moved`      → a single occurrence at a different (or unverifiable) position ⇒ `pending` (Tier-3);
 *   - `ambiguous`  → two or more occurrences ⇒ `pending` (Tier-3);
 *   - `not-found`  → zero occurrences ⇒ `failed`.
 *
 * ## Why it must be — and is — deterministic (load-bearing)
 * Atlas is contract-first and fail-closed: a re-anchor that auto-commits to `valid`
 * MUST reach the SAME verdict on every run, process, and platform, or a Tier-2
 * auto-commit becomes non-reproducible (and `db rebuild` could disagree with the run
 * that produced it). So the matcher uses ONLY:
 *   - exact substring search (`String.prototype.indexOf`, UTF-16 code-unit exact — the
 *     text is ALREADY the normalizer's deterministic output, so we add NO second
 *     normalization pass that could vary), and
 *   - integer offset comparison.
 * There is no similarity score, no threshold, no tokenization, no locale collation, no
 * clock, no randomness. Identical inputs ⇒ identical output, always.
 *
 * ## Why it fails closed
 * Every source of doubt resolves to a NON-`exact` verdict, because only `exact`
 * auto-commits (`valid`); the other three route to operator review (`pending`) or a
 * terminal `failed`. Specifically: an unverifiable previous offset (a page/dom locator
 * with no comparable char index) ⇒ `moved`, not `exact`; a whitespace/case difference
 * (the re-normalization actually changed the span) does NOT soft-match ⇒ `not-found`;
 * multiple hits ⇒ `ambiguous`. We would rather send a still-correct quote to review than
 * fabricate a `valid` on a quote that silently drifted.
 */
import type { ReanchorMatch } from "./reverify.js";

/** The inputs the matcher re-locates a recorded quote from. */
export interface ReanchorInput {
  /**
   * The exact quoted span the evidence head recorded, recovered + hash-verified from the
   * PINNED (old) rendition. An empty string means the span could not be recovered and is
   * treated as unanchorable (`not-found`) — the caller routes genuinely anchor-less
   * evidence (no locator/quoteHash) to `pending` BEFORE reaching this matcher.
   */
  readonly quote: string;
  /**
   * The start offset the quote occupied in the OLD rendition (from its locator), or
   * `null` when the locator scheme carries no comparable integer char offset (pdf page /
   * dom anchor). `null` ⇒ position unverifiable ⇒ never `exact`.
   */
  readonly previousStart: number | null;
  /** The NEW rendition's normalized text the quote is re-located within. */
  readonly newText: string;
}

/**
 * Re-locate `quote` in `newText` and classify the match (see the module header for the
 * determinism + fail-closed rationale). Pure: a function of its arguments alone.
 */
export function matchReanchor(input: ReanchorInput): ReanchorMatch {
  const { quote, previousStart, newText } = input;

  // An empty span is unanchorable — never assert a position it never had.
  if (quote.length === 0) return "not-found";

  // Count NON-overlapping occurrences and remember the first hit's index. Exact
  // substring search only: the operands are already the normalizer's deterministic
  // output, so a second normalization pass here would only add drift + false "exact"s.
  let idx = newText.indexOf(quote);
  if (idx === -1) return "not-found";
  const firstIndex = idx;
  let count = 0;
  while (idx !== -1) {
    count += 1;
    idx = newText.indexOf(quote, idx + quote.length);
  }

  if (count > 1) return "ambiguous";
  // Exactly one occurrence: it is `exact` ONLY when we can PROVE it held its old
  // position; an unverifiable offset (null) or a shifted one is `moved` (→ review).
  if (previousStart === null) return "moved";
  return firstIndex === previousStart ? "exact" : "moved";
}

/**
 * Parse an evidence `locator` into the comparable integer START offset the matcher uses
 * to distinguish `exact` from `moved`, or `null` when the scheme has none.
 *
 * Locators are `"<scheme>:<start>-<end>"` (normalization-contract §1 + the
 * `byte:`/`char:`/`page:`/`dom:` prefixes fixed by the sqlite data dictionary). Only the
 * `char`/`byte` schemes expose a comparable integer offset; `page` (pdf-page-span) and
 * `dom` (dom-anchor) do not, and the absent-anchor sentinel `(none)` and any malformed
 * value return `null` — all of which force the matcher's fail-closed `moved` branch
 * rather than a fabricated `exact`.
 */
export function parseLocatorStart(locator: string): number | null {
  const colon = locator.indexOf(":");
  if (colon === -1) return null;
  const scheme = locator.slice(0, colon);
  if (scheme !== "char" && scheme !== "byte") return null;
  const span = locator.slice(colon + 1);
  const dash = span.indexOf("-");
  if (dash <= 0) return null; // no dash, or an empty start (a leading '-' ⇒ negative/blank)
  const startText = span.slice(0, dash);
  // Strict non-negative integer only — reject signs, decimals, whitespace, leading zeros-with-junk.
  if (!/^\d+$/.test(startText)) return null;
  return Number.parseInt(startText, 10);
}
