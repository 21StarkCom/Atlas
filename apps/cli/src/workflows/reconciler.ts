/**
 * `workflows/reconciler` — `reconcileRunsOnStartup`, the startup recovery pass
 * (Task 2.5) that drives every interrupted run forward or to a `failed@` terminal
 * deterministically from `docs/specs/recovery-state-machine.md`. It runs in two
 * layers:
 *
 *   1. **§2.8 ledger drain** — `reconcileInterruptedRuns` (store-level) converges
 *      any `pending` audit intent left by a crash between §2.8 steps 1–3,
 *      idempotently on `(runId, seq)`. This must precede the run sweep so a run
 *      whose checkpoint CAS never committed is first made durable.
 *   2. **Run sweep** — for every non-terminal `agent_runs` row, apply the recovery
 *      action the contract table pins for its checkpoint:
 *        - `integrated`  → integrated-but-unfinalized: advance reindexed → finalized
 *                          (a durable canonical mutation is forward-only).
 *        - `review-pending` → leave intact (never auto-advanced; waits for
 *                          `git approve`/`git reject`).
 *        - `worktree-applied` → applied-uncommitted: commit iff planHash + baseRef
 *                          unmoved, else `failed@worktree-applied` (reason
 *                          `base-moved`) and clean the orphaned worktree.
 *        - `agent-committed` → route by tier (Tier-2 integrate; Tier-3 leave).
 *        - `planned`/`patched` → pure, no side effects past the row; safe to leave
 *                          for a fresh re-drive (recompute is deterministic).
 *   3. **Orphan sweep** — any worktree recorded for a now-terminal run that still
 *      exists on disk is removed (`git worktree remove --force`).
 *
 * The side-effecting recovery steps that genuinely belong to the run's producer
 * (committing an applied worktree, Tier-2 integration, reprojection) are injected
 * as {@link ReconcileHooks}; without a hook the reconciler leaves the run for its
 * producer's idempotent re-drive rather than fabricating the effect.
 */
import {
  DB_EVENT_SEQ_BASE,
  finalizeLedgerWrite,
  reconcileInterruptedRuns,
  runBackupStep,
  applyLedgerWrite,
  payloadHashOf,
  IntentsRepo,
  type AuditBroker,
  type LedgerBackupConfig,
  type ReconcileReport as LedgerReconcileReport,
  type Store,
} from "@atlas/sqlite-store";
import { existsSync } from "node:fs";
import type { Repo } from "@atlas/git";
import { newRunId, type WorkflowState } from "@atlas/contracts";
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
import { recordIntegration, recordIntegrationFromIntent } from "./engine.js";
import { reconcileIdempotency } from "./idempotency.js";

/** `true` iff `err` is the broker's canonical-installing signing refusal (un-anchored). */
function isAuditKindNotSignable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "broker.audit_kind_not_signable";
}

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

/** Everything the reconciler needs (matches the plan's `{store, repo, broker}`). */
export interface ReconcileDeps {
  readonly store: Store;
  readonly broker: AuditBroker;
  readonly repo: Repo;
  readonly backup: LedgerBackupConfig;
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
  /** The §2.8 ledger-drain result (pending-intent convergence). */
  readonly ledger: LedgerReconcileReport;
  /**
   * Anchored `run.integrated` intents whose canonical install could NOT be
   * authoritatively verified (round-2 finding W6): the event is on the audit chain
   * but canonical does not contain the claimed commit. Such an intent is PRESERVED
   * (never dropped) so its linkage to immutable audit evidence survives and no fresh
   * seq re-drives the same integration — it is surfaced here as ACTION-REQUIRED for
   * the operator (or a later pass once canonical advances). One `runId` per entry.
   */
  readonly integrationActionRequired: readonly string[];
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

  // Layer 0: drop un-anchored `run.integrated` pending intents (§ recovery
  // `integrated` case (a): "canonical advanced but no intent" — here the DUAL, an
  // intent allocated before the ref move that never anchored). A `run.integrated`
  // is canonical-installing, so the generic ledger drain CANNOT re-sign it; a
  // pending one that is not already anchored would abort the whole drain. We probe
  // each with the broker's idempotent replay: an anchored event replays cleanly
  // (leave it for the drain to land step-3); an un-anchored one throws
  // (`broker.audit_kind_not_signable`) — drop it so the run re-drives integration
  // from `agent-committed` with a fresh seq (the abandoned seq was never anchored).
  const { actionRequired: integrationActionRequired, barrierSeq } = await resolveIntegrationIntents(
    store,
    deps.broker,
    deps.repo,
    now,
  );

