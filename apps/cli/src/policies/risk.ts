/**
 * `policies.effectiveRisk` — the SINGLE deterministic producer of a ChangePlan's
 * risk tier (Task 4.3), part of the `policies` owner. Tier is derived from
 * `operation × target note type × scope × config` ONLY. The envelope's
 * proposer-advisory tier (a model-authored field) is deliberately never
 * consulted for control flow — a grep-guard test (`policies.test`) asserts no
 * module reads it, so a model can never talk its own change past the gate.
 *
 * This CLI value is advisory to the broker: before any protected-ref
 * advancement the broker independently re-derives risk from the candidate tree
 * and refuses/escalates on mismatch (`workflow-risk-contract.md` §tiers). Here
 * we compute the honest CLI-side tier that drives preview + the manifest.
 *
 * Tier is monotonic upward: any single Tier-3 trigger forces Tier-3 regardless
 * of the others. Only a genuinely auto-eligible op, within every threshold, on
 * trusted `valid`-evidence-grounded, single-note, non-destructive input, with
 * BOTH confidence inputs clearing the bound, earns Tier-2. Everything else is
 * Tier-3 (review-pending). `effectiveRisk` never returns Tier-1: that tier is
 * deterministic non-model capture, which is not a synthesis ChangePlan.
 */
import type { ChangePlan, RiskTier, NoteType } from "@atlas/contracts";
import { mutationPolicyFor } from "./mutation-policy.js";

/** The Tier-2 numeric bounds — read from `config.policies`, never hard-coded here. */
export interface RiskConfig {
  readonly minConfidence: number;
  readonly maxChangedLines: number;
  readonly maxSections: number;
}

/**
 * The deterministic scope inputs `effectiveRisk` needs that are NOT in the
 * ChangePlan envelope. Each is supplied by the pipeline (Task 4.5) from the
 * validator (4.4), trust ledger (4.8), and evidence verification (4.7).
 */
export interface PolicyContext {
  /** The target note's type (drives the mutation-policy cell). */
  readonly targetType: NoteType;
  /** Patch size in changed lines. */
  readonly changedLines: number;
  /** Number of distinct sections the change touches. */
  readonly sections: number;
  /** Whether the change is confined to a single note. */
  readonly singleNote: boolean;
  /** Whether the change removes/replaces existing content (destructive class). */
  readonly destructive: boolean;
  /** Whether every contributing source is trusted (Task 4.8). `false` ⇒ Tier-3. */
  readonly inputsTrusted: boolean;
  /** Whether every anchored evidence item is `valid` (Task 4.7). `false` ⇒ Tier-3. */
  readonly evidenceValid: boolean;
  /**
   * The validator's confidence (Task 4.4). Combined with the model's confidence
   * (envelope) under a min-reduction; a missing/malformed value is fail-closed.
   */
  readonly validationConfidence?: number;
  /** The Tier-2 bounds from `config.policies`. */
  readonly config: RiskConfig;
}

/** A confidence input is usable only if it is a finite number in `[0, 1]`. */
function inBand(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Compute the effective risk tier for a proposed change. Returns `tier-2` only
 * when every auto-commit condition holds; otherwise `tier-3`.
 */
export function effectiveRisk(plan: ChangePlan, ctx: PolicyContext): RiskTier {
  // Policy cell: only `auto`/`append-only` can EVER auto-commit. `review` is
  // always-Tier-3; `immutable`/`reserved` are policy violations validation
  // rejects — here they simply cannot grant Tier-2.
  const cell = mutationPolicyFor(ctx.targetType)[plan.operation.op];
  if (cell !== "auto" && cell !== "append-only") return "tier-3";

  // Fail-closed two-input confidence: min(model, validation) ≥ minConfidence,
  // and any missing/malformed input forces Tier-3.
  const modelConfidence = plan.confidence;
  if (!inBand(modelConfidence) || !inBand(ctx.validationConfidence)) return "tier-3";
  if (Math.min(modelConfidence, ctx.validationConfidence) < ctx.config.minConfidence) return "tier-3";

  // Structural + provenance escalations (each independently forces Tier-3).
  if (!ctx.singleNote) return "tier-3";
  if (ctx.destructive) return "tier-3";
  if (!ctx.inputsTrusted) return "tier-3";
  if (!ctx.evidenceValid) return "tier-3";
  if (ctx.changedLines > ctx.config.maxChangedLines) return "tier-3";
  if (ctx.sections > ctx.config.maxSections) return "tier-3";

  return "tier-2";
}

/** Build a {@link RiskConfig} from the resolved `config.policies` block. */
export function riskConfigFrom(policies: {
  readonly tier2_min_confidence: number;
  readonly tier2_max_changed_lines: number;
  readonly tier2_max_sections: number;
}): RiskConfig {
  return {
    minConfidence: policies.tier2_min_confidence,
    maxChangedLines: policies.tier2_max_changed_lines,
    maxSections: policies.tier2_max_sections,
  };
}
