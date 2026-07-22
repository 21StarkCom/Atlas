/**
 * `sync` + `sync status` command handlers (60-B Tasks 4.4–4.9).
 *
 * `sync` runs one absorb cycle for the adopted vault under the exclusive
 * `vault-maintenance` lock: OQ#5 divergence REJECT before any diff, per-commit
 * first-parent walk, scan-before-persist on every absorbed byte, ONE run / ONE
 * broker CAS integrate (scope `"sync"`) / ONE `index:reconcile` enqueue, cursor
 * + pending-quarantine finalized atomically with the run terminal. Exit 0 clean,
 * 6 when ≥1 attributable path was quarantined (cursor still advanced), 2 on
 * config/vault/lock/divergence/backup preconditions, 3 on a non-attributable
 * generated-artifact verdict (cursor unadvanced), 4 internal.
 *
 * `sync status` is the read-only durable-state surface: cursor, behind-by
 * (null across a divergence), pending set, live-derived divergence + the
 * deterministic exit-3 block. It mutates nothing and resolves no lock.
 */
import { openRepo, type Repo } from "@atlas/git";
import { bindEnqueueContext, productionEnqueueContext } from "@atlas/jobs";
import { assertBackupHealthy, BackupUnhealthyError, type Store } from "@atlas/sqlite-store";
import { registerCommand, type RunContext } from "../handlers.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { buildCaptureDeps } from "../ingest/wiring.js";
import { DEFAULT_CANONICAL_REF } from "../ingest/capture.js";
import { CANONICAL_BRANCH } from "../workflows/direct-integrator.js";
import { resolvePath } from "./backup-config.js";
import { openMigratedStore } from "./store-open.js";
import {
  runSyncCycle,
  readSingleCursor,
  computeBlocked,
  type SyncCycleDeps,
  type SyncEnvelope,
} from "../sync/cycle.js";
import { detectDivergence, countBehind } from "../sync/diff.js";
import type { ScanOutcome } from "../sync/plan.js";

interface SyncArgs {
  readonly dryRun: boolean;
  readonly maxPaths: number | undefined;
}

function parseSyncArgs(argv: readonly string[]): SyncArgs {
  let dryRun = false;
  let maxPaths: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--max-paths" || a.startsWith("--max-paths=")) {
      const raw = a === "--max-paths" ? argv[++i] : a.slice("--max-paths=".length);
      if (raw === undefined || !/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
        throw CliError.usage(`--max-paths requires an integer >= 1, got ${raw ?? "<missing>"}`);
      }
      maxPaths = Number.parseInt(raw, 10);
      continue;
    }
    throw CliError.usage(`unknown argument for sync: ${a}`);
  }
  return { dryRun, maxPaths };
}

/**
 * v2 (#326, ADR-0003): the secret scan is retired EVERYWHERE — production
 * scanners are always-clean no-ops, so a sync cycle can never quarantine and
 * exit 3 is unreachable. The engine's verdict-handling seam survives untouched
 * until #329 rewrites sync v2 (cycle tests inject their own scanners to
 * exercise it). Shared with `sync reset`.
 */
export function realScanners(_ctx: RunContext): Pick<SyncCycleDeps, "scanNoteBytes" | "scanGeneratedArtifact"> {
  return {
    scanNoteBytes: async (): Promise<ScanOutcome> => {
      await Promise.resolve();
      return { clean: true };
    },
    scanGeneratedArtifact: async () => {
      await Promise.resolve();
    },
  };
}

/** Dry-run scanners: identical always-clean no-ops in v2. Exported for the cycle tests. */
export function dryScanners(): Pick<SyncCycleDeps, "scanNoteBytes" | "scanGeneratedArtifact"> {
  return realScanners(undefined as unknown as RunContext);
}

async function syncHandler(ctx: RunContext): Promise<number> {
  const args = parseSyncArgs(ctx.argv);
  const cap = buildCaptureDeps(ctx, "sync", undefined, "sync");

  return ctx.withLock("vault-maintenance", async () => {
    const store = cap.openStore();
    try {
      if (!args.dryRun) {
        try {
          assertBackupHealthy(store.db);
        } catch (e) {
          if (e instanceof BackupUnhealthyError) {
            throw new CliError({
              code: "backup-unhealthy",
              message: e.message,
              hint: "A degraded backup blocks ledger-writing runs by design; run `db backup` / `db restore` to recover.",
              exitCode: EXIT.CONFIG,
            });
          }
          throw e;
        }
        bindEnqueueContext(
          store.db,
          productionEnqueueContext({ defaultMaxAttempts: ctx.config.config.jobs.max_attempts }),
        );
      }
      const deps: SyncCycleDeps = {
        store,
        repo: cap.repo,
        connectIntegration: cap.connectIntegration,
        backup: cap.backup,
        worktreesPath: cap.worktreesPath,
        canonicalRef: cap.canonicalRef,
        defaultCanonicalRef: DEFAULT_CANONICAL_REF,
        noteGlobs: ctx.config.config.vault.note_globs,
        now: cap.now ?? (() => new Date().toISOString()),
        ...(args.dryRun ? dryScanners() : realScanners(ctx)),
      };
      const res = await runSyncCycle(deps, {
        dryRun: args.dryRun,
        ...(args.maxPaths === undefined ? {} : { maxPaths: args.maxPaths }),
      });
      renderSync(ctx, res.envelope);
      return res.exitCode;
    } finally {
      store.close();
    }
  });
}

