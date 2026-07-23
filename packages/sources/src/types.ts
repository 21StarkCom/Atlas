/**
 * `@atlas/sources` shared types (v2, #334) — the surviving normalization
 * contract types. The sandbox seam types (limits, attestation, worker protocol,
 * capability report) died with the jail (ADR-0003).
 */
import type { SourceFormat } from "./formats.js";

/** Re-exported so consumers get the format token set from one place. */
export type { SourceFormat } from "./formats.js";
export { SOURCE_FORMATS, CANONICAL_MEDIA_TYPE } from "./formats.js";

/**
 * The exhaustive typed normalization rejection code set, verbatim from
 * `docs/specs/normalization-contract.md §2` (exit 1 each). A rejection is a VALUE,
 * never a throw. Duplicated here as a string-literal union (not imported) because
 * Task 2.0's contract lives in Markdown, not code; Task 2.4's normalizers and this
 * worker both reference this one union so there is a single code owner in TS.
 */
export type NormalizationRejectionCode =
  | "unsupported-encoding"
  | "encrypted-source"
  | "no-extractable-text"
  | "signature-mismatch"
  | "too-large"
  | "partial-extraction";

/** A typed normalization rejection (`normalization-contract.md §2`). */
export interface NormalizationRejection {
  readonly code: NormalizationRejectionCode;
  readonly format: SourceFormat;
  readonly detail?: string;
}
