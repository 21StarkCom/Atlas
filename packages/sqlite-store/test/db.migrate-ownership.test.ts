/**
 * `db.migrate-ownership` — every §2.7 table is created by *exactly* its declared
 * migration. `openStore` pre-registers the retained migrations `0001_core` +
 * `0003_provenance` + `0004_claims` + `0005` + `0013` + `0014`. `0004_claims` still
 * runs (creating the v1 `claims`/`claim_evidence` tables) but `0014_evidence_v2`
 * forward-DROPs them, so a fresh DB carries the dictionary's `0001_core` ∪
 * `0003_provenance` ∪ {`evidence`} table sets plus the runner-bootstrap
 * `db_schema_migrations` — no missing, extra, or duplicate table, and no v1 claims table.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { dictionaryTablesFor, userTables } from "./helpers.js";

describe("db.migrate-ownership", () => {
  it("the default migration set creates exactly its declared §2.7 tables, minus 0014's forward-dropped v1 claims tables (fresh-DB diff vs dictionary)", () => {
    const store = openStore({ path: ":memory:" });
    try {
      const report = store.migrate();
      // `0013_links_v2` and `0014_evidence_v2` are in `openStore`'s default set, so
      // a fresh `migrate` applies them too. `0004_claims` still RUNS (it creates the
      // v1 `claims`/`claim_evidence` tables) but `0014` then forward-DROPs them, so
      // they are absent from the fresh DB. `0013` creates NO new table (it rebuilds
      // `note_links` in place); `0014` creates the v2 `evidence` projection table. So
      // the fresh-DB table diff below is the §2.7 core set (0001 + 0003) plus
      // `evidence`, with the v1 claims tables gone.
      expect(new Set(report.newlyApplied)).toEqual(
        new Set([
          "0001_core",
          "0003_provenance",
          "0004_claims",
          "0005_ledger_finalize",
          "0013_links_v2",
          "0014_evidence_v2",
        ]),
      );

      // `dictionaryTablesFor("0004_claims")` is now empty (the dictionary's claims
      // sections were removed with the DROP), and the fresh DB no longer carries the
      // v1 claims tables either, so the two stay in agreement without an explicit
      // 0004 inclusion.
      const expected = dictionaryTablesFor("0001_core");
      for (const t of dictionaryTablesFor("0003_provenance")) expected.add(t);
      for (const t of dictionaryTablesFor("0014_evidence_v2")) expected.add(t);
      expected.add("db_schema_migrations"); // runner bootstrap
      // Sanity: the dictionary really did attribute the core tables to 0001_core…
      expect(expected.has("notes")).toBe(true);
      expect(expected.has("audit_events")).toBe(true);
      // …the provenance tables to 0003_provenance…
      expect(expected.has("content_blobs")).toBe(true);
      expect(expected.has("note_sources")).toBe(true);
      // …and the v2 evidence projection to 0014_evidence_v2.
      expect(expected.has("evidence")).toBe(true);
      // The v1 claims tables are forward-dropped by 0014 — absent from the fresh DB.
      expect(expected.has("claims")).toBe(false);
      expect(expected.has("claim_evidence")).toBe(false);
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
