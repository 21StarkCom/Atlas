/**
 * `migrate.source-registry` — `0015_source_registry` creates the v2 operational
 * `source` registry with the exact six-column schema (Phase-4 task 4-3a / #339).
 *
 * EXPAND-AND-CONTRACT: task 4-3a landed the ADDITIVE half of `0015`
 * (`CREATE TABLE source` ONLY); task 4-3b (#340) appended the CONTRACT half — the DROP
 * of the v1 provenance model (`content_blobs`/`source_captures`/`source_renditions`/
 * `note_sources`, `0003`), now that `ingest` + validation are rebased off it. So THIS
 * test asserts the CONTRACTED state: after `db migrate` the v2 `source` table exists
 * with the exact schema (locator UNIQUE + kind CHECK enforced), AND the four v1
 * provenance tables are GONE — mirroring `migrate.evidence-v2`'s coexistence-then-flip.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { userTables } from "./helpers.js";

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

function columns(store: { db: { prepare(sql: string): { all(): unknown[] } } }): ColumnInfo[] {
  return store.db.prepare(`PRAGMA table_info(source)`).all() as ColumnInfo[];
}

function createSql(store: { db: { prepare(sql: string): { get(name: string): unknown } } }): string {
  const row = store.db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get("source") as { sql: string } | undefined;
  return row?.sql ?? "";
}

describe("migrate.source-registry (0015_source_registry)", () => {
  it("db migrate creates the v2 source registry with the exact six-column schema", () => {
    const store = openStore({ path: ":memory:" });
    try {
      // Store-open alone never auto-applies a migration — the source table does not
      // exist until the explicit migrate() (the CLI's `brain db migrate`).
      expect(userTables(store.db).has("source")).toBe(false);

      store.migrate();
      expect(userTables(store.db).has("source")).toBe(true);

      const cols = columns(store);
      expect(cols.map((c) => c.name)).toEqual([
        "id",
        "kind",
        "locator",
        "title",
        "addedAt",
        "lastIngestedAt",
      ]);

      const byName = new Map(cols.map((c) => [c.name, c]));
      // `id` is the NOT NULL primary key.
      expect(byName.get("id")).toMatchObject({ type: "TEXT", notnull: 1, pk: 1 });
      // `kind`, `locator`, `addedAt` are NOT NULL; `title`, `lastIngestedAt` nullable.
      for (const name of ["kind", "locator", "addedAt"]) {
        expect(byName.get(name), name).toMatchObject({ type: "TEXT", notnull: 1, pk: 0 });
      }
      for (const name of ["title", "lastIngestedAt"]) {
        expect(byName.get(name), name).toMatchObject({ type: "TEXT", notnull: 0, pk: 0 });
      }

      // STRICT typing + the kind CHECK enum are carried in the stored DDL.
      const sql = createSql(store);
      expect(sql).toMatch(/\)\s*STRICT/i);
      expect(sql).toContain("kind IN ('file', 'url')");
      expect(sql).toMatch(/locator\s+TEXT\s+NOT NULL\s+UNIQUE/i);
    } finally {
      store.close();
    }
  });

  it("the locator UNIQUE constraint rejects a duplicate locator", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.migrate();
      const insert = store.db.prepare(
        `INSERT INTO source (id, kind, locator, addedAt) VALUES (@id, @kind, @locator, @addedAt)`,
      );
      insert.run({ id: "src-1", kind: "file", locator: "/inbox/a.md", addedAt: "2026-07-23T00:00:00Z" });
      // A second row on the SAME locator (different id) violates the UNIQUE index.
      expect(() =>
        insert.run({ id: "src-2", kind: "file", locator: "/inbox/a.md", addedAt: "2026-07-23T00:00:00Z" }),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("the kind CHECK rejects an out-of-enum kind and accepts file/url", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.migrate();
      const insert = store.db.prepare(
        `INSERT INTO source (id, kind, locator, addedAt) VALUES (@id, @kind, @locator, @addedAt)`,
      );
      insert.run({ id: "src-file", kind: "file", locator: "/inbox/a.md", addedAt: "2026-07-23T00:00:00Z" });
      insert.run({ id: "src-url", kind: "url", locator: "https://example.com/x", addedAt: "2026-07-23T00:00:00Z" });
      expect(() =>
        insert.run({ id: "src-bad", kind: "gopher", locator: "gopher://x", addedAt: "2026-07-23T00:00:00Z" }),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("the v1 provenance tables are GONE after 0015 (the CONTRACT DROP, task 4-3b/#340)", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.migrate();
      const tables = userTables(store.db);
      expect(tables.has("source")).toBe(true);
      // CONTRACT stage (#340): `ingest` + validation are rebased onto the flat `source`
      // registry, so `0015` forward-DROPs the four v1 provenance tables — none survives
      // a fresh migrate (`source` is the only table 0015 leaves standing).
      for (const t of ["content_blobs", "source_captures", "source_renditions", "note_sources"]) {
        expect(tables.has(t), `${t} must be dropped`).toBe(false);
      }
    } finally {
      store.close();
    }
  });
});
