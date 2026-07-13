/**
 * `connection` — the `better-sqlite3` handle factory for `@atlas/sqlite-store`.
 *
 * Every connection is opened per the data-dictionary binding conventions
 * (dictionary §0): **WAL** journalling and **`PRAGMA foreign_keys = ON`** so the
 * composite FKs (`MATCH SIMPLE`) and `ON DELETE` retention matrix are enforced.
 * `STRICT` tables need no pragma — it is declared per table in the DDL.
 */
import Database from "better-sqlite3";

/** The `better-sqlite3` database handle type (re-exported for consumers). */
export type SqliteDatabase = Database.Database;

/** Connection configuration consumed by {@link openConnection}. */
export interface SqliteConfig {
  /** Filesystem path to the SQLite database, or `:memory:` for an ephemeral db. */
  readonly path: string;
  /**
   * Open read-only (no migrations/writes). WAL is still requested but a
   * read-only handle cannot change the journal mode of a fresh file.
   */
  readonly readonly?: boolean;
  /** Busy-timeout in ms for lock contention (default 5000). */
  readonly busyTimeoutMs?: number;
}

/**
 * Open a configured `better-sqlite3` connection. Applies the two mandatory
 * pragmas (WAL, FKs on) plus a busy timeout. The caller owns the handle
 * lifecycle (`db.close()`); {@link openStore} wraps this.
 */
export function openConnection(cfg: SqliteConfig): Database.Database {
  const db = new Database(cfg.path, { readonly: cfg.readonly ?? false });
  // WAL: concurrent readers during a writer; the Online-Backup API (Task 1.7)
  // depends on it. An in-memory db reports "memory" — harmless.
  if (!cfg.readonly) db.pragma("journal_mode = WAL");
  // FKs ON for every connection (dictionary §0) — enforced, not advisory.
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${cfg.busyTimeoutMs ?? 5000}`);
  return db;
}
