/**
 * `indexNote` + `reconcileIndex` — the fenced, crash-safe index write path
 * (Task 3.2, retrieval-index-contract §3). This is the orchestrator that runs the
 * reconciliation pipeline to convergence:
 *
 *   chunk → embed → write → verify-complete → **activate (SQLite CAS)** → retire → mark
 *
 * Every step is independently retryable and crash-safe: a crash between ANY two
 * steps converges on rerun with no duplicate chunks and no orphaned active
 * generation. The pipeline holds no state of its own — it re-derives everything
 * from the note, the config, the deterministic chunk ids, and the SQLite fence
 * columns, so a rerun simply finishes wherever the last run stopped:
 *
 *   - after chunk/embed, before write → rerun re-embeds + writes (idempotent).
 *   - after write, before activate    → rerun sees chunks present (verify passes)
 *                                        and activates.
 *   - after activate, before retire   → the note is already live (fenced by
 *                                        `active_generation_id`); rerun retires the
 *                                        superseded chunks (idempotent) → unchanged.
 *   - after retire, before "mark"     → V1 has no separate marker column; the
 *                                        active fence columns ARE the indexed
 *                                        marker, so a rerun re-derives `unchanged`.
 *
 * **SQLite is the sole activation authority (D13).** This module NEVER flips the
 * fence itself — it calls {@link ActivationStore.activateGeneration}, whose CAS
 * (content-hash + config-revision fence) decides whether the generation goes live.
 * A stale-config worker's CAS FAILS after a newer activation (both completion
 * orders); this module then reports {@link SupersededOutcome} and leaves the newer
 * generation untouched.
 *
 * A permanent embedding failure surfaces as a TYPED {@link EmbeddingFailedOutcome}
 * (never a throw) so `index repair` (Task 3.5) can converge or escalate it.
 *
 * D14: consumes `@atlas/contracts` DTOs + LanceDB; the SQLite authority and the
 * embedder are injected as STRUCTURAL interfaces ({@link ActivationStore},
 * {@link Embedder}), so this package imports neither `@atlas/sqlite-store` nor
 * `@atlas/models` in production — no `apps/cli` import either.
 */
import type { ParsedNote, ProviderErrorKind } from "@atlas/contracts";
import { chunkNote } from "./chunker.js";
import {
  chunkId,
  generationId,
  indexingConfigKey,
  type GenerationId,
  type IndexingConfig,
} from "./generation.js";
import { assembleRows, verifyComplete, writeGeneration, type SearchTable } from "./writer.js";
import { compactOrphans, removeNoteGenerations, retireSupersededGenerations } from "./retire.js";
import { tableMaintenanceLock, type IndexMaintenanceLock } from "./lock.js";

/**
 * The SQLite activation authority (structural mirror of `@atlas/sqlite-store`'s
 * `GenerationRepo` / `Store`). Injected so this package stays decoupled from the
 * store; the real `Store.activateGeneration` / `Store.generation` satisfy it.
 */
export interface ActivationStore {
  /** The activation CAS — see `GenerationRepo.activateGeneration`. Consumes the
   * config IDENTITY (`configKey`), NEVER a raw revision: the store resolves and owns
   * the fence epoch, so a caller cannot inflate it (round-3 finding 3). Returns
   * `true` iff `gen` is now the note's live generation. */
  activateGeneration(
    noteId: string,
    gen: string,
    expectedContentHash: string,
    configKey: string,
  ): boolean;
  /** The fenced tombstone CAS — see `GenerationRepo.tombstoneGeneration`. Clears the
   * note's active generation under the same fence as activation. Returns `true` iff
   * cleared (round-3 finding 2). */
  tombstoneGeneration(noteId: string, expectedContentHash: string, configKey: string): boolean;
  /** Record a durable indexing-config ADOPTION event and return its monotonic epoch
   * (see `GenerationRepo.adoptConfig`). The orchestrator adopts the current config
   * once per pass; re-adopting the current config is idempotent, adopting a
   * different one (upgrade OR rollback) mints a strictly-higher epoch. SQLite owns
   * the number (round-3 findings 3 & 4). */
  adoptConfig(configKey: string): number;
  /** The composite `generationId` a note is fenced to, or `null` if never indexed. */
  activeGenerationId(noteId: string): string | null;
  /** Every currently-active `generationId` across all notes (the retrieval-live set). */
  activeGenerationIds(): string[];
}

