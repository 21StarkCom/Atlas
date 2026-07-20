/**
 * `sync/reset` — the operator-authorized OQ#5 escape hatch (60-B Phase 5).
 *
 * `sync` REJECT-halts on a divergent cursor (non-ancestral / gc-unreachable) or
 * a deterministic exit-3 block; `sync reset` is the "operator action" that
 * recovery requires. It is **tree-reconcile, not history-replay**: it diffs the
 * canonical tree against the current upstream tree over the note globs and
 * absorbs the net difference (archive what vanished upstream, capture what is
 * present) as ONE reconciled commit that is a **child of the current canonical
 * head** — always a fast-forward — then re-baselines the cursor to the upstream
 * head, accepting (and auditing) the history gap.
 *
 * Authorization (privileged). Two exclusive modes:
 *  - `--export-challenge`: scanned, READ-ONLY planning (dry scanners — nothing
 *    persists) → emit the broker AuthorizationChallenge bound to the canonical
 *    base + a deterministic reconciliation-plan digest. Exit 0.
 *  - `--authorization <path>`: `client.execAuthorized` verifies the signed
 *    challenge (the operator-consent gate — canonical-tip drift ⇒
 *    `authz.canonical_moved`; a changed upstream tree / note globs / plan ⇒ a
 *    different plan digest ⇒ `authz.target_mismatch`; both refused before any
 *    mutation), then the mechanical canonical move rides the cycle's own
 *    scope-`"sync"` FF integrate + a `cycle_seq` CAS on the finalize.
 *
 * The reconcile is fail-closed: a dirty upstream byte is quarantined, not
 * absorbed (partial reconcile, exit 6, tree-equals-upstream over non-quarantined
 * paths only); a still-present deterministic-exit-3 artifact is re-scanned and
 * legitimately still refused (reset is never a scan override). The reset
 * finalization intent rides the `run.integrated` event detail and is replayed by
 * `recoverSyncRuns` (operation `sync-reset`) exactly like the cycle's.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newRunId, type AuthorizationResponse, type RunManifest } from "@atlas/contracts";
import { enqueue, type JobId } from "@atlas/jobs";
import { foldNotesForPaths, type Store } from "@atlas/sqlite-store";
import type { BrokerClient } from "@atlas/broker";
import type { Repo } from "@atlas/git";
import { startRun, sha256Canonical, type WorkflowDeps } from "../workflows/index.js";
import { CliError, EXIT } from "../errors/envelope.js";
import { foldProvenanceFromCanonical } from "../ingest/manifests.js";
import type { CaptureDeps } from "../ingest/capture.js";
import { noteGlobPathspec, matchesNoteGlobs } from "../vault/note-matcher.js";
import { parseNote } from "../vault/reader.js";
import { resolveAtRef } from "./resolve-at-ref.js";
import { INDEX_RECONCILE_WORKFLOW } from "./reconcile-handler.js";
import { readSingleCursor, assertAdoptedConfig, runStartupRecovery, recoverSyncRuns, type SyncCycleDeps, type SyncIntent } from "./cycle.js";
import { finalizeCursor, type PendingEntry } from "./cursor.js";
import { reconcilePending } from "./pending.js";
import { isSyncNotePath, type ScanOutcome } from "./plan.js";

/** The reset op descriptor the broker challenge/authorization binds. */
export interface SyncResetOp {
  readonly op: "sync reset";
  readonly canonicalBaseCommit: string;
  readonly intendedEffect: { readonly kind: "integrate"; readonly tier: 1; readonly changePlanDigest: string };
}

export interface SyncResetDeps extends Omit<SyncCycleDeps, "connectIntegration"> {
  /** Connect the integration broker (holds broker + the scope-"sync" integrate seam + close). */
  readonly connectIntegration: CaptureDeps["connectIntegration"];
  /** The raw broker client for mintChallenge / execAuthorized (the operator-consent gate). */
  readonly connectBroker: () => Promise<BrokerClient>;
}

