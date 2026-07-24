/**
 * `workflows/reconciler` — `reconcileRunsOnStartup`, the startup recovery pass
 * (Task 2.5) that drives every interrupted run forward or to a `failed@` terminal
 * deterministically from `docs/specs/recovery-state-machine.md`.
 *
 * v2 (#338): the §2.8 audit-ledger drain + the un-anchored-integration barrier are
 * RETIRED with the audit ledger. Recovery is now a pure `agent_runs` run-sweep — a
 * crashed non-terminal run is re-driven from its durable `agent_runs.status` + gating
 * rows, and `integrated` is re-derived from authoritative canonical containment (git
 * is the sole source of truth). It runs in three layers:
 *
 *   1. **Run sweep** — for every non-terminal `agent_runs` row, apply the recovery
 *      action the contract table pins for its checkpoint:
 *        - `integrated`  → integrated-but-unfinalized: advance reindexed → finalized
 *                          (a durable canonical mutation is forward-only).
*        - `worktree-applied` → applied-uncommitted: commit iff planHash + baseRef
 *                          unmoved, else `failed@worktree-applied` (reason
 *                          `base-moved`) and clean the orphaned worktree.
 *        - `agent-committed` → integrate the committed run (v2 #335: no Tier-3 park).
 *        - `planned`/`patched` → pure, no side effects past the row; safe to leave
 *                          for a fresh re-drive (recompute is deterministic).
 *   2. **Orphan sweep** — any worktree recorded for a now-terminal run that still
 *      exists on disk is removed (`git worktree remove --force`).
 *   3. **Idempotency release** — claims wedged `in-progress` by a run that has since
 *      terminated are released.
 *
 * The side-effecting recovery steps that genuinely belong to the run's producer
 * (committing an applied worktree, Tier-2 integration, reprojection) are injected
 * as {@link ReconcileHooks}; without a hook the reconciler leaves the run for its
 * producer's idempotent re-drive rather than fabricating the effect.
 */
import {
  applyLedgerWrite,
  type Store,
} from "@atlas/sqlite-store";
import { existsSync } from "node:fs";
import type { Repo } from "@atlas/git";
import { type WorkflowState } from "@atlas/contracts";
import {
  agentRunUpsert,
  assertGatingEvidence,
  assertPatchPersisted,
  assertPersistedState,
  assertRowAdvancedTo,
  gitOpId,
  gitOpUpsert,
  patchInsert,
  readGitOp,
  readPatchHash,
  readPlanHash,
  type IntegratedArtifacts,
  type PatchedArtifacts,
  type WorktreeAppliedArtifacts,
} from "./checkpoints.js";
import { recordIntegration } from "./engine.js";
import { reconcileIdempotency } from "./idempotency.js";

/** RFC-3339 UTC millisecond timestamp. */
function rfc3339Ms(): string {
  return new Date().toISOString();
}

/** Context handed to a {@link ReconcileHooks} recovery step. */
export interface ReconcileRunContext {
  readonly runId: string;
  readonly operation: string;
  readonly tier: number | null;
  /** The canonical ref recorded at `planned`. */
  readonly canonicalRef: string | null;
  /** The `baseRef` (canonical HEAD sha) the plan was computed against. */
  readonly baseRef: string | null;
  /** The agent ref + worktree path recorded at `worktree-applied`, if any. */
  readonly agentRef: string | null;
  readonly worktreePath: string | null;
  readonly treeHash: string | null;
  /** The agent-branch commit recorded at `agent-committed`, if any. */
  readonly commitSha: string | null;
}

/** The recomputed-plan verdict: deterministic ⇒ carry the materialized patch artifacts. */
export type RecomputePlanResult =
  | { readonly deterministic: true; readonly patched: PatchedArtifacts }
  | { readonly deterministic: false };

/**
 * The recomputed-patch verdict: deterministic ⇒ carry the RECOMPUTED `patchHash`
 * (the reconciler compares it against the run's durably-stored `patchHash` — a
 * boolean alone is not trusted, round finding #6) AND the applied-worktree artifacts.
 */
export type RecomputePatchResult =
  | { readonly deterministic: true; readonly patchHash: string; readonly worktree: WorktreeAppliedArtifacts }
  | { readonly deterministic: false };

