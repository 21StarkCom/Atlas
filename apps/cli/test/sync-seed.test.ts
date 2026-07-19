/**
 * `seedSyncCursor` — idempotent zero-state cursor seed at adoption (60-A task 1.5).
 */
import { describe, it, expect } from "vitest";
import { openStore, registerSyncCursorsMigration } from "@atlas/sqlite-store";
import { seedSyncCursor } from "../src/sync/seed.js";

function migrated() {
  const store = openStore({ path: ":memory:" });
  registerSyncCursorsMigration(store);
  store.migrate();
  return store;
}

describe("seedSyncCursor", () => {
  it("inserts a zero-state row (null cursor, cycle_seq 0, pending '[]', non-null stamp)", () => {
    const store = migrated();
    try {
      const res = seedSyncCursor(store, {
        sourceId: "main-vault",
        upstreamRef: "refs/atlas/main",
        now: () => "2026-07-19T00:00:00Z",
      });
      expect(res).toEqual({ sourceId: "main-vault", upstreamRef: "refs/atlas/main", seeded: true });
      const row = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id = 'main-vault'`).get() as {
        upstream_ref: string;
        last_absorbed_oid: string | null;
        last_synced_at: string;
        cycle_seq: number;
        pending_quarantine: string;
      };
      expect(row).toEqual({
        source_id: "main-vault",
        upstream_ref: "refs/atlas/main",
        last_absorbed_oid: null,
        last_synced_at: "2026-07-19T00:00:00Z",
        cycle_seq: 0,
        pending_quarantine: "[]",
      });
    } finally {
      store.close();
    }
  });

  it("re-seeding is a no-op that never clobbers an advanced cursor or cycle_seq", () => {
    const store = migrated();
    try {
      seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/atlas/main", now: () => "2026-07-19T00:00:00Z" });
      // Simulate a real sync advancing the cursor.
      store.db
        .prepare(
          `UPDATE sync_cursors SET last_absorbed_oid = ?, cycle_seq = ?, pending_quarantine = ?, last_synced_at = ? WHERE source_id = 'main-vault'`,
        )
        .run("a".repeat(40), 12, JSON.stringify(["d".repeat(40)]), "2026-07-20T00:00:00Z");
      const before = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id = 'main-vault'`).get();

      // Re-seed (e.g. operator runs adoption again) — must be an INSERT OR IGNORE no-op.
      const res = seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/atlas/main", now: () => "2026-07-21T00:00:00Z" });
      expect(res.seeded).toBe(false);
      const after = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id = 'main-vault'`).get();
      expect(after).toEqual(before);
    } finally {
      store.close();
    }
  });
});
