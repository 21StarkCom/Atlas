/**
 * `sync/cycle` — the absorb-cycle engine (60-B Tasks 4.4–4.8; spec §behavior).
 *
 * One cycle = one engine run. The shape mirrors `ingest/note-add` exactly
 * (plan → worktree mirror of the upstream delta → ONE agent commit → ONE
 * broker CAS integrate under scope `"sync"` → provenance + notes fold →
 * finalize), with three sync-specific properties:
 *
 * - **OQ#5 REJECT guard before any diff** — a non-ancestral or unreachable
 *   cursor halts (exit 2, error envelope, cursor unadvanced, no run, no ledger
 *   write, no audit append). Recovery is Phase 5's operator-authorized
 *   `sync reset`, never automatic.
 * - **The finalize transaction is the cursor's only writer**: cursor advance,
 *   the reconciled pending-quarantine set, and the single `index:reconcile`
 *   enqueue land atomically with the run's `finalized` terminal (§2.8 step 3).
 * - **A durable finalization intent rides the `run.integrated` event detail**
 *   (persisted in `audit_intents.event_json` at §2.8 step 1, BEFORE the ref
 *   move). A crash between integrate and finalize is replayed from that intent
 *   by `recoverSyncRuns` — never re-derived from the upstream diff, which
 *   post-integrate would classify every byte `unchanged` and strand the
 *   fold/enqueue/cursor forever. `recoverSyncRuns` is the SOLE recovery path
 *   for sync runs (the generic reconciler leaves them); it also fails
 *   pre-integrate zombies so the next cycle re-derives cleanly.
 *
 * The all-quarantined / all-unchanged cycle is a successfully FINALIZED run
 * with an empty ChangePlan: no integrate, no canonical move — `planned →
 * finalized` via the engine's explicit empty-plan edge; the run's `run.planned`
 * audit event is its trail, and the cursor still advances (every path is
 * terminally disposed: absorbed, archived, renamed, or quarantined-and-
 * recorded).
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newRunId, type RunManifest } from "@atlas/contracts";
import { enqueue, type JobId } from "@atlas/jobs";
import type { Repo } from "@atlas/git";
import type { Store } from "@atlas/sqlite-store";
import {
  startRun,
  reconcileRunsOnStartup,
  sha256Canonical,
  canTerminateFrom,
  type ReconcileHooks,
  type WorkflowDeps,
} from "../workflows/index.js";
import { foldNotesForPaths } from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";
import { foldProvenanceFromCanonical } from "../ingest/manifests.js";
import type { CaptureDeps, CaptureIntegration } from "../ingest/capture.js";
import { noteGlobPathspec } from "../vault/note-matcher.js";
import { resolveAtRef } from "./resolve-at-ref.js";
import { INDEX_RECONCILE_WORKFLOW } from "./reconcile-handler.js";
import { readCursor, finalizeCursor, type PendingEntry, type SyncCursor, MalformedPendingError } from "./cursor.js";
import { detectDivergence, countBehind } from "./diff.js";
// (expandChange stays plan-internal — computeBlocked shares the whole planning walk instead.)
import { scanBytes, SecretDetectedError } from "@atlas/scan";
import {
  buildSyncPlan,
  SyncBlockedError,
  SyncPlanError,
  type SyncPlan,
  type SyncPlanDeps,
  type ScanOutcome,
} from "./plan.js";

/** The `sync` success envelope (mirrors docs/specs/cli-contract/sync.schema.json). */
export interface SyncEnvelope {
  readonly command: "sync";
  readonly cursorFrom: string | null;
  readonly cursorTo: string | null;
  readonly upstreamHead: string;
  readonly absorbed: readonly { path: string; noteId: string; contentId: string; action: string }[];
  readonly quarantined: readonly { path: string; quarantineId: string }[];
  readonly archived: readonly { path: string; noteId: string }[];
  readonly renamed: readonly { fromPath: string; toPath: string; noteId: string }[];
  readonly clearedPending: readonly { path: string; quarantineId: string }[];
  readonly appliedOps: number;
  readonly reconcileJobId: string | null;
  readonly cycleSeq: number;
  readonly truncated: boolean;
}