/** The producer-owned recovery steps the reconciler injects (all optional). */
export interface ReconcileHooks {
  /**
   * Commit a base-unmoved applied worktree (`worktree-applied` → `agent-committed`).
   * Returns the agent-branch commit + the hash of the tree it committed. The
   * reconciler REQUIRES that returned `treeHash` to equal the RECORDED
   * `worktree-applied` tree (round-3 finding #4) — a divergent tree is a
   * tamper/nondeterminism and fails the run. Without this hook a base-unmoved run
   * is left for the producer's re-drive.
   */
  commitApplied?(ctx: ReconcileRunContext): Promise<{ commitSha: string; treeHash: string }>;
  /**
   * Reopen the RECORDED worktree and hash its live working tree (round-3 finding
   * #4). Called BEFORE {@link commitApplied}: the reconciler requires the live hash
   * to equal the recorded `treeHash` (proving the applied patch survived intact)
   * before it commits. Without this hook the equality is still enforced on the
   * committed tree that `commitApplied` reports.
   */
  hashWorktree?(ctx: ReconcileRunContext): Promise<string>;
  /**
   * Tier-2 auto-integrate an `agent-committed` run: perform the broker ref-advance
   * + `run.integrated` append and return the integration artifacts. Without this
   * hook a Tier-2 run is left for the producer's re-drive.
   */
  integrate?(ctx: ReconcileRunContext): Promise<IntegratedArtifacts>;
  /**
   * Reproject an `integrated` run (`integrated`/reindex recovery). Returns the
   * advanced index generation AND the `canonicalSha` the projection now reflects,
   * so the reconciler can verify coverage before it records `reindexed` (round-2
   * finding: no invented generation). Without this hook an `integrated` run is
   * LEFT for the producer's idempotent reprojection re-drive — the reconciler
   * never fabricates a generation.
   */
  reindex?(ctx: ReconcileRunContext): Promise<{ indexGeneration: number; canonicalSha: string }>;
  /**
   * Recompute a `planned` run's plan from its inputs (§ recovery `planned`: "advance
   * to patched if inputs unchanged else failed@planned"). A `deterministic: true`
   * verdict carries the materialized {@link PatchedArtifacts} the reconciler
   * atomically advances the run to `patched` with; `deterministic: false` fails the
   * run `plan-stale`. Without this hook a planned run is left for a re-drive.
   */
  recomputePlan?(ctx: ReconcileRunContext): Promise<RecomputePlanResult>;
  /**
   * Recompute a `patched` run's patch from its stored plan (§ recovery `patched`:
   * "match patchHash advance, else failed@patched"). A `deterministic: true` verdict
   * carries the {@link WorktreeAppliedArtifacts} the reconciler atomically advances
   * the run to `worktree-applied` with; `deterministic: false` fails the run
   * `patch-nondeterministic`. Without this hook a patched run is left for a re-drive.
   */
  recomputePatch?(ctx: ReconcileRunContext): Promise<RecomputePatchResult>;
}

/** Everything the reconciler needs. v2 (#338): no broker, no backup — the run-sweep
 * recovers purely from `agent_runs` + git. */
export interface ReconcileDeps {
  readonly store: Store;
  readonly repo: Repo;
  readonly hooks?: ReconcileHooks;
  readonly now?: () => string;
}

/** What the reconciler did to a single run. */
export interface RunReconcileOutcome {
  readonly runId: string;
  readonly from: WorkflowState;
  /** The recovery action taken. */
  readonly action: "finalized" | "advanced" | "committed" | "integrated" | "reindexed" | "failed" | "left" | "cleaned";
  readonly to?: WorkflowState;
  readonly reason?: string;
}

/** The full startup-reconciliation report. */
export interface ReconcileRunsReport {
  /** Per-run recovery outcomes. */
  readonly runs: readonly RunReconcileOutcome[];
  /** Worktrees cleaned in the orphan sweep. */
  readonly worktreesCleaned: number;
  /** Idempotency claims released because their owning run had terminated. */
  readonly idempotencyReleased: number;
}

interface AgentRunRow {
  readonly run_id: string;
  readonly operation: string;
  readonly status: WorkflowState;
  readonly tier: number | null;
}

