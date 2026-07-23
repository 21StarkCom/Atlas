/**
 * `brain index rebuild` (Task 3.5 / #42; v2 #333 folded status→`status`, repair/verify→rebuild) — retrieval-index
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
 * (v2 #334: the formerly-appended `run.projection` audit event is retired; via
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
import { writeFileSync } from "node:fs";
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
import { ModelsClient, createInProcessInvoker, type ModelCallReceipt } from "@atlas/models";
import { GenerationRepo, type SqliteDatabase, type Store } from "@atlas/sqlite-store";
import { readVault } from "../vault/reader.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { resolvePath } from "./paths.js";

// Per-run egress ceilings for the index-embedding capability (D19) — generous; the
// payload scan + capability enforce the real limits.

function noFlags(cmd: string, argv: string[]): void {
  for (const a of argv) throw CliError.usage(`unknown flag/argument for \`${cmd}\`: ${a}`);
}

/** The configured generation identity (D4/D7) — shared by the index commands and the
 * `index:reconcile` job handler so the two derive the same `IndexingConfig`. */
export function indexingConfig(ctx: RunContext): IndexingConfig {
  const c = ctx.config.config.indexing;
  return { chunker_version: c.chunker_version, embedding_model: c.embedding_model, dimensions: c.dimensions };
}

/** The `notes` fence columns the activation authority reads (shared by the full and
 * scoped selects so the two can never drift in column set or order). */
const NOTE_FENCE_SELECT = `SELECT note_id, content_hash, active_generation_id FROM notes`;

type NoteFenceRow = { note_id: string; content_hash: string; active_generation_id: string | null };

/** Map raw `notes` rows to the `NoteFenceInput` the index engine consumes. */
function fenceRowsToInputs(rows: NoteFenceRow[]): NoteFenceInput[] {
  return rows.map((r) => ({
    noteId: r.note_id,
    contentHash: r.content_hash,
    activeGenerationId: r.active_generation_id,
  }));
}

/** The per-note fences for the WHOLE corpus from SQLite `notes` (the activation
 * authority) — the input `computeStaleness`/`indexVerify` reconcile against. */
export function noteFences(store: Store): NoteFenceInput[] {
  return fenceRowsToInputs(
    store.db.prepare(`${NOTE_FENCE_SELECT} ORDER BY note_id`).all() as NoteFenceRow[],
  );
}

/** The per-note fences for a BOUNDED set of note ids — never materializes the full
 * corpus (the O(delta) scoped-reconcile input, 60-B). Ids absent from `notes` simply
 * do not appear in the result (their fence is `undefined` ⇒ archived/deleted to the
 * scoped reconcile). An empty id list is a no-op (no query, no `IN ()`). */
export function noteFencesForNotes(store: Store, noteIds: string[]): NoteFenceInput[] {
  const ids = [...new Set(noteIds.map(String))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return fenceRowsToInputs(
    store.db
      .prepare(`${NOTE_FENCE_SELECT} WHERE note_id IN (${placeholders}) ORDER BY note_id`)
      .all(...ids) as NoteFenceRow[],
  );
}

/** Open the LanceDB search table, or `null` when the directory/table is absent — the
 * contract's `not-configured` (never a failure) for the read-only status path.
 * Exported for the v2 merged `status` (#332), which folds the `index status` read. */
export async function openTableOrNull(ctx: RunContext, cfg: IndexingConfig): Promise<SearchTable | null> {
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

/** Build the batch {@link Embedder} over the IN-PROCESS model boundary (repair/rebuild
 * + the `index:reconcile` job handler). No egress daemon, no capability mint; the
 * credential resolves lazily on the first call. Returns a no-op disposer. */
export async function buildEmbedder(
  ctx: RunContext,
  cfg: IndexingConfig,
  runId: string,
): Promise<{ embed: Embedder; close: () => void }> {
  const receipts: ModelCallReceipt[] = [];
  const models = new ModelsClient(
    createInProcessInvoker({ env: ctx.env }),
    (r: ModelCallReceipt) => {
      receipts.push(r);
    },
  );
  // The embed transmission binds to the run id (no capability mint).
  const embed = embedderFromClient(models, { runId }, cfg);
  // Test-only observable (gated; inert in production): when ATLAS_EMBED_COUNT_FILE
  // is set, persist the cumulative count of embed() calls this command made, so a
  // test can assert "zero embeddings on a noop/pure-move, exactly one on a
  // rename-plus-edit" without reaching into the provider.
  const countFile = ctx.env.ATLAS_EMBED_COUNT_FILE;
  if (ctx.env.ATLAS_TEST_MODE === "1" && countFile) {
    let calls = 0;
    const counting: Embedder = async (texts) => {
      calls += 1;
      writeFileSync(countFile, String(calls), "utf8");
      return embed(texts);
    };
    return { embed: counting, close: () => {} };
  }
  return { embed, close: () => {} };
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
  return unresolved.length > 0 ? EXIT.CONFIG : EXIT.OK;
}

// ---------------------------------------------------------------------------
// index rebuild (projection-write; full regeneration) — the ONE surviving
// index maintenance command (v2, #333): status folded into `status`,
// repair/verify folded into rebuild (a full deterministic regeneration
// subsumes convergent repair for a single-user vault).
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

      // v2 (#334): the run.projection audit append is retired (ADR-0003).
      ctx.log.info("index.rebuild", { notesIndexed: report.notesIndexed, chunksWritten: report.chunksWritten, unresolved: report.unresolved.length, runId: ctx.runId });
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

registerCommand("index rebuild", indexRebuildCmd);

export { indexRebuildCmd };