/**
 * Deterministic failpoints for the crash-safety + interleaving acceptance tests
 * (round-2 findings 2, 3, 5). Each is awaited by `indexNote`/`reconcileIndex` at a
 * durable boundary; a test hook can THROW (simulate a crash between steps) or AWAIT
 * a barrier (deterministically interleave a second worker). Undefined in
 * production. All are optional and default to no-ops.
 */
export interface IndexHooks {
  /** After embedding, before the LanceDB write. */
  readonly afterEmbed?: () => void | Promise<void>;
  /** After the (idempotent) write, before verify-complete. */
  readonly afterWrite?: () => void | Promise<void>;
  /** After a successful CAS activation, before retirement (inside the lock). */
  readonly afterActivate?: () => void | Promise<void>;
  /** Just before retirement deletes (inside the lock) — the finding-2 window. */
  readonly beforeRetire?: () => void | Promise<void>;
  /** After the compaction active-set snapshot, before its delete (inside the lock)
   * — the finding-3 window. */
  readonly afterCompactSnapshot?: () => void | Promise<void>;
}

/** The batch embedder outcome — a TYPED success/failure, never a throw across the
 * seam. On failure it mirrors the `@atlas/contracts` `ProviderError` taxonomy so
 * the caller can classify retryable vs permanent (D19 / provider-interface §5). */
export type EmbedOutcome =
  | { readonly ok: true; readonly vectors: readonly (readonly number[])[] }
  | {
      readonly ok: false;
      /** `true` for provider-retryable kinds (rate_limit/quota/timeout/transport). */
      readonly retryable: boolean;
      /** The provider-error kind (drives the typed index-repair code). */
      readonly kind: ProviderErrorKind;
      readonly message?: string;
      /** Provider-directed retry delay (ms), when the provider supplied timing. */
      readonly retryAfterMs?: number;
    };

/** Batch-embed chunk texts through the egress broker (D7 dims applied CLI-side).
 * Returns N vectors in input order, or a typed failure. */
export type Embedder = (texts: readonly string[]) => Promise<EmbedOutcome>;

/** Everything `indexNote` needs; `notes` is consumed only by {@link reconcileIndex}. */
export interface IndexDeps {
  /** The indexing config (generation-identity components: chunker/model/dims). The
   * fence's config epoch is resolved server-side from {@link indexingConfigKey}`(config)`
   * — never a caller-supplied integer (round-3 finding 3). */
  readonly config: IndexingConfig;
  /** The open `search_chunks` LanceDB table (from {@link openSearchTable}). */
  readonly table: SearchTable;
  /** The SQLite activation authority (the sole CAS owner + config-adoption owner). */
  readonly store: ActivationStore;
  /** The batch embedder (egress-broker `models.embed`, adapted to {@link Embedder}). */
  readonly embed: Embedder;
  /**
   * The index maintenance exclusion lock (round-2 findings 2 & 3, round-3 finding 1).
   * Serializes the write→verify→activate→retire critical section against orphan
   * compaction so neither races the other — across concurrent async workers AND
   * concurrent CLI processes. A lock is **REQUIRED**: supply EITHER an injected
   * shared `lock` OR a {@link lockLocation} from which the table-scoped lock is
   * derived. There is no NOOP default — a caller can never silently run unserialized
   * (which is how a separate process could delete the SQLite-active generation).
   * When both are given, `lock` wins (a test pinning deterministic interleaving).
   * {@link reconcileIndex} threads ONE lock through every `indexNote` + the final
   * compaction.
   */
  readonly lock?: IndexMaintenanceLock;
  /**
   * The LanceDB directory backing {@link table} — the scope for the REQUIRED
   * table-scoped maintenance lock when no `lock` is injected (round-3 finding 1).
   * All callers over the same directory (in ANY process) serialize through it: an
   * in-process mutex keyed by the directory + an inter-process advisory lockfile in
   * it. This is the LanceDB connect path (`lancedb.dir`). Required unless `lock` is
   * supplied.
   */
  readonly lockLocation?: string;
  /** Deterministic failpoints for the crash/interleaving tests (no-ops in prod). */
  readonly hooks?: IndexHooks;
  /** The notes to reconcile (reconcile only). A provider so the caller can stream
   * a fresh `VaultSnapshot` without holding it in `IndexDeps`. */
  readonly notes?: () => readonly ParsedNote[] | Promise<readonly ParsedNote[]>;
}

