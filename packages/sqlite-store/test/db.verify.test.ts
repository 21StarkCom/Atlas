/**
 * `db.verify` — the §7 invariant queries + the §6 query-plan (EQP) assertions.
 *
 * Query-plan assertions must use the contract's indexes (a `SEARCH … USING
 * INDEX`, never a `SCAN`). Invariants must catch a violation (a note with two
 * slug keys) and pass a clean DB. v2 (#338): the audit-terminal invariant + the
 * audit-by-run EQP are retired with the `audit_events` table.
 */
import { describe, expect, it } from "vitest";
import {
  checkQueryPlans,
  migration0001Core,
  openConnection,
  openStore,
  runMigrations,
} from "../src/index.js";
import { makeNote, snapshot } from "./helpers.js";

function migrated() {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  return store;
}

describe("db.verify — query plans", () => {
  it("every applicable §6 assertion uses the contract index (no SCAN)", () => {
    const store = migrated();
    try {
      const report = store.verify();
      expect(report.queryPlanViolations).toEqual([]);
      // jobs does not exist yet (0002) → the eligibility assertion is skipped, not failed.
      expect(report.skipped).toContain("query-plan:jobs-eligibility");
    } finally {
      store.close();
    }
  });

  it("the reverse note_links traversal uses idx_note_links_reverse", () => {
    const store = migrated();
    try {
      const plan = (
        store.db
          .prepare(`EXPLAIN QUERY PLAN SELECT source_note_id FROM note_links WHERE target_note_id = ?`)
          .all("x") as { detail: string }[]
      )
        .map((r) => r.detail)
        .join(" | ");
      expect(plan).toContain("idx_note_links_reverse");
      expect(plan).not.toMatch(/\bSCAN note_links\b/);
    } finally {
      store.close();
    }
  });

  it("the forward note_links traversal uses idx_note_links_forward (symmetric to reverse)", () => {
    // v2 (`0013_links_v2`) dropped the 3-column PK whose autoindex gave forward
    // traversal its free SEARCH, so the migration recreates an explicit
    // `idx_note_links_forward`. The data dictionary §6 requires `db verify` to
    // enforce it BY NAME — assert the plan names the index, not merely "a SEARCH".
    const store = migrated();
    try {
      const plan = (
        store.db
          .prepare(`EXPLAIN QUERY PLAN SELECT target_note_id FROM note_links WHERE source_note_id = ?`)
          .all("x") as { detail: string }[]
      )
        .map((r) => r.detail)
        .join(" | ");
      expect(plan).toContain("idx_note_links_forward");
      expect(plan).not.toMatch(/\bSCAN note_links\b/);
      // And the aggregate verify surfaces no query-plan violation for it.
      expect(store.verify().queryPlanViolations).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("is migration-frontier-aware: accepts the v1 PK autoindex SEARCH before 0013", () => {
    // A valid pre-0013 DB (only `0001_core` applied) has the 3-column PK whose
    // autoindex serves forward traversal via `sqlite_autoindex_note_links_1`;
    // there is no `idx_note_links_forward` yet, so requiring it by name would fail
    // a legitimate old schema. `resolveIndex` must accept the PK SEARCH there.
    const db = openConnection({ path: ":memory:" });
    try {
      runMigrations(db, [migration0001Core], () => "2026-01-01T00:00:00Z");
      expect(
        db
          .prepare(`SELECT 1 FROM db_schema_migrations WHERE id = '0013_links_v2'`)
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_note_links_forward'`)
          .get(),
      ).toBeUndefined();
      const { violations } = checkQueryPlans(db);
      expect(violations.some((v) => v.pattern === "note-links-forward")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("is migration-frontier-aware: requires idx_note_links_forward BY NAME after 0013", () => {
    // After 0013 the PK autoindex is gone; only the explicit forward index can
    // serve the lookup. Dropping it must be caught as a violation (a partial
    // `ux_note_links_plain` cannot serve an unfiltered forward lookup).
    const store = migrated();
    try {
      store.db.exec(`DROP INDEX idx_note_links_forward`);
      const { violations } = checkQueryPlans(store.db);
      expect(violations.some((v) => v.pattern === "note-links-forward")).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("db.verify — invariants", () => {
  it("passes on a freshly rebuilt clean projection", () => {
    const store = migrated();
    try {
      store.rebuildProjections(snapshot([makeNote({ id: "n", path: "n.md" })]));
      const report = store.verify();
      expect(report.ok).toBe(true);
      expect(report.invariantViolations).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("catches a note with two slug identity keys", () => {
    const store = migrated();
    try {
      store.rebuildProjections(snapshot([makeNote({ id: "n", path: "n.md" })]));
      // Inject a second slug key for the same note (violates §7.1).
      store.db
        .prepare(
          `INSERT INTO note_identity_keys (normalized_key, note_id, kind, normalizer_version)
           VALUES ('extra-slug', 'n', 'slug', 1)`,
        )
        .run();
      const report = store.verify();
      expect(report.ok).toBe(false);
      expect(report.invariantViolations.some((v) => v.invariant === "one-slug-per-note")).toBe(true);
    } finally {
      store.close();
    }
  });

  // v2 (#338): the audit-terminal-event-cardinality invariant is retired with the
  // `audit_events` table (the §2.8 audit ledger is gone; `agent_runs`'s terminal
  // status IS the record, with no separate terminal event to reconcile against).
});