export interface SyncResetEnvelope {
  readonly command: "sync reset";
  readonly mode: "export-challenge" | "applied";
  readonly reBaselinedTo: string | null;
  readonly canonicalRef: string;
  readonly upstreamRef: string;
  readonly archived: readonly { path: string; noteId: string }[];
  readonly captured: readonly { path: string; noteId: string; contentId: string }[];
  readonly quarantined: readonly { path: string; quarantineId: string }[];
  readonly pendingQuarantine: readonly PendingEntry[];
  readonly reconcileJobId: string | null;
  readonly cycleSeq: number;
  readonly historyGapAccepted: boolean;
}

export interface SyncResetResult {
  readonly exitCode: number;
  readonly envelope: SyncResetEnvelope;
  /** In export mode, the broker challenge to emit (the command JSON-prints it). */
  readonly challenge?: unknown;
}

/** The reconcile plan derived from the canonical↔upstream TREE diff. */
interface ResetPlan {
  readonly canonicalBase: string;
  readonly upstreamHead: string;
  readonly fileWrites: ReadonlyMap<string, Buffer>;
  readonly fileDeletes: readonly string[];
  readonly archived: readonly { path: string; noteId: string }[];
  readonly captured: readonly { path: string; noteId: string; contentId: string }[];
  readonly quarantined: readonly { path: string; quarantineId: string }[];
  readonly pendingAfter: readonly PendingEntry[];
  readonly changedNoteIds: readonly string[];
  /** Deterministic digest of the reconcile decision — the authorization binding. */
  readonly planDigest: string;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const contentIdOf = (b: Buffer): string => `sha256:${sha256(b)}:text/markdown`;

const cfgErr = (code: string, message: string, hint: string): CliError =>
  new CliError({ code, message, hint, exitCode: EXIT.CONFIG });

/**
 * Build the reconcile plan from the canonical↔upstream tree diff. `scanBytes`
 * decides absorb vs quarantine per path (real scanners persist a quarantine
 * record; dry scanners return a verdict only). Pure apart from that scan
 * contract; computes the deterministic plan digest the authorization binds.
 */
async function buildResetPlan(deps: SyncResetDeps): Promise<{ plan: ResetPlan; row: ReturnType<typeof readSingleCursor> }> {
  const row = readSingleCursor(deps.store);
  assertAdoptedConfig(deps, row);
  const canonicalBase = await deps.repo.readRef(deps.canonicalRef);
  if (canonicalBase === null) {
    throw cfgErr("vault-error", `canonical ref ${deps.canonicalRef} does not resolve`, "The vault is not adopted (run provisioning/adopt-vault.sh).");
  }
  const upstreamHead = await deps.repo.readRef(row.upstreamRef);
  if (upstreamHead === null) {
    throw cfgErr("vault-error", `upstream ref ${row.upstreamRef} does not resolve`, "The adopted vault's upstream branch is missing.");
  }

  // Net tree-vs-tree name-status over the note globs (NOT a history walk).
  const changes = await deps.repo.changedPaths(canonicalBase, upstreamHead, noteGlobPathspec(deps.noteGlobs));

  const canonicalNoteId = async (path: string): Promise<string | null> => {
    const bytes = await deps.repo.readBlobAt(canonicalBase, path);
    if (bytes === null) return null;
    const parsed = parseNote(path, bytes.toString("utf8"));
    return parsed.ok ? parsed.note.id : null;
  };

  const fileWrites = new Map<string, Buffer>();
  const fileDeletes: string[] = [];
  const archived: { path: string; noteId: string }[] = [];
  const captured: { path: string; noteId: string; contentId: string }[] = [];
  const quarantined: { path: string; quarantineId: string }[] = [];
  const pendingUpserts: PendingEntry[] = [];
  const clearCandidates: string[] = [];

  // Expand each tree change to BOTH sides for a rename, applying the inclusion rule.
  const steps: { readonly kind: "absorb" | "archive"; readonly path: string }[] = [];
  for (const c of changes) {
    if (c.status === "R") {
      if (c.fromPath !== undefined && isSyncNotePath(c.fromPath, deps.noteGlobs)) steps.push({ kind: "archive", path: c.fromPath });
      if (isSyncNotePath(c.path, deps.noteGlobs)) steps.push({ kind: "absorb", path: c.path });
    } else if (c.status === "D") {
      if (isSyncNotePath(c.path, deps.noteGlobs)) steps.push({ kind: "archive", path: c.path });
    } else if (isSyncNotePath(c.path, deps.noteGlobs)) {
      steps.push({ kind: "absorb", path: c.path });
    }
  }
  // De-dup a path that appears as both archive (rename-from) and absorb (rename-to)
  // is fine — different paths. A path both deleted and re-added collapses via the map.
  const sorted = [...steps].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const step of sorted) {
    if (step.kind === "archive") {
      clearCandidates.push(step.path);
      const noteId = await canonicalNoteId(step.path);
      if (noteId === null) continue; // never absorbed canonically — nothing to archive
      archived.push({ path: step.path, noteId });
      fileDeletes.push(step.path);
      continue;
    }
    // absorb: scan the upstream bytes; dirty ⇒ quarantine (partial reconcile).
    const bytes = await deps.repo.readBlobAt(upstreamHead, step.path);
    if (bytes === null) {
      throw cfgErr("internal", `blob ${upstreamHead}:${step.path} did not resolve during reset planning`, "The upstream tree changed mid-plan; retry.");
    }
    const verdict = await deps.scanNoteBytes(bytes, `${upstreamHead}:${step.path}`);
    if (!verdict.clean) {
      quarantined.push({ path: step.path, quarantineId: verdict.quarantineId });
      pendingUpserts.push({ path: step.path, quarantineId: verdict.quarantineId, firstSeenOid: upstreamHead });
      continue;
    }
    const parsed = parseNote(step.path, bytes.toString("utf8"));
    if (!parsed.ok) {
      throw cfgErr("vault-error", `upstream note ${step.path} failed to parse (${parsed.error.kind}: ${parsed.error.message})`, "Fix it upstream or exclude it via vault.note_globs.");
    }
    clearCandidates.push(step.path);
    fileWrites.set(step.path, bytes);
    captured.push({ path: step.path, noteId: parsed.note.id, contentId: contentIdOf(bytes) });
  }