export interface SyncSuccess {
  readonly exitCode: number;
  readonly envelope: SyncEnvelope;
}

export interface SyncCycleOptions {
  readonly dryRun?: boolean;
  readonly maxPaths?: number;
}

/** Everything a cycle needs; the command layer wires it from RunContext/config. */
export interface SyncCycleDeps {
  readonly store: Store;
  readonly repo: Repo;
  /** Capture-style seam: broker connection with scope "sync" (unused on dry-run). */
  readonly connectIntegration: CaptureDeps["connectIntegration"];
  readonly backup: CaptureDeps["backup"];
  readonly worktreesPath: string;
  readonly canonicalRef: string;
  /** The un-adopted default canonical ref — syncing against it is refused. */
  readonly defaultCanonicalRef: string;
  readonly noteGlobs: readonly string[];
  readonly now: () => string;
  /** Attributable per-path scan (real: quarantine-before-throw + captured id; dry: verdict only). */
  readonly scanNoteBytes: (bytes: Buffer, origin: string) => Promise<ScanOutcome>;
  /** Non-attributable generated-artifact scan (throws SecretDetectedError, exit 3). */
  readonly scanGeneratedArtifact: (text: string, runId: string) => Promise<void>;
  /** TEST-ONLY crash injection at the cycle's recovery boundaries (Task 4.8). Never set in production. */
  readonly failpoints?: {
    /** Fires at agent-committed, BEFORE the broker append/CAS — a clean pre-integrate crash. */
    readonly beforeIntegrate?: () => void;
    readonly afterIntegrate?: () => void;
    readonly afterReindexed?: () => void;
    readonly beforeFinalize?: () => void;
  };
}

/** The durable finalization intent carried on the run.integrated event detail. */
export interface SyncIntent {
  readonly sourceId: string;
  readonly upstreamRef: string;
  readonly cursorFrom: string | null;
  /** The upstream commit boundary the cursor advances to. */
  readonly targetOid: string;
  /** == the agent commit == the canonical sha after integrate (the enqueue idempotency key). */
  readonly canonicalSha: string;
  readonly changedNoteIds: readonly string[];
  readonly pendingQuarantine: readonly PendingEntry[];
}

const err = (code: string, message: string, hint: string, retryable = false): CliError =>
  new CliError({ code, message, hint, exitCode: EXIT.CONFIG, retryable });

/**
 * Resolve the single adopted source's cursor row. V1 adopts exactly one vault;
 * zero rows ⇒ un-adopted (vault-error), more ⇒ out of scope (vault-error).
 */
export function readSingleCursor(store: Store): SyncCursor {
  let ids: { source_id: string }[];
  try {
    ids = store.db.prepare(`SELECT source_id FROM sync_cursors ORDER BY source_id`).all() as { source_id: string }[];
  } catch {
    throw err("vault-error", "sync_cursors table is missing — the vault is not adopted", "Run `db migrate` and provisioning/adopt-vault.sh first.");
  }
  if (ids.length === 0) {
    throw err("vault-error", "no sync_cursors row — the vault is not adopted", "Run provisioning/adopt-vault.sh to adopt the vault.");
  }
  if (ids.length > 1) {
    throw err("vault-error", `expected one adopted source, found ${ids.length}`, "Multi-source sync is out of V1 scope.");
  }
  try {
    return readCursor(store, ids[0]!.source_id)!;
  } catch (e) {
    if (e instanceof MalformedPendingError) {
      throw err("vault-error", e.message, "The durable pending_quarantine set failed validation; restore from backup or reseed.");
    }
    throw e;
  }
}

