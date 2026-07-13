/**
 * `@atlas/scan` shared types — the structural surface the leaf exposes to its
 * consumers (`@atlas/sources`, the `@atlas/broker` egress side, and `apps/cli`)
 * WITHOUT any of them importing each other or `apps/cli` (the D14 no-app-import
 * invariant — this package consumes ONLY `@atlas/contracts`).
 *
 * The one structural seam that matters here is {@link QuarantineSink}: the guards
 * require it at construction, and `apps/cli`'s quarantine store implements it, so
 * the leaf never back-edges into the app to persist quarantined bytes.
 */
import type { Sensitivity } from "@atlas/contracts";

/**
 * The persistence/transmission destinations a scanned byte-stream could reach.
 * Carried on a {@link SecretFinding}/{@link ScanContext} so a refusal names the
 * boundary it fired at. This is the enforcement surface of the safety spine — no
 * raw or normalized byte reaches any of these unscanned.
 */
export type PersistenceSink = "sqlite" | "worktree" | "git-object" | "lancedb" | "log" | "audit";

/**
 * Where a scan was invoked from. `boundary` distinguishes the two enforcement
 * points (raw/normalized bytes before persistence vs. the exact serialized form of
 * a model response / derived artifact). `origin` is an opaque, non-secret label
 * (a path, run id, or content id) used only for diagnostics + quarantine metadata.
 */
export interface ScanContext {
  /** Opaque, non-secret origin label (path / runId / contentId). Never a secret. */
  readonly origin: string;
  /** Which enforcement point invoked the scan. */
  readonly boundary: "pre-persistence" | "generated-artifact";
  /** Pre-persistence phase: the raw source bytes vs. the normalized output. */
  readonly kind?: "raw" | "normalized";
  /** Generated-artifact: the destination the artifact was about to reach. */
  readonly sink?: PersistenceSink;
  /**
   * The content's sensitivity class (the shared `@atlas/contracts` DTO). Carried
   * through so the egress-side generated-artifact boundary can pair a scan refusal
   * with the run's allowed-class enforcement (D19). Diagnostic only — it does NOT
   * change secret detection.
   */
  readonly sensitivity?: Sensitivity;
}

/** Finding severity. `high` = a matched credential shape; `medium` = an entropy/heuristic hit. */
export type FindingSeverity = "high" | "medium";

/**
 * One secret detection. Carries ONLY non-secret metadata: the rule that fired, a
 * byte/char range, and a redacted preview (never the raw match). The plaintext is
 * never copied into a finding — quarantine (AEAD, CLI-side) is the sole holder of
 * the actual bytes.
 */
export interface SecretFinding {
  /** Stable rule identifier from the versioned ruleset (e.g. `aws-access-key-id`). */
  readonly ruleId: string;
  /** Human-readable rule title. */
  readonly title: string;
  /** `high` for a matched credential shape; `medium` for an entropy heuristic. */
  readonly severity: FindingSeverity;
  /** Char offset (into the UTF-8-decoded text) where the match starts. */
  readonly startOffset: number;
  /** Char offset (exclusive) where the match ends. */
  readonly endOffset: number;
  /** A masked, non-reversible preview — NEVER the raw secret. */
  readonly redactedPreview: string;
  /** Shannon entropy (bits/char) of the matched token, when the rule is entropy-based. */
  readonly entropyBitsPerChar?: number;
}

/**
 * The scan result. Clean carries no findings; a dirty verdict carries the ordered,
 * de-duplicated findings. Both stamp the ruleset id + version so results are
 * reproducible (a deterministic, versioned ruleset — a change bumps the version).
 */
export type ScanVerdict =
  | { readonly clean: true; readonly rulesetId: string; readonly rulesetVersion: number }
  | {
      readonly clean: false;
      readonly rulesetId: string;
      readonly rulesetVersion: number;
      readonly findings: readonly SecretFinding[];
    };

/**
 * The structural quarantine seam (defined HERE, in the leaf). A guard requires one
 * at construction and calls it — BEFORE throwing — with the offending bytes so they
 * are captured (AEAD, ciphertext-only) rather than lost. `apps/cli`'s
 * `quarantine/store.ts` implements it; the leaf never imports the app.
 */
export interface QuarantineSink {
  /** Capture the offending bytes under `origin` with the findings that flagged them. */
  quarantine(input: {
    readonly bytes: Uint8Array;
    readonly origin: string;
    readonly findings: readonly SecretFinding[];
  }): Promise<void>;
}

/**
 * Thrown by a guard after the offending bytes have been quarantined. Its
 * `exitCode` is the plan §2.5 secret-scan code (3); the CLI boundary maps this to
 * process exit 3. Carries only non-secret finding metadata.
 */
export class SecretDetectedError extends Error {
  /** Plan §2.5 exit code for a secret-scan refusal. */
  readonly exitCode = 3 as const;
  /** The enforcement point that refused. */
  readonly boundary: ScanContext["boundary"];
  /** The opaque origin label of the refused write. */
  readonly origin: string;
  /** Non-secret finding metadata (rule ids, offsets, redacted previews). */
  readonly findings: readonly SecretFinding[];

  constructor(
    origin: string,
    findings: readonly SecretFinding[],
    boundary: ScanContext["boundary"],
  ) {
    const rules = findings.map((f) => f.ruleId).join(", ");
    super(
      `secret-scan refused the ${boundary} write for "${origin}": ` +
        `${findings.length} finding(s) [${rules}]`,
    );
    this.name = "SecretDetectedError";
    this.origin = origin;
    this.findings = findings;
    this.boundary = boundary;
  }
}