function renderSync(ctx: RunContext, env: SyncEnvelope): void {
  if (ctx.output.mode === "json") {
    emitJson(env);
    return;
  }
  const lines = [
    `sync: ${env.cursorFrom ?? "zero-state"} → ${env.cursorTo ?? "unmoved"} (upstream ${env.upstreamHead.slice(0, 12)})`,
    `applied ${env.appliedOps} op(s) · absorbed ${env.absorbed.length} · archived ${env.archived.length} · renamed ${env.renamed.length} · quarantined ${env.quarantined.length}${env.truncated ? " · truncated" : ""}`,
  ];
  if (env.reconcileJobId !== null) lines.push(`index:reconcile enqueued: ${env.reconcileJobId}`);
  if (env.quarantined.length > 0) {
    lines.push(`pending quarantine: ${env.quarantined.map((q) => q.path).join(", ")}`);
  }
  ctx.render(lines.join("\n"));
}

/** The `sync status` success envelope (mirrors sync-status.schema.json). */
export interface SyncStatusEnvelope {
  readonly command: "sync status";
  readonly sourceId: string;
  readonly upstreamRef: string;
  readonly lastAbsorbedOid: string | null;
  readonly upstreamHead: string;
  readonly behindBy: number | null;
  readonly lastSyncedAt: string;
  readonly cycleSeq: number;
  readonly pendingQuarantine: readonly { path: string; quarantineId: string; firstSeenOid: string }[];
  readonly divergence: { state: string; cursorOid: string | null; upstreamHead: string };
  readonly blocked: { commitOid: string; reason: string } | null;
}

/**
 * Assemble the read-only status envelope: cursor row + live-derived divergence,
 * behind-by (null across a divergence — the count is undefined), and the
 * deterministic exit-3 block (re-derived because the cursor never advances on
 * exit 3). Everything beyond the row is read-time-derived; nothing mutates.
 */
export async function readSyncStatus(
  store: Store,
  repo: Repo,
  noteGlobs: readonly string[],
  canonicalRef: string,
): Promise<SyncStatusEnvelope> {
  const row = readSingleCursor(store);
  const upstreamHead = await repo.readRef(row.upstreamRef);
  if (upstreamHead === null) {
    throw new CliError({
      code: "vault-error",
      message: `upstream ref ${row.upstreamRef} does not resolve`,
      hint: "The adopted vault's upstream branch is missing.",
      exitCode: EXIT.CONFIG,
    });
  }
  const divergence = await detectDivergence(repo, row.lastAbsorbedOid, upstreamHead);
  const ok = divergence.state === "ok";
  const behindBy = ok ? await countBehind(repo, row.lastAbsorbedOid, upstreamHead) : null;
  // The archived-id block derivation needs the REAL canonical base (#289 round-2)
  // so status and the live cycle agree; a missing canonical ref means no block.
  const canonicalBase = ok && behindBy !== null && behindBy > 0 ? await repo.readRef(canonicalRef) : null;
  const blocked =
    canonicalBase !== null ? await computeBlocked({ repo, noteGlobs }, row, upstreamHead, canonicalBase) : null;
  return {
    command: "sync status",
    sourceId: row.sourceId,
    upstreamRef: row.upstreamRef,
    lastAbsorbedOid: row.lastAbsorbedOid,
    upstreamHead,
    behindBy,
    lastSyncedAt: row.lastSyncedAt,
    cycleSeq: row.cycleSeq,
    pendingQuarantine: row.pendingQuarantine,
    divergence: {
      state: divergence.state,
      cursorOid: divergence.state === "ok" ? row.lastAbsorbedOid : divergence.cursorOid,
      upstreamHead,
    },
    blocked,
  };
}

async function syncStatusHandler(ctx: RunContext): Promise<number> {
  if (ctx.argv.length > 0) throw CliError.usage(`unknown argument for sync status: ${ctx.argv[0]}`);
  const store = openMigratedStore(ctx);
  try {
    const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
    const env = await readSyncStatus(store, repo, ctx.config.config.vault.note_globs, CANONICAL_BRANCH);
    if (ctx.output.mode === "json") {
      emitJson(env);
    } else {
      const lines = [
        `source ${env.sourceId} · upstream ${env.upstreamRef}`,
        `cursor ${env.lastAbsorbedOid ?? "zero-state"} · behind by ${env.behindBy ?? "?? (diverged)"} · cycle ${env.cycleSeq}`,
        `divergence: ${env.divergence.state} · pending quarantine: ${env.pendingQuarantine.length}${env.blocked ? ` · BLOCKED at ${env.blocked.commitOid.slice(0, 12)} (${env.blocked.reason})` : ""}`,
      ];
      ctx.render(lines.join("\n"));
    }
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("sync", syncHandler);
registerCommand("sync status", syncStatusHandler);
