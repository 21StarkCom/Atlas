/**
 * `@atlas/sources` shared types — the structural surface Task 2.3 (the sandboxed
 * parser worker) produces and Task 2.4 (per-format normalizers) later consumes.
 *
 * These live in THIS package (not `@atlas/contracts`) because they are the sandbox
 * worker's own interface, not a cross-store DTO (the D14 DTO set — `VaultSnapshot`,
 * `NormalizedRendition`, … — already lives in `@atlas/contracts`; this package
 * produces *values* of `NormalizedRendition` in Task 2.4 but owns the sandbox seam
 * here). The result union below is the verbatim three-kind output contract of
 * `docs/specs/sandbox-contract.md §4` (SSOT): a clean digest-bound stream, a
 * distinct exit-3 scan rejection, or a typed normalization rejection.
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

/**
 * Resource caps enforced on a worker (`sandbox-contract.md §1 resource-caps`). CPU
 * + address-space + output-file size + fd count are POSIX rlimits (Linux/macOS);
 * `wallClockMs` is the launcher-side watchdog that force-terminates a worker that
 * exceeds it (a hung parser cannot outlive the deadline). `maxOutputBytes` caps the
 * normalized byte stream the worker may release — exceeding it is a forced kill,
 * never a truncated success (partial output is a rejection, never attested clean).
 */
export interface SandboxLimits {
  /** RLIMIT_CPU seconds (hard CPU-time ceiling). */
  readonly cpuSeconds: number;
  /** RLIMIT_AS bytes (virtual address-space ceiling ≈ memory cap). */
  readonly maxAddressSpaceBytes: number;
  /** RLIMIT_FSIZE bytes (largest file the worker may create in its private temp). */
  readonly maxFileSizeBytes: number;
  /** RLIMIT_NOFILE (max open fds). */
  readonly maxOpenFiles: number;
  /**
   * RLIMIT_NPROC — max processes/tasks the worker's (namespaced) uid may hold. On
   * Linux this is a real cap inside the worker's user namespace (where the mapped uid
   * starts at ~0 processes); on macOS the count is session-wide so it is NOT applied
   * (the Seatbelt `process-fork` denial is the no-subprocess mechanism there). Node's
   * own threads are tasks and count toward this, so the default is generous.
   */
  readonly maxProcesses: number;
  /** Wall-clock deadline (ms) — the launcher's watchdog kills the worker past this. */
  readonly wallClockMs: number;
  /** Max bytes the launcher will accept on the output stream before force-killing. */
  readonly maxOutputBytes: number;
}

/**
 * Conservative default caps for parsing an untrusted local file. Callers (Task 2.4)
 * may lower these but the contract caps them from above; a `format` never raises a
 * cap beyond these hard ceilings.
 */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  cpuSeconds: 30,
  maxAddressSpaceBytes: 1024 * 1024 * 1024, // 1 GiB
  maxFileSizeBytes: 128 * 1024 * 1024, // 128 MiB (worker-private temp scratch)
  maxOpenFiles: 256,
  maxProcesses: 128, // generous (node's threadpool are tasks); a fork bomb still trips it
  wallClockMs: 60_000,
  maxOutputBytes: 64 * 1024 * 1024, // 64 MiB normalized output ceiling
};

/**
 * The HARD upper bounds a caller override may not exceed (wing round-2 finding:
 * unvalidated overrides could raise or disable every cap). {@link runInSandbox}
 * validates each override to a finite positive integer and clamps it to these
 * ceilings — a caller (Task 2.4) may only ever LOWER a cap, never raise or disable it.
 */
export const SANDBOX_LIMIT_CEILINGS: SandboxLimits = {
  cpuSeconds: 120,
  maxAddressSpaceBytes: 4 * 1024 * 1024 * 1024, // 4 GiB
  maxFileSizeBytes: 512 * 1024 * 1024, // 512 MiB
  maxOpenFiles: 4096,
  maxProcesses: 512,
  wallClockMs: 300_000, // 5 min
  maxOutputBytes: 256 * 1024 * 1024, // 256 MiB
};

/**
 * The digest-bound scan attestation accompanying a CLEAN stream (`sandbox-contract.md
 * §4`). `outputDigest` is the SHA-256 the IN-WORKER scanner computed over the exact
 * clean byte stream it released; the launcher recomputes it over the received bytes
 * and refuses to expose them on a mismatch (so unscanned/tampered bytes can never be
 * attested clean).
 */
export interface ScanAttestation {
  /** The `@atlas/scan` ruleset version that produced the clean verdict. */
  readonly scannerRulesetVersion: number;
  /** Number of bytes scanned (== the released stream length). */
  readonly scannedBytes: number;
  /** Always `true` on an attestation — a dirty verdict is a scan rejection, not an attestation. */
  readonly clean: true;
  /** `sha256:<hex>` over the released clean bytes; the binding the consumer re-verifies. */
  readonly outputDigest: string;
}

/**
 * The `runInSandbox` result — the verbatim three disjoint kinds of
 * `sandbox-contract.md §4`. Secret detection is NOT folded into the normalization
 * rejection set: a `scan-rejection` is the distinct exit-3 path, separate from the
 * exhaustive exit-1 `NormalizationRejection` set.
 *
 * NB the byte payload is exposed as a Web `ReadableStream<Uint8Array>` (not a
 * directory path) — the D15 output contract.
 */
export type WorkerResult =
  | {
      readonly ok: true;
      readonly stream: ReadableStream<Uint8Array>;
      readonly attestation: ScanAttestation;
    }
  | {
      readonly ok: false;
      readonly kind: "scan-rejection";
      readonly code: "secret-detected";
      /** Plan §2.5 secret-scan exit code. */
      readonly exit: 3;
      readonly scannerRulesetVersion: number;
    }
  | {
      readonly ok: false;
      readonly kind: "normalization-rejection";
      readonly rejection: NormalizationRejection;
    };

/** A supported sandbox host id (`sandbox-contract.md §3`). */
export type SandboxHostId = "darwin-arm64" | "linux-x86_64" | "linux-arm64";

/** The per-guarantee names of `sandbox-contract.md §1`. */
export type SandboxGuarantee =
  | "no-network"
  | "empty-environment"
  | "isolated-filesystem"
  | "no-credential-access"
  | "no-inherited-fds"
  | "no-subprocess"
  | "syscall-restriction"
  | "resource-caps"
  | "scan-before-persist";

/** One capability probe result: is this guarantee's primitive available on this host? */
export interface SandboxCapabilityCheck {
  readonly guarantee: SandboxGuarantee;
  readonly available: boolean;
  /** The concrete primitive backing the guarantee (e.g. `seatbelt-default-deny`). */
  readonly primitive: string;
  /** Present when `available` is false — why the primitive is missing (doctor surfaces it). */
  readonly detail?: string;
}

/**
 * The startup capability report (`sandbox-contract.md §2`), surfaced by `doctor`.
 * `supported` is false if ANY required guarantee is unavailable — `runInSandbox`
 * then refuses to launch (fail closed) and nothing is parsed.
 */
export interface SandboxCapabilityReport {
  /** The detected host token, or the raw `os-arch` string when unsupported. */
  readonly host: string;
  /** True only when every REQUIRED guarantee's primitive is available on this host. */
  readonly supported: boolean;
  readonly checks: readonly SandboxCapabilityCheck[];
}