  // Duplicate note ids across captured paths cannot project — fail closed.
  const byId = new Map<string, string>();
  for (const c of captured) {
    const clash = byId.get(c.noteId);
    if (clash !== undefined) {
      throw cfgErr("vault-error", `duplicate note id "${c.noteId}" at ${clash} and ${c.path} in the upstream tree`, "The upstream vault has an id collision; fix it upstream.");
    }
    byId.set(c.noteId, c.path);
  }

  const reconciled = reconcilePending(row.pendingQuarantine, { clearedPaths: clearCandidates, upsertedDirty: pendingUpserts });
  const changedNoteIds = [...new Set([...captured.map((c) => c.noteId), ...archived.map((a) => a.noteId)])].sort();

  // Scan the Atlas-generated bytes bound for the SIGNED audit ref + canonical
  // commit trailer (#293 review CRITICAL — reset must NOT bypass the guard the
  // cycle applies). Captured-note ids ride inside their raw bytes (already
  // scanned by scanNoteBytes above), but ARCHIVED ids come from the pre-cycle
  // canonical tree and are never in an upstream blob — so a secret-bearing
  // archived id would otherwise reach the audit ref unscanned. Scan the archived
  // ids + the full changed-note-id/path serialization (the intent detail +
  // manifest.targets content); a dirty verdict throws SecretDetectedError →
  // exit 3, cursor unadvanced (reset is never a scan override).
  await deps.scanGeneratedArtifact(
    JSON.stringify({
      archivedNoteIds: [...new Set(archived.map((a) => a.noteId))].sort(),
      changedNoteIds,
      capturedPaths: captured.map((c) => c.path).sort(),
    }),
    "sync-reset",
  );