/** The step-2 preconditions shared by `sync` and `sync status`. */
export function assertAdoptedConfig(deps: Pick<SyncCycleDeps, "canonicalRef" | "defaultCanonicalRef">, row: SyncCursor): void {
  if (deps.canonicalRef === row.upstreamRef) {
    throw new CliError({
      code: "config-invalid",
      message: `git.canonical_ref (${deps.canonicalRef}) equals the sync upstream ref — sync would write the live upstream`,
      hint: "An adopted vault's canonical ref must be a broker-owned ref distinct from upstream (e.g. refs/atlas/main).",
      exitCode: EXIT.CONFIG,
    });
  }
  if (deps.canonicalRef === deps.defaultCanonicalRef) {
    throw new CliError({
      code: "config-invalid",
      message: `git.canonical_ref is still the un-adopted default (${deps.defaultCanonicalRef})`,
      hint: "Set git.canonical_ref to the adopted broker-owned ref (refs/atlas/main) before syncing.",
      exitCode: EXIT.CONFIG,
    });
  }
}

/** Map a divergence verdict to the OQ#5 REJECT halt (error envelope, exit 2). */
function divergenceError(state: "non-ancestral" | "cursor-unreachable"): CliError {
  return new CliError({
    code: `diverged:${state}`,
    message:
      state === "non-ancestral"
        ? "the sync cursor is no longer an ancestor of the upstream head (force-push/rewrite)"
        : "the sync cursor commit no longer resolves in the repo (upstream gc)",
    hint: "Automatic re-convergence is disabled by design (OQ#5 REJECT). Recover with the operator-authorized `sync reset`.",
    exitCode: EXIT.CONFIG,
    retryable: false,
  });
}

interface CycleContext {
  readonly deps: SyncCycleDeps;
  readonly row: SyncCursor;
  readonly upstreamHead: string;
}

/** Shared step-1/2 preamble: cursor, config gate, divergence, behindBy. */
async function preamble(deps: SyncCycleDeps): Promise<{ ctx: CycleContext; behindBy: number }> {
  const row = readSingleCursor(deps.store);
  assertAdoptedConfig(deps, row);
  const upstreamHead = await deps.repo.readRef(row.upstreamRef);
  if (upstreamHead === null) {
    throw err("vault-error", `upstream ref ${row.upstreamRef} does not resolve`, "The adopted vault's upstream branch is missing.");
  }
  const divergence = await detectDivergence(deps.repo, row.lastAbsorbedOid, upstreamHead);
  if (divergence.state !== "ok") throw divergenceError(divergence.state);
  const behindBy = await countBehind(deps.repo, row.lastAbsorbedOid, upstreamHead);
  return { ctx: { deps, row, upstreamHead }, behindBy };
}

const noRunEnvelope = (row: SyncCursor, upstreamHead: string, plan?: SyncPlan): SyncEnvelope => ({
  command: "sync",
  cursorFrom: row.lastAbsorbedOid,
  cursorTo: row.lastAbsorbedOid,
  upstreamHead,
  absorbed: plan?.absorbed ?? [],
  quarantined: plan?.quarantined.map((q) => ({ path: q.path, quarantineId: "" })) ?? [],
  archived: plan?.archived ?? [],
  renamed: plan?.renamed ?? [],
  clearedPending: plan?.clearedPending ?? [],
  appliedOps: 0,
  reconcileJobId: null,
  cycleSeq: row.cycleSeq,
  truncated: plan?.truncated ?? false,
});

/**
 * Run one absorb cycle. The caller holds the `vault-maintenance` lock and has
 * bound an `EnqueueContext` on `deps.store.db`. Throws `CliError` /
 * `SecretDetectedError` for every non-success outcome; returns the success
 * envelope with exit 0 (clean) or 6 (≥1 attributable quarantine).
 */
