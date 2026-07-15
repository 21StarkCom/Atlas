/**
 * `workflows/review` — the read-only `git review` + `git verify` surface (Task 4.9).
 *
 * `reviewRun` renders everything a reviewer needs to decide a Tier-3 run WITHOUT mutating
 * anything: the run's state, tier, plan summary, the agent commit + base it would install, and
 * whether that commit is still FF-integrable (its base unmoved) or needs a refresh first.
 *
 * `verifyRun` is the convergence check: the durable ledger evidence (the recorded agent commit,
 * the canonical base) must agree with the observable git refs. A divergence is reported (never
 * silently repaired here); the privileged repair path re-folds from canonical.
 */
import type { Repo } from "@atlas/git";
import type { SqliteDatabase } from "@atlas/sqlite-store";
import { readAgentRunStatus, readGitOp } from "./checkpoints.js";
import type { WorkflowState } from "@atlas/contracts";

const DEFAULT_CANONICAL_REF = "refs/heads/main";
const ZERO_OID = "0".repeat(40);

/** The read-only review report for a run. */
export interface ReviewReport {
  readonly runId: string;
  readonly state: WorkflowState | null;
  readonly tier: number | null;
  /** The plan summary recorded at `planned` (allowlisted metadata). */
  readonly summary: string | null;
  /** The agent commit the run would install (from agent-committed), or null. */
  readonly commitSha: string | null;
  /** The canonical base the run branched from. */
  readonly baseRef: string | null;
  /** True iff the recorded base still equals the current canonical tip (FF-integrable as-is). */
  readonly ffIntegrable: boolean;
}

/** Render a read-only review of a run (no mutation). */
export async function reviewRun(db: SqliteDatabase, repo: Repo, runId: string, canonicalRef = DEFAULT_CANONICAL_REF): Promise<ReviewReport> {
  const state = readAgentRunStatus(db, runId);
  const committed = readGitOp(db, runId, "agent-committed");
  const base = readGitOp(db, runId, "base");
  const tierRow = db.prepare(`SELECT tier FROM agent_runs WHERE run_id = ?`).get(runId) as { tier: number | null } | undefined;
  const planRow = db.prepare(`SELECT summary FROM change_plans WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(runId) as { summary: string } | undefined;
  const currentCanonical = (await repo.readRef(canonicalRef)) ?? ZERO_OID;
  return {
    runId,
    state,
    tier: tierRow?.tier ?? null,
    summary: planRow?.summary ?? null,
    commitSha: committed?.commitSha ?? null,
    baseRef: base?.commitSha ?? null,
    ffIntegrable: base?.commitSha !== undefined && base.commitSha === currentCanonical,
  };
}

/** A single manifest↔index divergence found by `verifyRun`. */
export interface VerifyDivergence {
  readonly runId: string;
  readonly kind: "agent-commit-missing" | "agent-ref-mismatch";
  readonly detail: string;
}

/** The verify report: convergent iff no divergences. */
export interface VerifyReport {
  readonly checked: number;
  readonly convergent: boolean;
  readonly divergences: readonly VerifyDivergence[];
}

/**
 * Verify that every non-terminal run's recorded git evidence agrees with the observable refs:
 * the recorded agent commit must resolve, and the agent ref `refs/agent/<runId>` (when present)
 * must point at it. Read-only — divergences are REPORTED for the repair path, never mutated here.
 */
export async function verifyRun(db: SqliteDatabase, repo: Repo, runId: string): Promise<VerifyReport> {
  const divergences: VerifyDivergence[] = [];
  const committed = readGitOp(db, runId, "agent-committed");
  if (committed?.commitSha) {
    const resolved = await repo.readRef(committed.commitSha);
    if (resolved === null) {
      divergences.push({ runId, kind: "agent-commit-missing", detail: `recorded agent commit ${committed.commitSha} does not resolve` });
    } else {
      const agentRef = await repo.readRef(`refs/agent/${runId}`);
      if (agentRef !== null && agentRef !== committed.commitSha) {
        divergences.push({ runId, kind: "agent-ref-mismatch", detail: `refs/agent/${runId} (${agentRef}) ≠ recorded agent commit ${committed.commitSha}` });
      }
    }
  }
  return { checked: 1, convergent: divergences.length === 0, divergences };
}
