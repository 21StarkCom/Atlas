/**
 * `migrate.evidence-v2` — `0014_evidence_v2` creates the v2 vault-derived
 * `evidence` projection with the exact eleven-column schema (Phase-4 task 4-2).
 *
 * EXPAND-AND-CONTRACT stage note: task 4-2 landed the ADDITIVE half of `0014`
 * (`CREATE TABLE evidence`); task 4-4 appends the CONTRACT half — the DROP of the v1
 * `claims`/`claim_evidence` model now that the flat `evidence` projection has fully
 * replaced it. So THIS test asserts every half: after `db migrate` the v2 `evidence`
 * table exists with the exact schema, the v1 `claims`/`claim_evidence` tables are
 * gone, AND (task 4-1) the retired ledger/backup tables (`audit_events`,
 * `audit_intents`, `backup_watermark`, `raw_payloads`) are gone too.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { userTables } from "./helpers.js";

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  /** `1` when the column is `NOT NULL`. */
  readonly notnull: number;
  readonly dflt_value: string | null;
  /** `> 0` when the column participates in the primary key. */
  readonly pk: number;
}

function columns(store: { db: { prepare(sql: string): { all(): unknown[] } } }): ColumnInfo[] {
  return store.db.prepare(`PRAGMA table_info(evidence)`).all() as ColumnInfo[];
}

function createSql(store: { db: { prepare(sql: string): { get(name: string): unknown } } }): string {
  const row = store.db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get("evidence") as { sql: string } | undefined;
  return row?.sql ?? "";
}

describe("migrate.evidence-v2 (0014_evidence_v2)", () => {
  it("db migrate creates the v2 evidence projection with the exact eleven-column schema", () => {
    const store = openStore({ path: ":memory:" });
    try {
      // Store-open alone never auto-applies a migration — the evidence table does
      // not exist until the explicit migrate() (the CLI's `brain db migrate`).
      expect(userTables(store.db).has("evidence")).toBe(false);

      store.migrate();
      expect(userTables(store.db).has("evidence")).toBe(true);

      const cols = columns(store);
      // Eleven columns, in DDL order, camelCase (the v2 form the plan pins).
      expect(cols.map((c) => c.name)).toEqual([
        "id",
        "noteId",
        "sectionPath",
        "claim",
        "citation",
        "status",
        "verdict",
        "attempts",
        "lastCheckedAt",
        "sourceNoteHash",
        "createdAt",
      ]);

      const byName = new Map(cols.map((c) => [c.name, c]));
      // `id` is the NOT NULL primary key.
      expect(byName.get("id")).toMatchObject({ type: "TEXT", notnull: 1, pk: 1 });
      // `attempts` is the one NOT NULL column with a default (the retry counter).
      expect(byName.get("attempts")).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "0" });
      // The five explicitly-nullable columns.
      for (const name of ["sectionPath", "citation", "verdict", "lastCheckedAt", "sourceNoteHash"]) {
        expect(byName.get(name), name).toMatchObject({ notnull: 0, pk: 0 });
      }

      // STRICT typing + the status CHECK enum are carried in the stored DDL.
      const sql = createSql(store);
      expect(sql).toMatch(/\)\s*STRICT/i);
      expect(sql).toContain("status IN ('pending', 'resolved', 'failed', 'needs-review')");
    } finally {
      store.close();
    }
  });

  it("the status CHECK rejects an out-of-enum verdict status and accepts the four legal states", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.migrate();
      const insert = store.db.prepare(
        `INSERT INTO evidence (id, noteId, claim, status, attempts, createdAt)
         VALUES (@id, @noteId, @claim, @status, 0, @createdAt)`,
      );
      for (const status of ["pending", "resolved", "failed", "needs-review"]) {
        insert.run({ id: `e-${status}`, noteId: "n-1", claim: "c", status, createdAt: "2026-07-23T00:00:00Z" });
      }
      expect(
        () =>
          insert.run({ id: "e-bad", noteId: "n-1", claim: "c", status: "bogus", createdAt: "2026-07-23T00:00:00Z" }),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("the v1 claims model is dropped (0014 forward-DROPs claims/claim_evidence in task 4-4)", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.migrate();
      const tables = userTables(store.db);
      expect(tables.has("evidence")).toBe(true);
      // The v1 evidence model is now dropped — its last consumer is removed and the
      // DROP is appended to 0014 (children-first: claim_evidence before claims). The
      // flat vault-derived `evidence` projection has fully replaced it.
      expect(tables.has("claims")).toBe(false);
      expect(tables.has("claim_evidence")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("the ledger/backup tables are dropped (0014 forward-DROPs them in task 4-1, #338)", () => {
    const store = openStore({ path: ":memory:" });
    try {
      store.migrate();
      const tables = userTables(store.db);
      // v2 (#338): the §2.8 audit ledger + AEAD backup are retired; git is the only
      // safety mechanism. `agent_runs`/`model_calls` are retained operational tables.
      for (const t of ["audit_events", "audit_intents", "backup_watermark", "raw_payloads"]) {
        expect(tables.has(t), `${t} must be dropped`).toBe(false);
      }
      expect(tables.has("agent_runs"), "agent_runs is retained").toBe(true);
      expect(tables.has("model_calls"), "model_calls is retained").toBe(true);
    } finally {
      store.close();
    }
  });
});