export async function runSyncCycle(deps: SyncCycleDeps, opts: SyncCycleOptions = {}): Promise<SyncSuccess> {
  if (opts.dryRun === true) return dryRunCycle(deps, opts);

  const integration = await deps.connectIntegration();
  try {
    // Startup recovery. ORDER IS LOAD-BEARING: the generic reconciler runs FIRST
    // — its layer-0 lands an anchored `run.integrated` intent's §2.8 step-3
    // (promoting an agent-committed mid-integrate-crash run to `integrated`), and
    // its `recoverRun` now LEAVES every `operation:"sync"` run (never finalizing
    // one without the cursor/fold/enqueue extras). `recoverSyncRuns` then runs as
    // the SOLE finalizer of sync runs: it replays integrated/reindexed runs from
    // their durable intent and fails pre-integrate zombies so the next cycle
    // re-derives cleanly. (#289 review: CRITICAL — generic recovery finalized
    // stuck sync runs and stranded the cursor.)
    await runStartupRecovery(deps, integration);
    await recoverSyncRuns(deps, integration);

    // Re-read AFTER recovery — the replay may have advanced the cursor.
    const { ctx, behindBy } = await preamble(deps);
    if (behindBy === 0) {
      return { exitCode: EXIT.OK, envelope: noRunEnvelope(ctx.row, ctx.upstreamHead) };
    }
    return await absorb(ctx, integration, opts);
  } finally {
    integration.close();
  }
}

/** `--dry-run`: plan + classify + scan preflight; open no run, mutate nothing. */
async function dryRunCycle(deps: SyncCycleDeps, opts: SyncCycleOptions): Promise<SyncSuccess> {
  const { ctx, behindBy } = await preamble(deps);
  if (behindBy === 0) {
    return { exitCode: EXIT.OK, envelope: noRunEnvelope(ctx.row, ctx.upstreamHead) };
  }
  const plan = await computePlan(ctx, opts, newRunId(), await resolveCanonicalBase(deps));
  return { exitCode: EXIT.OK, envelope: noRunEnvelope(ctx.row, ctx.upstreamHead, plan) };
}

async function resolveCanonicalBase(deps: SyncCycleDeps): Promise<string> {
  const canonicalBase = await deps.repo.readRef(deps.canonicalRef);
  if (canonicalBase === null) {
    throw err(
      "vault-error",
      `canonical ref ${deps.canonicalRef} does not resolve — the vault is not adopted`,
      "provisioning/adopt-vault.sh creates the broker-owned canonical baseline.",
    );
  }
  return canonicalBase;
}

async function computePlan(ctx: CycleContext, opts: SyncCycleOptions, runId: string, canonicalBase: string): Promise<SyncPlan> {
  const { deps, row, upstreamHead } = ctx;
  const commits = await deps.repo.commitsInRange(row.lastAbsorbedOid, upstreamHead, noteGlobPathspec(deps.noteGlobs));
  const planDeps: SyncPlanDeps = {
    repo: deps.repo,
    canonicalBase,
    noteGlobs: deps.noteGlobs,
    pendingBefore: row.pendingQuarantine,
    scanNoteBytes: deps.scanNoteBytes,
    scanGeneratedArtifact: (text) => deps.scanGeneratedArtifact(text, runId),
  };
  try {
    return await buildSyncPlan(planDeps, commits, opts.maxPaths === undefined ? {} : { maxPaths: opts.maxPaths });
  } catch (e) {
    // The commit-attributed blocked wrapper is for `computeBlocked`; the live
    // cycle surfaces the underlying SecretDetectedError (exit 3, cursor
    // unadvanced) with the commit named in the envelope hint via sync status.
    if (e instanceof SyncBlockedError) throw e.cause;
    if (e instanceof SyncPlanError) {
      throw new CliError({
        code: e.code === "vault-error" ? "vault-error" : "internal",
        message: e.message,
        hint:
          e.code === "vault-error"
            ? "The cursor did not advance; fix the offending note upstream or adjust vault.note_globs."
            : "The cursor did not advance; the next cycle re-derives the identical delta.",
        exitCode: e.code === "vault-error" ? EXIT.CONFIG : EXIT.INTERNAL,
        retryable: e.code !== "vault-error",
      });
    }
    throw e;
  }
}