/** Fields on every {@link IndexOutcome}. */
interface OutcomeBase {
  readonly noteId: string;
  /** The generation this pass computed for the note (its target `generationId`). */
  readonly generationId: GenerationId;
}

/** The generation was written, verified complete, and CAS-activated (now live). */
export interface IndexedOutcome extends OutcomeBase {
  readonly kind: "indexed";
  readonly chunkCount: number;
  /** Superseded chunks retired for this note after activation (§3 step 6). */
  readonly retiredChunks: number;
  /** Present iff the generation's chunks were already durably complete in LanceDB
   * and only the SQLite fence was re-pointed — no embed spend (repair action
   * `re-activated`). */
  readonly reattached?: true;
}

/** The note's target generation was already active and complete — a no-op pass. */
export interface UnchangedOutcome extends OutcomeBase {
  readonly kind: "unchanged";
  readonly chunkCount: number;
}

/**
 * The note produced ZERO chunks (no prose-bearing section — e.g. a title-only
 * stub), so there is nothing to embed, write, or activate. An empty note is never
 * activated: an active generation with zero live chunks is exactly the divergent
 * state retrieval-index-contract §4 flags as broken.
 *
 * There are two sub-cases, both reported here:
 *   - **never-indexed empty** — the note had no active generation, so it stays
 *     `active_generation_id = NULL`; `retiredChunks` is `0` (round-2 finding 6).
 *   - **tombstoned** — the note WAS indexed and just lost all its prose. Leaving
 *     the old generation active would keep serving stale content and preserve its
 *     rows through compaction, so the pass performs a **fenced tombstone**: it CAS-
 *     clears `active_generation_id` (so retrieval stops serving it) and retires the
 *     note's now-orphaned chunks; `retiredChunks` counts them (round-3 finding 2).
 *
 * A rerun re-derives `empty` idempotently; if the note later gains prose it indexes
 * normally. `superseded` (not `empty`) is returned if a newer worker wins the
 * tombstone fence.
 */
export interface EmptyOutcome extends OutcomeBase {
  readonly kind: "empty";
  /** Orphaned chunks retired when tombstoning a formerly-indexed note (0 if it was
   * never indexed). */
  readonly retiredChunks: number;
}

/**
 * The CAS refused this generation — a newer generation/config already activated
 * (config-revision fence) OR the note's content changed under the worker
 * (content-hash fence). The written chunks are left as an orphaned generation:
 * filtered from retrieval by the active-generation join, compacted by a later
 * {@link reconcileIndex} sweep.
 */
export interface SupersededOutcome extends OutcomeBase {
  readonly kind: "superseded";
}

/**
 * A TYPED permanent/retryable embedding failure (repairable via `index repair`,
 * Task 3.5). `code` mirrors `cli-contract/index-repair.schema.json`:
 * `embedding-retryable` (retryable) or `embedding-failed` (permanent).
 */
export interface EmbeddingFailedOutcome extends OutcomeBase {
  readonly kind: "embedding-failed";
  readonly code: "embedding-retryable" | "embedding-failed";
  readonly retryable: boolean;
  /** The underlying provider-error kind (never a secret). */
  readonly providerKind: ProviderErrorKind;
  readonly message?: string;
  readonly retryAfterMs?: number;
}

/**
 * The verify-complete gate failed after the write (§3 step 4) — a short/partial
 * batched write. Always retryable: a rerun re-writes the gaps and re-checks. The
 * generation is NOT activated, so a partial write is never queryable.
 */
export interface WriteIncompleteOutcome extends OutcomeBase {
  readonly kind: "write-incomplete";
  /** Expected chunk count for the generation (LanceDB is missing some of these). */
  readonly expectedChunks: number;
}

/** The discriminated result of indexing one note. */
export type IndexOutcome =
  | IndexedOutcome
  | UnchangedOutcome
  | EmptyOutcome
  | SupersededOutcome
  | EmbeddingFailedOutcome
  | WriteIncompleteOutcome;

/**
 * Resolve the REQUIRED maintenance lock (round-3 finding 1): an injected shared
 * `lock` wins (deterministic interleaving / a caller coordinating its own mutex);
 * otherwise the table-scoped lock derived from `lockLocation`. Throws if NEITHER is
 * supplied — the write path must never run unserialized (a NOOP default is exactly
 * the cross-process gap the finding calls out).
 */
