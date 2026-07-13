/**
 * The launcher ⇄ worker wire protocol.
 *
 * The worker is a dedicated low-privilege process. Because the sandbox spawns it
 * with an ALLOWLISTED EMPTY ENVIRONMENT (`sandbox-contract.md §1 empty-environment`)
 * the request cannot travel through env vars, and because output must leave ONLY via
 * the attested pipe (D15) it cannot travel through a shared output directory. So:
 *
 *   - the launcher passes the {@link WorkerRequest} as a single argv JSON string
 *     (non-secret metadata only: the input path, declared format, and caps);
 *   - the worker reads the source bytes from the read-only input handle it was given;
 *   - the CLEAN normalized bytes leave on **fd 1** (the output pipe) and NOTHING else
 *     is written there;
 *   - a single {@link WorkerControl} JSON message leaves on **fd 3** (the result pipe)
 *     describing the outcome (clean + attestation, scan-rejection, or
 *     normalization-rejection). fd 2 carries only diagnostics.
 *
 * The worker NEVER writes normalized bytes to any file — the scan-before-persist
 * invariant (D15) is that output exists only in memory until it has been scanned and
 * then released through the pipe.
 */
import type { NormalizationRejection, NormalizationRejectionCode, ScanAttestation } from "../types.js";
import type { SourceFormat } from "../formats.js";
import { SOURCE_FORMATS } from "../formats.js";

/** fd the worker writes the clean normalized byte stream to (the output pipe). */
export const OUTPUT_FD = 1 as const;
/** fd the worker writes the single {@link WorkerControl} JSON message to (result pipe). */
export const CONTROL_FD = 3 as const;

/** The request the launcher hands the worker (argv JSON — non-secret metadata only). */
export interface WorkerRequest {
  /** Absolute path of the read-only input handle inside the sandbox. */
  readonly inputPath: string;
  /** The declared source format (signature-validated by the worker before parse). */
  readonly format: SourceFormat;
  /** The worker-private disposable temp dir (the only path it may write). */
  readonly workTmp: string;
  /** Byte ceiling the worker must not exceed on the output pipe. */
  readonly maxOutputBytes: number;
}

/** The single control message the worker emits on {@link CONTROL_FD}. */
export type WorkerControl =
  | {
      readonly kind: "clean";
      readonly attestation: ScanAttestation;
    }
  | {
      readonly kind: "scan-rejection";
      readonly code: "secret-detected";
      readonly scannerRulesetVersion: number;
    }
  | {
      readonly kind: "normalization-rejection";
      readonly rejection: NormalizationRejection;
    }
  | {
      /** The worker hit an unexpected internal error (surfaced as exit 4 by the launcher). */
      readonly kind: "worker-error";
      readonly message: string;
    };

/** The exhaustive normalization-rejection code set (`normalization-contract.md §2`). */
const REJECTION_CODES: ReadonlySet<string> = new Set<NormalizationRejectionCode>([
  "unsupported-encoding",
  "encrypted-source",
  "no-extractable-text",
  "signature-mismatch",
  "too-large",
  "partial-extraction",
]);

const FORMATS: ReadonlySet<string> = new Set<string>(SOURCE_FORMATS);

/** `sha256:` + 64 lowercase hex — the exact attestation digest shape. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** A finite, non-negative, safe integer (a byte count or version). */
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Parse + STRICTLY validate a control message received off {@link CONTROL_FD} (wing
 * round-2 finding: a message was accepted on `kind` alone, so a malformed `clean`
 * attestation could reach the digest gate as `undefined`). Every field of every kind
 * is validated here; anything off-shape throws, so the launcher treats it as a worker
 * failure and NEVER exposes output built from an untrusted control blob.
 */
export function parseWorkerControl(raw: string): WorkerControl {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new Error(`worker control is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(v)) throw new Error("worker control is not a JSON object");

  switch (v.kind) {
    case "clean": {
      const a = v.attestation;
      if (!isRecord(a)) throw new Error("clean control missing an attestation object");
      if (!isCount(a.scannerRulesetVersion)) throw new Error("clean attestation: scannerRulesetVersion is not a count");
      if (!isCount(a.scannedBytes)) throw new Error("clean attestation: scannedBytes is not a count");
      if (a.clean !== true) throw new Error("clean attestation: `clean` must be exactly true");
      if (typeof a.outputDigest !== "string" || !DIGEST_RE.test(a.outputDigest)) {
        throw new Error("clean attestation: outputDigest is not a sha256:<64hex> string");
      }
      const attestation: ScanAttestation = {
        scannerRulesetVersion: a.scannerRulesetVersion,
        scannedBytes: a.scannedBytes,
        clean: true,
        outputDigest: a.outputDigest,
      };
      return { kind: "clean", attestation };
    }
    case "scan-rejection": {
      if (v.code !== "secret-detected") throw new Error("scan-rejection: code must be `secret-detected`");
      if (!isCount(v.scannerRulesetVersion)) throw new Error("scan-rejection: scannerRulesetVersion is not a count");
      return { kind: "scan-rejection", code: "secret-detected", scannerRulesetVersion: v.scannerRulesetVersion };
    }
    case "normalization-rejection": {
      const r = v.rejection;
      if (!isRecord(r)) throw new Error("normalization-rejection missing a rejection object");
      if (typeof r.code !== "string" || !REJECTION_CODES.has(r.code)) {
        throw new Error(`normalization-rejection: unknown code ${JSON.stringify(r.code)}`);
      }
      if (typeof r.format !== "string" || !FORMATS.has(r.format)) {
        throw new Error(`normalization-rejection: unknown format ${JSON.stringify(r.format)}`);
      }
      if (r.detail !== undefined && typeof r.detail !== "string") {
        throw new Error("normalization-rejection: detail must be a string when present");
      }
      const rejection: NormalizationRejection = {
        code: r.code as NormalizationRejectionCode,
        format: r.format as SourceFormat,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
      };
      return { kind: "normalization-rejection", rejection };
    }
    case "worker-error": {
      if (typeof v.message !== "string") throw new Error("worker-error: message must be a string");
      return { kind: "worker-error", message: v.message };
    }
    default:
      throw new Error(`worker emitted an unrecognized control kind: ${JSON.stringify(v.kind)}`);
  }
}