/** The non-empty-delta absorb: one run, at most one integrate, one finalize. */
async function absorb(ctx: CycleContext, integration: CaptureIntegration, opts: SyncCycleOptions): Promise<SyncSuccess> {
  const { deps, row, upstreamHead } = ctx;
  const runId = newRunId();
  const canonicalBase = await resolveCanonicalBase(deps);
  const plan = await computePlan(ctx, opts, runId, canonicalBase);
  const now = deps.now;
  const wdeps: WorkflowDeps = { store: deps.store, broker: integration.broker, backup: deps.backup, repo: deps.repo, now };

  const handle = await startRun(wdeps, { operation: "sync", runId, targetNoteId: null, canonicalCommit: canonicalBase });
  await handle.checkpoint("planned", {
    planId: `${runId}-plan`,
    tier: 1,
    confidence: 1,
    summary: `sync absorb ${row.lastAbsorbedOid ?? "zero-state"}..${plan.boundaryOid} (${plan.appliedOps} ops, ${plan.quarantined.length} quarantined)`,
    planHash: plan.planHash,
    canonicalRef: deps.canonicalRef,
    baseRef: canonicalBase,
  });

  let reconcileJobId: JobId | null = null;

  if (plan.appliedOps === 0) {
    // All-quarantined / all-unchanged: an empty ChangePlan — no integrate, no
    // canonical move; the run finalizes straight from `planned` and the cursor
    // still advances (every path is terminally disposed).
    deps.failpoints?.beforeFinalize?.();
    await handle.finalize(undefined, {
      fromEmptyPlan: true,
      extraCommit: (db) => {
        finalizeCursor(db, {
          sourceId: row.sourceId,
          newOid: plan.boundaryOid,
          now: now(),
          pendingQuarantine: plan.pendingAfter,
        });
      },
    });
    return {
      exitCode: plan.quarantined.length > 0 ? EXIT.ACTION_REQUIRED : EXIT.OK,
      envelope: envelopeFor(row, upstreamHead, plan, null),
    };
  }

  let worktreeDir: string | null = null;
  try {
    const agentRef = await deps.repo.createAgentBranch(runId, deps.canonicalRef);
    worktreeDir = await mkdtemp(
      join(deps.worktreesPath && existsSync(deps.worktreesPath) ? deps.worktreesPath : tmpdir(), `atlas-sync-${runId}-`),
    );
    const worktree = await deps.repo.addWorktree(agentRef, worktreeDir);

    // Mirror the FINAL upstream state for every touched path.
    for (const p of plan.fileDeletes) {
      await rm(join(worktreeDir, p), { force: true });
    }
    let changedLines = 0;
    for (const [p, bytes] of plan.fileWrites) {
      await mkdir(join(worktreeDir, dirname(p)), { recursive: true });
      await writeFile(join(worktreeDir, p), bytes);
      changedLines += bytes.toString("utf8").split("\n").length;
    }

    const patchHash = sha256Canonical({ planHash: plan.planHash });
    await handle.checkpoint("patched", {
      patchId: `${runId}-patch`,
      planId: `${runId}-plan`,
      noteId: plan.changedNoteIds[0]!,
      changedLines,
      changedSections: plan.fileWrites.size + plan.fileDeletes.length,
      patchHash,
      planHash: plan.planHash,
    });

    const treeHash = sha256Canonical({
      writes: [...plan.fileWrites.entries()].map(([p, b]) => [p, sha256Canonical({ h: b.toString("base64") })]).sort(),
      deletes: plan.fileDeletes,
    });
    await handle.checkpoint("worktree-applied", { worktreePath: worktreeDir, treeHash, agentRef });

    const manifest: RunManifest = {
      schemaVersion: 1,
      runId,
      state: "agent-committed",
      createdAt: now(),
      canonicalBaseCommit: canonicalBase,
      targets: [...plan.changedNoteIds],
    };
    const commitSha = await worktree.commit(
      `sync: absorb ${row.lastAbsorbedOid ?? "zero-state"}..${plan.boundaryOid}`,
      manifest,
    );
    await handle.checkpoint("agent-committed", { commitSha, treeHash, agentRef, tier: 1 });
    // Pre-integrate crash window: the run is durably `agent-committed`, NO broker
    // append or canonical move has happened, and no intent is anchored (Task 4.8).
    deps.failpoints?.beforeIntegrate?.();

    // The durable finalization intent — everything replay needs, persisted in
    // the §2.8 step-1 intent BEFORE the ref moves.
    const intent: SyncIntent = {
      sourceId: row.sourceId,
      upstreamRef: row.upstreamRef,
      cursorFrom: row.lastAbsorbedOid,
      targetOid: plan.boundaryOid,
      canonicalSha: commitSha,
      changedNoteIds: plan.changedNoteIds,
      pendingQuarantine: plan.pendingAfter,
    };
    const integrated = await handle.integrate(integration.integrate, { extraDetail: { sync: intent } });
    deps.failpoints?.afterIntegrate?.();

    await foldProvenanceFromCanonical(deps.store, deps.repo, deps.canonicalRef);
    foldNotesForPaths(deps.store, [...plan.changedNoteIds], resolveAtRef(deps.repo, deps.canonicalRef, deps.noteGlobs));
    await handle.checkpoint("reindexed", { indexGeneration: 1, canonicalSha: integrated.canonicalSha });
    deps.failpoints?.afterReindexed?.();

    await handle.finalize(undefined, {
      extraCommit: (db) => {
        finalizeCursor(db, {
          sourceId: row.sourceId,
          newOid: plan.boundaryOid,
          now: now(),
          pendingQuarantine: plan.pendingAfter,
        });
        reconcileJobId = enqueue(db, {
          workflow: INDEX_RECONCILE_WORKFLOW,
          idempotencyKey: integrated.canonicalSha,
          payload: { noteIds: [...plan.changedNoteIds] },
        });
      },
    });

    await cleanupWorktree(deps.repo, worktreeDir);
    worktreeDir = null;
    return {
      exitCode: plan.quarantined.length > 0 ? EXIT.ACTION_REQUIRED : EXIT.OK,
      envelope: envelopeFor(row, upstreamHead, plan, reconcileJobId),
    };
  } finally {
    if (worktreeDir !== null) await cleanupWorktree(deps.repo, worktreeDir);
  }
}

