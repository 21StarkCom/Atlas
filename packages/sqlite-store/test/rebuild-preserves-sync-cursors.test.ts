/**
 * `db rebuild` preserves `sync_cursors` (60-A task 1.4, regression lock).
 *
 * `sync_cursors` is AUTHORITATIVE, non-derived state (like `jobs`): it is NOT
 * rebuildable from canonical Markdown, so `rebuildProjections` must leave every row
 * byte-identical. This asserts a non-trivial (advanced-cursor) row survives a rebuild
 * unchanged — guarding against a future pre-clear/fold accidentally clearing it.
 */
import { describe, expect, it } from "vitest";
import { openStore, registerSyncCursorsMigration } from "../src/index.js";
import { makeNote, snapshot } from "./helpers.js";

function migrated() {
  const store = openStore({ path: ":memory:" });
  registerSyncCursorsMigration(store);
  store.migrate();
  return store;
}

describe("db rebuild preserves sync_cursors", () => {
  it("leaves a non-trivial cursor row byte-identical across rebuildProjections", () => {
    const store = migrated();
    try {
      // An ADVANCED, non-zero-state cursor (a real absorbed oid, cycle 7, pending list).
      const advanced = {
        source_id: "main-vault",
        upstream_ref: "refs/atlas/main",
        last_absorbed_oid: "a".repeat(40),
        last_synced_at: "2026-07-19T12:34:56Z",
        cycle_seq: 7,
        pending_quarantine: JSON.stringify(["b".repeat(40), "c".repeat(40)]),
      };
      store.db
        .prepare(
          `INSERT INTO sync_cursors (source_id, upstream_ref, last_absorbed_oid, last_synced_at, cycle_seq, pending_quarantine)
           VALUES (@source_id, @upstream_ref, @last_absorbed_oid, @last_synced_at, @cycle_seq, @pending_quarantine)`,
        )
        .run(advanced);

      const before = store.db.prepare(`SELECT * FROM sync_cursors ORDER BY source_id`).all();

      // A real projection rebuild from a non-empty snapshot.
      store.rebuildProjections(snapshot([makeNote({ id: "note-a", path: "notes/alpha.md" })]));

      const after = store.db.prepare(`SELECT * FROM sync_cursors ORDER BY source_id`).all();
      expect(after).toEqual(before);
      expect(after).toEqual([advanced]);
    } finally {
      store.close();
    }
  });
});
