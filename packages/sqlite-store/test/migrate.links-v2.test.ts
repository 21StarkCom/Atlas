/**
 * `migrate.links-v2` — the `0013_links_v2` table-rebuild migration.
 *
 * Seeds a v1 `note_links` (`0001_core`: 3-col PK, `NOT NULL predicate`, an
 * `ordinal` column, no `alias`) with rows, applies `0013_links_v2`, and asserts:
 *  - the v2 column set (`predicate`/`alias` nullable, no `ordinal`, no 3-col PK);
 *  - both partial unique indexes + the reverse/forward traversal indexes exist;
 *  - every v1 row survives as a predicate-edge with `alias` NULL;
 *  - the two partial unique indexes reject the duplicates they own.
 *
 * The migration is applied in isolation (raw `runMigrations` over `[0001]` then
 * `[0013]`) so a genuine v1 table exists to migrate — `openStore` now carries
 * `0013` in its default set, so a plain `store.migrate()` would never expose the
 * intermediate v1 shape.
 */
import { describe, expect, it } from "vitest";
import {
  migration0001Core,
  migration0013LinksV2,
  openConnection,
  runMigrations,
  type SqliteDatabase,
} from "../src/index.js";

const NOW = () => "2026-07-22T00:00:00Z";

/** Seed the three notes the FK-checked link rows point at. */
function seedNotes(db: SqliteDatabase, ids: string[]): void {
  const insert = db.prepare(
    `INSERT INTO notes
       (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
     VALUES (?, ?, ?, 'concept', 1, 'active', ?, ?, ?, ?)`,
  );
  for (const id of ids) {
    insert.run(id, id, id, `${id}.md`, `sha256:${"a".repeat(64)}`, NOW(), NOW());
  }
}

/** A DB at the v1 (`0001_core`) frontier, with `notes` seeded. */
function v1Db(): SqliteDatabase {
  const db = openConnection({ path: ":memory:" });
  runMigrations(db, [migration0001Core], NOW);
  seedNotes(db, ["n1", "n2", "n3"]);
  return db;
}

interface ColumnInfo {
  readonly name: string;
  readonly notnull: number;
  readonly pk: number;
}

function columns(db: SqliteDatabase): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(note_links)`).all() as ColumnInfo[];
}

function indexNames(db: SqliteDatabase): Set<string> {
  return new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='note_links'`)
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
}

describe("migrate.links-v2 (0013)", () => {
  it("yields the v2 note_links shape: predicate/alias nullable, no ordinal, no 3-col PK", () => {
    const db = v1Db();
    try {
      runMigrations(db, [migration0013LinksV2], NOW);
      const cols = columns(db);
      const byName = new Map(cols.map((c) => [c.name, c]));

      expect([...byName.keys()].sort()).toEqual(
        ["alias", "predicate", "source_note_id", "target_note_id"].sort(),
      );
      // No authoring-order column survives.
      expect(byName.has("ordinal")).toBe(false);
      // predicate + alias are nullable; the two note ids stay NOT NULL.
      expect(byName.get("predicate")!.notnull).toBe(0);
      expect(byName.get("alias")!.notnull).toBe(0);
      expect(byName.get("source_note_id")!.notnull).toBe(1);
      expect(byName.get("target_note_id")!.notnull).toBe(1);
      // No column participates in a primary key (the 3-col PK is gone).
      expect(cols.every((c) => c.pk === 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("creates both partial unique indexes + the reverse/forward traversal indexes", () => {
    const db = v1Db();
    try {
      runMigrations(db, [migration0013LinksV2], NOW);
      const idx = indexNames(db);
      for (const name of [
        "ux_note_links_plain",
        "ux_note_links_pred",
        "idx_note_links_reverse",
        "idx_note_links_forward",
      ]) {
        expect(idx.has(name), `missing index ${name}`).toBe(true);
      }
      // ux_note_links_plain / ux_note_links_pred are PARTIAL (carry a WHERE clause).
      const plainSql = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_note_links_plain'`)
          .get() as { sql: string }
      ).sql;
      expect(plainSql).toMatch(/WHERE\s+predicate\s+IS\s+NULL/i);
      const predSql = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_note_links_pred'`)
          .get() as { sql: string }
      ).sql;
      expect(predSql).toMatch(/WHERE\s+predicate\s+IS\s+NOT\s+NULL/i);
    } finally {
      db.close();
    }
  });

  it("preserves every v1 row as a predicate-edge with alias NULL", () => {
    const db = v1Db();
    try {
      // Every v1 row carried a non-null predicate (v1 predicate was NOT NULL).
      const insertV1 = db.prepare(
        `INSERT INTO note_links (source_note_id, target_note_id, predicate, ordinal) VALUES (?, ?, ?, ?)`,
      );
      insertV1.run("n1", "n2", "references", 0);
      insertV1.run("n1", "n3", "depends-on", 1);
      insertV1.run("n2", "n3", "references", 0);

      runMigrations(db, [migration0013LinksV2], NOW);

      const rows = db
        .prepare(
          `SELECT source_note_id, target_note_id, predicate, alias FROM note_links
           ORDER BY source_note_id, target_note_id`,
        )
        .all() as { source_note_id: string; target_note_id: string; predicate: string | null; alias: string | null }[];
      expect(rows).toEqual([
        { source_note_id: "n1", target_note_id: "n2", predicate: "references", alias: null },
        { source_note_id: "n1", target_note_id: "n3", predicate: "depends-on", alias: null },
        { source_note_id: "n2", target_note_id: "n3", predicate: "references", alias: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("rejects a duplicate plain link (ux_note_links_plain) and a duplicate predicate-edge (ux_note_links_pred)", () => {
    const db = v1Db();
    try {
      runMigrations(db, [migration0013LinksV2], NOW);
      const insert = db.prepare(
        `INSERT INTO note_links (source_note_id, target_note_id, predicate, alias) VALUES (?, ?, ?, ?)`,
      );

      // A plain link (predicate NULL): the second insert for the same (source,
      // target) violates ux_note_links_plain even though the alias differs.
      insert.run("n1", "n2", null, "Alpha");
      expect(() => insert.run("n1", "n2", null, "Alpha again")).toThrow(/UNIQUE|constraint/i);

      // A predicate-edge: a duplicate (source, target, predicate) violates
      // ux_note_links_pred.
      insert.run("n1", "n3", "references", null);
      expect(() => insert.run("n1", "n3", "references", null)).toThrow(/UNIQUE|constraint/i);

      // But a DIFFERENT predicate for the same pair is allowed, and a plain link
      // coexists with a predicate-edge between the same pair (disjoint indexes).
      expect(() => insert.run("n1", "n3", "depends-on", null)).not.toThrow();
      expect(() => insert.run("n2", "n3", null, null)).not.toThrow();
      expect(() => insert.run("n2", "n3", "references", null)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