  // The authorization binding: a pure function of the reconcile DECISION, so any
  // drift in canonical base, upstream head, note globs, or the reconcile output
  // changes it → the broker refuses a stale authorization (authz.target_mismatch).
  const planDigest =
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify({
          canonicalBase,
          upstreamHead,
          noteGlobs: [...deps.noteGlobs],
          writes: [...fileWrites.entries()].map(([p, b]) => [p, sha256(b)]).sort(),
          deletes: [...new Set(fileDeletes)].sort(),
          quarantined: quarantined.map((q) => q.path).sort(),
        }),
      )
      .digest("hex");

  return {
    row,
    plan: {
      canonicalBase,
      upstreamHead,
      fileWrites,
      fileDeletes: [...new Set(fileDeletes)].sort(),
      archived,
      captured,
      quarantined,
      pendingAfter: reconciled.entries,
      changedNoteIds,
      planDigest,
    },
  };
}

const resetOp = (plan: ResetPlan): SyncResetOp => ({
  op: "sync reset",
  canonicalBaseCommit: plan.canonicalBase,
  intendedEffect: { kind: "integrate", tier: 1, changePlanDigest: plan.planDigest },
});

function exportEnvelope(deps: SyncResetDeps, row: ReturnType<typeof readSingleCursor>, plan: ResetPlan): SyncResetEnvelope {
  return {
    command: "sync reset",
    mode: "export-challenge",
    reBaselinedTo: plan.upstreamHead,
    canonicalRef: deps.canonicalRef,
    upstreamRef: row.upstreamRef,
    archived: plan.archived,
    captured: plan.captured,
    quarantined: plan.quarantined.map((q) => ({ path: q.path, quarantineId: "" })),
    pendingQuarantine: plan.pendingAfter,
    reconcileJobId: null,
    cycleSeq: row.cycleSeq,
    historyGapAccepted: true,
  };
}

/** `--export-challenge`: read-only plan (dry scanners) → mint + return the challenge. */
export async function exportResetChallenge(deps: SyncResetDeps): Promise<SyncResetResult> {
  const { plan, row } = await buildResetPlan(deps);
  const client = await deps.connectBroker();
  try {
    const challenge = await client.mintChallenge(resetOp(plan));
    return { exitCode: EXIT.OK, envelope: exportEnvelope(deps, row, plan), challenge };
  } finally {
    client.close();
  }
}

/**
 * `--authorization`: verify the operator's authorization (execAuthorized — the
 * consent gate, refuses drift before any mutation), then re-converge.
 */
