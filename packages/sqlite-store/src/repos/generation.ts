/**
 * `repos/generation` — the **sole activation authority** for the retrieval index
 * (Task 3.2; retrieval-index-contract §2). SQLite — not LanceDB — decides which
 * generation a note's retrieval is fenced to; LanceDB only stores the chunks that
 * a successful CAS makes live.
 *
 * The two `notes` fence columns (owned by `0001_core`, provisioned there because
 * Phase 3 registers no migration) are updated **atomically together** by
 * {@link GenerationRepo.activateGeneration}:
 *
 * - **`active_generation`** — `INTEGER NOT NULL DEFAULT 0`. It carries the
 *   **indexing-config revision** the active generation was produced under (a
 *   monotonic epoch: `0` = never indexed, higher = newer config). It orders
 *   activations and drives the needs-index scan
 *   (`idx_notes_needs_index(active_generation, content_hash)`,
 *   `… WHERE active_generation < ?`); it is **not** the generation identity.
 * - **`active_generation_id`** — `TEXT` composite `generationId` (the §2 tuple
 *   hash) this note's retrieval is fenced to; the LanceDB join / retrieval-filter
 *   key. NULL until first indexed.
 *
 * ## The generation/config fence (Task issue #39, carry-forward #1)
 *
 * A `content_hash`-only CAS is **insufficient**: two workers running DIFFERENT
 * indexing configs (a bumped `chunker_version` / `embedding_model` / `dimensions`)
 * over the SAME note content compute DIFFERENT `generationId`s yet share the same
 * `content_hash`. A pure per-note activation counter (`stored + 1`) cannot fence
 * them either — it tracks *activation* order, not config *recency*, so whichever
 * worker commits last wins regardless of which config is newer. So activation also
 * fences on a **config revision** (`configRevision`): a monotonic epoch identifying
 * the indexing-config the worker ran under, stamped into `active_generation`. The
 * CAS updates the note **iff**:
 *
 *   (a) `content_hash-unchanged` — the note's live `content_hash` equals the hash
 *       the worker embedded against (a note edited mid-flight loses here); AND
 *   (b) `config-revision-not-superseded` — the worker's `configRevision` is `>=`
 *       the stored `active_generation`, so a strictly-older config that finishes
 *       after a newer activation is rejected.
 *
 * This makes a stale-config worker's activation FAIL after a newer activation in
 * **both** completion orders:
 *   - new-then-old: new sets `active_generation = revNew`; old (`revOld < revNew`)
 *     fails guard (b) → no write.
 *   - old-then-new: old sets `active_generation = revOld`; new (`revNew >= revOld`)
 *     passes → supersedes; a subsequent stale old worker again fails guard (b).
 * Either way the newer config wins and the stale one never overwrites it.
 *
 * ## Server-owned config identity, not a trusted integer (round-3 findings 3 & 4)
 *
 * The fence epoch must be a **server-issued, durably-owned, monotonic** number —
 * NOT an integer a caller invents (an inflated value would fence out every future
 * worker; an under-shot value would permanently reject a legitimate config). So
 * activation consumes a **config identity** (`configKey`, a deterministic hash of
 * the fence-relevant config), NEVER a raw revision: the caller supplies the config,
 * and SQLite — the sole activation authority — looks up and issues the number.
 * {@link GenerationRepo.activateGeneration}/{@link GenerationRepo.tombstoneGeneration}
 * resolve the config's live epoch internally, so a caller can neither inflate the
 * revision nor bind it to the wrong config.
 *
 * The epoch is owned by an append-only **adoption log** (`index_config_revisions`,
 * migration `0008_index_config_revision`) that models durable adoption EVENTS and
 * the current configuration explicitly — NOT a permanent first-seen mapping (which
 * cannot roll back and confuses first-seen with recency; round-3 finding 4):
 *   - {@link GenerationRepo.adoptConfig} records an adoption event. Re-adopting the
 *     already-current config is idempotent (no new event); adopting a DIFFERENT
 *     config (an upgrade OR a rollback/re-adoption) appends a NEW event with a
 *     strictly-higher `MAX(revision) + 1` epoch and marks it current.
 *   - a config's LIVE epoch is `MAX(revision) WHERE config_key = ?` — its
 *     most-recent adoption — so a rolled-back-to config CAN supersede whatever is
 *     live (its fresh event out-ranks the newer config's older event), and adoption
 *     RECENCY (operator order), not first-seen order, drives the fence.
 * The orchestrator calls `adoptConfig` ONCE at config-adoption; every
 * `activateGeneration`/`tombstoneGeneration` in that pass then resolves the same
 * live epoch by config identity.
 *
 * There is no store service (D13): the unprivileged CLI opens `better-sqlite3`
 * directly and this repo runs its CAS + adoption log in-process.
 */
import type { SqliteDatabase } from "../connection.js";

/** A wall-clock supplier for `created_at` timestamps (mirrors `store.ts`'s `Clock`;
 * declared locally so this repo need not import from `store.ts` — that would be a
 * cycle). */
