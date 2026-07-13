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
 *     describing the outcome (clean + attestation + represented gaps, scan-rejection, or
 *     normalization-rejection). fd 2 carries only diagnostics.
 *
 * Two payloads travel on the control channel besides the outcome discriminator:
 *   - CLEAN carries the deterministic {@link RepresentedGap} list the normalizer produced
 *     (e.g. HTML `image-no-alt` / `image-decorative` records) — these are metadata, NOT
 *     document bytes, so they ride the control message rather than fd 1 (wing round-2
 *     finding 2: the gap records must survive the sandbox path, not be discarded).
 *   - SCAN-REJECTION optionally carries the offending NORMALIZED bytes (base64) so the
 *     trusted-side `PrePersistenceGuard` can QUARANTINE the exact decoded content that
 *     flagged the refusal. These bytes were scanned (found dirty) INSIDE the sandbox and
 *     travel ONLY to the trusted quarantine store (AEAD, ciphertext-only) — never to fd 1
 *     and never to any real sink — so the scan-before-persist invariant holds (fd 1 stays
 *     empty on a hit; see `scan-before-persist.test`). The payload is bounded by
 *     {@link MAX_QUARANTINE_CONTROL_BYTES}: an output within the bound ships whole; a
 *     LARGER dirty output ships a bounded WINDOW around the match (still under the bound)
 *     rather than omitting the payload — so quarantine always happens and the channel is
 *     never overflowed (wing round-3 finding 5).
 *
 * The worker NEVER writes normalized bytes to any file — the scan-before-persist
 * invariant (D15) is that output exists only in memory until it has been scanned and
 * then released through the pipe.
 */
import type { RepresentedGap } from "@atlas/contracts";
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

/**
 * Max bytes of offending normalized output the worker may carry (base64) on a
 * scan-rejection for trusted-side quarantine. Well under the launcher's control-channel
 * cap (base64 inflates ~4/3, so 1 MiB → ~1.33 MiB, comfortably below CONTROL_BYTE_CAP).
 * An output within the bound ships whole; a larger dirty output ships a bounded WINDOW
 * around the match sized to this bound (wing round-3 finding 5) — so the exact decoded
 * secret still reaches quarantine without overflowing the channel.
 */
export const MAX_QUARANTINE_CONTROL_BYTES = 1024 * 1024; // 1 MiB

/** The single control message the worker emits on {@link CONTROL_FD}. */
export type WorkerControl =
  | {
      readonly kind: "clean";
      readonly attestation: ScanAttestation;
      /** Deterministic gap records the normalizer produced (metadata, not document bytes). */
      readonly gaps: readonly RepresentedGap[];
    }
  | {
      readonly kind: "scan-rejection";
      readonly code: "secret-detected";
      readonly scannerRulesetVersion: number;
      /** Base64 of the offending normalized bytes for trusted-side quarantine (bounded; optional). */
      readonly quarantineB64?: string;
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

/**
 * The exhaustive represented-gap kind set the Phase-2 normalizers produce (`media.ts` /
 * `normalization-contract.md §4`). Validated here so a compromised worker cannot smuggle
 * an arbitrary `kind`/`note` blob into the rendition through the control channel.
 */
const GAP_KINDS: ReadonlySet<string> = new Set<string>(["image-no-alt", "image-decorative"]);

/** `sha256:` + 64 lowercase hex — the exact attestation digest shape. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Standard base64 (with optional `=` padding) — the quarantine payload shape. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** A finite, non-negative, safe integer (a byte count or version). */
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Strictly validate the `gaps` array of a `clean` control message. Every entry must be a
 * known-kind record with an optional string `locator`/`note`; anything off-shape throws
 * so a rendition is never assembled from an untrusted gap blob. Order is preserved (the
 * normalizer emits gaps deterministically in document order).
 */
function parseGaps(v: unknown): RepresentedGap[] {
  // Finding 6: a clean message MUST carry an explicit `gaps` array — an omitted `gaps` is
  // rejected, never silently coerced to `[]`. Coercing omission to empty turned MISSING
  // media-gap metadata (a normalizer that failed to attach its gaps) into a faithful-looking
  // success; the normalizer always emits an explicit array (empty when there are genuinely no
  // gaps), so requiring one distinguishes "no gaps" from "gaps dropped".
  if (!Array.isArray(v)) throw new Error("clean control: gaps must be an explicit array");
  return v.map((g, i) => {
    if (!isRecord(g)) throw new Error(`clean control: gap[${i}] is not an object`);
    if (typeof g.kind !== "string" || !GAP_KINDS.has(g.kind)) {
      throw new Error(`clean control: gap[${i}] has unknown kind ${JSON.stringify(g.kind)}`);
    }
    if (g.locator !== undefined && typeof g.locator !== "string") throw new Error(`clean control: gap[${i}].locator must be a string`);
    if (g.note !== undefined && typeof g.note !== "string") throw new Error(`clean control: gap[${i}].note must be a string`);
    return {
      kind: g.kind,
      ...(g.locator !== undefined ? { locator: g.locator } : {}),
      ...(g.note !== undefined ? { note: g.note } : {}),
    };
  });
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
      return { kind: "clean", attestation, gaps: parseGaps(v.gaps) };
    }
    case "scan-rejection": {
      if (v.code !== "secret-detected") throw new Error("scan-rejection: code must be `secret-detected`");
      if (!isCount(v.scannerRulesetVersion)) throw new Error("scan-rejection: scannerRulesetVersion is not a count");
      if (v.quarantineB64 !== undefined && (typeof v.quarantineB64 !== "string" || !BASE64_RE.test(v.quarantineB64))) {
        throw new Error("scan-rejection: quarantineB64 must be a base64 string when present");
      }
      return {
        kind: "scan-rejection",
        code: "secret-detected",
        scannerRulesetVersion: v.scannerRulesetVersion,
        ...(v.quarantineB64 !== undefined ? { quarantineB64: v.quarantineB64 } : {}),
      };
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
