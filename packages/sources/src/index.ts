/**
 * `@atlas/sources` — the md/txt/pdf/html normalizers (v2, #334). The v1 sandbox
 * jail (Seatbelt/userns/seccomp/cgroup worker) and the scan-before-persist guard
 * are RETIRED with the security architecture (ADR-0003); what survives is the
 * deterministic normalization core: {@link normalize} (bounded read → signature
 * check → pure per-format extraction, in-process) + its contract types/pins.
 */

// Formats + shared types.
export {
  SOURCE_FORMATS,
  CANONICAL_MEDIA_TYPE,
  MAX_BYTES,
  signatureMatches,
  decodeTextStrict,
  type SourceFormat,
  type TextEncoding,
  type StrictDecode,
} from "./formats.js";
export { type NormalizationRejection, type NormalizationRejectionCode } from "./types.js";

// The normalization API + version pins.
export {
  normalize,
  EXTRACTOR_VERSION,
  NORMALIZER_VERSION,
  EXTRACTOR_PINS,
  LOCATOR_SCHEME,
  UnsupportedSourceError,
  IrregularSourceError,
  type NormalizeInput,
  type NormalizeResult,
} from "./normalize/index.js";
