/**
 * `workflows/approve` — the approve/reject decision core for the Tier-3 review gate
 * (Task 4.9). `git approve` FF-integrates the EXACT commit a reviewer signed; it never
 * rebases. This module is the pure precondition logic the broker-authorized command
 * consults (the command adds the challenge/authorization round-trip + the broker FF-CAS):
 *
 *  - the review-pending commit's recorded base must still be the current canonical tip —
 *    a moved base is a stable `refresh-required` (exit 6): the operator runs `git refresh`
 *    (Task 4.5) and re-approves; approve NEVER rebases the signed commit;
 *  - an already-integrated run re-approves idempotently (returns the installed sha);
 *  - only a genuinely review-pending run at an unmoved base is approvable — the broker then
 *    FF-CASes the exact signed commit onto canonical.
 */
import type { WorkflowState } from "@atlas/contracts";

/** The verdict for an approve attempt. */
export type ApproveDecision =
  /** Approvable: FF-CAS `commitSha` onto canonical (expected old = `expectedBase`). */
  | { readonly kind: "approve"; readonly commitSha: string; readonly expectedBase: string }
  /** The base moved since the commit was signed — refresh + re-approve (exit 6). Never rebases. */
  | { readonly kind: "refresh-required"; readonly recordedBase: string; readonly currentCanonical: string }
  /** Idempotent: the run already integrated this commit. */
  | { readonly kind: "already-approved"; readonly canonicalSha: string }
  /** Not in the review gate (nothing to approve). */
  | { readonly kind: "not-review-pending"; readonly state: WorkflowState | null };

/** The durable facts an approve decision reads about a run. */
export interface ApproveInput {
  readonly state: WorkflowState | null;
  /** The agent commit recorded at review-pending (the exact commit the reviewer signs). */
  readonly reviewPendingCommit: string;
  /** The canonical base the run branched from (the FF old-value). */
  readonly recordedBase: string;
  /** The CURRENT canonical tip (observed now). */
  readonly currentCanonical: string;
  /** Present iff the run already integrated (idempotent re-approve). */
  readonly integratedSha?: string;
}

/**
 * Decide an approve attempt (spec §Tier-3 review). Idempotency FIRST (an already-integrated
 * run returns its installed sha), then the review-gate check, then the stale-base check
 * (moved base ⇒ `refresh-required`, never a rebase), else `approve` the exact signed commit
 * under FF-CAS from the unmoved base.
 */
export function decideApprove(input: ApproveInput): ApproveDecision {
  if (input.integratedSha !== undefined) {
    return { kind: "already-approved", canonicalSha: input.integratedSha };
  }
  if (input.state !== "review-pending") {
    return { kind: "not-review-pending", state: input.state };
  }
  if (input.currentCanonical !== input.recordedBase) {
    return { kind: "refresh-required", recordedBase: input.recordedBase, currentCanonical: input.currentCanonical };
  }
  return { kind: "approve", commitSha: input.reviewPendingCommit, expectedBase: input.recordedBase };
}

/** Whether a run may be rejected (only a review-pending run is at the gate). */
export function canReject(state: WorkflowState | null): boolean {
  return state === "review-pending";
}