export async function applySyncReset(deps: SyncResetDeps, authorization: AuthorizationResponse): Promise<SyncResetResult> {
  const integration = await deps.connectIntegration();
  let worktreeDir: string | null = null;
  try {
    // Startup recovery FIRST (#293 review MAJOR): finish any crashed sync /
    // sync-reset run before planning, so a prior post-integrate zombie (canonical
    // moved, cursor not advanced, intent pending) is replayed to a consistent
    // cursor rather than left to regress the re-baseline. Same order + machinery
    // as the normal cycle (runStartupRecovery then recoverSyncRuns; the generic
    // reconciler leaves sync/sync-reset runs, recoverSyncRuns owns them).
    await runStartupRecovery(deps, integration);
    await recoverSyncRuns(deps, integration);

    // Plan AFTER recovery — recovery may have advanced the cursor / canonical.
    const { plan, row } = await buildResetPlan(deps);
    const op = resetOp(plan);
    // The operator-consent gate: broker re-verifies the signed challenge against
    // the current canonical tip + the re-derived plan digest. Any drift throws
    // here (mapped to authorization-invalid, exit 2) — no ref/cursor mutation.
    const gate = await deps.connectBroker();
    try {
      await gate.execAuthorized(op, authorization);
    } finally {
      gate.close();
    }

    const now = deps.now;
    const runId = newRunId();
    const wdeps: WorkflowDeps = { store: deps.store, broker: integration.broker, backup: deps.backup, repo: deps.repo, now };
    const historyGapAccepted = true;

    const intent: SyncIntent = {
      sourceId: row.sourceId,
      upstreamRef: row.upstreamRef,
      cursorFrom: row.lastAbsorbedOid,
      targetOid: plan.upstreamHead,
      canonicalSha: "", // set to the reconciled commit sha below (or the base on empty-diff)
      changedNoteIds: plan.changedNoteIds,
      pendingQuarantine: plan.pendingAfter,
    };

    const handle = await startRun(wdeps, { operation: "sync-reset", runId, targetNoteId: null, canonicalCommit: plan.canonicalBase });
    const exitCode = plan.quarantined.length > 0 ? EXIT.ACTION_REQUIRED : EXIT.OK;
    const planHash = sha256Canonical({ resetPlanDigest: plan.planDigest });
    await handle.checkpoint("planned", {
      planId: `${runId}-plan`,
      tier: 1,
      confidence: 1,
      summary: `sync reset re-converge ${deps.canonicalRef} → ${plan.upstreamHead} (${plan.captured.length} captured, ${plan.archived.length} archived, ${plan.quarantined.length} quarantined)`,
      planHash,
      canonicalRef: deps.canonicalRef,
      baseRef: plan.canonicalBase,
    });

    // Empty-diff (history-only divergence): the trees already match. No integrate,
    // no reconcile job — the reset is a cursor re-baseline + audited history gap.
    if (plan.fileWrites.size === 0 && plan.fileDeletes.length === 0) {
      let reconcileJobId: JobId | null = null;
      void reconcileJobId;
      await handle.finalize(undefined, {
        fromEmptyPlan: true,
        extraCommit: (db) => {
          finalizeResetCursor(db, row, plan, now());
        },
      });
      return { exitCode, envelope: appliedEnvelope(deps, row, plan, null, historyGapAccepted) };
    }

    // Non-empty: mirror the reconciled tree onto a worktree off canonical head,
    // commit as a child (FF), integrate via the cycle's scope-"sync" path.
    const agentRef = await deps.repo.createAgentBranch(runId, deps.canonicalRef);
    worktreeDir = await mkdtemp(
      join(deps.worktreesPath && existsSync(deps.worktreesPath) ? deps.worktreesPath : tmpdir(), `atlas-sync-reset-${runId}-`),
    );
    const worktree = await deps.repo.addWorktree(agentRef, worktreeDir);
    for (const p of plan.fileDeletes) await rm(join(worktreeDir, p), { force: true });
    let changedLines = 0;
    for (const [p, bytes] of plan.fileWrites) {
      await mkdir(join(worktreeDir, dirname(p)), { recursive: true });
      await writeFile(join(worktreeDir, p), bytes);
      changedLines += bytes.toString("utf8").split("\n").length;
    }
    const patchHash = sha256Canonical({ planHash });
    await handle.checkpoint("patched", {
      patchId: `${runId}-patch`,
      planId: `${runId}-plan`,
      noteId: plan.changedNoteIds[0] ?? "sync-reset",
      changedLines,
      changedSections: plan.fileWrites.size + plan.fileDeletes.length,
      patchHash,
      planHash,
    });
    const treeHash = sha256Canonical({
      writes: [...plan.fileWrites.entries()].map(([p, b]) => [p, sha256(b)]).sort(),
      deletes: plan.fileDeletes,
    });
    await handle.checkpoint("worktree-applied", { worktreePath: worktreeDir, treeHash, agentRef });
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId,
      state: "agent-committed",
      createdAt: now(),
      canonicalBaseCommit: plan.canonicalBase,
      targets: [...plan.changedNoteIds],
    };
    const commitSha = await worktree.commit(`sync reset: re-converge ${deps.canonicalRef} to ${plan.upstreamHead}`, manifest);
    await handle.checkpoint("agent-committed", { commitSha, treeHash, agentRef, tier: 1 });

    const boundIntent: SyncIntent = { ...intent, canonicalSha: commitSha };
    const integrated = await handle.integrate(integration.integrate, { extraDetail: { sync: boundIntent } });
    deps.failpoints?.afterIntegrate?.();

    await foldProvenanceFromCanonical(deps.store, deps.repo, deps.canonicalRef);
    foldNotesForPaths(deps.store, [...plan.changedNoteIds], resolveAtRef(deps.repo, deps.canonicalRef, deps.noteGlobs));
    await handle.checkpoint("reindexed", { indexGeneration: 1, canonicalSha: integrated.canonicalSha });

    let reconcileJobId: JobId | null = null;
    await handle.finalize(undefined, {
      extraCommit: (db) => {
        finalizeResetCursor(db, row, plan, now());
        if (plan.changedNoteIds.length > 0) {
          reconcileJobId = enqueue(db, {
            workflow: INDEX_RECONCILE_WORKFLOW,
            idempotencyKey: integrated.canonicalSha,
            payload: { noteIds: [...plan.changedNoteIds] },
          });
        }
      },
    });

    await cleanupWorktree(deps.repo, worktreeDir);
    worktreeDir = null;
    return { exitCode, envelope: appliedEnvelope(deps, row, plan, reconcileJobId, historyGapAccepted) };
  } finally {
    if (worktreeDir !== null) await cleanupWorktree(deps.repo, worktreeDir);
    integration.close();
  }
}

