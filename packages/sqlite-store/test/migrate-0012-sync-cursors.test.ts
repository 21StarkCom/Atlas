/**
 * `0012_sync_cursors` — the per-source vault-sync cursor migration (60-A task 1.3).
 *
 * Proves the STRICT table with the pinned column contract: `source_id` PK,
 * `upstream_ref` NOT NULL, `last_absorbed_oid` nullable, `last_synced_at` NOT NULL,
 * `cycle_seq` default 0, `pending_quarantine` default `'[]'`. Registered through the
 * checksum-guarded runner as a FEATURE migration (not in `openStore`'s default set).
 */
import { describe, expect, it } from "vitest";
import { openStore, registerSyncCursorsMigration } from "../src/index.js";

function migrated() {
  const store = openStore({ path: ":memory:" });
  registerSyncCursorsMigration(store);
  store.migrate();
  return store;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe("0012_sync_cursors", () => {
  it("creates a STRICT table with the pinned column contract", () => {
    const store = migrated();
    try {
      // STRICT table (recorded in the schema DDL).
      const ddl = (
        store.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_cursors'`).get() as
          | { sql: string }
          | undefined
      )?.sql;
      expect(ddl).toBeDefined();
      expect(ddl!.toUpperCase()).toContain("STRICT");

      const cols = store.db.prepare(`PRAGMA table_info(sync_cursors)`).all() as ColumnInfo[];
      const byName = new Map(cols.map((c) => [c.name, c]));

      expect(byName.get("source_id")).toMatchObject({ type: "TEXT", notnull: 1, pk: 1 });
      expect(byName.get("upstream_ref")).toMatchObject({ type: "TEXT", notnull: 1, pk: 0 });
      // last_absorbed_oid is nullable (zero-state before the first sync cycle).
      expect(byName.get("last_absorbed_oid")).toMatchObject({ type: "TEXT", notnull: 0 });
      expect(byName.get("last_synced_at")).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.get("cycle_seq")).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "0" });
      expect(byName.get("pending_quarantine")).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'[]'" });
    } finally {
      store.close();
    }
  });

  it("applies the column defaults on a minimal insert", () => {
    const store = migrated();
    try {
      store.db
        .prepare(`INSERT INTO sync_cursors (source_id, upstream_ref, last_synced_at) VALUES (?, ?, ?)`)
        .run("main-vault", "refs/atlas/main", "2026-07-19T00:00:00Z");
      const row = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id = 'main-vault'`).get() as {
        last_absorbed_oid: string | null;
        cycle_seq: number;
        pending_quarantine: string;
      };
      expect(row.last_absorbed_oid).toBeNull();
      expect(row.cycle_seq).toBe(0);
      expect(row.pending_quarantine).toBe("[]");
    } finally {
      store.close();
    }
  });

  it("enforces NOT NULL on upstream_ref and last_synced_at", () => {
    const store = migrated();
    try {
      expect(() =>
        store.db
          .prepare(`INSERT INTO sync_cursors (source_id, last_synced_at) VALUES (?, ?)`)
          .run("no-ref", "2026-07-19T00:00:00Z"),
      ).toThrow();
      expect(() =>
        store.db
          .prepare(`INSERT INTO sync_cursors (source_id, upstream_ref) VALUES (?, ?)`)
          .run("no-time", "refs/atlas/main"),
      ).toThrow();
    } finally {
      store.close();
    }
  });
});
