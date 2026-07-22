/**
 * `db.migrate-gap-tolerant` — the runner never assumes a contiguous max-applied
 * id. `0003_provenance` (retained PR-A) can land before `0002_jobs` (PR-B), so a
 * DB may already have `0003` applied when `0002` is first registered. The runner
 * must still apply `0002` then — not skip it because a higher id is present.
 */
import { describe, expect, it } from "vitest";
import {
  DuplicateMigrationError,
  MigrationChecksumError,
  migrationChecksum,
  openConnection,
  openStore,
  runMigrations,
  type Migration,
} from "../src/index.js";

function ddlMigration(id: string, table: string): Migration {
  const sql = `CREATE TABLE ${table} (k TEXT NOT NULL PRIMARY KEY) STRICT;`;
  return { id, checksum: migrationChecksum(sql), up: (db) => db.exec(sql) };
}

describe("db.migrate-gap-tolerant", () => {
  it("applies 0002 after 0003 is already applied (no skip)", () => {
    const store = openStore({ path: ":memory:" });
    try {
      // Retained PR-A is pre-registered by `openStore` (0001_core + 0003_provenance
      // + 0004_claims); applying them lands 0003/0004 while 0002 is still absent.
      const first = store.migrate();
      expect(first.newlyApplied).toEqual(["0001_core", "0003_provenance", "0004_claims", "0005_ledger_finalize", "0013_links_v2"]);

      const appliedIds = () =>
        new Set(
          (store.db.prepare(`SELECT id FROM db_schema_migrations`).all() as { id: string }[]).map(
            (r) => r.id,
          ),
        );
      expect(appliedIds()).toEqual(new Set(["0001_core", "0003_provenance", "0004_claims", "0005_ledger_finalize", "0013_links_v2"]));
      // 0002's table must not exist yet.
      expect(store.db.prepare(`SELECT 1 FROM sqlite_master WHERE name='gap_0002'`).get()).toBeUndefined();

      // PR-B lands later: register 0002 and migrate again — it MUST apply now.
      store.registerMigration(ddlMigration("0002_jobs", "gap_0002"));
      const second = store.migrate();
      expect(second.newlyApplied).toEqual(["0002_jobs"]);
      expect(appliedIds()).toEqual(
        new Set(["0001_core", "0002_jobs", "0003_provenance", "0004_claims", "0005_ledger_finalize", "0013_links_v2"]),
      );
      expect(store.db.prepare(`SELECT 1 FROM sqlite_master WHERE name='gap_0002'`).get()).toEqual({
        1: 1,
      });
    } finally {
      store.close();
    }
  });

  it("a changed migration body is a hard checksum failure, never a silent overwrite", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.registerMigration(ddlMigration("0009_x", "gap_0009"));
      store.migrate();
      // Re-register the same id with a different body → registration rejects.
      expect(() => store.registerMigration(ddlMigration("0009_x", "gap_0009_changed"))).toThrow();
    } finally {
      store.close();
    }
  });

  it("the runner rejects an applied migration whose stored checksum diverges", () => {
    const db = openConnection({ path: ":memory:" });
    try {
      runMigrations(db, [ddlMigration("0007_a", "gap_0007")], () => "2026-07-13T00:00:00Z");
      const tampered: Migration = {
        id: "0007_a",
        checksum: migrationChecksum("something else entirely"),
        up: (d) => d.exec(`CREATE TABLE gap_0007_v2 (k TEXT NOT NULL PRIMARY KEY) STRICT;`),
      };
      expect(() => runMigrations(db, [tampered], () => "2026-07-13T00:00:00Z")).toThrow(
        MigrationChecksumError,
      );
    } finally {
      db.close();
    }
  });

  it("rejects duplicate migration ids before executing any up() body", () => {
    const db = openConnection({ path: ":memory:" });
    try {
      // Two DISTINCT bodies sharing one id: a bare run would execute both up()s
      // (creating both tables) while keeping only one ledger row — and report both
      // as applied. The runner must refuse before running anything.
      const first = ddlMigration("0005_dup", "dup_first");
      const second: Migration = {
        id: "0005_dup",
        checksum: migrationChecksum(`CREATE TABLE dup_second (k TEXT NOT NULL PRIMARY KEY) STRICT;`),
        up: (d) => d.exec(`CREATE TABLE dup_second (k TEXT NOT NULL PRIMARY KEY) STRICT;`),
      };
      expect(() => runMigrations(db, [first, second], () => "2026-07-13T00:00:00Z")).toThrow(
        DuplicateMigrationError,
      );
      // Nothing ran: neither table nor any ledger row exists.
      expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='dup_first'`).get()).toBeUndefined();
      expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='dup_second'`).get()).toBeUndefined();
      expect(
        db.prepare(`SELECT 1 FROM sqlite_master WHERE name='db_schema_migrations'`).get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