function envelopeFor(row: SyncCursor, upstreamHead: string, plan: SyncPlan, reconcileJobId: string | null): SyncEnvelope {
  return {
    command: "sync",
    cursorFrom: row.lastAbsorbedOid,
    cursorTo: plan.boundaryOid,
    upstreamHead,
    absorbed: plan.absorbed,
    quarantined: plan.quarantined,
    archived: plan.archived,
    renamed: plan.renamed,
    clearedPending: plan.clearedPending,
    appliedOps: plan.appliedOps,
    reconcileJobId,
    cycleSeq: row.cycleSeq + 1,
    truncated: plan.truncated,
  };
}

async function runStartupRecovery(deps: SyncCycleDeps, integration: CaptureIntegration): Promise<void> {
  const reindexHook: ReconcileHooks["reindex"] = async () => {
    const head = await foldProvenanceFromCanonical(deps.store, deps.repo, deps.canonicalRef);
    return { indexGeneration: 1, canonicalSha: head };
  };
  await reconcileRunsOnStartup({
    store: deps.store,
    broker: integration.broker,
    repo: deps.repo,
    backup: deps.backup,
    hooks: { reindex: reindexHook },
    now: deps.now,
  });
}

/** Parse the sync intent back out of the run's durable `run.integrated` intent row. */
export function readSyncIntent(store: Store, runId: string): SyncIntent | null {
  const rows = store.db
    .prepare(`SELECT event_json FROM audit_intents WHERE run_id = ? ORDER BY seq DESC`)
    .all(runId) as { event_json: string }[];
  for (const r of rows) {
    try {
      const ev = JSON.parse(r.event_json) as { kind?: string; detail?: { sync?: SyncIntent } };
      if (ev.kind === "run.integrated" && ev.detail?.sync !== undefined) return ev.detail.sync;
    } catch {
      /* a non-JSON row is not ours */
    }
  }
  return null;
}

/** What `recoverSyncRuns` did to the interrupted sync runs it found. */
export interface SyncRecoveryReport {
  /** integrated/reindexed runs whose finalize was replayed from the intent. */
  readonly replayed: number;
  /** pre-integrate zombies failed so the next cycle re-derives cleanly. */
  readonly failed: number;
}