  // Layer 1: converge §2.8 pending intents so a checkpoint whose step-3 CAS never
  // committed becomes durable before the state sweep reads `agent_runs`. The layer-0
  // barrier (`barrierSeq`, the lowest UNRESOLVED `run.integrated` seq) is passed through
  // as a GLOBAL ordering stop: the gapless chain is driven oldest-first, so no later
  // intent may be completed past an unresolved earlier sequence (round-3 finding on
  // reconciler.ts:700-756 + reconcile.ts:94-102).
  const ledger = await reconcileInterruptedRuns(store, deps.broker, { backup: deps.backup, now, stopAtSeq: barrierSeq });

  // Layer 2: sweep non-terminal runs, oldest first (deterministic ordering).
  const rows = store.db
    .prepare(
      `SELECT run_id, operation, status, tier FROM agent_runs
        WHERE status IN ('planned','patched','worktree-applied','agent-committed','review-pending','integrated','reindexed')
        ORDER BY started_at ASC`,
    )
    .all() as AgentRunRow[];

  const runs: RunReconcileOutcome[] = [];
  for (const row of rows) {
    runs.push(await recoverRun(deps, row, now));
  }

  // Layer 3: orphan-worktree sweep — a worktree recorded for a now-terminal run
  // that still exists on disk is removed (git worktree remove --force).
  const worktreesCleaned = await sweepOrphanWorktrees(deps);

  // Layer 4: release idempotency claims wedged `in-progress` by a crashed run whose
  // owning run has since reached a terminal state (round-2 finding).
  const idempotencyReleased = reconcileIdempotency(store.db, now());

  return { ledger, runs, worktreesCleaned, idempotencyReleased, integrationActionRequired };
}