export type GenerationClock = () => string;

/** The `notes` fence columns a caller reads to plan/verify indexing (Task 3.2/3.5). */
export interface NoteFenceRow {
  readonly note_id: string;
  readonly content_hash: string;
  /** The config revision the active generation was produced under (0 = never indexed). */
  readonly active_generation: number;
  /** The composite `generationId` retrieval is fenced to, or NULL until first indexed. */
  readonly active_generation_id: string | null;
}

export class GenerationRepo {
  constructor(
    private readonly db: SqliteDatabase,
    /** Wall-clock for `index_config_revisions.created_at`; defaults to RFC3339 now. */
    private readonly clock: GenerationClock = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  ) {}

  /**
   * Record a durable **adoption event** for an indexing-config identity and return
   * its monotonic epoch (round-3 finding 4 — "model durable adoption events /
   * current configuration explicitly"). This is the ONLY way a config epoch is
   * allocated; the number is owned by SQLite, never the caller.
   *
   *   - if `configKey` is already the current configuration → idempotent: returns
   *     its existing epoch, records NO new event (so re-running a pass under the
   *     same config can neither supersede itself nor reject itself);
   *   - otherwise (an upgrade to a new config, OR a rollback / re-adoption of a
   *     previously-used one) → appends a NEW event with `MAX(revision) + 1`, marks
   *     it the current configuration (clearing the prior `is_current`), and returns
   *     the new, strictly-higher epoch. A rolled-back-to config therefore gets a
   *     fresh epoch that OUT-RANKS whatever is currently live, so it can supersede
   *     it — which a permanent first-seen mapping could never do.
   *
   * Adoption order (operator action) — NOT first-seen order — drives the fence: the
   * caller adopts OLD before NEW when upgrading, so OLD's epoch is strictly lower.
   *
   * Runs in one transaction (better-sqlite3 transactions are synchronous + atomic,
   * and SQLite serializes writers across connections), so two adoptions can never
   * receive the same epoch and there is never more than one current row.
   *
   * @param configKey a deterministic identity of the fence-relevant indexing config
   *   (`chunker_version` / `embedding_model` / `dimensions`) — see
   *   `@atlas/lancedb-index`'s `indexingConfigKey`.
   * @returns the config's current monotonic epoch (`>= 1`).
   */
  adoptConfig(configKey: string): number {
    const current = this.db.prepare(
      `SELECT revision, config_key FROM index_config_revisions WHERE is_current = 1`,
    );
    const clearCurrent = this.db.prepare(
      `UPDATE index_config_revisions SET is_current = 0 WHERE is_current = 1`,
    );
    const nextRev = this.db.prepare(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS r FROM index_config_revisions`,
    );
    const insert = this.db.prepare(
      `INSERT INTO index_config_revisions (revision, config_key, is_current, adopted_at) VALUES (?, ?, 1, ?)`,
    );
    const adopt = this.db.transaction((key: string, now: string): number => {
      const cur = current.get() as { revision: number; config_key: string } | undefined;
      if (cur && cur.config_key === key) return cur.revision; // already current → idempotent
      const revision = (nextRev.get() as { r: number }).r;
      clearCurrent.run();
      insert.run(revision, key, now);
      return revision;
    });
    return adopt(configKey, this.clock());
  }

  /**
   * Resolve a config's LIVE epoch — the revision of its MOST-RECENT adoption event
   * (`MAX(revision) WHERE config_key = ?`), or `0` if the config was never adopted.
   * Read-only: it never allocates (so it can never conflate first-seen with
   * recency). This is the number the CAS fences on; a config that was rolled back
   * to has a fresh (higher) epoch here.
   */
  configRevisionFor(configKey: string): number {
    const row = this.db
      .prepare(`SELECT MAX(revision) AS r FROM index_config_revisions WHERE config_key = ?`)
      .get(configKey) as { r: number | null } | undefined;
    return row?.r ?? 0;
  }

  /**
   * The activation compare-and-set (retrieval-index-contract §2). Atomically sets
   * `active_generation_id = gen` and `active_generation = <config epoch>` for
   * `noteId` **iff** both fences hold:
   *
   *   (a) the note's live `content_hash` equals `expectedContentHash`, and
   *   (b) the config's live epoch `>= active_generation` (the stored epoch).
   *
   * Activation consumes a **config identity** (`configKey`), NOT a raw integer
   * (round-3 finding 3): the epoch is resolved HERE from the adoption log
   * ({@link configRevisionFor}), so a caller can neither inflate the revision nor
   * bind it to the wrong config. A config that was never adopted has epoch `0` and
   * is rejected — activation requires a prior {@link adoptConfig} (the caller must
   * declare the current configuration before workers race under it).
   *
   * Returns `true` iff the row was updated (the generation is now live), `false`
   * if either fence failed or the note does not exist. Both columns move in the
   * SAME statement (one implicit transaction), so retrieval can never observe an
   * `active_generation_id` that disagrees with its `active_generation`.
   *
   * @param noteId              the note whose fence to advance
   * @param gen                 the composite `generationId` to activate (LanceDB join key)
   * @param expectedContentHash the `content_hash` the worker embedded against
   * @param configKey           the indexing-config identity (see class docs / {@link adoptConfig})
   */
  activateGeneration(
    noteId: string,
    gen: string,
    expectedContentHash: string,
    configKey: string,
  ): boolean {
    const rev = this.requireConfigEpoch(configKey, "activateGeneration");
    const info = this.db
      .prepare(
        `UPDATE notes
            SET active_generation_id = @gen,
                active_generation    = @rev
          WHERE note_id      = @noteId
            AND content_hash  = @expectedContentHash   -- (a) content_hash-unchanged
            AND @rev         >= active_generation`,     // (b) config-revision-not-superseded
      )
      .run({ noteId, gen, expectedContentHash, rev });
    return info.changes === 1;
  }

  /**
   * Fenced **tombstone** transition (round-3 finding 2): CLEAR a note's active
   * generation — `active_generation_id = NULL`, `active_generation = <config epoch>`
   * — under the SAME two fences as {@link activateGeneration}. This is how a note
   * that lost all its prose (became empty) stops being served: retrieval's
   * active-generation join now finds NULL and returns nothing, and the note's chunks
   * become orphans the write path retires + compaction reclaims. Fenced exactly like
   * activation, so a stale-config worker cannot tombstone a newer generation, and a
   * mid-flight content change loses. Returns `true` iff the row was cleared.
   *
   * @param noteId              the note to tombstone
   * @param expectedContentHash the note's current (now-empty) `content_hash`
   * @param configKey           the indexing-config identity (see {@link adoptConfig})
   */
  tombstoneGeneration(noteId: string, expectedContentHash: string, configKey: string): boolean {
    const rev = this.requireConfigEpoch(configKey, "tombstoneGeneration");
    const info = this.db
      .prepare(
        `UPDATE notes
            SET active_generation_id = NULL,
                active_generation    = @rev
          WHERE note_id      = @noteId
            AND content_hash  = @expectedContentHash   -- (a) content_hash-unchanged
            AND @rev         >= active_generation`,     // (b) config-revision-not-superseded
      )
      .run({ noteId, expectedContentHash, rev });
    return info.changes === 1;
  }

  /** Resolve a config's live epoch for a CAS, rejecting an un-adopted config
   * (epoch `0`): activation/tombstone require the current configuration to have been
   * declared via {@link adoptConfig} first, so the store — never the caller — owns
   * the fence number. */
  private requireConfigEpoch(configKey: string, op: string): number {
    const rev = this.configRevisionFor(configKey);
    if (rev < 1) {
      throw new RangeError(
        `${op}: config "${configKey}" has no adopted epoch — call adoptConfig(configKey) ` +
          `before activating a generation under it (SQLite owns the fence revision)`,
      );
    }
    return rev;
  }

  /** Read a note's fence columns, or `undefined` if the note is not projected. */
  fence(noteId: string): NoteFenceRow | undefined {
    return this.db
      .prepare(
        `SELECT note_id, content_hash, active_generation, active_generation_id
           FROM notes WHERE note_id = ?`,
      )
      .get(noteId) as NoteFenceRow | undefined;
  }

  /** The composite `generationId` a note's retrieval is fenced to, or `null`. */
  activeGenerationId(noteId: string): string | null {
    const row = this.db
      .prepare(`SELECT active_generation_id FROM notes WHERE note_id = ?`)
      .get(noteId) as { active_generation_id: string | null } | undefined;
    return row?.active_generation_id ?? null;
  }

  /**
   * Notes that need (re)indexing under `currentConfigRevision` — those produced
   * under a strictly-older config epoch, plus never-indexed notes
   * (`active_generation_id IS NULL`). Uses `idx_notes_needs_index` (dictionary §6:
   * `… WHERE active_generation < ?` — an index SEARCH, never a full scan). The
   * NULL check catches a note whose counter was left at a prior revision but whose
   * id was cleared (defensive; the two normally move together).
   */
  needsIndex(currentConfigRevision: number): NoteFenceRow[] {
    return this.db
      .prepare(
        `SELECT note_id, content_hash, active_generation, active_generation_id
           FROM notes
          WHERE active_generation < @rev
             OR active_generation_id IS NULL
          ORDER BY note_id`,
      )
      .all({ rev: currentConfigRevision }) as NoteFenceRow[];
  }

  /** The set of composite `generationId`s currently active across all notes — the
   * retrieval-live set. A LanceDB chunk whose `generationId` is NOT in this set is
   * orphaned (superseded, or belongs to a removed note) and is compacted (Task 3.2
   * `reconcileIndex`); until compaction it is filtered from retrieval by the
   * `active_generation_id` join. */
  activeGenerationIds(): string[] {
    return (
      this.db
        .prepare(
          `SELECT active_generation_id FROM notes WHERE active_generation_id IS NOT NULL`,
        )
        .all() as { active_generation_id: string }[]
    ).map((r) => r.active_generation_id);
  }
}