function resolveLock(deps: IndexDeps): IndexMaintenanceLock {
  if (deps.lock !== undefined) return deps.lock;
  if (deps.lockLocation !== undefined) return tableMaintenanceLock(deps.lockLocation);
  throw new Error(
    "indexNote/reconcileIndex: a maintenance lock is required — supply deps.lock " +
      "(a shared IndexMaintenanceLock) or deps.lockLocation (the LanceDB dir, for the " +
      "table-scoped cross-process lock). Running unserialized can delete the SQLite-active generation.",
  );
}

/**
 * Drive one note through the fenced reconciliation pipeline (§3). Idempotent and
 * crash-safe (see module docs). Returns a typed {@link IndexOutcome} for every
 * terminal state — including a permanent embedding failure — and never throws for
 * a fenced/failed activation.
 */
export async function indexNote(note: ParsedNote, deps: IndexDeps): Promise<IndexOutcome> {
  const { config, table, store, embed } = deps;
  const hooks = deps.hooks ?? {};
  // The maintenance lock is REQUIRED (round-3 finding 1): an injected shared lock, or
  // the table-scoped lock derived from `lockLocation` (which serializes concurrent
  // async workers AND concurrent CLI processes). There is no NOOP default — without
  // one, a separate process could interleave activation with retirement/compaction
  // and delete the SQLite-active generation.
  const lock = resolveLock(deps);
  // The fence's config epoch is server-owned: the store resolves it from the config
  // IDENTITY (round-3 findings 3 & 4); this module never passes a raw integer.
  const configKey = indexingConfigKey(config);
  const gen = generationId(note, config);

  // (1) Chunk — deterministic; the complete expected chunk-id set is knowable now.
  const chunks = chunkNote(note, config);
  const expectedChunkIds = chunks.map((c) => chunkId(gen, c.sectionPath, c.ordinal));

  // (1a) Empty-note policy (round-2 finding 6 + round-3 finding 2). A note with no
  // prose-bearing section yields zero chunks: there is nothing to embed, write, or
  // activate, and activating it would create the §4 "active generation with zero live
  // chunks" divergence. Two cases:
  //   - never-indexed → benign `empty`, stays `active_generation_id = NULL`.
  //   - formerly indexed → it just lost all prose: leaving the old generation active
  //     would keep serving stale content, so perform a FENCED tombstone (clear the
  //     fence + retire the orphaned chunks) under the lock.
  if (chunks.length === 0) {
    if (store.activeGenerationId(note.id) === null) {
      return { kind: "empty", noteId: note.id, generationId: gen, retiredChunks: 0 };
    }
    return lock.runExclusive(async () => {
      // Re-read under the lock: a concurrent worker may have already cleared/changed it.
      if (store.activeGenerationId(note.id) === null) {
        return { kind: "empty", noteId: note.id, generationId: gen, retiredChunks: 0 };
      }
      // Fenced clear. A stale-config worker (or a mid-flight content change) loses
      // here and does NOT clear a newer generation.
      if (!store.tombstoneGeneration(note.id, note.contentHash, configKey)) {
        return { kind: "superseded", noteId: note.id, generationId: gen };
      }
      // The note now has no active generation — retire ALL of its chunks. `gen` (the
      // empty note's generation) has zero rows, so "retire every generation except
      // `gen`" deletes them all.
      if (hooks.beforeRetire) await hooks.beforeRetire();
      const retiredChunks = await retireSupersededGenerations(table, note.id, gen);
      return { kind: "empty", noteId: note.id, generationId: gen, retiredChunks };
    });
  }

  // Fast path: the target generation is already live AND complete → nothing to do
  // (no re-embed). This is what makes a reconcile sweep cheap and idempotent. If
  // it is active but INCOMPLETE (e.g. the LanceDB dir was lost), fall through and
  // re-embed/re-write; re-activation with the same gen is an idempotent CAS.
  //
  // Retirement of any stray superseded generation runs UNDER THE LOCK and against
  // the CURRENT SQLite-active generation (re-read inside the lock) — never a value
  // read before the lock, which could be stale (round-2 finding 2).
  if (store.activeGenerationId(note.id) === gen) {
    if (await verifyComplete(table, gen, expectedChunkIds)) {
      const retiredChunks = await lock.runExclusive(async () => {
        const activeNow = store.activeGenerationId(note.id);
        // A concurrent worker may have superseded us between the check above and the
        // lock; only retire relative to the CURRENT active generation, and only if
        // WE are still it (otherwise leave the newer generation's retire to its own
        // pass — never delete a generation that is now live).
        if (activeNow !== gen) return 0;
        if (hooks.beforeRetire) await hooks.beforeRetire();
        return retireSupersededGenerations(table, note.id, gen);
      });
      // A stray superseded generation cleaned up counts as an "indexed" convergence;
      // a clean no-op is "unchanged".
      if (retiredChunks > 0) {
        return { kind: "indexed", noteId: note.id, generationId: gen, chunkCount: chunks.length, retiredChunks };
      }
      return { kind: "unchanged", noteId: note.id, generationId: gen, chunkCount: chunks.length };
    }
  }

  // Re-attach: the target generation is already durably COMPLETE in LanceDB but
  // the fence does not point at it (fence lost — e.g. an older-backup restore or a
  // pre-#212 projection rebuild). Activate without re-embedding. Fail-closed by
  // construction: any config/content drift changes `gen`, whose chunks will NOT be
  // present, so this path can never mask a genuine invalidation. Same double-verify
  // pattern as the fast path: probe outside the lock, recheck inside (a concurrent
  // compaction may have reclaimed the rows between the two).
  if (await verifyComplete(table, gen, expectedChunkIds)) {
    const reattachOutcome = await lock.runExclusive(async (): Promise<IndexOutcome | null> => {
      if (!(await verifyComplete(table, gen, expectedChunkIds))) return null; // compacted since — fall through to embed
      const activated = store.activateGeneration(note.id, gen, note.contentHash, configKey);
      if (!activated) return { kind: "superseded", noteId: note.id, generationId: gen };
      if (hooks.afterActivate) await hooks.afterActivate();
      if (hooks.beforeRetire) await hooks.beforeRetire();
      const retiredChunks = await retireSupersededGenerations(table, note.id, gen);
      return { kind: "indexed", noteId: note.id, generationId: gen, chunkCount: chunks.length, retiredChunks, reattached: true };
    });
    if (reattachOutcome !== null) return reattachOutcome;
  }

  // (2) Embed — batched, through the egress broker (D7 dims applied CLI-side).
  // OUTSIDE the lock (the expensive network step must not serialize all indexing).
  const outcome = await embed(chunks.map((c) => c.text));
  if (!outcome.ok) {
    return {
      kind: "embedding-failed",
      noteId: note.id,
      generationId: gen,
      code: outcome.retryable ? "embedding-retryable" : "embedding-failed",
      retryable: outcome.retryable,
      providerKind: outcome.kind,
      ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
    };
  }
  const vectors = outcome.vectors;
  if (hooks.afterEmbed) await hooks.afterEmbed();

  const rows = assembleRows(chunks, vectors, config, gen);

  // (3)–(6) write → verify → activate → retire run UNDER THE LOCK as one critical
  // section (round-2 findings 2 & 3): compaction cannot snapshot the active set
  // mid-write (so it never deletes an about-to-activate generation), and no other
  // worker can activate between our CAS and our retire (so retire never deletes a
  // now-live generation).
  return lock.runExclusive(async () => {
    // (3) Write — idempotent, keyed by deterministic chunkId; resumable after a crash.
    await writeGeneration(table, rows);
    if (hooks.afterWrite) await hooks.afterWrite();

    // (4) Verify-complete — gate activation on a COMPLETE write (§3 step 4).
    if (!(await verifyComplete(table, gen, expectedChunkIds))) {
      return { kind: "write-incomplete", noteId: note.id, generationId: gen, expectedChunks: expectedChunkIds.length };
    }

    // (5) Activate — the SQLite CAS is the linearization point + the fence. A stale
    // config (or a mid-flight content change) loses here and does NOT overwrite the
    // live generation.
    const activated = store.activateGeneration(note.id, gen, note.contentHash, configKey);
    if (!activated) {
      return { kind: "superseded", noteId: note.id, generationId: gen };
    }
    if (hooks.afterActivate) await hooks.afterActivate();

    // (6) Retire the superseded generations for this note. Safe here: we hold the
    // lock and just set the active generation to `gen`, so no concurrent activation
    // can have changed it — deleting "every generation for this note except `gen`"
    // cannot touch a live generation.
    if (hooks.beforeRetire) await hooks.beforeRetire();
    const retiredChunks = await retireSupersededGenerations(table, note.id, gen);

    // (7) Mark indexed — in V1 the marker IS the active fence state (no separate
    // column), so activation + retire completing is the mark; a crash before this
    // return converges to `unchanged` on rerun via the fast path above.
    return { kind: "indexed", noteId: note.id, generationId: gen, chunkCount: chunks.length, retiredChunks };
  });
}

