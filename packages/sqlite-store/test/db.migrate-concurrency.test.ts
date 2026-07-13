/**
 * `db.migrate-concurrency` — the migration bootstrap + applied-id snapshot + DDL
 * application are serialized under one `BEGIN IMMEDIATE` transaction. Two
 * migrators on separate connections must NOT both observe a migration as absent
 * and both attempt its DDL: the second acquirer of the write lock either waits
 * or fails, and once it runs it reads a FRESH applied-id snapshot (seeing the
 * first migrator's work) so it never re-runs the same `CREATE TABLE`.
 *
 * better-sqlite3 is synchronous/single-threaded, so true simultaneous execution
 * cannot be staged in one event loop. We instead hold the write lock on one
 * connection and prove a migrator on a second connection is excluded (never
 * reading stale state mid-transaction), then that it applies cleanly — exactly
 * once — after the lock is released.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrationChecksum,
  openConnection,
  runMigrations,
  type Migration,
  type SqliteDatabase,
} from "../src/index.js";

const NOW = () => "2026-07-13T00:00:00Z";

function ddlMigration(id: string, table: string): Migration {
  const sql = `CREATE TABLE ${table} (k TEXT NOT NULL PRIMARY KEY) STRICT;`;
  return { id, checksum: migrationChecksum(sql), up: (db) => db.exec(sql) };
}

function tempDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atlas-migrate-conc-"));
  return { path: join(dir, "core.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function appliedIds(db: SqliteDatabase): Set<string> {
  const rows = db.prepare(`SELECT id FROM db_schema_migrations`).all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

describe("db.migrate-concurrency", () => {
  it("excludes a second migrator while the write lock is held, then applies exactly once", () => {
    const { path, cleanup } = tempDbPath();
    // Short busy timeout so the excluded migrator fails fast instead of hanging.
    const a = openConnection({ path, busyTimeoutMs: 100 });
    const b = openConnection({ path, busyTimeoutMs: 100 });
    const migrations = [ddlMigration("0001_conc", "conc_one")];
    try {
      // Connection A simulates a migrator that has taken the write lock and is
      // mid-transaction (BEGIN IMMEDIATE + a write). Its work is not yet committed.
      a.exec("BEGIN IMMEDIATE");
      a.exec("CREATE TABLE lock_probe (k TEXT NOT NULL PRIMARY KEY) STRICT");

      // Connection B tries to migrate. Because runMigrations opens BEGIN IMMEDIATE,
      // it must acquire the write lock BEFORE reading the applied-id snapshot — so
      // it cannot proceed on stale state. With A holding the lock it errors busy.
      expect(() => runMigrations(b, migrations, NOW)).toThrow(/SQLITE_BUSY|database is locked/i);

      // A commits and releases the lock.
      a.exec("COMMIT");

      // Now B migrates cleanly, reading a fresh snapshot.
      const rep = runMigrations(b, migrations, NOW);
      expect(rep.newlyApplied).toEqual(["0001_conc"]);
      expect(appliedIds(b)).toEqual(new Set(["0001_conc"]));
    } finally {
      a.close();
      b.close();
      cleanup();
    }
  });

  it("a second connection migrating the same set after the first sees it applied (no double-apply)", () => {
    const { path, cleanup } = tempDbPath();
    const a = openConnection({ path, busyTimeoutMs: 2000 });
    const b = openConnection({ path, busyTimeoutMs: 2000 });
    const migrations = [ddlMigration("0001_conc", "conc_one"), ddlMigration("0002_conc", "conc_two")];
    try {
      const first = runMigrations(a, migrations, NOW);
      expect(first.newlyApplied).toEqual(["0001_conc", "0002_conc"]);

      // A different connection runs the identical set: the serialized fresh read
      // sees both ids present, so every migration is skipped — the DDL is NOT
      // re-run (which would throw "table already exists").
      const second = runMigrations(b, migrations, NOW);
      expect(second.newlyApplied).toEqual([]);
      expect(second.applied.every((m) => m.action === "skipped")).toBe(true);
      expect(appliedIds(b)).toEqual(new Set(["0001_conc", "0002_conc"]));

      // Exactly one ledger row per id — no duplicate application.
      const rows = a.prepare(`SELECT id, COUNT(*) AS c FROM db_schema_migrations GROUP BY id`).all() as {
        id: string;
        c: number;
      }[];
      expect(rows.every((r) => r.c === 1)).toBe(true);
    } finally {
      a.close();
      b.close();
      cleanup();
    }
  });
});
