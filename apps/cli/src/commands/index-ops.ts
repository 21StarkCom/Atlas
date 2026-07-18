/**
 * `brain index status|verify|repair|rebuild` (Task 3.5 / #42) — retrieval-index
 * maintenance, per `retrieval-index-contract.md` §3/§4 and the four committed
 * `cli-contract/index-*.schema.json` contracts.
 *
 *   - **status**  read-only: the configured generation identity (D4/D7), per-note
 *                 coverage (indexed/stale/missing), and staleness detail (§4).
 *   - **verify**  read-only SQLite↔LanceDB consistency (exit 1 on any divergence).
 *   - **repair**  converge divergences: re-embed/re-activate stale-or-missing notes,
 *                 retire orphans; `outcome` (converged|partial) is the source of truth.
 *   - **rebuild** full regeneration from Markdown: clear the table, re-embed every note.
 *
 * Every EXECUTED index operation is a projection-class op: it appends EXACTLY ONE
 * terminal `run.projection` git-ref audit event (via {@link runReadAudit} →
 * `finalizeLedgerWrite`, §2.8) and — because a projection is a real state change — takes
 * its mandatory covering backup (`strictBackup`, never coalesced). status/verify write
 * NO ledger business row; repair/rebuild mutate only the LanceDB projection + the SQLite
 * activation fence (never canonical git / the vault / a ledger business table) — index
 * state is disposable derived state (Phase-3 rollback: delete `lancedb.dir` wholesale).
 *
 * The index write path (embed → write → verify-complete → activate → retire → compact)
 * is ASYNC and external to the ledger transaction, so repair/rebuild run it to
 * convergence FIRST and then anchor the single `run.projection` marker; a crash between
 * the two re-converges idempotently on rerun (`reconcileIndex` is crash-safe).
 */
import * as lancedb from "@lancedb/lancedb";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import {
  computeStaleness,
  embedderFromClient,
  ensureFtsIndex,
  indexRebuild,
  indexRepair,
  indexVerify,
  openSearchTable,
  SEARCH_CHUNK_TABLE,
  type Embedder,
  type IndexDeps,
  type IndexingConfig,
  type NoteFenceInput,
  type SearchTable,
  type UnresolvedNote,
} from "@atlas/lancedb-index";
import type { IndexRebuildReport } from "@atlas/lancedb-index";
import { ModelsClient, mintEgressCapability, type EgressLimits, type ModelCallReceipt } from "@atlas/models";
import { EgressClient } from "@atlas/broker";
import { GenerationRepo, type SqliteDatabase, type Store } from "@atlas/sqlite-store";
import { readVault } from "../vault/reader.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { resolvePath } from "./backup-config.js";
import { runReadAudit } from "../audit/readonly.js";

// Per-run egress ceilings for the index-embedding capability (D19) — generous; the
// payload scan + capability enforce the real limits.
const EGRESS_MAX_BYTES = 8_000_000;
const EGRESS_MAX_TOKENS = 2_000_000;
const EGRESS_COST_CEILING = 10_000_000;

function noFlags(cmd: string, argv: string[]): void {
  for (const a of argv) throw CliError.usage(`unknown flag/argument for \`${cmd}\`: ${a}`);
}

function indexingConfig(ctx: RunContext): IndexingConfig {
  const c = ctx.config.config.indexing;
  return { chunker_version: c.chunker_version, embedding_model: c.embedding_model, dimensions: c.dimensions };
}

/** The per-note fences from SQLite `notes` (the activation authority). */
function noteFences(store: Store): NoteFenceInput[] {
  return (
    store.db
      .prepare(`SELECT note_id, content_hash, active_generation_id FROM notes ORDER BY note_id`)
      .all() as { note_id: string; content_hash: string; active_generation_id: string | null }[]
  ).map((r) => ({ noteId: r.note_id, contentHash: r.content_hash, activeGenerationId: r.active_generation_id }));
}

/** Open the LanceDB search table, or `null` when the directory/table is absent — the
 * contract's `not-configured` (never a failure) for the read-only status path. */