/** Aggregate report from a full {@link reconcileIndex} pass. */
export interface IndexReconcileReport {
  /** One {@link IndexOutcome} per reconciled note, in input order. */
  readonly outcomes: readonly IndexOutcome[];
  /** Orphaned/mixed-generation chunks compacted by the sweep (§3 step 6 / §2). */
  readonly compactedChunks: number;
}

/**
 * Reconcile the whole index to convergence (Task 3.2): run {@link indexNote} for
 * every note, then compact orphaned/mixed generations across the table using the
 * SQLite-authoritative active set (which also reclaims chunks of notes removed
 * from the vault). Crash-safe: a crash anywhere converges on the next run because
 * each note's pipeline and the final sweep are individually idempotent.
 *
 * Requires `deps.notes`.
 */
export async function reconcileIndex(deps: IndexDeps): Promise<IndexReconcileReport> {
  if (deps.notes === undefined) {
    throw new Error("reconcileIndex: deps.notes is required (provides the notes to reconcile)");
  }
  const notesProvider = deps.notes;
  const hooks = deps.hooks ?? {};
  // ONE shared lock for the whole pass — every `indexNote`'s critical section AND
  // the final compaction serialize through it (round-2 finding 3 / round-3 finding
  // 1). The scoped `indexNotes` reconcile shares this exact threading.
  return withReconcileLock(deps, async (lock, noteDeps) => {
    // Declare the current configuration ONCE for the pass (an adoption event): a config
    // change (upgrade or rollback) mints a new epoch, re-running under the same config
    // is idempotent. SQLite owns the epoch; workers resolve it by config identity
    // (round-3 findings 3 & 4).
    deps.store.adoptConfig(indexingConfigKey(deps.config));

    const notes = await notesProvider();
    const outcomes: IndexOutcome[] = [];
    for (const note of notes) {
      outcomes.push(await indexNote(note, noteDeps));
    }
    // Sweep: compact every chunk whose generation is not SQLite-active. Retrieval
    // already fenced these out; this reclaims their storage (§2 last paragraph). The
    // snapshot + delete run UNDER THE LOCK as one critical section so no activation/
    // write can add a live generation between the snapshot and the delete (finding 3).
    const compactedChunks = await lock.runExclusive(async () => {
      const activeIds = deps.store.activeGenerationIds();
      if (hooks.afterCompactSnapshot) await hooks.afterCompactSnapshot();
      return compactOrphans(deps.table, activeIds);
    });
    return { outcomes, compactedChunks };
  });
}

