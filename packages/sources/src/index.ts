/**
 * `@atlas/sources` — the sandboxed parser worker (Task 2.3). It runs the normalizer
 * + the secret scanner INSIDE a per-host jail (macOS Seatbelt / Linux
 * userns+mountns+netns+seccomp+rlimits) and returns a readable stream + a digest-bound
 * scan attestation — never a directory path (D15 scan-before-persist).
 *
 * Public surface:
 *   - {@link runInSandbox} — parse one untrusted file confined; returns a
 *     {@link WorkerResult} (clean stream + attestation, exit-3 scan rejection, or a
 *     typed normalization rejection).
 *   - {@link probeSandbox} — the startup capability report `doctor` surfaces (fail
 *     loud when a required guarantee is unavailable).
 *
 * Task 2.4 consumes {@link SourceFormat}/{@link NormalizationRejection} and plugs the
 * per-format normalizers into the worker seam.
 */

// The launcher entrypoint + its errors + the lower-level primitive tests use.
export {
  runInSandbox,
  spawnSandboxed,
  detectCodeRoot,
  importClosureRoots,
  resolveLimits,
  sha256Hex,
  SandboxUnsupportedError,
  SandboxCapExceededError,
  SandboxWorkerError,
  SandboxAttestationError,
  type RunInSandboxRequest,
  type SpawnSandboxedOpts,
  type RawSandboxRun,
} from "./sandbox/launcher.js";

// The startup capability probe (consumed by `doctor`) + host selection.
export { probeSandbox, resetSandboxProbeCache, selectBackend } from "./sandbox/probes.js";
export { detectHost } from "./sandbox/backend.js";

// Linux seccomp internals — the pure BPF builder + interpreter + arch table (used by the
// containment suite to assert the ARM64/x86_64 filter on ANY host, incl. macOS CI).
export { buildSeccompProgram, evalSeccomp, AUDIT_ARCH, type SeccompAction } from "./sandbox/linux.js";

// The worker↔launcher wire protocol (control message shape + fd constants).
export {
  OUTPUT_FD,
  CONTROL_FD,
  parseWorkerControl,
  type WorkerRequest,
  type WorkerControl,
} from "./sandbox/protocol.js";

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
export {
  DEFAULT_SANDBOX_LIMITS,
  SANDBOX_LIMIT_CEILINGS,
  type SandboxLimits,
  type ScanAttestation,
  type WorkerResult,
  type NormalizationRejection,
  type NormalizationRejectionCode,
  type SandboxHostId,
  type SandboxGuarantee,
  type SandboxCapabilityCheck,
  type SandboxCapabilityReport,
} from "./types.js";
