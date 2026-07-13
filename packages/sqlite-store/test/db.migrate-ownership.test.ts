/**
 * `db.migrate-ownership` — every §2.7 table is created by *exactly* its declared
 * migration. Applying only `0001_core` against a fresh DB must produce exactly
 * the dictionary's `0001_core` table set plus the runner-bootstrap
 * `db_schema_migrations` — no missing, extra, or duplicate table.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { dictionaryTablesFor, userTables } from "./helpers.js";

describe("db.migrate-ownership", () => {
  it("0001_core creates exactly its declared §2.7 tables (fresh-DB diff vs dictionary)", () => {
    const store = openStore({ path: ":memory:" });
    try {
      const report = store.migrate();
      expect(report.newlyApplied).toEqual(["0001_core"]);

      const expected = dictionaryTablesFor("0001_core");
      expected.add("db_schema_migrations"); // runner bootstrap
      // Sanity: the dictionary really did attribute the core tables to 0001_core.
      expect(expected.has("notes")).toBe(true);
      expect(expected.has("audit_events")).toBe(true);
      // And it must NOT include tables owned by later migrations.
      expect(expected.has("jobs")).toBe(false);
      expect(expected.has("claims")).toBe(false);

      const actual = userTables(store.db);
      expect([...actual].sort()).toEqual([...expected].sort());
    } finally {
      store.close();
    }
  });

  it("db migrate is idempotent (re-applying is a checksum-guarded no-op)", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.migrate();
      const again = store.migrate();
      expect(again.newlyApplied).toEqual([]);
      expect(again.applied.every((a) => a.action === "skipped")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("the §6 indexes owned by 0001_core exist", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.migrate();
      const idx = new Set(
        (
          store.db
            .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`)
            .all() as { name: string }[]
        ).map((r) => r.name),
      );
      for (const name of [
        "idx_note_identity_keys_note",
        "idx_note_links_reverse",
        "idx_agent_runs_status",
        "idx_model_calls_run",
        "idx_audit_events_run",
        "idx_notes_needs_index",
      ]) {
        expect(idx.has(name), `missing index ${name}`).toBe(true);
      }
    } finally {
      store.close();
    }
  });
});
