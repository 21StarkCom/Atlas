/**
 * `workflows/rollback-run` — the rollback EXECUTION (Task 4.9), building on the merged
 * {@link classifyRollback}. A rollback is a DISTINCT operator-initiated run (`rolled-back`
 * terminal) that reverts a previously-integrated run WITHOUT re-opening it — the reverted run
 * stays finalized, and the reverting run links to it via `rollbackOf` (recovery-state-machine.md).
 *
 * Flow: classify → (has-dependents ⇒ REFUSE, listing the dependents + pointing at the
 * compensating-ChangePlan path) → produce the deterministic revert → install it onto canonical
 * under the broker's `run.rolled_back` advance → record the `rolled-back` run + reconcile. The
 * revert-derivation + broker install are injected seams (the broker owns the canonical-installing
 * `run.rolled_back` advance, Task 1.6); this module owns the safety-critical orchestration:
 * refuse-on-dependents FIRST, one rollback run per revert, mandatory reconciliation.
 */
import { newRunId } from "@atlas/contracts";
import type { Store } from "@atlas/sqlite-store";
import { classifyRollback, type RollbackClass, type RunToRollback } from "./rollback.js";
import { CliError } from "../errors/envelope.js";

function rfc3339MsNow(): string {
  return new Date().toISOString();
}

/** The seams rollback execution drives (dependency enumeration + the deep git/broker steps). */
export interface RollbackDeps {
  readonly store: Store;
  /** Enumerate downstream dependents of the target run (empty ⇒ safe to roll back). */
  dependentsOf(run: RunToRollback): readonly string[];
  /**
   * Produce the deterministic revert for the target's integrated commit — a revert commit on a
   * fresh agent branch (self-contained), or the rendition/capture tombstone (capture-only).
   * Returns the commit to install (null for a pure projection tombstone) + the canonical base.
   */
  produceRevert(args: { rollbackRunId: string; target: RunToRollback; rollbackClass: RollbackClass }): Promise<{ revertCommit: string | null; base: string }>;
  /** Install the revert onto canonical under the broker `run.rolled_back` advance; returns the new sha. */
  installRevert(args: { rollbackRunId: string; revertCommit: string; base: string }): Promise<{ canonicalSha: string }>;
  /** Re-derive projections after the revert (mandatory reconciliation). */
  reconcile(): Promise<void>;
  readonly now?: () => string;
}

/** The outcome of a rollback attempt. */
export type RollbackOutcome =
  | {
      readonly mode: "rolled-back";
      readonly rollbackRunId: string;
      readonly rollbackOf: string;
      readonly rollbackClass: RollbackClass;
      /** The installed revert commit, or null for a capture-only projection tombstone. */
      readonly revertCommit: string | null;
      readonly canonicalSha: string | null;
      readonly reconciled: true;
    }
  | { readonly mode: "refused"; readonly reason: "has-dependents"; readonly dependents: readonly string[] };

/** A rollback failure the CLI maps to an exit code. */
export class RollbackError extends CliError {}

/**
 * Execute a rollback of `target` (spec §rollback). Refuses FIRST if anything depends on the run
 * (`has-dependents`, exit 1) — a cited rendition is never silently reverted out from under live
 * evidence. Otherwise produces the revert (self-contained commit revert / capture-only tombstone),
 * installs it under the broker `run.rolled_back` advance, records the DISTINCT `rolled-back`
 * rollback run linked via `rollbackOf`, and runs the mandatory post-revert reconciliation.
 */
export async function rollbackRun(target: RunToRollback, deps: RollbackDeps): Promise<RollbackOutcome> {
  const now = deps.now ?? rfc3339MsNow;
  const classification = classifyRollback(target, { dependentsOf: deps.dependentsOf });
  if (classification.kind === "has-dependents") {
    return { mode: "refused", reason: "has-dependents", dependents: classification.dependents };
  }

  const rollbackRunId = newRunId();
  const { revertCommit, base } = await deps.produceRevert({ rollbackRunId, target, rollbackClass: classification.rollbackClass });

  let canonicalSha: string | null = null;
  if (revertCommit !== null) {
    const installed = await deps.installRevert({ rollbackRunId, revertCommit, base });
    canonicalSha = installed.canonicalSha;
  }

  // Record the DISTINCT rollback run (`rolled-back`), linked to the reverted run. The reverted
  // run is NOT touched — it stays finalized (spec §rollback).
  deps.store.ledger.upsertAgentRun({
    run_id: rollbackRunId,
    operation: "rollback",
    status: "rolled-back",
    tier: null,
    started_at: now(),
    updated_at: now(),
  });

  // Mandatory reconciliation after the revert (an exit-0 rollback ALWAYS reflects a completed one).
  await deps.reconcile();

  return {
    mode: "rolled-back",
    rollbackRunId,
    rollbackOf: target.runId,
    rollbackClass: classification.rollbackClass,
    revertCommit,
    canonicalSha,
    reconciled: true,
  };
}
