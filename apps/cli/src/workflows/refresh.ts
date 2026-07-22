/**
 * `workflows/refresh` — the Tier-3 review-loop refresh (Task 4.5 §refresh).
 *
 * `refreshRun` regenerates a `review-pending` run against the CURRENT canonical head
 * without leaving the review gate (spec `workflow-risk-contract.md` §refresh): it
 * re-plans (retrieval-first), re-validates (4.4), re-tiers (4.3), produces a NEW agent
 * commit on top of current canonical, records a **supersession** (new commit supersedes
 * the prior review-pending commit), advances the run's agent ref + recorded commit, and
 * returns the run to `review-pending`. It emits a `run.refreshed` audit event.
 *
 * Invariants this operation OWNS:
 *  - **Never escapes the review gate.** Regardless of the recomputed tier, a refreshed
 *    run stays `review-pending` and still requires a fresh approval — refresh can only
 *    ever *raise* scrutiny, never let a run auto-integrate by re-tiering.
 *  - **No canonical mutation.** Refresh regenerates the agent branch only; the superseded
 *    commit is RETAINED for the audit trail, never fast-forwarded onto canonical.
 *  - **Key-accepting against the canonical head.** A repeat refresh while canonical has
 *    not moved returns the existing superseding commit rather than creating another
 *    (idempotent on `(runId, base_commit)`).
 *
 * The broker-authorized `git refresh` COMMAND (challenge/authorization flow, the
 * canonical-integration lock) is Task 4.9/4.11; this is the engine-level producer the
 * plan (§4.5) names: `refreshRun(runId, kind, input, deps): {newCommit, superseded}`.
 */
import { mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId, type RunManifest } from "@atlas/contracts";
import {
  finalizeLedgerWrite,
  type AuditBroker,
  type AuditEventDraft,
  type LedgerBackupConfig,
  type LedgerStatement,
  type SqliteDatabase,
  type Store,
} from "@atlas/sqlite-store";
import type { Repo } from "@atlas/git";
import { applyPatch } from "../markdown/apply.js";
import { CliError, EXIT } from "../errors/envelope.js";
import { gitOpId, gitOpUpsert, readAgentRunStatus, readGitOp, sha256Canonical } from "./checkpoints.js";
import { planSynthesis, type SynthesisKind, type SynthesisPlanDeps, type WorkflowInput } from "./synthesis.js";

const ZERO_OID = "0".repeat(40);

function rfc3339MsNow(): string {
  return new Date().toISOString();
}

/** The mutation seams `refreshRun` needs beyond the pure {@link SynthesisPlanDeps}. */
export interface SynthesisRefreshDeps extends SynthesisPlanDeps {
  readonly store: Store;
  readonly broker: AuditBroker;
  readonly backup: LedgerBackupConfig;
  readonly repo: Repo;
  readonly worktreesPath: string;
  /** The canonical protected ref (config `git.canonical_ref`, threaded by the caller). */
  readonly canonicalRef: string;
  readonly now?: () => string;
}

/** The result of a refresh: the new superseding commit + the commit it superseded. */
export interface RefreshResult {
  readonly runId: string;
  /** The new agent commit regenerated against current canonical. */
  readonly newCommit: string;
  /** The prior review-pending agent commit this refresh superseded. */
  readonly superseded: string;
  /** The canonical head the new commit was rebased onto. */
  readonly baseCommit: string;
  /** Always `review-pending` — refresh never leaves the review gate. */
  readonly state: "review-pending";
  /** True when a prior refresh against the same canonical head was replayed (idempotent). */
  readonly reused: boolean;
}

/** A refresh failure the CLI boundary maps to an exit code. */
export class RefreshError extends CliError {}

/** Look up an existing supersession for a run against a canonical head (idempotency). */
function findSupersession(
  db: SqliteDatabase,
  runId: string,
  baseCommit: string,
): { supersededCommit: string; newCommit: string } | undefined {
  const row = db
    .prepare(`SELECT superseded_commit, new_commit FROM run_supersessions WHERE run_id = ? AND base_commit = ?`)
    .get(runId, baseCommit) as { superseded_commit: string; new_commit: string } | undefined;
  return row ? { supersededCommit: row.superseded_commit, newCommit: row.new_commit } : undefined;
}

/** The idempotent supersession-insert statement (natural key `(run_id, base_commit)`). */
function supersessionInsert(args: {
  runId: string;
  baseCommit: string;
  supersededCommit: string;
  newCommit: string;
  now: string;
}): LedgerStatement {
  return {
    sql: `INSERT INTO run_supersessions (run_id, base_commit, superseded_commit, new_commit, created_at)
          VALUES (@run_id, @base_commit, @superseded_commit, @new_commit, @now)
          ON CONFLICT(run_id, base_commit) DO NOTHING`,
    params: {
      run_id: args.runId,
      base_commit: args.baseCommit,
      superseded_commit: args.supersededCommit,
      new_commit: args.newCommit,
      now: args.now,
    },
  };
}

