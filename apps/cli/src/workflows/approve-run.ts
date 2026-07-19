/**
 * `workflows/approve-run` — the `git approve` / `git reject` execution (Task 4.9). Approve
 * FF-integrates the EXACT commit a reviewer authorized onto canonical; it never rebases. It
 * reuses the 2.5 engine's `integrate` seam (a review-pending run is `review-pending → integrated`
 * in the recovery machine), so approving a Tier-3 run runs the SAME broker-CAS + audit path the
 * Tier-2 auto-commit does — the only difference is the operator authorization that triggers it.
 *
 * The precondition decision ({@link decideApprove}) is applied FIRST: a moved base is a stable
 * `refresh-required` (approve never rebases), an already-integrated run is idempotent, and only a
 * genuinely review-pending run at an unmoved base reaches the broker advance. The broker itself
 * re-verifies the authorization + audit-event binding + FF-only CAS (Task 1.6) — a forged or
 * mismatched authorization is refused there, before canonical moves.
 */
import type { AuditBroker, LedgerBackupConfig, Store } from "@atlas/sqlite-store";
import type { Repo } from "@atlas/git";
import { startRun, type IntegratedResult, type RunIntegrator, type WorkflowDeps } from "./index.js";
import { readAgentRunStatus, readGitOp } from "./checkpoints.js";
import { CliError, EXIT } from "../errors/envelope.js";
import { decideApprove, canReject } from "./approve.js";

const ZERO_OID = "0".repeat(40);

function rfc3339MsNow(): string {
  return new Date().toISOString();
}

/** The mutation seams `approveRun`/`rejectRun` drive. */
export interface ApproveDeps {
  readonly store: Store;
  readonly broker: AuditBroker;
  readonly backup: LedgerBackupConfig;
  readonly repo: Repo;
  /** The broker-authorized canonical-install seam (carries the reviewer authorization). */
  readonly integrate: RunIntegrator;
  /** Re-derive projections from the immutable canonical commit (post-integration). */
  foldProjections(canonicalRef: string): Promise<void>;
  /** The canonical protected ref (config `git.canonical_ref`, threaded by the caller). */
  readonly canonicalRef: string;
  readonly now?: () => string;
}

/** The outcome of an approve attempt. */
export type ApproveOutcome =
  | { readonly mode: "integrated"; readonly runId: string; readonly canonicalSha: string }
  | { readonly mode: "already-approved"; readonly runId: string; readonly canonicalSha: string }
  | { readonly mode: "refresh-required"; readonly runId: string; readonly recordedBase: string; readonly currentCanonical: string };

/** An approve/reject failure the CLI maps to an exit code. */
export class ApproveError extends CliError {}

function runOperation(store: Store, runId: string): string {
  const row = store.db.prepare(`SELECT operation FROM agent_runs WHERE run_id = ?`).get(runId) as { operation: string } | undefined;
  if (!row) throw new ApproveError({ code: "approve-run-unknown", message: `run ${runId} does not exist`, hint: "Check the run id.", exitCode: EXIT.VALIDATION });
  return row.operation;
}

/**
 * Approve a review-pending run: FF-integrate its exact reviewed commit onto canonical (via the
 * broker-authorized `integrate` seam), then reindex + finalize. Applies {@link decideApprove}
 * first — a moved base returns `refresh-required` (exit 6; approve NEVER rebases), an
 * already-integrated run returns idempotently.
 */
export async function approveRun(runId: string, deps: ApproveDeps): Promise<ApproveOutcome> {
  const now = deps.now ?? rfc3339MsNow;
  const canonicalRef = deps.canonicalRef;
  const db = deps.store.db;

  const state = readAgentRunStatus(db, runId);
  const committed = readGitOp(db, runId, "agent-committed");
  const base = readGitOp(db, runId, "base");
  const integrated = readGitOp(db, runId, "integrated");
  const currentCanonical = (await deps.repo.readRef(canonicalRef)) ?? ZERO_OID;

  const decision = decideApprove({
    state,
    reviewPendingCommit: committed?.commitSha ?? "",
    recordedBase: base?.commitSha ?? ZERO_OID,
    currentCanonical,
    ...(integrated?.commitSha ? { integratedSha: integrated.commitSha } : {}),
  });

  if (decision.kind === "already-approved") {
    return { mode: "already-approved", runId, canonicalSha: decision.canonicalSha };
  }
  if (decision.kind === "refresh-required") {
    return { mode: "refresh-required", runId, recordedBase: decision.recordedBase, currentCanonical: decision.currentCanonical };
  }
  if (decision.kind === "not-review-pending") {
    throw new ApproveError({
      code: "approve-not-review-pending",
      message: `run ${runId} is at ${state ?? "<unknown>"}, not review-pending; only a run at the review gate can be approved`,
      hint: "Approve applies to a Tier-3 run awaiting review.",
      exitCode: EXIT.VALIDATION,
    });
  }

  // Resume the review-pending run and FF-integrate its exact reviewed commit.
  const wdeps: WorkflowDeps = { store: deps.store, broker: deps.broker, backup: deps.backup, repo: deps.repo, now };
  const handle = await startRun(wdeps, { operation: runOperation(deps.store, runId), runId, resume: true, canonicalCommit: base?.commitSha ?? ZERO_OID });
  const result: IntegratedResult = await handle.integrate(deps.integrate);
  await deps.foldProjections(canonicalRef);
  await handle.checkpoint("reindexed", { indexGeneration: 1, canonicalSha: result.canonicalSha });
  await handle.finalize();
  return { mode: "integrated", runId, canonicalSha: result.canonicalSha };
}

/**
 * Reject a review-pending run at review (terminal `rejected`, `run.rejected`). Refuses a run
 * not at the review gate. The agent branch/worktree cleanup rides the engine's terminate path.
 */
export async function rejectRun(runId: string, reason: string, deps: ApproveDeps): Promise<{ runId: string; state: "rejected" }> {
  const now = deps.now ?? rfc3339MsNow;
  const state = readAgentRunStatus(deps.store.db, runId);
  if (!canReject(state)) {
    throw new ApproveError({
      code: "reject-not-review-pending",
      message: `run ${runId} is at ${state ?? "<unknown>"}, not review-pending; only a run at the review gate can be rejected`,
      hint: "Reject applies to a Tier-3 run awaiting review.",
      exitCode: EXIT.VALIDATION,
    });
  }
  const base = readGitOp(deps.store.db, runId, "base");
  const wdeps: WorkflowDeps = { store: deps.store, broker: deps.broker, backup: deps.backup, repo: deps.repo, now };
  const handle = await startRun(wdeps, { operation: runOperation(deps.store, runId), runId, resume: true, canonicalCommit: base?.commitSha ?? ZERO_OID });
  await handle.reject(reason);
  return { runId, state: "rejected" };
}