/**
 * The SOLE recovery path for `operation:"sync"` runs (the generic reconciler
 * leaves them — see `reconciler.ts` `recoverRun`). Runs AFTER the generic pass,
 * so an anchored `run.integrated` intent has already been landed (layer-0
 * promoted its run to `integrated`). Two dispositions:
 *
 * - **`integrated`/`reindexed`** (canonical DID advance): replay fold + cursor
 *   advance + the single `index:reconcile` enqueue idempotently FROM THE DURABLE
 *   INTENT — never from the upstream diff, which post-integrate classifies every
 *   byte `unchanged` and would strand the fold/enqueue/cursor forever.
 * - **pre-integrate** (`planned`/`patched`/`worktree-applied`/`agent-committed`
 *   — canonical did NOT advance; a crash before §2.8 step 2, or an un-anchored
 *   intent layer-0 dropped): FAIL the run at its checkpoint so it converges
 *   (agent_runs terminal + its worktree becomes sweep-eligible). The cursor
 *   never moved, so the next cycle re-derives the identical delta and opens a
 *   fresh run. This closes the zombie-run leak.
 */
export async function recoverSyncRuns(deps: SyncCycleDeps, integration: CaptureIntegration): Promise<SyncRecoveryReport> {
  const rows = deps.store.db
    .prepare(
      `SELECT run_id, operation, status FROM agent_runs
        WHERE operation IN ('sync', 'sync-reset')
          AND status NOT IN ('finalized','failed','cancelled','rejected','rolled-back')
        ORDER BY started_at ASC, run_id ASC`,
    )
    .all() as { run_id: string; operation: string; status: string }[];
  const wdeps: WorkflowDeps = {
    store: deps.store,
    broker: integration.broker,
    backup: deps.backup,
    repo: deps.repo,
    now: deps.now,
  };
  let replayed = 0;
  let failed = 0;
  for (const runRow of rows) {
    if (runRow.status === "integrated" || runRow.status === "reindexed") {
      const intent = readSyncIntent(deps.store, runRow.run_id);
      if (intent === null) {
        throw new CliError({
          code: "internal",
          message: `sync run ${runRow.run_id} is ${runRow.status} but carries no sync finalization intent`,
          hint: "The run.integrated intent should always carry detail.sync; inspect audit_intents.",
          exitCode: EXIT.INTERNAL,
        });
      }
      const handle = await startRun(wdeps, { operation: runRow.operation, runId: runRow.run_id, targetNoteId: null, resume: true });
      // Idempotent re-drive of the post-integrate steps.
      await foldProvenanceFromCanonical(deps.store, deps.repo, deps.canonicalRef);
      foldNotesForPaths(deps.store, [...intent.changedNoteIds], resolveAtRef(deps.repo, deps.canonicalRef, deps.noteGlobs));
      if (runRow.status === "integrated") {
        await handle.checkpoint("reindexed", { indexGeneration: 1, canonicalSha: intent.canonicalSha });
      }
      await handle.finalize(undefined, {
        extraCommit: (db) => {
          finalizeCursor(db, {
            sourceId: intent.sourceId,
            newOid: intent.targetOid,
            now: deps.now(),
            pendingQuarantine: intent.pendingQuarantine,
          });
          if (intent.changedNoteIds.length > 0) {
            enqueue(db, {
              workflow: INDEX_RECONCILE_WORKFLOW,
              idempotencyKey: intent.canonicalSha,
              payload: { noteIds: [...intent.changedNoteIds] },
            });
          }
        },
      });
      replayed++;
      continue;
    }
    // Pre-integrate. Two sub-cases (#289 round-2, W6):
    //   (a) A durable run.integrated intent EXISTS but the run is still
    //       pre-integrate — the append/canonical-CAS split window: the broker
    //       anchored run.integrated at seq N, then its canonical CAS failed (or
    //       the process died before it). Layer-0 preserves that intent as
    //       action-required and does NOT promote the run. Force-failing here
    //       would append run.failed atop the already-anchored run.integrated,
    //       corrupting the WORM trail. LEAVE it for operator resolution (the
    //       #65 residual class) — exactly the pre-fix behavior.
    //   (b) NO intent (clean crash before §2.8 step 1): canonical never moved
    //       and nothing was anchored. Fail the run so it converges; the cursor
    //       is untouched, so the next cycle re-derives the identical delta.
    if (readSyncIntent(deps.store, runRow.run_id) !== null) {
      continue; // (a) anchored-intent — leave for operator / sync reset
    }
    const handle = await startRun(wdeps, { operation: runRow.operation, runId: runRow.run_id, targetNoteId: null, resume: true });
    const at = handle.hydrateFromDurable();
    if (at === null || !canTerminateFrom(at)) {
      // A state the terminal contract does not permit failing from — leave it for
      // the generic orphan sweep rather than force an illegal transition.
      continue;
    }
    await handle.fail(at, "sync-crash-pre-integrate: canonical unadvanced; next cycle re-derives");
    failed++;
  }
  return { replayed, failed };
}

