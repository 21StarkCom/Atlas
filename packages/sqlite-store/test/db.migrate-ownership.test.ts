/**
 * `db.migrate-ownership` — every §2.7 table is created by *exactly* its declared
 * migration. `openStore` pre-registers the retained-PR-A migrations `0001_core`
 * + `0003_provenance` + `0004_claims`, so applying them against a fresh DB must
 * produce exactly the dictionary's `0001_core` ∪ `0003_provenance` ∪ `0004_claims`
 * table sets plus the runner-bootstrap `db_schema_migrations` — no missing,
 * extra, or duplicate table.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { dictionaryTablesFor, userTables } from "./helpers.js";

describe("db.migrate-ownership", () => {
  it("0001_core + 0003_provenance + 0004_claims create exactly their declared §2.7 tables (fresh-DB diff vs dictionary)", () => {
    const store = openStore({ path: ":memory:" });
    try {
      const report = store.migrate();
      // `0013_links_v2` is in `openStore`'s default set (it reshapes the
      // `0001_core` `note_links` projection), so a fresh `migrate` applies it too.
      // It creates NO new table (it rebuilds `note_links` in place), so the
      // fresh-DB table diff below is unchanged from the §2.7 core set.
      expect(new Set(report.newlyApplied)).toEqual(
        new Set(["0001_core", "0003_provenance", "0004_claims", "0005_ledger_finalize", "0013_links_v2"]),
      );

      const expected = dictionaryTablesFor("0001_core");
      for (const t of dictionaryTablesFor("0003_provenance")) expected.add(t);
      for (const t of dictionaryTablesFor("0004_claims")) expected.add(t);
      expected.add("db_schema_migrations"); // runner bootstrap
      // Sanity: the dictionary really did attribute the core tables to 0001_core…
      expect(expected.has("notes")).toBe(true);
      expect(expected.has("audit_events")).toBe(true);
      // …the provenance tables to 0003_provenance…
      expect(expected.has("content_blobs")).toBe(true);
      expect(expected.has("note_sources")).toBe(true);
      // …and the claims tables to 0004_claims.
      expect(expected.has("claims")).toBe(true);
      expect(expected.has("claim_evidence")).toBe(true);
      // And it must NOT include tables owned by later migrations.
      expect(expected.has("jobs")).toBe(false);

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
