/**
 * Media alt-text rules (`normalization-contract.md §4`, Phase-2 scope) + the shared
 * per-format normalizer outcome type.
 *
 * The three dispositions of an image reference the contract fixes verbatim:
 *   - a MEANINGFUL `alt` → preserved verbatim as represented text (no gap). "Verbatim"
 *     is exact: multiple spaces, tabs, and leading/trailing whitespace inside the alt are
 *     NOT collapsed (wing round-3 finding 3) — the HTML normalizer pushes it through a
 *     verbatim sink, not the whitespace-collapsing text path.
 *   - an explicitly EMPTY `alt=""` → the image is DECORATIVE → a `image-decorative`
 *     gap, no text. Decorative classification applies ONLY to the contract-defined empty
 *     value (`alt` present and exactly `""`); a whitespace-only `alt=" "` is NOT decorative
 *     — it is a meaningful (if unusual) value, preserved verbatim (wing round-3 finding 3).
 *   - a meaningful image with NO `alt` attribute → a `image-no-alt`
 *     {@link RepresentedGap} carrying a locator (a gap record, NOT fabricated text).
 *
 * Auto-generated descriptions are explicitly OUT of Phase 2 (they would be synthesis;
 * the Tier-3 gate applies when Phase 4 enables them) — so a missing `alt` becomes a
 * durable gap, never an invented caption.
 *
 * These live in `normalize/` (not `@atlas/contracts`) because they are normalization
 * internals; the produced {@link RepresentedGap}/`NormalizedRendition` DTOs are the
 * contracts types (imported type-only, erased at compile).
 */
import type { RepresentedGap } from "@atlas/contracts";
import type { NormalizationRejection } from "../types.js";

/**
 * The pure outcome of a per-format normalizer: a complete faithful text rendition
 * (plus any gaps it could not represent) or a typed rejection. This is a VALUE, never
 * a throw — partial extraction is expressed as `{ ok: false, rejection: {...} }` with
 * code `partial-extraction`, never as truncated `ok: true` text.
 */
export type NormalizeOutcome =
  | { readonly ok: true; readonly text: string; readonly gaps: readonly RepresentedGap[] }
  | { readonly ok: false; readonly rejection: NormalizationRejection };

/** A single image reference discovered during normalization. */
export interface MediaRef {
  /** The raw `alt` attribute value, or `null` when the attribute is ABSENT. */
  readonly alt: string | null;
  /** The locator identifying the image in the source (e.g. a `dom:` anchor). */
  readonly locator: string;
}

/** How an image reference is represented in the normalized output. */
export type MediaDisposition =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "gap"; readonly gap: RepresentedGap };

/**
 * Apply the contract's alt-text rules to one image reference. `alt === null` (attribute
 * absent) is the meaningful-image gap; the EXACT empty value `alt === ""` is the
 * decorative gap; any other value — INCLUDING a whitespace-only `alt=" "` — is a
 * meaningful value preserved VERBATIM as represented text (wing round-3 finding 3:
 * whitespace-only alt must NOT be misclassified as the empty/decorative value).
 */
export function classifyMedia(ref: MediaRef): MediaDisposition {
  if (ref.alt === null) {
    // A meaningful image with no alt at all — a gap, never a fabricated description.
    return { kind: "gap", gap: { kind: "image-no-alt", locator: ref.locator } };
  }
  if (ref.alt === "") {
    // The contract's decorative marker is the EXACT empty value `alt=""` — and only that.
    return { kind: "gap", gap: { kind: "image-decorative", locator: ref.locator } };
  }
  // Preserve a meaningful alt VERBATIM (contract §4: "preserve … verbatim"), whitespace
  // and all — the HTML walker routes this through the verbatim sink, not the collapsing one.
  return { kind: "text", text: ref.alt };
}