async function openTableOrNull(ctx: RunContext, cfg: IndexingConfig): Promise<SearchTable | null> {
  const dir = resolvePath(ctx, ctx.config.config.lancedb.dir);
  try {
    const conn = await lancedb.connect(dir);
    const names = await conn.tableNames();
    if (!names.includes(SEARCH_CHUNK_TABLE)) return null;
    return await openSearchTable(conn, cfg);
  } catch {
    return null;
  }
}

/** Read all vault notes for a rebuild/repair, mapping a read failure to `vault-error`. */
async function readNotes(ctx: RunContext): Promise<readonly ParsedNote[]> {
  let snapshot: VaultSnapshot;
  try {
    snapshot = await readVault(ctx.config.config);
  } catch (e) {
    throw new CliError({
      code: "vault-error",
      message: `cannot read vault: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Check that vault.path in brain.config.yaml exists and is readable.",
      exitCode: EXIT.CONFIG,
      cause: e,
    });
  }
  return snapshot.notes;
}

/** Build the batch {@link Embedder} over the egress broker (repair/rebuild only). Returns
 * a disposer to close the egress socket. */
async function buildEmbedder(
  ctx: RunContext,
  cfg: IndexingConfig,
  runId: string,
): Promise<{ embed: Embedder; close: () => void }> {
  const socketPath = ctx.config.config.broker.egress_socket_path;
  let egress: EgressClient;
  try {
    egress = await EgressClient.connect(socketPath);
  } catch (e) {
    throw new CliError({
      code: "internal",
      message: `the egress broker is unreachable at ${socketPath}: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Start the egress broker daemon before `brain index repair`/`rebuild`.",
      exitCode: EXIT.INTERNAL,
      retryable: true,
      cause: e,
    });
  }
  const receipts: ModelCallReceipt[] = [];
  const models = new ModelsClient(
    (params, signal) => egress.invoke(params, signal),
    (r: ModelCallReceipt) => {
      receipts.push(r);
    },
  );
  const limits: EgressLimits = {
    operation: "embed",
    model: cfg.embedding_model,
    maxBytes: EGRESS_MAX_BYTES,
    maxTokens: EGRESS_MAX_TOKENS,
    costCeiling: EGRESS_COST_CEILING,
    allowedSensitivity: "internal",
  };
  const cap = mintEgressCapability({ runId }, limits);
  return { embed: embedderFromClient(models, cap, cfg), close: () => egress.close() };
}

/** Build the reconcile {@link IndexDeps} shared by repair + rebuild. */
function indexDeps(ctx: RunContext, cfg: IndexingConfig, store: Store, table: SearchTable, embed: Embedder, notes: readonly ParsedNote[]): IndexDeps {
  return {
    config: cfg,
    table,
    store: store.generation,
    embed,
    lockLocation: resolvePath(ctx, ctx.config.config.lancedb.dir),
    notes: () => notes,
  };
}

/**
 * Rebuild the LanceDB index from the vault against a specific ledger `db` handle — the
 * SHARED engine for the `index rebuild` command AND the post-restore rebuild hook
 * (R1-F1: from Phase 3, `db restore` triggers projection + index rebuild). Drops any
 * prior table so every note is re-embedded; reconstructs a wholly-absent index (connect
 * creates the directory). The caller owns locking + the `run.projection` audit.
 */
export async function rebuildIndexFromVault(ctx: RunContext, db: SqliteDatabase, runId: string): Promise<IndexRebuildReport> {
  const cfg = indexingConfig(ctx);
  const dir = resolvePath(ctx, ctx.config.config.lancedb.dir);
  const conn = await lancedb.connect(dir);
  if ((await conn.tableNames()).includes(SEARCH_CHUNK_TABLE)) await conn.dropTable(SEARCH_CHUNK_TABLE);
  const table = await openSearchTable(conn, cfg);
  const { embed, close } = await buildEmbedder(ctx, cfg, runId);
  try {
    const notes = await readNotes(ctx);
    const report = await indexRebuild({ config: cfg, table, store: new GenerationRepo(db), embed, lockLocation: dir, notes: () => notes });
    // Rebuild the `text` FTS inverted index over the freshly written rows so the FTS
    // retrieval layer scores on stemmed content terms, not stop words (§6, #156).
    await ensureFtsIndex(table);
    return report;
  } finally {
    close();
  }
}

