/**
 * ChangePlan ENVELOPE schema (Task 1.1, fixes R2-F1/R3-F1). This is the stable
 * cross-cutting wrapper every proposed change carries; the per-operation
 * payload schemas (`ChangePlanSchema` union) are Phase-2's gate and are
 * deliberately NOT defined here.
 */
import { z } from "zod";

/** Risk tier a change proposes (Tier-2 auto-commit vs Tier-3 review, plan §2.5). */
export const RISK_TIERS = ["tier-1", "tier-2", "tier-3"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** Reversibility class of a proposed change. */
export const REVERSIBILITY = ["reversible", "conditional", "irreversible"] as const;
export type Reversibility = (typeof REVERSIBILITY)[number];

/**
 * The ChangePlan envelope. Per-op specifics live in a Phase-2 `operation`
 * payload; the envelope only fixes the fields common to every change.
 */
export const ChangePlanEnvelopeSchema = z.object({
  /** The note/entity the change targets (natural identifier). */
  target: z.string().min(1),
  /** Human/agent rationale for the change. */
  rationale: z.string(),
  /** Serialized source handles backing the change (D3 `parseSourceHandle` inputs). */
  sourceIds: z.array(z.string()),
  /** Evidence refs retrieved to justify the change. */
  retrievedEvidence: z.array(z.string()),
  /** Model/agent confidence in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** The tier the proposer believes this change warrants. */
  proposedRisk: z.enum(RISK_TIERS),
  /** Reversibility classification. */
  reversibility: z.enum(REVERSIBILITY),
  /** Optional idempotency key for key-accepting commands. */
  idempotencyKey: z.string().min(1).optional(),
});

export type ChangePlanEnvelope = z.infer<typeof ChangePlanEnvelopeSchema>;
