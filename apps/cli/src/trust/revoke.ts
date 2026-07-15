/**
 * `trust/revoke` — revocation semantics (Task 4.8). When a source's trust is revoked,
 * every run derived from it must be neutralized, and the effect depends on how far the run
 * got (design §Trust revocation):
 *
 *  - a run that has NOT yet installed to canonical (planned…review-pending) ⇒ fail it at
 *    its current checkpoint with reason `trust-revoked` (nothing durable was integrated);
 *  - a run that HAS integrated (integrated/reindexed/finalized) ⇒ the canonical commit
 *    cannot simply be failed, so a Tier-3 REMEDIATION run is spawned referencing the
 *    revoked source + the affected run for operator review (revert/quarantine).
 *
 * Revocation NEVER launders: a revoked source's derived artifacts do not silently stay.
 */
import { enqueue, type JobId, type LedgerTx } from "@atlas/jobs";
import type { WorkflowState } from "@atlas/contracts";

/** The workflow name trust-remediation jobs are enqueued under. */
export const REMEDIATION_WORKFLOW = "trust-remediation";

/** The effect a revocation has on a derived run, keyed by how far the run progressed. */
export type RevocationEffect =
  | { readonly kind: "fail"; readonly checkpoint: WorkflowState; readonly reason: "trust-revoked" }
  | { readonly kind: "remediate" };

/** The run states past which a run has installed to canonical (a revoke cannot just fail it). */
const INTEGRATED_STATES: ReadonlySet<WorkflowState> = new Set(["integrated", "reindexed", "finalized"]);

/**
 * Classify a revocation's effect on a run at `runState`. A pre-integration run is failed
 * at its checkpoint (`trust-revoked`); an integrated run must be remediated (spawn a
 * Tier-3 remediation run). Terminal non-integrated states (failed/cancelled/rejected) need
 * no action — they never installed — and are reported as a no-op `fail` at that state.
 */
export function revocationEffect(runState: WorkflowState): RevocationEffect {
  if (INTEGRATED_STATES.has(runState)) return { kind: "remediate" };
  return { kind: "fail", checkpoint: runState, reason: "trust-revoked" };
}

/** The durable payload of a trust-remediation job (allowlisted, hash-verified). */
export interface RemediationJobPayload {
  readonly revokedSourceHandle: string;
  readonly affectedRunId: string;
}

/**
 * Spawn the Tier-3 remediation work for an INTEGRATED run whose source was revoked:
 * enqueue a `trust-remediation` job (idempotent on `(revokedSource, affectedRun)`)
 * referencing the revoked source + affected run. The reviewer-facing remediation run
 * (revert/quarantine ChangePlan) is driven from this job by the workflow commands
 * (Task 4.11); this returns the durable remediation task id.
 */
export function spawnRemediationRun(tx: LedgerTx, revokedSourceHandle: string, affectedRunId: string): JobId {
  const payload: RemediationJobPayload = { revokedSourceHandle, affectedRunId };
  return enqueue(tx, {
    workflow: REMEDIATION_WORKFLOW,
    idempotencyKey: `${revokedSourceHandle}::${affectedRunId}`,
    payload,
  });
}