/** The aggregate exit code for a repair/rebuild that could not fully converge. The
 * plan §2.5 exit set caps at 6, so the contract's nominal exit 7 (retryable partial) is
 * expressed as exit 6 (action-required) — the retryability a jobs runner consumes lives
 * on each `unresolved[].retryable` flag, not on a code the exit set does not define. */
function partialExit(unresolved: readonly UnresolvedNote[]): number {
  return unresolved.length > 0 ? EXIT.ACTION_REQUIRED : EXIT.OK;
}

// ---------------------------------------------------------------------------
// index status (read-only)
// ---------------------------------------------------------------------------

async function indexStatus(ctx: RunContext): Promise<number> {
  noFlags("index status", ctx.argv);
  const cfg = indexingConfig(ctx);
  const store = openMigratedStore(ctx);
  try {
    const table = await openTableOrNull(ctx, cfg);
    const fences = noteFences(store);
    const staleness = await computeStaleness(fences, table, cfg);

    let indexed = 0;
    let stale = 0;
    let missing = 0;
    for (const s of staleness) {
      if (s.status === "indexed") indexed++;
      else if (s.status === "stale") stale++;
      else missing++;
    }
    const chunkCount = table === null ? 0 : await table.countRows();

    const out = {
      command: "index status" as const,
      index: { configured: table !== null, chunkCount },
      generation: {
        chunkerVersion: cfg.chunker_version,
        embeddingModel: cfg.embedding_model,
        embeddingDimensions: cfg.dimensions,
      },
      notes: { total: fences.length, indexed, stale, missing },
      staleness: staleness
        .filter((s) => s.status !== "indexed")
        .map((s) => ({ noteId: s.noteId, triggers: s.triggers })),
    };

    const audit = await runReadAudit(ctx, "run.projection", "index status", store, { strictBackup: true });
    ctx.log.info("index.status", { indexed, stale, missing, configured: out.index.configured, audited: audit.recorded, runId: audit.runId });
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`index status — ${indexed} indexed, ${stale} stale, ${missing} missing (${out.index.configured ? `${chunkCount} chunks` : "not configured"})`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// index verify (read-only; exit 1 on divergence)
// ---------------------------------------------------------------------------

async function indexVerifyCmd(ctx: RunContext): Promise<number> {
  noFlags("index verify", ctx.argv);
  const cfg = indexingConfig(ctx);
  const store = openMigratedStore(ctx);
  try {
    const table = await openTableOrNull(ctx, cfg);
    const report = await indexVerify({
      notes: noteFences(store),
      table,
      config: cfg,
      activeGenerationIds: store.generation.activeGenerationIds(),
    });

    const out = {
      command: "index verify" as const,
      consistent: report.consistent,
      checked: report.checked,
      divergences: report.divergences.map((d) => ({ noteId: d.noteId, kind: d.kind, ...(d.detail !== undefined ? { detail: d.detail } : {}) })),
    };

    const audit = await runReadAudit(ctx, "run.projection", "index verify", store, { strictBackup: true });
    ctx.log.info("index.verify", { consistent: report.consistent, checked: report.checked, divergences: report.divergences.length, audited: audit.recorded, runId: audit.runId });
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`index verify — ${report.consistent ? "consistent" : `${report.divergences.length} divergence(s)`} (${report.checked} checked)`);
    return report.consistent ? EXIT.OK : EXIT.VALIDATION;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// index repair (projection-write)
// ---------------------------------------------------------------------------

async function indexRepairCmd(ctx: RunContext): Promise<number> {
  noFlags("index repair", ctx.argv);
  const cfg = indexingConfig(ctx);
  const runId = ctx.runId;
  return ctx.withLock("vault-maintenance", async () => {
    const store = openMigratedStore(ctx);
    const table = await requireTable(ctx, cfg);
    const { embed, close } = await buildEmbedder(ctx, cfg, runId);
    try {
      const started = Date.now();
      const notes = await readNotes(ctx);
      const report = await indexRepair(indexDeps(ctx, cfg, store, table, embed, notes));
      // Re-derive the `text` FTS index to cover any newly written rows (§6, #156).
      await ensureFtsIndex(table);
      const durationMs = Date.now() - started;

      const out = {
        command: "index repair" as const,
        outcome: report.outcome,
        repaired: report.repaired.map((r) => ({ noteId: r.noteId, action: r.action, ...(r.generationId !== undefined ? { generationId: r.generationId } : {}) })),
        ...(report.outcome === "partial" ? { unresolved: report.unresolved.map(serializeUnresolved) } : {}),
        durationMs,
      };

      const audit = await runReadAudit(ctx, "run.projection", "index repair", store, { strictBackup: true });
      ctx.log.info("index.repair", { outcome: report.outcome, repaired: report.repaired.length, unresolved: report.unresolved.length, audited: audit.recorded, runId: audit.runId });
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`index repair — ${report.outcome}: ${report.repaired.length} repaired, ${report.unresolved.length} unresolved (${durationMs}ms)`);
      return partialExit(report.unresolved);
    } finally {
      close();
      store.close();
    }
  });
}

// ---------------------------------------------------------------------------
// index rebuild (projection-write; full regeneration)
// ---------------------------------------------------------------------------

async function indexRebuildCmd(ctx: RunContext): Promise<number> {
  noFlags("index rebuild", ctx.argv);
  const runId = ctx.runId;
  return ctx.withLock("vault-maintenance", async () => {
    const store = openMigratedStore(ctx);
    try {
      const started = Date.now();
      // Full regeneration from Markdown (shared with the post-restore hook): drops the
      // table, re-embeds every note, reconstructs a wholly-absent index.
      const report = await rebuildIndexFromVault(ctx, store.db, runId);
      const durationMs = Date.now() - started;

      const out = {
        command: "index rebuild" as const,
        notesIndexed: report.notesIndexed,
        chunksWritten: report.chunksWritten,
        generationsRetired: report.generationsRetired,
        durationMs,
      };

      const audit = await runReadAudit(ctx, "run.projection", "index rebuild", store, { strictBackup: true });
      ctx.log.info("index.rebuild", { notesIndexed: report.notesIndexed, chunksWritten: report.chunksWritten, unresolved: report.unresolved.length, audited: audit.recorded, runId: audit.runId });
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`index rebuild — ${report.notesIndexed} note(s), ${report.chunksWritten} chunk(s), ${report.generationsRetired} retired (${durationMs}ms)`);
      return partialExit(report.unresolved);
    } finally {
      store.close();
    }
  });
}

/** Open the table, mapping an absent/unopenable index to `index-unavailable` (exit 2)
 * — the projection-write commands (repair) require an existing index to converge. */
async function requireTable(ctx: RunContext, cfg: IndexingConfig): Promise<SearchTable> {
  const table = await openTableOrNull(ctx, cfg);
  if (table === null) {
    throw new CliError({
      code: "index-unavailable",
      message: `the LanceDB index at ${ctx.config.config.lancedb.dir} is not configured/present`,
      hint: "Run `brain index rebuild` to (re)build the retrieval index from Markdown.",
      exitCode: EXIT.CONFIG,
    });
  }
  return table;
}

function serializeUnresolved(u: UnresolvedNote): Record<string, unknown> {
  return {
    noteId: u.noteId,
    code: u.code,
    retryable: u.retryable,
    message: u.message,
    ...(u.retryAfterMs !== undefined ? { retryAfterMs: u.retryAfterMs } : {}),
  };
}

registerCommand("index status", indexStatus);
registerCommand("index verify", indexVerifyCmd);
registerCommand("index repair", indexRepairCmd);
registerCommand("index rebuild", indexRebuildCmd);

export { indexStatus, indexVerifyCmd, indexRepairCmd, indexRebuildCmd };
