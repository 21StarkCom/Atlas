/**
 * The `sync` command handler.
 *
 * **`sync` (v2, #329)** reconciles the vault WORKING TREE against the SQLite
 * projection by per-note content hash — there is NO HEAD cursor; the projection's
 * `content_hash` IS the cursor. Under the exclusive `vault-maintenance` lock it
 * scans + classifies via the shared {@link readReconcile} routine into
 * changed/new/dropped/moved, then STAGES the reindex (embed + write + verify the
 * new LanceDB generation) and commits the projection fold + fenced activation
 * ATOMICALLY (one SQLite txn) so the content-hash cursor advances IFF the verified
 * generation goes live; purges dropped invisibility-first (SQLite row + identity
 * keys + note_links in one txn, then LanceDB vectors), and moves-in-place pure
 * moves (no re-embed). An unchanged tree is a structural noop with NO index write;
 * the orphan-vector sweep belongs to `index rebuild` alone. Exit 0 (incl. noop), 2
 * on config/vault/lock preconditions, 4 internal, 5 usage.
 *
 * `sync status` is RETIRED (v2, #333) — the merged `status` carries the four
 * pending counts from the SAME {@link readReconcile} routine, so the two
 * surfaces still cannot disagree; the absorb-cycle status surface died with its
 * engine's last command consumers.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as lancedb from "@lancedb/lancedb";
import type { ParsedNote } from "@atlas/contracts";
import { foldNotesV2, type Store } from "@atlas/sqlite-store";
import {
  assembleRows,
  chunkId,
  chunkNote,
  ensureFtsIndex,
  generationId,
  indexNotes,
  indexingConfigKey,
  openSearchTable,
  retireSupersededGenerations,
  tableMaintenanceLock,
  verifyComplete,
  writeGeneration,
  type Embedder,
  type GenerationId,
  type IndexDeps,
} from "@atlas/lancedb-index";
import { registerCommand, type RunContext } from "../handlers.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { resolvePath } from "./paths.js";
import { openMigratedStore } from "./store-open.js";
import { readVault } from "../vault/reader.js";
import { buildEmbedder, indexingConfig } from "./index-ops.js";
import { reconcile, type ReconcileResult } from "../sync/diff.js";

interface SyncArgs {
  readonly dryRun: boolean;
}

function parseSyncArgs(argv: readonly string[]): SyncArgs {
  let dryRun = false;
  for (const a of argv) {
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    throw CliError.usage(`unknown argument for sync: ${a}`);
  }
  return { dryRun };
}

/**
 * The v2 `sync` success envelope — the flat 6-count shape (`sync.schema.json`).
 * There is no HEAD cursor and no `head` field: the projection's per-note
 * `content_hash` IS the cursor. `reindexed = changedCount + newCount` is
 * derivable (consumers sum), so it is not stored.
 */
export interface SyncV2Envelope {
  readonly command: "sync";
  readonly scannedCount: number;
  readonly changedCount: number;
  readonly newCount: number;
  readonly droppedCount: number;
  readonly movedCount: number;
  readonly noop: boolean;
}

/**
 * VaultError kinds that are genuinely NON-STRUCTURAL advisories — a link that
 * points nowhere / is ambiguous does not change how any note is CLASSIFIED, so it
 * may remain an advisory without endangering reconciliation. Every OTHER kind
 * fails the cycle CLOSED (exit 2, nothing mutated), for two distinct reasons:
 *
 *   - `read-error` / missing/invalid frontmatter / unsupported schema version —
 *     the note failed to parse, so it is ABSENT from the vault set and reconcile
 *     would misclassify it as a DROP and purge a note it could not read.
 *   - `duplicate-id` / `identity-collision` (#329 round-2, wing finding 2) —
 *     reconciliation matches vault ↔ projection by a UNIQUE stable id; two files
 *     claiming one id makes the vault map non-deterministic (last-writer-wins would
 *     silently pick one and eventually noop). A unique-id violation is structural,
 *     never advisory — fail closed BEFORE reconcile so no projection or index
 *     mutation happens against an ambiguous identity.
 */
const NON_STRUCTURAL_ERROR_KINDS = new Set(["broken-link", "ambiguous-link"]);

/**
 * The LanceDB write methods a v2 sync can invoke — the mutation boundary the
 * structural-noop invariant is defined against (#329 round-3, wing finding 5):
 * `mergeInsert` (a staged generation write), `delete` (a superseded-generation
 * retire or a dropped-note vector delete), and `createIndex` (the FTS re-derive).
 * A noop or a pure move MUST invoke NONE of them.
 */