/**
 * Re-baseline the cursor to the upstream head under a cycle_seq CAS so a
 * concurrent `sync` that snapshotted the pre-reset state cannot finalize its
 * stale cursor over the reset (its finalize CAS would then mismatch).
 */
function finalizeResetCursor(db: Store["db"], row: ReturnType<typeof readSingleCursor>, plan: ResetPlan, now: string): void {
  const guard = db
    .prepare(`SELECT cycle_seq FROM sync_cursors WHERE source_id = ?`)
    .get(row.sourceId) as { cycle_seq: number } | undefined;
  if (guard === undefined || guard.cycle_seq !== row.cycleSeq) {
    throw new CliError({
      code: "internal",
      message: `sync reset cursor CAS failed for ${row.sourceId} (expected cycle_seq ${row.cycleSeq}, found ${guard?.cycle_seq ?? "none"})`,
      hint: "A concurrent sync advanced the cursor; re-run sync reset.",
      exitCode: EXIT.INTERNAL,
      retryable: true,
    });
  }
  finalizeCursor(db, { sourceId: row.sourceId, newOid: plan.upstreamHead, now, pendingQuarantine: plan.pendingAfter });
}

function appliedEnvelope(
  deps: SyncResetDeps,
  row: ReturnType<typeof readSingleCursor>,
  plan: ResetPlan,
  reconcileJobId: string | null,
  historyGapAccepted: boolean,
): SyncResetEnvelope {
  return {
    command: "sync reset",
    mode: "applied",
    reBaselinedTo: plan.upstreamHead,
    canonicalRef: deps.canonicalRef,
    upstreamRef: row.upstreamRef,
    archived: plan.archived,
    captured: plan.captured,
    quarantined: plan.quarantined,
    pendingQuarantine: plan.pendingAfter,
    reconcileJobId,
    cycleSeq: row.cycleSeq + 1,
    historyGapAccepted,
  };
}

async function cleanupWorktree(repo: Repo, dir: string): Promise<void> {
  try {
    await repo.removeWorktree(dir);
  } catch {
    /* best-effort — the reconciler sweeps leftovers */
  }
}

// re-export for the scanner wiring parity with the cycle
export type { ScanOutcome };
export { matchesNoteGlobs };
