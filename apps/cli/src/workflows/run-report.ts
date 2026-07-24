/**
 * `workflows/run-report` — `assembleRunReport`, the read-only projection of a
 * run's durable ledger state into a single report object (Task 2.5). Consumed by
 * capture (Phase 2) and synthesis (Phase 4) to surface a run's outcome without
 * re-deriving it from the individual ledger tables. Pure reads — never mutates.
 */
import type { Store } from "@atlas/sqlite-store";
import type { WorkflowState } from "@atlas/contracts";
import { gitOpId } from "./checkpoints.js";

/** A run's assembled report. */
export interface RunReport {
  readonly runId: string;
  /** `agent_runs.operation` (ingest|enrich|reconcile|maintain|…). */
  readonly operation: string;
  /** Current `agent_runs.status`. */
  readonly state: WorkflowState;
  /** For a terminated run, the checkpoint it terminated from (`failed@<checkpoint>`). */
  readonly failedCheckpoint: string | null;
  readonly tier: number | null;
  readonly targetNoteId: string | null;
  /** Monotonic per-run checkpoint counter (how many transitions committed). */
  readonly checkpointSeq: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  /** The gating hashes/shas recorded along the run's path. */
  readonly artifacts: RunArtifacts;
  /** `true` when `state` is a terminal (`agent_runs` sink). */
  readonly terminal: boolean;
}

/** The gating artifacts recorded across a run's checkpoints. */
export interface RunArtifacts {
  readonly planHash: string | null;
  readonly patchHash: string | null;
  readonly baseRef: string | null;
  readonly canonicalRef: string | null;
  readonly worktreePath: string | null;
  readonly treeHash: string | null;
  readonly commitSha: string | null;
  readonly canonicalSha: string | null;
  readonly indexGeneration: number | null;
}

const TERMINALS: ReadonlySet<string> = new Set([
  "finalized",
  "rejected",
  "rolled-back",
  "failed",
  "cancelled",
]);

/** Assemble the {@link RunReport} for `runId`, or `undefined` if no such run. */
export function assembleRunReport(store: Store, runId: string): RunReport | undefined {
  const db = store.db;
  const run = db
    .prepare(
      `SELECT run_id, operation, status, failed_checkpoint, checkpoint_seq, target_note_id, tier,
              started_at, updated_at, finished_at
         FROM agent_runs WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        run_id: string;
        operation: string;
        status: WorkflowState;
        failed_checkpoint: string | null;
        checkpoint_seq: number;
        target_note_id: string | null;
        tier: number | null;
        started_at: string;
        updated_at: string;
        finished_at: string | null;
      }
    | undefined;
  if (run === undefined) return undefined;

  const plan = db.prepare(`SELECT plan_hash FROM change_plans WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId) as
    | { plan_hash: string }
    | undefined;
  const patch = db
    .prepare(
      `SELECT p.patch_hash AS patch_hash FROM patches p
         JOIN change_plans c ON c.plan_id = p.plan_id
        WHERE c.run_id = ? ORDER BY p.created_at DESC LIMIT 1`,
    )
    .get(runId) as { patch_hash: string } | undefined;

  const gitOp = (opType: Parameters<typeof gitOpId>[1]): { ref_name: string; commit_sha: string | null } | undefined =>
    db.prepare(`SELECT ref_name, commit_sha FROM git_operations WHERE git_op_id = ?`).get(gitOpId(runId, opType)) as
      | { ref_name: string; commit_sha: string | null }
      | undefined;

  const base = gitOp("base");
  const wt = gitOp("worktree-applied");
  const committed = gitOp("agent-committed");
  const integrated = gitOp("integrated");
  const reindexed = gitOp("reindexed");

  const artifacts: RunArtifacts = {
    planHash: plan?.plan_hash ?? null,
    patchHash: patch?.patch_hash ?? null,
    baseRef: base?.commit_sha ?? null,
    canonicalRef: base?.ref_name ?? null,
    worktreePath: wt?.ref_name ?? null,
    treeHash: wt?.commit_sha ?? null,
    commitSha: committed?.commit_sha ?? null,
    canonicalSha: integrated?.commit_sha ?? null,
    indexGeneration: parseGeneration(reindexed?.ref_name),
  };

  return {
    runId: run.run_id,
    operation: run.operation,
    state: run.status,
    failedCheckpoint: run.failed_checkpoint,
    tier: run.tier,
    targetNoteId: run.target_note_id,
    checkpointSeq: run.checkpoint_seq,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    finishedAt: run.finished_at,
    artifacts,
    terminal: TERMINALS.has(run.status),
  };
}

/** Parse `index-generation:<n>` back to the integer generation, or null. */
function parseGeneration(refName: string | undefined): number | null {
  if (!refName) return null;
  const m = /^index-generation:(\d+)$/.exec(refName);
  return m ? Number(m[1]) : null;
}