async function cleanupWorktree(repo: Repo, dir: string): Promise<void> {
  try {
    await repo.removeWorktree(dir);
  } catch {
    /* best-effort — the reconciler sweeps leftovers */
  }
}

/**
 * Derive the deterministic exit-3 block for `sync status` (Task 4.7). Because
 * the cursor never advances on exit 3, the block is re-derivable: re-run the
 * SAME scan-only planning walk the cycle runs (one derivation, two consumers —
 * status and cycle can never disagree on what blocks) and report the commit
 * the planner's generated-artifact guard refused. Nothing persists — verdicts
 * only; a parse/vault halt is NOT the exit-3 block (sync itself reports it),
 * so `SyncPlanError` yields null.
 *
 * `canonicalBase` MUST be the real pre-cycle canonical OID (`git.canonical_ref`),
 * NOT `upstreamHead` (#289 round-2): the archived-note-id scan runs during
 * end-state derivation, which compares the overlay against `canonicalBase`. A
 * throwaway base mis-derives the archive set (a note present on canonical but
 * deleted at head resolves to null against `upstreamHead`), so the archive
 * scan would be skipped here while the real cycle halts exit 3 on it — the two
 * consumers would disagree. Threading the real base restores the single
 * derivation.
 */
export async function computeBlocked(
  deps: Pick<SyncCycleDeps, "repo" | "noteGlobs">,
  row: SyncCursor,
  upstreamHead: string,
  canonicalBase: string,
): Promise<{ commitOid: string; reason: string } | null> {
  const commits = await deps.repo.commitsInRange(row.lastAbsorbedOid, upstreamHead, noteGlobPathspec(deps.noteGlobs));
  if (commits.length === 0) return null;
  const dry: SyncPlanDeps = {
    repo: deps.repo,
    // The real pre-cycle canonical base, so the end-state archive derivation
    // (and its archived-id scan) matches the live cycle exactly.
    canonicalBase,
    noteGlobs: deps.noteGlobs,
    pendingBefore: [],
    scanNoteBytes: async (bytes, origin) => {
      await Promise.resolve();
      const v = scanBytes({ bytes, context: { origin, boundary: "pre-persistence", kind: "raw" } });
      return v.clean ? { clean: true } : { clean: false, quarantineId: "" };
    },
    scanGeneratedArtifact: async (text) => {
      await Promise.resolve();
      const v = scanBytes({
        bytes: new TextEncoder().encode(text),
        context: { origin: "sync-status:blocked", boundary: "generated-artifact", sink: "audit" },
      });
      if (!v.clean) throw new SecretDetectedError("sync-status:blocked", v.findings, "generated-artifact");
    },
  };
  try {
    await buildSyncPlan(dry, commits, {});
  } catch (e) {
    if (e instanceof SyncBlockedError) {
      const c = e.cause;
      const reason =
        c instanceof SecretDetectedError
          ? `generated-artifact verdict: ${c.findings.map((f) => f.ruleId).join(",")}`
          : e.reason;
      return { commitOid: e.commitOid, reason };
    }
    if (e instanceof SyncPlanError) return null;
    throw e;
  }
  return null;
}
