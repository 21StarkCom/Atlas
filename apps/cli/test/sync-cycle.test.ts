/**
 * `sync` cycle engine — 60-B Phase 4. Grows task-by-task:
 *   - cursor read/finalize module (Task 4.2)
 *   - pending-quarantine reconcile policy (Task 4.6's pure half)
 *   - the cycle engine itself (Tasks 4.4-4.7) — appended once built.
 */
import { describe, it, expect } from "vitest";
import { openStore, registerSyncCursorsMigration, type Store } from "@atlas/sqlite-store";
import { seedSyncCursor } from "../src/sync/seed.js";
import {
  readCursor,
  finalizeCursor,
  serializePending,
  MalformedPendingError,
  type PendingEntry,
} from "../src/sync/cursor.js";
import { reconcilePending } from "../src/sync/pending.js";

function seededStore(sourceId = "main-vault"): Store {
  const store = openStore({ path: ":memory:" });
  registerSyncCursorsMigration(store);
  store.migrate();
  seedSyncCursor(store, { sourceId, upstreamRef: "refs/heads/main", now: () => "2026-07-20T00:00:00Z" });
  return store;
}

const entry = (path: string, q = "q1", oid = "b".repeat(40)): PendingEntry => ({
  path,
  quarantineId: q,
  firstSeenOid: oid,
});

describe("sync cursor module (Task 4.2)", () => {
  it("readCursor returns the seeded zero-state row", () => {
    const store = seededStore();
    try {
      const c = readCursor(store, "main-vault");
      expect(c).toEqual({
        sourceId: "main-vault",
        upstreamRef: "refs/heads/main",
        lastAbsorbedOid: null,
        lastSyncedAt: "2026-07-20T00:00:00Z",
        cycleSeq: 0,
        pendingQuarantine: [],
      });
    } finally {
      store.close();
    }
  });

  it("readCursor returns null for an un-adopted source (no row)", () => {
    const store = seededStore();
    try {
      expect(readCursor(store, "other-vault")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("finalizeCursor advances OID, bumps cycle_seq, persists the reconciled pending set, atomically", () => {
    const store = seededStore();
    try {
      const pending = [entry("s.md")];
      finalizeCursor(store.db, {
        sourceId: "main-vault",
        newOid: "a".repeat(40),
        now: "2026-07-20T01:00:00Z",
        pendingQuarantine: pending,
      });
      const c = readCursor(store, "main-vault")!;
      expect(c.lastAbsorbedOid).toBe("a".repeat(40));
      expect(c.cycleSeq).toBe(1);
      expect(c.lastSyncedAt).toBe("2026-07-20T01:00:00Z");
      expect(c.pendingQuarantine).toEqual(pending);
    } finally {
      store.close();
    }
  });

  it("finalizeCursor participates in the caller's transaction (rollback leaves the row untouched)", () => {
    const store = seededStore();
    try {
      const before = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id='main-vault'`).get();
      const tx = store.db.transaction(() => {
        finalizeCursor(store.db, {
          sourceId: "main-vault",
          newOid: "c".repeat(40),
          now: "t",
          pendingQuarantine: [],
        });
        throw new Error("boom"); // simulated late failure inside the finalize tx
      });
      expect(() => tx()).toThrow("boom");
      const after = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id='main-vault'`).get();
      expect(after).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("finalizeCursor throws for a missing row and a malformed OID", () => {
    const store = seededStore();
    try {
      expect(() =>
        finalizeCursor(store.db, { sourceId: "ghost", newOid: "a".repeat(40), now: "t", pendingQuarantine: [] }),
      ).toThrow(/no sync_cursors row/);
      expect(() =>
        finalizeCursor(store.db, { sourceId: "main-vault", newOid: "nope", now: "t", pendingQuarantine: [] }),
      ).toThrow(/not a 40-hex OID/);
    } finally {
      store.close();
    }
  });

  it("readCursor fails closed on malformed pending JSON (never silently tolerates)", () => {
    const store = seededStore();
    try {
      for (const bad of [
        `{"not":"array"}`,
        `[{"path":"x.md"}]`,
        `[{"path":"x.md","quarantineId":"q","firstSeenOid":"short"}]`,
        `[{"path":"x.md","quarantineId":"q","firstSeenOid":"${"b".repeat(40)}"},{"path":"x.md","quarantineId":"q2","firstSeenOid":"${"c".repeat(40)}"}]`,
        `not json`,
      ]) {
        store.db.prepare(`UPDATE sync_cursors SET pending_quarantine = ? WHERE source_id='main-vault'`).run(bad);
        expect(() => readCursor(store, "main-vault")).toThrow(MalformedPendingError);
      }
    } finally {
      store.close();
    }
  });

  it("serializePending is deterministic (sorted by path, byte-stable across replays)", () => {
    const a = serializePending([entry("z.md", "q2"), entry("a.md", "q1")]);
    const b = serializePending([entry("a.md", "q1"), entry("z.md", "q2")]);
    expect(a).toBe(b);
    expect(JSON.parse(a).map((e: PendingEntry) => e.path)).toEqual(["a.md", "z.md"]);
  });
});

describe("reconcilePending (sole pending-policy owner)", () => {
  it("clears corrected/archived/renamed-away paths and reports them", () => {
    const existing = [entry("a.md", "qa"), entry("b.md", "qb")];
    const r = reconcilePending(existing, { clearedPaths: ["a.md", "never-pending.md"], upsertedDirty: [] });
    expect(r.entries).toEqual([entry("b.md", "qb")]);
    expect(r.cleared).toEqual([entry("a.md", "qa")]);
  });

  it("upserts a still-dirty path preserving firstSeenOid (new quarantineId, old OID)", () => {
    const first = entry("a.md", "q-old", "1".repeat(40));
    const r = reconcilePending([first], {
      clearedPaths: [],
      upsertedDirty: [entry("a.md", "q-new", "2".repeat(40))],
    });
    expect(r.entries).toEqual([{ path: "a.md", quarantineId: "q-new", firstSeenOid: "1".repeat(40) }]);
    expect(r.cleared).toEqual([]);
  });

  it("a fresh dirty path records the sighting OID as firstSeenOid", () => {
    const r = reconcilePending([], { clearedPaths: [], upsertedDirty: [entry("new.md", "q", "3".repeat(40))] });
    expect(r.entries).toEqual([{ path: "new.md", quarantineId: "q", firstSeenOid: "3".repeat(40) }]);
  });

  it("clear-then-re-dirty in one range is a FRESH occurrence (new firstSeenOid)", () => {
    const r = reconcilePending([entry("a.md", "q-old", "1".repeat(40))], {
      clearedPaths: ["a.md"],
      upsertedDirty: [entry("a.md", "q-new", "9".repeat(40))],
    });
    expect(r.entries).toEqual([{ path: "a.md", quarantineId: "q-new", firstSeenOid: "9".repeat(40) }]);
    // The clear itself is still reported: the OLD entry did leave the set.
    expect(r.cleared).toEqual([entry("a.md", "q-old", "1".repeat(40))]);
  });

  it("untouched pending paths keep their entries; output is path-sorted; set stays keyed by path", () => {
    const existing = [entry("z.md", "qz"), entry("a.md", "qa")];
    const r = reconcilePending(existing, {
      clearedPaths: [],
      upsertedDirty: [entry("m.md", "qm", "4".repeat(40))],
    });
    expect(r.entries.map((e) => e.path)).toEqual(["a.md", "m.md", "z.md"]);
  });
});
