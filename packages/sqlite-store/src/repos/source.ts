/**
 * `repos/source` — typed access to the v2 operational `source` registry owned by
 * `0015_source_registry` (dictionary §5.7). One row per source, keyed by a stable
 * `id`, deduped on the UNIQUE `locator`.
 *
 * ## Operational, NOT vault-derived
 * Unlike the evidence/provenance projections, `source` is the **system-of-record**
 * for source rows: a plain SQLite table `db rebuild` never touches and never
 * re-derives from Markdown. `source add` writes it directly (no git commit, no
 * capture/normalize — that is `ingest`); `source list`/`show` read it. So this repo
 * is a plain SQLite accessor with **no ledger/broker/git dependency**.
 *
 * ## Dedup is a NOOP SUCCESS
 * `insert()` is idempotent on the `locator`: a duplicate locator is NOT an error —
 * it is a no-op that returns the EXISTING row's id (`inserted:false`), via
 * `INSERT … ON CONFLICT(locator) DO NOTHING` then a SELECT of the existing id. So a
 * repeated `source add <same-locator>` is intrinsically idempotent.
 */
import type { SqliteDatabase } from "../connection.js";

/** The `kind` CHECK enum (dictionary §5.7 — the single source is the DDL). */
export type SourceKind = "file" | "url";

/** A row of the v2 `source` registry (all six columns, verbatim camelCase names). */
export interface SourceRow {
  readonly id: string;
  readonly kind: SourceKind;
  /** The dedup key (UNIQUE): a file path or URL locating the source. */
  readonly locator: string;
  readonly title: string | null;
  readonly addedAt: string;
  /** RFC3339 time `ingest` last folded this source, or NULL if never ingested. */
  readonly lastIngestedAt: string | null;
}

/** Input to {@link SourceRepo.insert} — the authored fields. */
export interface SourceInput {
  readonly id: string;
  readonly kind: SourceKind;
  readonly locator: string;
  readonly title?: string | null;
  readonly addedAt: string;
}

export class SourceRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /** True if the `0015_source_registry` `source` table exists (v2 migration applied). */
  static isApplied(db: SqliteDatabase): boolean {
    return (
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source'`).get() !==
      undefined
    );
  }

  /**
   * Insert a source row, deduped on the UNIQUE `locator`. A duplicate locator is a
   * NOOP SUCCESS: it returns the EXISTING row's id with `inserted:false` (never an
   * error), so a repeated `source add <same-locator>` is intrinsically idempotent.
   * Returns `{ id, inserted }` where `id` is the row's id (the new one on insert,
   * the pre-existing one on conflict) and `inserted` is `true` iff a new row landed.
   */
  insert(input: SourceInput): { id: string; inserted: boolean } {
    const info = this.db
      .prepare(
        `INSERT INTO source (id, kind, locator, title, addedAt, lastIngestedAt)
         VALUES (@id, @kind, @locator, @title, @addedAt, NULL)
         ON CONFLICT(locator) DO NOTHING`,
      )
      .run({
        id: input.id,
        kind: input.kind,
        locator: input.locator,
        title: input.title ?? null,
        addedAt: input.addedAt,
      });
    if (info.changes > 0) return { id: input.id, inserted: true };
    // Conflict on `locator` (DO NOTHING wrote nothing): return the EXISTING id.
    const existing = this.byLocator(input.locator);
    // `existing` is always present here — the conflict fired because a row on this
    // UNIQUE locator exists — but fall back to the requested id defensively.
    return { id: existing?.id ?? input.id, inserted: false };
  }

  /** A single source row by id, or `undefined`. */
  byId(id: string): SourceRow | undefined {
    return this.db.prepare(`SELECT * FROM source WHERE id = ?`).get(id) as SourceRow | undefined;
  }

  /** A single source row by its UNIQUE locator, or `undefined`. */
  byLocator(locator: string): SourceRow | undefined {
    return this.db.prepare(`SELECT * FROM source WHERE locator = ?`).get(locator) as
      | SourceRow
      | undefined;
  }

  /**
   * One page of source rows, ordered by the contract sort key `(addedAt DESC, id
   * ASC)`. `id` is the primary key (unique), so the ORDER BY is a total order and
   * offset pagination is deterministic (best-effort under concurrency, plan §2.5).
   */
  list(req: { limit: number; offset: number }): SourceRow[] {
    return this.db
      .prepare(`SELECT * FROM source ORDER BY addedAt DESC, id ASC LIMIT ? OFFSET ?`)
      .all(req.limit, req.offset) as SourceRow[];
  }

  /** Total source-row count (the pagination `total`). */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM source`).get() as { c: number }).c;
  }

  /**
   * Stamp `lastIngestedAt` on a source row (used by `ingest`, #340). No-op when the
   * id is unknown. Returns `true` iff a row was updated.
   */
  stampIngested(id: string, at: string): boolean {
    const info = this.db.prepare(`UPDATE source SET lastIngestedAt = ? WHERE id = ?`).run(at, id);
    return info.changes > 0;
  }
}
