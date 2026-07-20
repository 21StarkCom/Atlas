/**
 * `seq-partition` (#217 E2E finding) — the two ledger seq spaces are DISJOINT NUMERIC
 * RANGES (`run.*` from 0; ledger-internal from {@link DB_EVENT_SEQ_BASE}), and every
 * query that reads ONE space must partition by the RANGE, not by event-type prefix.
 *
 * The bug this pins: `evidence.retry_enqueued` is a ledger-internal event (allocated
 * by `nextDbEventSeq` in the high range, never sent to the broker) but its type does
 * not match `db.%`, so the prefix-partitioned `nextRunSeq()`/`latestRunSeq()` counted
 * it into the RUN space. After a single `brain evidence retry`, `nextRunSeq()`
 * returned ~10^12+1 and EVERY subsequent broker-anchored run was refused
 * `broker.audit_seq_nonmonotonic` (the broker signs only `lastSeq + 1`); the backup
 * cut point (`latestRunSeq`) similarly jumped into the internal range, corrupting the
 * watermark. Found by the #217 reverify E2E (real broker), invisible to seam tests.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "../../src/index.js";
import {
  DB_EVENT_SEQ_BASE,
  IntentsRepo,
  latestRunSeq,
  nextDbEventSeq,
} from "../../src/ledger/intents.js";
import { readCoalesceCovers } from "../../src/ledger/finalize.js";
import { WatermarkRepo } from "../../src/backup/watermark.js";
import { reconcileInterruptedRuns } from "../../src/ledger/reconcile.js";

function seededDb() {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  const insert = store.db.prepare(
    `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
     VALUES (?, ?, ?, 'h', NULL, '2026-07-20T00:00:00.000Z')`,
  );
  // A committed run chain 0..2 …
  insert.run(0, "r1", "run.started");
  insert.run(1, "r1", "run.planned");
  insert.run(2, "r1", "run.integrated");
  // … and ledger-internal events in the disjoint high range, INCLUDING the
  // non-`db.%` `evidence.retry_enqueued`.
  insert.run(DB_EVENT_SEQ_BASE, "db", "db.backup");
  insert.run(DB_EVENT_SEQ_BASE + 1, "retry", "evidence.retry_enqueued");
  return store;
}

describe("ledger seq-space partition (range, not type prefix)", () => {
  it("nextRunSeq ignores ledger-internal events — evidence.retry_enqueued included", () => {
    const store = seededDb();
    try {
      // Chain head is 2 ⇒ the only broker-signable next seq is 3. Counting the
      // internal-range retry event here poisons every subsequent run.
      expect(new IntentsRepo(store.db).nextRunSeq()).toBe(3);
    } finally {
      store.close();
    }
  });

  it("nextRunSeq ignores a stale intent stranded in the internal range", () => {
    const store = seededDb();
    try {
      // A pre-fix poisoned allocation left a pending intent at BASE+2 — it must not
      // drag fresh allocations back into the internal range.
      store.db
        .prepare(
          `INSERT INTO audit_intents (run_id, seq, event_json, write_json, payload_hash, state, created_at, updated_at)
           VALUES ('poisoned', ?, '{}', '[]', 'h', 'pending', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`,
        )
        .run(DB_EVENT_SEQ_BASE + 2);
      expect(new IntentsRepo(store.db).nextRunSeq()).toBe(3);
    } finally {
      store.close();
    }
  });

  it("latestRunSeq (the backup cut point) ignores ledger-internal events", () => {
    const store = seededDb();
    try {
      expect(latestRunSeq(store.db)).toBe(2);
    } finally {
      store.close();
    }
  });

  it("nextDbEventSeq keeps counting EVERY internal kind (db.* and evidence.*)", () => {
    const store = seededDb();
    try {
      expect(nextDbEventSeq(store.db)).toBe(DB_EVENT_SEQ_BASE + 2);
    } finally {
      store.close();
    }
  });

  it("readCoalesceCovers ignores internal-range events — a retry event never defeats the coalesce window", () => {
    const store = seededDb();
    try {
      // Chain head 2, covered through 2, all-readonly window above the cut… the
      // internal-range retry event (BASE+1) is NOT an uncovered run event.
      expect(readCoalesceCovers(store.db, 2)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("a watermark poisoned into the internal range is repaired to the nothing-covered sentinel", async () => {
    const store = seededDb();
    try {
      const wm = new WatermarkRepo(store.db);
      wm.markCovered(DB_EVENT_SEQ_BASE + 5, "2026-07-20T00:00:00.000Z"); // the pre-fix poisoned cut
      const broker = { signAndAppendAuditEvent: () => { throw new Error("no intents to drive"); } } as never;
      await reconcileInterruptedRuns(store, broker);
      expect(wm.get().seq).toBe(-1); // fail-closed: the next verified backup re-covers

      // A HEALTHY watermark is untouched by the repair.
      wm.markCovered(2, "2026-07-20T00:00:01.000Z");
      await reconcileInterruptedRuns(store, broker);
      expect(wm.get().seq).toBe(2);
    } finally {
      store.close();
    }
  });

  it("the reconcile drain finalizes a stranded internal-range intent WITHOUT a broker append (no wedge)", async () => {
    const store = seededDb();
    try {
      store.db
        .prepare(
          `INSERT INTO audit_intents (run_id, seq, event_json, write_json, payload_hash, state, created_at, updated_at)
           VALUES ('poisoned', ?, '{"kind":"run.started","seq":${DB_EVENT_SEQ_BASE + 2}}', '[]', 'h', 'pending', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`,
        )
        .run(DB_EVENT_SEQ_BASE + 2);
      // The broker MUST NOT be consulted for it — presenting a ~10^12 seq would be
      // refused broker.audit_seq_nonmonotonic and (pre-fix) abort the whole pass.
      const broker = {
        signAndAppendAuditEvent: () => {
          throw new Error("broker must not be called for a stranded internal-range intent");
        },
      } as never;
      const report = await reconcileInterruptedRuns(store, broker);
      expect(report.reconciled).toBe(1);
      // DELETED, not retained: a done row at ~10^12 would keep poisoning
      // unpartitioned MAX(seq) readers (round-2 finding).
      const row = store.db.prepare(`SELECT state FROM audit_intents WHERE seq = ?`).get(DB_EVENT_SEQ_BASE + 2);
      expect(row).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