/**
 * Resolve the ONE shared maintenance lock for a reconcile pass and hand it — plus
 * lock-threaded `noteDeps` (every `indexNote` uses the SAME lock) — to `fn`. Every
 * per-note critical section AND the final compaction serialize through this single
 * lock, across async workers AND processes (round-3 finding 1). Extracted so the
 * full {@link reconcileIndex} and the scoped {@link indexNotes} (60-B) share one
 * lock-threading code path (DRY).
 */
export async function withReconcileLock<T>(
  deps: IndexDeps,
  fn: (lock: IndexMaintenanceLock, noteDeps: IndexDeps) => Promise<T>,
): Promise<T> {
  const lock = resolveLock(deps);
  return fn(lock, { ...deps, lock });
}

/**
 * Drop EVERY chunk for a note under the shared reconcile lock — the scoped
 * reconcile's removal path for a note that no longer resolves in the vault
 * (archived/deleted). LanceDB-only (never the SQLite fence — the caller owns
 * activation state); idempotent. Returns the rows removed.
 */
export async function removeNoteChunks(
  deps: IndexDeps,
  noteId: string,
  lock: IndexMaintenanceLock,
): Promise<number> {
  return lock.runExclusive(() => removeNoteGenerations(deps.table, noteId));
}

// Re-export the write-path helpers the CLI orchestrator (Task 3.4/3.5) composes.
export { openSearchTable, countGenerationChunks } from "./writer.js";
export { compactOrphans, retireSupersededGenerations } from "./retire.js";