/**
 * Recover every interrupted run on startup. Idempotent: a run already at a
 * terminal (or at a leave-intact state) is a no-op, so a second pass converges to
 * the same result.
 */
export async function reconcileRunsOnStartup(deps: ReconcileDeps): Promise<ReconcileRunsReport> {
  const now = deps.now ?? rfc3339Ms;
  const { store } = deps;

  // Layer 1: sweep non-terminal runs, oldest first (deterministic ordering). v2
  // (#338): the state IS the durable `agent_runs.status` (no audit-drain precedes
  // this) — a crashed run is re-driven forward from its checkpoint + gating rows.
  const rows = store.db
    .prepare(
      `SELECT run_id, operation, status, tier FROM agent_runs
        WHERE status IN ('planned','patched','worktree-applied','agent-committed','integrated','reindexed')
        ORDER BY started_at ASC`,
    )
    .all() as AgentRunRow[];

  const runs: RunReconcileOutcome[] = [];
  for (const row of rows) {
    // Per-row isolation: one row's recovery failure (a git error, a CAS conflict, a
    // hook throw) must NOT abort recovery of the remaining rows. Record it as `left`
    // with the reason and continue — the row stays non-terminal for the next pass.
    try {
      runs.push(await recoverRun(deps, row, now));
    } catch (err) {
      runs.push({
        runId: row.run_id,
        from: row.status,
        action: "left",
        reason: `recovery-error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Layer 2: orphan-worktree sweep — a worktree recorded for a now-terminal run
  // that still exists on disk is removed (git worktree remove --force).
  const worktreesCleaned = await sweepOrphanWorktrees(deps);

  // Layer 3: release idempotency claims wedged `in-progress` by a crashed run whose
  // owning run has since reached a terminal state (round-2 finding).
  const idempotencyReleased = reconcileIdempotency(store.db, now());

  return { runs, worktreesCleaned, idempotencyReleased };
}

async function recoverRun(
  deps: ReconcileDeps,
  row: AgentRunRow,
  now: () => string,
): Promise<RunReconcileOutcome> {
  const ctx = runContext(deps.store, row);
  // `sync`-operation runs are owned EXCLUSIVELY by the sync producer's recovery. The
  // generic finalizer has no notion of the sync finalize extras (cursor advance,
  // projection fold, `index:reconcile` enqueue), so finalizing a sync run here would
  // strand the cursor — LEAVE it for the sync producer.
  if (row.operation === "sync" || row.operation === "sync-reset") {
    return { runId: row.run_id, from: row.status, action: "left", reason: "sync-producer-owned" };
  }
  switch (row.status) {
    case "planned":
    case "patched":
      // No side effects past the row; recompute is deterministic → leave for the
      // producer's idempotent re-drive (§ recovery: "re-drive planning is safe";
      // "recompute patches from plan"). The producer owns the recompute/advance —
      // the reconciler never fabricates a plan/patch — so a hook-less pass leaves
      // the run and a `recomputePlan`/`recomputePatch` hook advances it.
      return recoverPure(deps, row, ctx);

    case "worktree-applied":
      return recoverWorktreeApplied(deps, row, ctx, now);

    case "agent-committed":
      return recoverAgentCommitted(deps, row, ctx, now);

    case "integrated":
    case "reindexed":
      return recoverIntegrated(deps, row, ctx, now);

    default:
      return { runId: row.run_id, from: row.status, action: "left" };
  }
}

/**
 * `planned`/`patched` recovery (§ recovery state table). The state is a pure
 * function of the run's inputs, so the producer recomputes it and the reconciler
 * ADVANCES the run forward when deterministic (round-3 finding #3 — the prior
 * "always leave" contradicted the table):
 *  - `planned` → recompute the plan; deterministic ⇒ atomically advance to
 *    `patched` persisting the recomputed patch artifacts; else `failed@planned`
 *    (`plan-stale`).
 *  - `patched` → recompute the patch; deterministic ⇒ atomically advance to
 *    `worktree-applied` persisting the applied-tree artifacts; else `failed@patched`
 *    (`patch-nondeterministic`).
 * Without the producer hook the run is left for its idempotent re-drive (the
 * reconciler never fabricates a plan/patch).
 */
async function recoverPure(
  deps: ReconcileDeps,
  row: AgentRunRow,
  ctx: ReconcileRunContext,
): Promise<RunReconcileOutcome> {
  const now = deps.now ?? rfc3339Ms;
  if (row.status === "planned") {
    const hook = deps.hooks?.recomputePlan;
    if (!hook) return { runId: row.run_id, from: row.status, action: "left" };
    const verdict = await hook(ctx);
    if (!verdict.deterministic) {
      await failRun(deps, row, "planned", "plan-stale", now);
      return { runId: row.run_id, from: "planned", action: "failed", to: "failed", reason: "plan-stale" };
    }
    advanceCheckpoint(deps.store.db, row, "patched", ["planned"], [patchInsert(verdict.patched, now())], verdict.patched, now);
    return { runId: row.run_id, from: "planned", action: "advanced", to: "patched" };
  }
  // patched
  const hook = deps.hooks?.recomputePatch;
  if (!hook) return { runId: row.run_id, from: row.status, action: "left" };
  const verdict = await hook(ctx);
  if (!verdict.deterministic) {
    await failRun(deps, row, "patched", "patch-nondeterministic", now);
    return { runId: row.run_id, from: "patched", action: "failed", to: "failed", reason: "patch-nondeterministic" };
  }
  // Compare the RECOMPUTED patchHash against the run's durably-stored one (round
  // finding #6): a `deterministic: true` boolean is not trusted on its own — patches
  // are a pure function of the plan, so a recomputed hash that diverges from the
  // stored evidence is nondeterminism/tamper and fails the run rather than advancing.
  const storedPatchHash = readPatchHash(deps.store.db, row.run_id);
  if (storedPatchHash === undefined || verdict.patchHash !== storedPatchHash) {
    await failRun(deps, row, "patched", "patch-nondeterministic", now);
    return { runId: row.run_id, from: "patched", action: "failed", to: "failed", reason: "patch-nondeterministic" };
  }
  const w = verdict.worktree;
  const wtStmt = gitOpUpsert({ gitOpId: gitOpId(row.run_id, "worktree-applied"), runId: row.run_id, opType: "worktree-applied", refName: w.worktreePath, commitSha: w.treeHash, now: now() });
  advanceCheckpoint(deps.store.db, row, "worktree-applied", ["patched"], [wtStmt], w, now);
  return { runId: row.run_id, from: "patched", action: "advanced", to: "worktree-applied" };
}

/**
 * Atomically advance a run to a progression checkpoint during recovery — one
 * transaction that CAS-asserts the persisted prior state, validates the gating
 * evidence, applies the guarded `agent_runs` upsert + gating rows, then re-asserts
 * the row advanced (affected-row CAS) and the immutable patch artifact. Mirrors the
 * engine's no-audit checkpoint write so a recovery advance obeys the same gates
 * (round-3 findings #2/#3/#5).
 */
function advanceCheckpoint(
  db: Store["db"],
  row: AgentRunRow,
  to: "patched" | "worktree-applied",
  expectedFrom: readonly WorkflowState[],
  gating: readonly ReturnType<typeof patchInsert>[],
  artifacts: PatchedArtifacts | WorktreeAppliedArtifacts,
  now: () => string,
): void {
  const ts = now();
  db.transaction(() => {
    assertPersistedState(db, row.run_id, to, expectedFrom);
    assertGatingEvidence(db, row.run_id, to, artifacts);
    applyLedgerWrite(db, [
      agentRunUpsert({ runId: row.run_id, operation: row.operation, status: to, tier: row.tier, startedAt: ts, now: ts, expectedFrom }),
      ...gating,
    ]);
    assertRowAdvancedTo(db, row.run_id, to);
    if (to === "patched") assertPatchPersisted(db, artifacts as PatchedArtifacts);
  })();
}

/**
 * The load-bearing case (§ recovery `worktree-applied` recovery): commit iff
 * `planHash` + `baseRef` unmoved, else `failed@worktree-applied` (`base-moved`)
 * and clean the orphaned worktree.
 */
async function recoverWorktreeApplied(
  deps: ReconcileDeps,
  row: AgentRunRow,
  ctx: ReconcileRunContext,
  now: () => string,
): Promise<RunReconcileOutcome> {
  const db = deps.store.db;
  // Normative gates (round-2 finding): a legitimate commit requires the plan hash
  // still present, the recorded worktree/tree evidence intact, the worktree present
  // on disk, AND the canonical base unmoved. Any missing/tampered gate fails the
  // run `failed@worktree-applied` and cleans the orphan.
  const planHash = readPlanHash(db, row.run_id);
  const current = ctx.canonicalRef ? await deps.repo.readRef(ctx.canonicalRef) : null;
  const baseMoved = ctx.baseRef === null || current === null || current !== ctx.baseRef;
  const worktreeMissing = !ctx.worktreePath || !existsSync(ctx.worktreePath);
  const evidenceMissing = !planHash || ctx.treeHash === null;

  const failReason = baseMoved ? "base-moved" : evidenceMissing ? "gating-evidence-missing" : worktreeMissing ? "worktree-missing" : null;
  if (failReason) {
    await failRun(deps, row, "worktree-applied", failReason, now);
    await removeWorktreeBestEffort(deps.repo, ctx.worktreePath);
    return { runId: row.run_id, from: "worktree-applied", action: "failed", to: "failed", reason: failReason };
  }

  // Base unmoved + gates intact: commit the applied worktree via the producer's
  // hook, advancing to `agent-committed` in one atomic write. Without a hook,
  // leave for re-drive.
  const hook = deps.hooks?.commitApplied;
  if (!hook) return { runId: row.run_id, from: "worktree-applied", action: "left" };

  // Tamper proof (round-3 finding #4): reopen + hash the RECORDED worktree and
  // require the live tree to still equal the recorded `treeHash` BEFORE committing.
  // A divergent live tree means the applied patch was tampered/lost — fail + clean.
  if (deps.hooks?.hashWorktree) {
    const liveHash = await deps.hooks.hashWorktree(ctx);
    if (liveHash !== ctx.treeHash) {
      await failRun(deps, row, "worktree-applied", "tree-tampered", now);
      await removeWorktreeBestEffort(deps.repo, ctx.worktreePath);
      return { runId: row.run_id, from: "worktree-applied", action: "failed", to: "failed", reason: "tree-tampered" };
    }
  }

  const { commitSha, treeHash } = await hook(ctx);
  if (!commitSha) {
    await failRun(deps, row, "worktree-applied", "commit-failed", now);
    await removeWorktreeBestEffort(deps.repo, ctx.worktreePath);
    return { runId: row.run_id, from: "worktree-applied", action: "failed", to: "failed", reason: "commit-failed" };
  }
  // The resulting commit's tree MUST equal the RECORDED applied tree (round-3
  // finding #4): the reconciler proves it recovered the SAME applied patch, never
  // a different worktree. A mismatch fails the run — the recorded `treeHash` is the
  // authority and is NEVER overwritten with the hook's value.
  if (treeHash !== ctx.treeHash) {
    await failRun(deps, row, "worktree-applied", "tree-mismatch", now);
    await removeWorktreeBestEffort(deps.repo, ctx.worktreePath);
    return { runId: row.run_id, from: "worktree-applied", action: "failed", to: "failed", reason: "tree-mismatch" };
  }
  const ts = now();
  db.transaction(() => {
    // The recorded worktree tree hash is preserved as the agent-committed gate's
    // authority; only the commit + the state advance are written.
    applyLedgerWrite(db, [
      agentRunUpsert({ runId: row.run_id, operation: row.operation, status: "agent-committed", tier: row.tier, startedAt: ts, now: ts, expectedFrom: ["worktree-applied"] }),
      gitOpUpsert({ gitOpId: gitOpId(row.run_id, "agent-committed"), runId: row.run_id, opType: "agent-committed", refName: ctx.agentRef ?? "", commitSha, now: ts }),
    ]);
    assertRowAdvancedTo(db, row.run_id, "agent-committed");
  })();
  return { runId: row.run_id, from: "worktree-applied", action: "committed", to: "agent-committed" };
}

/**
 * `agent-committed` recovery (§ recovery): commit present ⇒ integrate the run
 * (v2 #335: no Tier-3 review park). Commit MISSING but worktree present ⇒ the
 * commit never landed — recover as `worktree-applied` (round-2 finding: the
 * missing-commit branch was absent).
 */
async function recoverAgentCommitted(
  deps: ReconcileDeps,
  row: AgentRunRow,
  ctx: ReconcileRunContext,
  now: () => string,
): Promise<RunReconcileOutcome> {
  if (ctx.commitSha === null) {
    // No durable commit: fall back to the worktree-applied recovery (commit iff
    // base unmoved, else fail + clean). The agent_runs row is regressed under CAS
    // to worktree-applied first so the applied recovery's gates apply.
    const db = deps.store.db;
    if (readGitOp(db, row.run_id, "worktree-applied")) {
      const ts = now();
      db.transaction(() =>
        applyLedgerWrite(db, [
          agentRunUpsert({ runId: row.run_id, operation: row.operation, status: "worktree-applied", tier: row.tier, startedAt: ts, now: ts, expectedFrom: ["agent-committed"] }),
        ]),
      )();
      return recoverWorktreeApplied(deps, { ...row, status: "worktree-applied" }, ctx, now);
    }
    return { runId: row.run_id, from: "agent-committed", action: "left" };
  }
  // Auto-integration covers every committed run (v2 #335: captures tier-1,
  // synthesis tier-2; there is no Tier-3 review park to hold one back). A run with
  // no integrate hook is left for the producer's re-drive.
  if (deps.hooks?.integrate) {
    // Enforce the normative git checks on the STORED commit BEFORE integrating
    // (round finding #6): trust neither the recorded `commitSha` nor `treeHash` on
    // faith. (1) The agent ref must actually CONTAIN the commit (its head resolves
    // to it) — a missing/diverged ref is not auto-integrated. (2) The commit's tree
    // must equal the `treeHash` captured at `worktree-applied` — a divergent tree is
    // tamper/nondeterminism. A failed proof LEAVES the run for the producer/operator
    // rather than integrating an unproven commit.
    const agentHead = await deps.repo.readRef(ctx.agentRef ?? "");
    // Containment by ANCESTRY, not tip-equality (round-2 finding W4): the agent ref
    // must CONTAIN the recorded commit — a ref whose tip advanced past the commit
    // (e.g. a follow-up commit) still contains it, so equality would wrongly reject a
    // valid descendant tip. A missing ref (null) or non-containing tip is left.
    if (agentHead === null || !(await deps.repo.isAncestor(ctx.commitSha, agentHead))) {
      return { runId: row.run_id, from: "agent-committed", action: "left", reason: "agent-ref-missing-commit" };
    }
    // Tree proof is MANDATORY (round-2 finding W5): a NULL recorded `treeHash` is
    // MISSING evidence, not proof of a matching tree — never auto-integrate without a
    // non-null stored hash AND an exact resolved commit-tree match.
    if (ctx.treeHash === null) {
      return { runId: row.run_id, from: "agent-committed", action: "left", reason: "tree-hash-missing" };
    }
    const commitTree = await deps.repo.commitTree(ctx.commitSha);
    if (commitTree !== ctx.treeHash) {
      return { runId: row.run_id, from: "agent-committed", action: "left", reason: "commit-tree-mismatch" };
    }
    // Crash-after-FF-before-agent_runs-flip: if canonical ALREADY contains the recorded
    // commit, a prior (crashed) attempt landed the FF but never wrote the CLI-side
    // `integrated` CAS. Re-running the integrate hook here would advance from a STALE
    // base and throw `broker.cas_failed`. Finalize FORWARD instead — record `integrated`
    // directly from the DURABLE ctx values (mirrors engine.ts `resolveIntegrationCrash`).
    // The commit is already proven contained-in-agent-ref + tree-matched above, so this
    // records only a genuinely-installed commit.
    if (ctx.canonicalRef !== null) {
      const canonicalHead = await deps.repo.readRef(ctx.canonicalRef);
      if (canonicalHead !== null && (await deps.repo.isAncestor(ctx.commitSha, canonicalHead))) {
        recordIntegration(deps.store, {
          runId: row.run_id,
          operation: row.operation,
          artifacts: { canonicalRef: ctx.canonicalRef, canonicalSha: ctx.commitSha },
          now: now(),
        });
        return { runId: row.run_id, from: "agent-committed", action: "integrated", to: "integrated" };
      }
    }
    const artifacts = await deps.hooks.integrate(ctx);
    // Bind the hook's result to the run's DURABLE integration intent (round-3 finding
    // on reconciler.ts:504-513): a hook that returns the UNCHANGED base sha or a
    // DIFFERENT canonical ref could otherwise pass the ancestry test and falsely record
    // an integration that never installed THIS run's commit. Require the ref to equal
    // the ref recorded at `planned` and the sha to equal the agent commit recorded at
    // `agent-committed` before the containment check is meaningful.
    if (ctx.canonicalRef === null || artifacts.canonicalRef !== ctx.canonicalRef) {
      return { runId: row.run_id, from: "agent-committed", action: "left", reason: "integration-ref-mismatch" };
    }
    if (artifacts.canonicalSha !== ctx.commitSha) {
      return { runId: row.run_id, from: "agent-committed", action: "left", reason: "integration-sha-not-agent-commit" };
    }
    // Validate canonical containment before recording the CLI-side step-3 CAS —
    // by ancestry, not tip-equality (round-2 finding W4). The commit tested is the
    // agent commit itself (bound above).
    const canonicalNow = await deps.repo.readRef(ctx.canonicalRef);
    if (canonicalNow === null || !(await deps.repo.isAncestor(ctx.commitSha, canonicalNow))) {
      return { runId: row.run_id, from: "agent-committed", action: "left", reason: "canonical-containment-unverified" };
    }
    recordIntegration(deps.store, { runId: row.run_id, operation: row.operation, artifacts, now: now() });
    return { runId: row.run_id, from: "agent-committed", action: "integrated", to: "integrated" };
  }
  // No integrate hook: leave for the producer's re-drive.
  return { runId: row.run_id, from: "agent-committed", action: "left" };
}

/**
 * Integrated-but-unfinalized (§ recovery): a durable canonical mutation is
 * forward-only. Reproject (real hook, verified to cover `canonicalSha`) → record
 * `reindexed`, then advance `reindexed → finalized`. v2 (#338): the §2.8 audit
 * ledger + AEAD backup/watermark are retired, so there is NO step-4 backup-coverage
 * gate on `finalized` — git (one commit per ChangePlan on `refs/heads/main`) is the
 * only safety mechanism, and `finalized` is durable on the commit. Reprojection stays
 * producer-owned: without a `reindex` hook the run is LEFT `integrated` for the
 * producer's idempotent re-drive (the reconciler never invents an index generation).
 */
async function recoverIntegrated(
  deps: ReconcileDeps,
  row: AgentRunRow,
  ctx: ReconcileRunContext,
  now: () => string,
): Promise<RunReconcileOutcome> {
  const db = deps.store.db;
  const canonicalSha = readGitOp(db, row.run_id, "integrated")?.commitSha ?? null;

  if (row.status === "integrated") {
    // Reprojection is producer-owned. Without a hook the reconciler LEAVES the run
    // integrated for the producer's idempotent reprojection re-drive — it never
    // invents an index generation (round-2 finding).
    if (!deps.hooks?.reindex) {
      return { runId: row.run_id, from: "integrated", action: "left", reason: "reindex-hook-absent" };
    }
    const reprojected = await deps.hooks.reindex(ctx);
    if (canonicalSha !== null && reprojected.canonicalSha !== canonicalSha) {
      return { runId: row.run_id, from: "integrated", action: "left", reason: "reindex-canonical-mismatch" };
    }
    const ts = now();
    db.transaction(() => {
      applyLedgerWrite(db, [
        agentRunUpsert({ runId: row.run_id, operation: row.operation, status: "reindexed", tier: row.tier, startedAt: ts, now: ts, expectedFrom: ["integrated"] }),
        gitOpUpsert({ gitOpId: gitOpId(row.run_id, "reindexed"), runId: row.run_id, opType: "reindexed", refName: `index-generation:${reprojected.indexGeneration}`, commitSha: canonicalSha, now: ts }),
      ]);
      assertRowAdvancedTo(db, row.run_id, "reindexed");
    })();
  }

  // v2 (#338): no §2.8 step-4 backup gate — the audit ledger + AEAD backup are
  // retired, so `finalized` advances directly once the run is reprojected (git is
  // the only safety mechanism; the finalized state is durable on commit).
  const ts = now();
  db.transaction(() => {
    applyLedgerWrite(db, [
      // CAS ONLY from `reindexed` (round-3 finding on engine.ts:635-667): a run reaches
      // here already reprojected (an `integrated` run is advanced to `reindexed` above;
      // a `reindexed` run enters directly), so `finalized` is only ever a reindexed→
      // finalized advance — never integrated→finalized skipping the reindexed checkpoint.
      agentRunUpsert({ runId: row.run_id, operation: row.operation, status: "finalized", tier: row.tier, startedAt: ts, now: ts, finishedAt: ts, expectedFrom: ["reindexed"] }),
    ]);
    assertRowAdvancedTo(db, row.run_id, "finalized");
  })();

  return { runId: row.run_id, from: row.status, action: "finalized", to: "finalized" };
}

/** Write a `failed@<at>` terminal in one plain transaction (v2 #338: no audit event). */
async function failRun(
  deps: ReconcileDeps,
  row: AgentRunRow,
  at: WorkflowState,
  reason: string,
  now: () => string,
): Promise<void> {
  void reason;
  const ts = now();
  const db = deps.store.db;
  db.transaction(() => {
    applyLedgerWrite(db, [
      agentRunUpsert({
        runId: row.run_id,
        operation: row.operation,
        status: "failed",
        failedCheckpoint: at,
        tier: row.tier,
        startedAt: ts,
        now: ts,
        finishedAt: ts,
        // Persisted-state CAS (round-3 finding #2): only fail a run still at the
        // checkpoint it is being failed FROM. A run that advanced under another
        // handle is never regressed to `failed` — the guarded upsert no-ops and the
        // affected-row assertion below rolls the whole terminal tx back.
        expectedFrom: [at],
        assertAdvanced: true,
      }),
    ]);
    assertRowAdvancedTo(db, row.run_id, "failed");
  })();
  await Promise.resolve();
}

/** Assemble the recovery context for a run from its persisted artifacts. */
function runContext(store: Store, row: AgentRunRow): ReconcileRunContext {
  const db = store.db;
  const base = readGitOp(db, row.run_id, "base");
  const wt = readGitOp(db, row.run_id, "worktree-applied");
  const commit = readGitOp(db, row.run_id, "agent-committed");
  return {
    runId: row.run_id,
    operation: row.operation,
    tier: row.tier,
    canonicalRef: base?.refName ?? null,
    baseRef: base?.commitSha ?? null,
    // The agent ref is canonical per run (`refs/agent/<runId>`, @atlas/git); the
    // `agent-committed` op records it explicitly, but a worktree-applied run has
    // no such row yet, so derive it (the worktree-applied `ref_name` holds the
    // worktree PATH, not the agent ref).
    agentRef: commit?.refName ?? `refs/agent/${row.run_id}`,
    worktreePath: wt?.refName ?? null,
    treeHash: wt?.commitSha ?? null,
    commitSha: commit?.commitSha ?? null,
  };
}

/** Remove every worktree recorded for a now-terminal run that still exists. */
async function sweepOrphanWorktrees(deps: ReconcileDeps): Promise<number> {
  const rows = deps.store.db
    .prepare(
      `SELECT g.ref_name AS path FROM git_operations g
         JOIN agent_runs r ON r.run_id = g.run_id
        WHERE g.op_type = 'worktree-applied'
          AND r.status IN ('failed','cancelled','rejected')`,
    )
    .all() as { path: string }[];
  let cleaned = 0;
  for (const { path } of rows) {
    if (await removeWorktreeBestEffort(deps.repo, path)) cleaned++;
  }
  return cleaned;
}

/** `git worktree remove --force`, swallowing "already gone". Returns whether it ran. */
async function removeWorktreeBestEffort(repo: Repo, path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    await repo.removeWorktree(path);
    return true;
  } catch {
    return false;
  }
}