const LANCE_MUTATION_METHODS: ReadonlySet<string> = new Set(["mergeInsert", "delete", "createIndex"]);

/**
 * Test-only (gated; inert in production): wrap the LanceDB table so every mutating
 * call (see {@link LANCE_MUTATION_METHODS}) bumps a persisted counter. This is the
 * observable that proves "zero index WRITES on the immediate 2nd sync / a pure
 * move" — a claim an unchanged row count alone can NOT make (a rewrite or a
 * delete-then-reinsert preserves the count). Returns the table unchanged unless
 * `ATLAS_TEST_MODE=1` and `ATLAS_LANCE_MUTATION_COUNT_FILE` is set.
 */
function instrumentTable<T extends object>(ctx: RunContext, table: T): T {
  const file = ctx.env.ATLAS_LANCE_MUTATION_COUNT_FILE;
  if (ctx.env.ATLAS_TEST_MODE !== "1" || !file) return table;
  const bump = (): void => {
    const cur = existsSync(file) ? Number.parseInt(readFileSync(file, "utf8").trim(), 10) || 0 : 0;
    writeFileSync(file, String(cur + 1), "utf8");
  };
  return new Proxy(table, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (typeof prop === "string" && LANCE_MUTATION_METHODS.has(prop)) {
        return (...args: unknown[]): unknown => {
          bump();
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  }) as T;
}

async function syncHandler(ctx: RunContext): Promise<number> {
  const args = parseSyncArgs(ctx.argv);

  return ctx.withLock("vault-maintenance", async () => {
    const store = openMigratedStore(ctx);
    try {
      const env = await runSyncV2(ctx, store, args.dryRun);
      renderSync(ctx, env);
      return EXIT.OK;
    } finally {
      store.close();
    }
  });
}

/**
 * The pending-set read a v2 `sync` acts on. `notes` is the successfully-parsed
 * working-tree snapshot (the resolver source for the fold/index passes); `rec` is
 * the classification; `scannedCount` is the reconcile input size.
 */
export interface ReconcileRead {
  readonly notes: readonly ParsedNote[];
  readonly rec: ReconcileResult;
  readonly scannedCount: number;
}

/**
 * The ONE reconciliation-input read (#329 round-2, wing finding 3) — the SSOT
 * both `sync` (to act) and `sync status` (to report) consume, so the two can
 * never disagree about the pending set. Reads the vault working tree, fails
 * closed on any structural parse/identity error (exit 2, nothing mutated), and
 * classifies against the projection via the pure {@link reconcile} routine.
 */
export async function readReconcile(ctx: RunContext, store: Store): Promise<ReconcileRead> {
  const projRows = store.projections
    .allNotes()
    .map((r) => ({ noteId: r.note_id, path: r.file_path, contentHash: r.content_hash }));
  return reconcileAgainstRows(ctx, projRows);
}

/**
 * The projection-row-parameterized half of {@link readReconcile}: the SAME vault
 * read + fail-closed structural gate + pure {@link classifySnapshot}, for a
 * caller that sources its projection rows itself. Composed from the exported
 * pieces below so the v2 merged `status` (#332) can consume the identical read +
 * classification while applying its OWN structural-error POLICY (degrade-and-
 * report instead of sync's writer-grade fail-closed halt) — the routine is
 * shared; only the fail policy differs.
 */
export async function reconcileAgainstRows(
  ctx: RunContext,
  projRows: readonly { noteId: string; path: string; contentHash: string }[],
): Promise<ReconcileRead> {
  const snapshot = await readVaultForReconcile(ctx);
  // Fail closed on any STRUCTURAL note error: a parse/read failure hides the note
  // from the vault set (reconcile would purge it as a DROP), and a duplicate-id /
  // identity-collision makes the id→note map ambiguous (reconcile matches by the
  // unique stable id). Only genuinely non-structural link advisories are tolerated.
  const fatal = structuralVaultErrors(snapshot);
  if (fatal.length > 0) {
    const first = fatal[0]!;
    throw new CliError({
      code: "vault-error",
      message: `vault note is not reconcilable (${first.kind}): ${first.path} — ${first.message}`,
      hint:
        first.kind === "duplicate-id" || first.kind === "identity-collision"
          ? "Two files claim one stable id — reconciliation needs a unique id per note. Fix the collision upstream."
          : "Fix the offending note upstream or narrow vault.note_globs; sync never purges a note it could not read.",
      exitCode: EXIT.CONFIG,
    });
  }
  return classifySnapshot(snapshot, projRows);
}

/** Read the vault working tree, mapping an unreadable vault (missing path,
 * permission failure) to the exit-2 `vault-error` — the "vault unresolvable, no
 * payload possible" boundary both `sync` and `status` share. */
export async function readVaultForReconcile(ctx: RunContext): Promise<Awaited<ReturnType<typeof readVault>>> {
  try {
    return await readVault(ctx.config.config);
  } catch (e) {
    throw new CliError({
      code: "vault-error",
      message: `cannot read vault: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Check that vault.path in brain.config.yaml exists and is readable.",
      exitCode: EXIT.CONFIG,
      cause: e,
    });
  }
}

/** The snapshot's STRUCTURAL errors — everything except the tolerated
 * non-structural link advisories. Non-empty ⇒ the id→note map is unreliable and
 * any reconcile classification over it is too. */
export function structuralVaultErrors(
  snapshot: Awaited<ReturnType<typeof readVault>>,
): typeof snapshot.errors {
  return snapshot.errors.filter((e) => !NON_STRUCTURAL_ERROR_KINDS.has(e.kind));
}

/** The PURE classification half of the one reconciliation routine: parsed vault
 * snapshot vs projection rows → the {@link ReconcileRead}. Every consumer
 * (`sync`, `sync status`, the merged `status`) classifies through THIS function
 * — there is no second derivation. */
export function classifySnapshot(
  snapshot: Awaited<ReturnType<typeof readVault>>,
  projRows: readonly { noteId: string; path: string; contentHash: string }[],
): ReconcileRead {
  const vaultNotes = snapshot.notes.map((n) => ({ noteId: n.id, path: n.path, contentHash: n.contentHash }));
  return { notes: snapshot.notes, rec: reconcile(vaultNotes, [...projRows]), scannedCount: vaultNotes.length };
}

/** The six flat counts + noop derived from a {@link ReconcileRead}. */
export function reconcileCounts(read: ReconcileRead): Omit<SyncV2Envelope, "command"> {
  const { rec, scannedCount } = read;
  return {
    scannedCount,
    changedCount: rec.changed.length,
    newCount: rec.new.length,
    droppedCount: rec.dropped.length,
    movedCount: rec.moved.length,
    noop:
      rec.changed.length === 0 && rec.new.length === 0 && rec.dropped.length === 0 && rec.moved.length === 0,
  };
}

/**
 * One v2 reconcile: read the pending set via the shared {@link readReconcile}
 * routine and (unless `--dry-run` or a structural noop) reindex changed+new,
 * purge dropped invisibility-first, and move-in-place pure moves. Returns the
 * flat count envelope.
 */
export async function runSyncV2(ctx: RunContext, store: Store, dryRun: boolean): Promise<SyncV2Envelope> {
  const read = await readReconcile(ctx, store);
  const env: SyncV2Envelope = { command: "sync", ...reconcileCounts(read) };

  // Structural-noop invariant: an unchanged tree performs NO index or projection
  // write. `--dry-run` classifies but never touches a sink.
  if (env.noop || dryRun) return env;

  await applyReconcile(ctx, store, read.notes, read.rec);
  return env;
}

/** A reindex generation staged (written + verified) in LanceDB but NOT yet activated. */
interface PreparedGeneration {
  readonly noteId: string;
  /** The generation id, or `null` for a prose-less (empty) note (tombstone, not activate). */
  readonly gen: GenerationId | null;
  /** The note's new content hash — the fence the activation/tombstone CAS binds to. */
  readonly contentHash: string;
  /** The embedded LanceDB rows to write (empty when `gen === null`). */
  readonly rows: ReturnType<typeof assembleRows>;
  /** The chunk ids the write must produce, for the post-write completeness verify. */
  readonly expectedChunkIds: readonly string[];
}

/**
 * Apply a non-empty reconcile result to the two derived stores. The mutation
 * order is dictated by the content-hash cursor being the SQLite `content_hash`
 * itself — so it MUST never advance past a note whose embedding has not durably
 * landed, and it must NEVER advance without activating the matching generation
 * (else the note serves stale/nothing forever, since the next reconcile sees it
 * as unchanged). The staged shape (#329 round-2, wing finding 1):
 *
 *   1. **Purge dropped** — one SQLite transaction (note_links → identity keys →
 *      notes row) makes the note unreturnable the instant it commits (retrieval
 *      joins live projection rows), THEN its LanceDB vectors are dropped. This is
 *      invisibility-first: a crash between the two leaves an orphan vector that
 *      `query` can never surface and `index rebuild` sweeps — never `sync`.
 *   2. **Stage reindex** — for each changed+new note, embed + write + verify its
 *      new generation in LanceDB, but do NOT activate it and do NOT fold. A crash
 *      here leaves the note still classified `changed` (projection hash unmoved),
 *      so the next sync re-stages idempotently — the cursor never advanced past a
 *      failed embed.
 *   3. **FTS (pre-cursor)** — re-derive the inverted index over the freshly staged
 *      rows BEFORE the cursor-advancing commit (finding 2). An FTS failure throws
 *      here, so content_hash never advances and the next sync retries — never a
 *      committed cursor over a stale inverted index.
 *   4. **Commit atomically** — in ONE SQLite transaction: fold the projection for
 *      changed+new (advancing content_hash to the new hash) AND run the fenced
 *      activation CAS for each staged generation against that same new hash. The
 *      fold is the v2 reconciling {@link foldNotesV2} — it reconciles notes +
 *      note_identity_keys + outgoing note_links (finding 1), never the notes table
 *      alone. Fold and activation share the transaction, so the content-hash cursor
 *      advances IFF the verified generation goes live — never one without the other.
 *   5. **Retire + drop vectors** — LanceDB cleanup under the maintenance lock:
 *      retire each reindexed note's now-superseded generations, then drop the
 *      dropped notes' chunks. This is per-note cleanup, NOT the global orphan
 *      sweep (which is `index rebuild`'s alone) — it runs only when there is real
 *      reindex/drop work, so the structural-noop invariant is untouched.
 *   6. **Move-in-place** — pure moves re-embed NOTHING (same content hash, same
 *      live generation) but still run {@link foldNotesV2}: a rename moves the
 *      path-derived slug, so its slug identity key must move with it (finding 1).
 */
async function applyReconcile(
  ctx: RunContext,
  store: Store,
  notes: readonly ParsedNote[],
  rec: ReconcileResult,
): Promise<void> {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const resolve = (id: string): ParsedNote | null => byId.get(id) ?? null;

  const reindex = [...rec.changed, ...rec.new];
  const reindexIds = reindex.map((n) => n.noteId);
  const droppedIds = rec.dropped.map((n) => n.noteId);
  const movedIds = rec.moved.map((n) => n.noteId);

  // 1. Invisibility-first SQLite purge of dropped notes (before any LanceDB delete).
  if (droppedIds.length > 0) {
    purgeDropped(store, droppedIds);
    // Test-only crash injection (gated; inert in production): abort the real sync
    // immediately AFTER the SQLite purge transaction commits but BEFORE the LanceDB
    // vector delete — the exact orphan-vector window (§2.8). The projection row is
    // already gone (retrieval is invisibility-first), so `query` cannot surface the
    // note; `index rebuild` sweeps the stranded vector. This drives the failpoint
    // through the production path, never by hand-deleting rows.
    if (ctx.env.ATLAS_TEST_MODE === "1" && ctx.env.ATLAS_SYNC_FAILPOINT === "after-purge-txn") {
      throw new CliError({
        code: "internal",
        message: "sync: test failpoint after-purge-txn (crash before LanceDB vector delete)",
        exitCode: EXIT.INTERNAL,
      });
    }
  }

  if (reindexIds.length > 0 || droppedIds.length > 0) {
    const cfg = indexingConfig(ctx);
    const dir = resolvePath(ctx, ctx.config.config.lancedb.dir);
    const conn = await lancedb.connect(dir);
    const table = instrumentTable(ctx, await openSearchTable(conn, cfg));
    const { embed, close } = await buildEmbedder(ctx, cfg, ctx.runId);
    const lock = tableMaintenanceLock(dir);
    const configKey = indexingConfigKey(cfg);
    try {
      // The activation CAS fences against a server-owned config epoch — adopt once.
      store.generation.adoptConfig(configKey);

      // 2. PREPARE every reindex generation OUTSIDE the lock: chunk + embed + assemble
      //    rows. The network embed must NOT serialize behind the table lock. Nothing is
      //    written to LanceDB yet — that happens inside the single critical section below.
      const prepared: PreparedGeneration[] = [];
      for (const rn of reindex) {
        const note = byId.get(rn.noteId);
        if (note === undefined) {
          // Unreachable — reconcile only classifies parsed vault notes as changed/new.
          throw new CliError({
            code: "internal",
            message: `sync: reindex note ${rn.noteId} missing from the parsed snapshot`,
            exitCode: EXIT.INTERNAL,
          });
        }
        prepared.push(await prepareGeneration(cfg, embed, note));
      }

      // 3. ONE table-lock critical section (#329 round-3, wing finding 3). The lock had
      //    been RELEASED between staging and activation, so a concurrent compaction /
      //    orphan sweep could classify the not-yet-active generation rows as orphans and
      //    delete them — after which activation exposed a ZERO-CHUNK generation and the
      //    content_hash cursor advanced, wedging the note forever. Hold the lock
      //    CONTINUOUSLY across write → verify → FTS → fold+activate → retire, so no other
      //    maintenance can observe a staged-but-unactivated generation. Embedding already
      //    happened above, outside the lock, so the network step never serializes.
      await lock.runExclusive(async () => {
        // 3a. Write + verify every staged generation.
        for (const p of prepared) {
          if (p.gen === null) continue;
          await writeGeneration(table, p.rows);
          if (!(await verifyComplete(table, p.gen, p.expectedChunkIds))) {
            throw new CliError({
              code: "internal",
              message: `sync: incomplete LanceDB write for note ${p.noteId} (gen ${p.gen})`,
              exitCode: EXIT.INTERNAL,
              retryable: true,
            });
          }
        }

        // 3b. FTS BEFORE the cursor-advancing commit (#329 round-3, wing finding 2).
        //     An FTS failure must throw BEFORE the commit so content_hash never moves and
        //     the next sync re-detects the note as changed and retries the whole stage.
        if (ctx.env.ATLAS_TEST_MODE === "1" && ctx.env.ATLAS_SYNC_FAILPOINT === "before-fts") {
          throw new CliError({
            code: "internal",
            message: "sync: test failpoint before-fts (crash before FTS + the cursor-advancing commit)",
            exitCode: EXIT.INTERNAL,
          });
        }
        await ensureFtsIndex(table);

        // 3c. COMMIT: fold changed+new + activate the staged generations ATOMICALLY. The
        //     fold advances content_hash to the new hash; the fenced CAS then matches it —
        //     the cursor advances iff the note goes live. Any activation-CAS failure rolls
        //     the whole fold back. The v2 reconciling fold reconciles notes +
        //     note_identity_keys + outgoing plain note_links.
        const commit = store.db.transaction(() => {
          if (reindexIds.length > 0) foldNotesV2(store, reindexIds, resolve);
          for (const p of prepared) {
            if (p.gen === null) {
              // Prose-less note: clear the fence so retrieval serves nothing for it.
              store.generation.tombstoneGeneration(p.noteId, p.contentHash, configKey);
              continue;
            }
            const activated = store.generation.activateGeneration(p.noteId, p.gen, p.contentHash, configKey);
            if (!activated) {
              throw new CliError({
                code: "internal",
                message: `sync: activation CAS failed for note ${p.noteId} (gen ${p.gen})`,
                hint: "The projection fence moved under the sync; re-run sync to re-detect.",
                exitCode: EXIT.INTERNAL,
              });
            }
          }
        });
        commit();

        // 3d. Retire each reindexed note's superseded generations — STILL under the same
        //     lock hold (never the global orphan sweep).
        for (const p of prepared) {
          if (p.gen !== null) await retireSupersededGenerations(table, p.noteId, p.gen);
        }
      });

      // 4. Dropped-note vector delete — AFTER the critical section. `indexNotes` takes the
      //    table lock ITSELF (so it cannot run inside the section above without a
      //    self-deadlock on the non-reentrant mutex), and the dropped notes' projection
      //    rows are already purged, so a crash here only leaves orphan vectors the next
      //    maintenance sweep reclaims — never a cursor-buried inconsistency.
      if (droppedIds.length > 0) {
        // Drive the dropped-note vector delete through indexNotes with an EMPTY note
        // provider: a requested id absent from `deps.notes()` has its chunks removed
        // (the same removal path `index:reconcile` uses).
        const dropDeps: IndexDeps = {
          config: cfg,
          table,
          store: store.generation,
          embed,
          lockLocation: dir,
          notes: () => [],
        };
        await indexNotes(dropDeps, droppedIds);
      }
    } finally {
      close();
    }
  }

  // 6. Pure moves: no re-embed (same content hash ⇒ same live generation), but the
  //    v2 fold still reconciles notes + note_identity_keys + outgoing note_links —
  //    a rename changes the path-derived slug, so its slug identity key must move
  //    too (finding 1). Independent of the reindex commit — nothing to activate.
  if (movedIds.length > 0) foldNotesV2(store, movedIds, resolve);
}

/**
 * PREPARE ONE reindex note's new generation OUTSIDE any lock: chunk → embed →
 * assemble rows (the §3 steps 1–3 of the fenced pipeline, WITHOUT write or
 * activation). Returns the assembled rows + the ids the write must produce, or
 * `gen: null` for a prose-less note (zero chunks — never written/activated; the
 * commit tombstones it). Throws (fail-closed, cursor unadvanced) on an embed
 * failure. The WRITE + verify happen later, inside the single table-lock critical
 * section, so the embed network step never serializes behind the lock and the
 * staged rows are written under the same hold that activates them.
 */
async function prepareGeneration(
  cfg: ReturnType<typeof indexingConfig>,
  embed: Embedder,
  note: ParsedNote,
): Promise<PreparedGeneration> {
  const gen = generationId(note, cfg);
  const chunks = chunkNote(note, cfg);
  if (chunks.length === 0) {
    return { noteId: note.id, gen: null, contentHash: note.contentHash, rows: [], expectedChunkIds: [] };
  }
  const expectedChunkIds = chunks.map((c) => chunkId(gen, c.sectionPath, c.ordinal));

  const outcome = await embed(chunks.map((c) => c.text));
  if (!outcome.ok) {
    throw new CliError({
      code: "internal",
      message: `sync: embedding failed for note ${note.id} (${outcome.kind})${outcome.message ? `: ${outcome.message}` : ""}`,
      hint: "The projection content_hash is not advanced past a note whose embed failed; the next sync re-detects and repairs it.",
      exitCode: EXIT.INTERNAL,
      retryable: outcome.retryable,
      ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
    });
  }
  const rows = assembleRows(chunks, outcome.vectors, cfg, gen);
  return { noteId: note.id, gen, contentHash: note.contentHash, rows, expectedChunkIds };
}

/**
 * The dropped-note cross-store purge — the SQLite half, in ONE transaction:
 * delete `note_links` (both directions) → `note_identity_keys` → the `notes` row.
 * Children are deleted explicitly (FK-pragma-order-independent, the erase.ts
 * pattern) even though `notes` cascades. Scope is exactly the v2 vault-derived
 * projection PLUS the vault-derived `evidence` rows (task 4-4): a dropped note's
 * evidence is deleted in the SAME invisibility-first transaction, so `sync`'s drop
 * path and `db rebuild` agree (no orphaned evidence). `evidence.noteId` is a soft
 * reference (no FK), so it must be deleted explicitly.
 */
function purgeDropped(store: Store, noteIds: readonly string[]): void {
  const ids = [...new Set(noteIds)];
  if (ids.length === 0) return;
  const delLinks = store.db.prepare(`DELETE FROM note_links WHERE source_note_id = ? OR target_note_id = ?`);
  const delKeys = store.db.prepare(`DELETE FROM note_identity_keys WHERE note_id = ?`);
  const delEvidence = store.db.prepare(`DELETE FROM evidence WHERE noteId = ?`);
  const delNote = store.db.prepare(`DELETE FROM notes WHERE note_id = ?`);
  const run = store.db.transaction(() => {
    for (const id of ids) {
      delLinks.run(id, id);
      delKeys.run(id);
      delEvidence.run(id);
      delNote.run(id);
    }
  });
  run();
}

function renderSync(ctx: RunContext, env: SyncV2Envelope): void {
  if (ctx.output.mode === "json") {
    emitJson(env);
    return;
  }
  if (env.noop) {
    ctx.render(`sync: up to date (${env.scannedCount} note(s) scanned) · noop`);
    return;
  }
  const reindexed = env.changedCount + env.newCount;
  ctx.render(
    [
      `sync: ${env.scannedCount} note(s) scanned`,
      `reindexed ${reindexed} (changed ${env.changedCount} · new ${env.newCount}) · dropped ${env.droppedCount} · moved ${env.movedCount}`,
    ].join("\n"),
  );
}

registerCommand("sync", syncHandler);