async function recoverRun(
  deps: ReconcileDeps,
  row: AgentRunRow,
  now: () => string,
): Promise<RunReconcileOutcome> {
  const ctx = runContext(deps.store, row);
  switch (row.status) {
    case "planned":
    case "patched":
      // No side effects past the row; recompute is deterministic → leave for the
      // producer's idempotent re-drive (§ recovery: "re-drive planning is safe";
      // "recompute patches from plan"). The producer owns the recompute/advance —
      // the reconciler never fabricates a plan/patch — so a hook-less pass leaves
      // the run and a `recomputePlan`/`recomputePatch` hook advances it.
      return recoverPure(deps, row, ctx);

    case "review-pending":
      // Never auto-advanced — waits for git approve/reject (§ recovery).
      return { runId: row.run_id, from: row.status, action: "left" };

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
 * `agent-committed` recovery (§ recovery): commit present ⇒ route by tier (Tier-2
 * integrate; Tier-3 leave for review). Commit MISSING but worktree present ⇒ the
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
  // Auto-integration is for Tier-1 (source capture) AND Tier-2 (round finding #6:
  // the prior `=== 2` excluded Tier-1). Tier-3 always parks for the review gate.
  if ((row.tier === 1 || row.tier === 2) && deps.hooks?.integrate) {
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
  // Tier-3 (or no integrate hook): leave for the review gate / producer re-drive.
  return { runId: row.run_id, from: "agent-committed", action: "left" };
}

/**
 * Integrated-but-unfinalized (§ recovery): a durable canonical mutation is
 * forward-only. Reproject (real hook, verified to cover `canonicalSha`) → record
 * `reindexed`; then finalize ONLY once the §2.8 step-4 backup covering the run's
 * seq is verified — a backup failure leaves the run `integrated`/`reindexed` for a
 * later retry rather than declaring `finalized` without durable coverage
 * (round-2 finding).
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

  // §2.8 step 4 FIRST: a verified backup covering this run's committed seq must
  // precede the `finalized` CAS (the state table gates `finalized` on step-4
  // success). Layer 1 already drained pending intents, so the safe backup cut is
  // the latest committed run seq — a verified backup therefore covers this run. If
  // the backup does not succeed, leave the run `reindexed`; a later reconcile
  // retries once the fault clears (round-2 finding: no `finalized` without coverage).
  const backedUp = await runBackupStep(deps.store, deps.backup, 2, now);
  if (!backedUp) {
    return { runId: row.run_id, from: row.status, action: "reindexed", to: "reindexed", reason: "backup-uncovered" };
  }

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

/** Write a `failed@<at>` terminal (run.failed) via the §2.8 orchestrator. */
async function failRun(
  deps: ReconcileDeps,
  row: AgentRunRow,
  at: WorkflowState,
  reason: string,
  now: () => string,
): Promise<void> {
  const ts = now();
  await finalizeLedgerWrite(deps.store, deps.broker, {
    runId: row.run_id,
    event: {
      schemaVersion: 1,
      eventId: newRunId(),
      kind: "run.failed",
      occurredAt: ts,
      runId: row.run_id,
      subjects: [],
      canonicalCommit: "0".repeat(40),
      detail: { failedAt: at, reason },
    },
    ledgerWrite: [
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
        // `extraCommit` affected-row assertion rolls the whole terminal tx back.
        expectedFrom: [at],
      }),
    ],
    backup: deps.backup,
    now,
    extraCommit: (tx) => assertRowAdvancedTo(tx, row.run_id, "failed"),
  });
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

/**
 * Layer 0 (§ recovery `integrated` case (a)) — resolve every `pending`
 * `run.integrated` intent left by an interrupted `RunHandle.integrate`. Because
 * `run.integrated` is canonical-INSTALLING, the generic ledger drain refuses it
 * (Layer 1 skips this kind), so this pass owns it. Each intent is classified
 * against the AUTHORITATIVE broker + canonical-ref state:
 *
 *   - **un-anchored** (broker signing refusal `broker.audit_kind_not_signable`) —
 *     the broker appends BEFORE its canonical CAS, so an un-anchored event proves
 *     canonical did not advance and the seq was never anchored. DROP the abandoned
 *     intent so the run re-drives integration from `agent-committed` with a fresh
 *     seq (gapless: the seq is unused). This is the ONLY case that deletes.
 *   - **anchored + canonical CONTAINS the commit** (by ancestry, round-2 finding
 *     W4) — the install completed; LAND step-3 here (record `integrated`) and mark
 *     the intent `done`.
 *   - **anchored + canonical does NOT contain the commit** — an append-success /
 *     canonical-CAS-failure. The event is durable audit evidence; PRESERVE the
 *     intent (round-2 finding W6) — never delete it — and SURFACE the run as
 *     action-required. A later pass lands it once canonical advances; the preserved
 *     same seq forbids re-driving another `run.integrated`.
 *
 * A transient/ambiguous broker error (not the signing refusal) is NOT proof of
 * un-anchoring: the intent is preserved and the error re-thrown so a later reconcile
 * retries. Returns the `runId`s surfaced as action-required.
 */
async function resolveIntegrationIntents(
  store: Store,
  broker: AuditBroker,
  repo: Repo,
  now: () => string,
): Promise<{ actionRequired: string[]; barrierSeq: number | null }> {
  const intents = new IntentsRepo(store.db);
  const actionRequired: string[] = [];
  // The highest seq ever ALLOCATED (pending or done) — used to decide whether dropping
  // an un-anchored intent would punch a permanent hole (round-3 finding on
  // reconciler.ts:716-718): a higher allocation means a later intent depends on this
  // seq existing in the gapless chain, so it must be PRESERVED as a barrier, not deleted.
  // Range-partitioned to the run space (round-2 finding, same class as the #291
  // nextRunSeq fix): an intent stranded at >= DB_EVENT_SEQ_BASE by the pre-fix
  // allocator must not read as "a later allocation exists" forever — that would
  // permanently disable the un-anchored auto-drop below on an ex-poisoned vault.
  const maxAllocatedSeq = (
    store.db.prepare(`SELECT COALESCE(MAX(seq), -1) AS m FROM audit_intents WHERE seq < ${DB_EVENT_SEQ_BASE}`).get() as { m: number }
  ).m;
  for (const row of intents.listPending()) {
    if (!row.event_json) continue;
    const event = IntentsRepo.parseEvent(row);
    if (event.kind !== "run.integrated") continue;
    let head: string;
    try {
      const anchored = await broker.signAndAppendAuditEvent(event); // idempotent replay if already anchored
      head = anchored.head;
    } catch (err) {
      // Ambiguous/transient error (not the signing refusal) ⇒ cannot prove un-anchored:
      // PRESERVE the intent as a barrier and surface it — never destroy possibly-durable
      // evidence, and never advance past it (round-3 finding on reconciler.ts:700-756).
      if (!isAuditKindNotSignable(err)) {
        actionRequired.push(row.run_id);
        return { actionRequired, barrierSeq: row.seq };
      }
      // Un-anchored (signing refusal) ⇒ canonical never advanced. Normally the
      // abandoned seq is dropped so the run re-drives with a fresh seq. But if a HIGHER
      // seq was already allocated (a concurrent later intent), deleting this seq would
      // leave a PERMANENT hole in the gapless chain (round-3 finding on
      // reconciler.ts:716-718) — the later intent could never anchor at `last+1`.
      // PRESERVE it as an ordered barrier instead (the run re-drives at the SAME seq),
      // and HALT so no later intent is completed past it.
      if (row.seq < maxAllocatedSeq) {
        actionRequired.push(row.run_id);
        return { actionRequired, barrierSeq: row.seq };
      }
      store.db.prepare(`DELETE FROM audit_intents WHERE run_id = ? AND seq = ? AND state = 'pending'`).run(row.run_id, row.seq);
      continue;
    }

    // Anchored — but that is NOT proof canonical advanced (append precedes the
    // canonical CAS). Require AUTHORITATIVE containment by ANCESTRY (round-2 finding
    // W4): a canonical tip that advanced beyond the installed commit still contains
    // it, so ancestry — not tip-equality — is the correct test.
    const base = readGitOp(store.db, row.run_id, "base");
    const canonicalRef = base?.refName ?? null;
    const installed = event.canonicalCommit;
    const canonicalNow = canonicalRef ? await repo.readRef(canonicalRef) : null;
    const contained =
      canonicalRef !== null &&
      canonicalNow !== null &&
      installed !== "0".repeat(40) &&
      (await repo.isAncestor(installed, canonicalNow));

    if (contained) {
      // Canonical genuinely contains the commit → land step-3 by REPLAYING the intent's
      // EXACT persisted `write_json` (round-3 finding on reconciler.ts:738-747), NOT by
      // reconstructing the write from current mutable `agent_runs` metadata (which may
      // have diverged). Validate payload identity first: the recomputed hash of the
      // stored event MUST equal the intent's `payload_hash` (the anchored event's hash),
      // proving the persisted write belongs to this exact audit event.
      const recomputed = payloadHashOf(event);
      if (recomputed !== row.payload_hash) {
        // Corrupt/mismatched intent — never fabricate. Preserve as a barrier + surface.
        actionRequired.push(row.run_id);
        return { actionRequired, barrierSeq: row.seq };
      }
      recordIntegrationFromIntent(store, {
        runId: row.run_id,
        seq: row.seq,
        payloadHash: row.payload_hash,
        canonicalRef: canonicalRef!,
        canonicalSha: installed,
        auditHead: head,
        write: IntentsRepo.parseWrite(row),
        now: now(),
      });
      continue;
    }

    // Anchored but canonical does NOT contain the claimed commit (append-success /
    // CAS-failure). PRESERVE the intent (round-2 finding W6) — its linkage to the
    // immutable audit event must survive and no fresh seq may re-drive integration —
    // and surface the run as action-required. As the FIRST unresolved sequence it is
    // also the ordered BARRIER (round-3 finding on reconciler.ts:700-756): HALT so
    // layer 0 never completes a LATER integrated intent past this unresolved earlier
    // one, and layer 1 stops before it.
    actionRequired.push(row.run_id);
    return { actionRequired, barrierSeq: row.seq };
  }
  return { actionRequired, barrierSeq: null };
}
