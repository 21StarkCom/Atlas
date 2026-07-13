/**
 * `db.verify` — the §7 invariant queries + the §6 query-plan (EQP) assertions.
 *
 * Query-plan assertions must use the contract's indexes (a `SEARCH … USING
 * INDEX`, never a `SCAN`). Invariants must catch a violation (a note with two
 * slug keys; a terminal run with no terminal audit event) and pass a clean DB.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
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

  it("catches a terminal run with no terminal audit event", () => {
    const store = migrated();
    try {
      store.ledger.upsertAgentRun({
        run_id: "run-x",
        operation: "ingest",
        status: "failed",
        failed_checkpoint: "planned",
        started_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
      });
      const report = store.verify();
      expect(report.ok).toBe(false);
      expect(
        report.invariantViolations.some((v) => v.invariant === "audit-terminal-event-cardinality"),
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});