async function cleanupWorktree(repo: Repo, dir: string): Promise<void> {
  try {
    await repo.removeWorktree(dir);
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Refresh a `review-pending` run against current canonical (spec §refresh). Re-plans,
 * re-validates, and produces a new superseding agent commit that stays in the review
 * gate. Idempotent per canonical head. `kind`/`input` re-seed the regeneration (the CLI
 * resolves them from the run record); the returned {@link RefreshResult} carries the new
 * + superseded commits.
 */
export async function refreshRun(
  runId: string,
  kind: SynthesisKind,
  input: WorkflowInput,
  deps: SynthesisRefreshDeps,
): Promise<RefreshResult> {
  const now = deps.now ?? rfc3339MsNow;
  const canonicalRef = deps.canonicalRef;
  const db = deps.store.db;

  // 1. The run must be at the review gate.
  const status = readAgentRunStatus(db, runId);
  if (status !== "review-pending") {
    throw new RefreshError({
      code: "refresh-not-review-pending",
      message: `run ${runId} is at ${status ?? "<unknown>"}, not review-pending; only a review-pending run can be refreshed`,
      hint: "Refresh regenerates a run awaiting approval; a run that is not in the review gate has nothing to refresh.",
      exitCode: EXIT.VALIDATION,
    });
  }
  const prior = readGitOp(db, runId, "agent-committed");
  if (!prior?.commitSha) {
    throw new RefreshError({
      code: "refresh-no-prior-commit",
      message: `run ${runId} has no recorded agent commit to supersede`,
      hint: "A review-pending run always has an agent commit; the ledger appears inconsistent.",
      exitCode: EXIT.INTERNAL,
    });
  }
  const superseded = prior.commitSha;
  const baseCommit = (await deps.repo.readRef(canonicalRef)) ?? ZERO_OID;

  // 2. Key-accepting idempotency: a repeat refresh against the SAME canonical head
  //    returns the existing superseding commit rather than creating another.
  const existing = findSupersession(db, runId, baseCommit);
  if (existing) {
    return {
      runId,
      newCommit: existing.newCommit,
      superseded: existing.supersededCommit,
      baseCommit,
      state: "review-pending",
      reused: true,
    };
  }

  // 3. Regenerate the plan against current canonical (retrieval-first) + re-validate.
  const plan = await planSynthesis(kind, input, deps);
  if (!plan.report.ok) {
    throw new RefreshError({
      code: "refresh-validation-failed",
      message: `refreshed plan failed validation: ${plan.report.findings.filter((f) => f.severity === "error").map((f) => f.code).join(", ") || "invalid"}`,
      hint: "The regenerated ChangePlan violates a validation rule; the run stays at its prior review-pending commit.",
      exitCode: EXIT.VALIDATION,
    });
  }
  const note = deps.readNote(input.target);
  if (note === null || plan.patch === null) {
    throw new RefreshError({
      code: "refresh-op-not-applicable",
      message: `run ${runId} refresh produced no patchable single-note change (op ${plan.changePlan.operation.op})`,
      hint: "Refresh in this slice regenerates patchable single-note edits; other ops are pending (Tasks 4.6+).",
      exitCode: EXIT.VALIDATION,
    });
  }
  const patch = plan.patch;
  const planHash = sha256Canonical(plan.changePlan);

  // 4. Rebase the run's agent branch onto current canonical + re-apply the patch.
  const agentRef = await deps.repo.createAgentBranch(runId, canonicalRef);
  const wtParent = deps.worktreesPath && existsSync(deps.worktreesPath) ? deps.worktreesPath : tmpdir();
  let worktreeDir: string | null = await mkdtemp(join(wtParent, `atlas-refresh-${runId}-`));
  try {
    const worktree = await deps.repo.addWorktree(agentRef, worktreeDir);
    const notePath = join(worktreeDir, note.path);
    const applied = applyPatch(readFileSync(notePath, "utf8"), patch);
    if (!applied.ok) {
      throw new RefreshError({
        code: "refresh-stale-context",
        message: `refreshed patch preconditions no longer hold for "${note.id}": ${applied.error.code}`,
        hint: "The note changed under the regenerated plan; re-run refresh to re-ground it.",
        exitCode: EXIT.VALIDATION,
        retryable: true,
      });
    }
    writeFileSync(notePath, applied.next, "utf8");

    // 5. New agent commit (superseding), carrying the run manifest.
    const commitMsg = `refresh(${kind}): ${plan.changePlan.operation.op} ${note.id}`;
    const commitManifest: RunManifest = {
      schemaVersion: 1,
      runId,
      state: "review-pending",
      createdAt: now(),
      canonicalBaseCommit: baseCommit,
      targets: [note.id],
      changePlanDigest: planHash,
    };
    const newCommit = await worktree.commit(commitMsg, commitManifest);

    // 6. Record the supersession + advance the recorded review-pending commit atomically
    //    with the run.refreshed audit event. The run STAYS review-pending (no status
    //    change) — refresh never escapes the review gate.
    const event: AuditEventDraft = {
      schemaVersion: 1,
      eventId: newRunId(),
      kind: "run.refreshed",
      occurredAt: now(),
      runId,
      subjects: [],
      canonicalCommit: baseCommit,
      detail: { supersededCommit: superseded, newCommit, baseRef: baseCommit },
    };
    const ledgerWrite: LedgerStatement[] = [
      supersessionInsert({ runId, baseCommit, supersededCommit: superseded, newCommit, now: now() }),
      // Advance the recorded agent-committed commit (the review-pending gating commit)
      // and the recorded base to the rebased head, so recovery + approve see the fresh commit.
      gitOpUpsert({ gitOpId: gitOpId(runId, "agent-committed"), runId, opType: "agent-committed", refName: agentRef, commitSha: newCommit, now: now() }),
      gitOpUpsert({ gitOpId: gitOpId(runId, "base"), runId, opType: "base", refName: canonicalRef, commitSha: baseCommit, now: now() }),
    ];
    await finalizeLedgerWrite(deps.store, deps.broker, {
      runId,
      event,
      ledgerWrite,
      backup: deps.backup,
      now,
    });

    await cleanupWorktree(deps.repo, worktreeDir);
    worktreeDir = null;
    return { runId, newCommit, superseded, baseCommit, state: "review-pending", reused: false };
  } finally {
    if (worktreeDir) await cleanupWorktree(deps.repo, worktreeDir);
  }
}
