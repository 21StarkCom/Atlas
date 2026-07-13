/**
 * `migrate` — the checksum-guarded, **gap-tolerant** migration runner and the
 * `db_schema_migrations` bootstrap (dictionary §1).
 *
 * Design points fixed by the spec + plan Task 1.4:
 *  - **Bootstrap:** the runner itself creates `db_schema_migrations` (not a
 *    numbered migration) before applying anything.
 *  - **Gap-tolerant:** it applies the set of *registered-but-unapplied*
 *    migrations ordered by id, and **never** assumes a contiguous max-applied
 *    id. `0003_provenance` (retained PR-A) can land before `0002_jobs` (PR-B),
 *    so a DB may already have `0003` applied when `0002` is first registered —
 *    the runner must still apply `0002` then.
 *  - **Checksum guard:** an already-applied migration is a no-op, but its stored
 *    checksum is re-verified and a *changed body is a hard failure*, never a
 *    silent overwrite.
 *  - **Never drops tables on downgrade.** There is no `down`; the runner only
 *    ever moves forward.
 */
import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./connection.js";

/**
 * A registered DDL migration. `id` is the lexicographically-orderable key
 * (e.g. `'0001_core'`); `checksum` is the sha256 of the migration SQL text
 * (see {@link migrationChecksum}); `up` performs the DDL. Exactly one migration
 * creates each §2.7 table.
 */
export interface Migration {
  readonly id: string;
  readonly checksum: string;
  up(db: SqliteDatabase): void;
}

/** Per-migration outcome recorded in {@link MigrationReport}. */
export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
  /** `applied` = ran now; `skipped` = already present (checksum re-verified). */
  readonly action: "applied" | "skipped";
}

/** The result of a {@link runMigrations} call. */
export interface MigrationReport {
  readonly applied: readonly AppliedMigration[];
  /** ids applied during *this* run (subset of `applied` with action `applied`). */
  readonly newlyApplied: readonly string[];
}

/** sha256 of a migration's SQL text — the stored + verified checksum. */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Bootstrap DDL for the runner's own ledger of applied migrations (§1, verbatim). */
const BOOTSTRAP_SQL = `CREATE TABLE db_schema_migrations (
  id          TEXT    NOT NULL PRIMARY KEY,   -- migration id, e.g. '0001_core'
  checksum    TEXT    NOT NULL,               -- sha256 of the migration SQL text
  applied_at  TEXT    NOT NULL                -- RFC-3339 UTC
) STRICT;`;

/** Ensure `db_schema_migrations` exists (idempotent). */
export function bootstrapMigrationsTable(db: SqliteDatabase): void {
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_schema_migrations'`)
    .get();
  if (!exists) db.exec(BOOTSTRAP_SQL);
}

interface MigrationRow {
  readonly id: string;
  readonly checksum: string;
}

/**
 * Apply every registered-but-unapplied migration, ordered by id. Gap-tolerant:
 * the applied set is computed row-by-row (which ids are absent from
 * `db_schema_migrations`), never as "everything after the max applied id".
 *
 * **Serialized (fixes the concurrent-migrator race).** The ENTIRE sequence —
 * bootstrap, the applied-id snapshot read, and the application of every
 * migration — runs inside ONE `BEGIN IMMEDIATE` transaction. IMMEDIATE takes the
 * database write lock up front, so a second concurrent migrator (another
 * connection/process) blocks on `busy_timeout` until this one commits, then
 * re-reads a fresh applied-id snapshot and correctly sees the migrations as
 * present (a no-op) instead of racing to re-run the same DDL. Without this, two
 * migrators could both observe a migration as absent and both attempt its
 * `CREATE TABLE`, and the loser fails with "table already exists".
 *
 * All-or-nothing per run: a failure rolls the whole transaction back, leaving
 * the DB at its last committed state; a re-run reapplies the unapplied set. The
 * runner never drops tables and never runs a `down` — it only moves forward.
 *
 * **Duplicate-id guard (fixes duplicate-registration).** The `migrations` list
 * is validated for unique ids BEFORE anything executes: two entries sharing an
 * id would run both `up` bodies while only one ledger row is retained (and both
 * would be reported as applied). A duplicate id is a {@link DuplicateMigrationError}.
 */
export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  now: () => string,
): MigrationReport {
  // Reject duplicate ids up front — never execute a single up() body twice.
  const seenIds = new Set<string>();
  for (const m of migrations) {
    if (seenIds.has(m.id)) throw new DuplicateMigrationError(m.id);
    seenIds.add(m.id);
  }

  // Deterministic id order so a gap (0003 present, 0002 absent) still applies
  // 0002 in-order relative to the remaining unapplied set.
  const ordered = [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const report: AppliedMigration[] = [];
  const newlyApplied: string[] = [];

  // Serialize bootstrap + snapshot + application under a single write-locked txn.
  const runAll = db.transaction((appliedAt: string) => {
    bootstrapMigrationsTable(db);

    const appliedRows = new Map<string, string>();
    for (const row of db
      .prepare(`SELECT id, checksum FROM db_schema_migrations`)
      .all() as MigrationRow[]) {
      appliedRows.set(row.id, row.checksum);
    }

    const insert = db.prepare(
      `INSERT INTO db_schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)`,
    );

    for (const m of ordered) {
      const storedChecksum = appliedRows.get(m.id);
      if (storedChecksum !== undefined) {
        // Already applied — checksum-guarded no-op; a changed body is a hard fail.
        if (storedChecksum !== m.checksum) {
          throw new MigrationChecksumError(m.id, storedChecksum, m.checksum);
        }
        report.push({ id: m.id, checksum: m.checksum, action: "skipped" });
        continue;
      }

      m.up(db);
      insert.run(m.id, m.checksum, appliedAt);
      report.push({ id: m.id, checksum: m.checksum, action: "applied" });
      newlyApplied.push(m.id);
    }
  });

  // `.immediate` → BEGIN IMMEDIATE: acquire the write lock before any read, so
  // concurrent migrators serialize instead of both observing an absent migration.
  runAll.immediate(now());

  return { applied: report, newlyApplied };
}

/** Raised when a re-registered migration's checksum diverges from the stored one. */
export class MigrationChecksumError extends Error {
  constructor(
    readonly migrationId: string,
    readonly stored: string,
    readonly current: string,
  ) {
    super(
      `migration ${migrationId} checksum mismatch: stored ${stored} != current ${current} ` +
        `(a migration body must never change after it is applied)`,
    );
    this.name = "MigrationChecksumError";
  }
}

/** Raised when the migration list contains two entries sharing an `id`. */
export class DuplicateMigrationError extends Error {
  constructor(readonly migrationId: string) {
    super(
      `duplicate migration id ${migrationId}: each id must be registered exactly once ` +
        `(two up() bodies for one id would run twice while only one ledger row is kept)`,
    );
    this.name = "DuplicateMigrationError";
  }
}
