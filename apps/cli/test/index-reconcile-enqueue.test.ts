/**
 * `index:reconcile` enqueue primitive (60-B Phase 3, Task 3.3).
 *
 * The sync cycle (Phase 4) enqueues ONE `index:reconcile` job per cycle, keyed by the
 * run's `refs/atlas/main` OID, so a cycle that re-runs (crash, retry, overlapping timer
 * fire) against the same absorbed commit never double-enqueues a reindex. That property
 * rests entirely on `@atlas/jobs`'s `UNIQUE (workflow, idempotency_key)` + `ON CONFLICT
 * DO NOTHING`; this suite locks it in as a regression at the `index:reconcile` workflow
 * name so a future change to the enqueue path cannot silently drop the de-dupe.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "@atlas/sqlite-store";
import {
  registerJobsMigration,
  enqueue,
  bindEnqueueContext,
  runAll,
  type JobsDeps,
  type JobHandler,
} from "@atlas/jobs";
import { INDEX_RECONCILE_WORKFLOW, buildIndexReconcileHandler } from "../src/sync/reconcile-handler.js";
import type { JobHandlerDeps } from "../src/commands/job-handlers.js";

/** An in-memory jobs-migrated store with a deterministic enqueue context bound. */
function jobsStore() {
  const store = openStore({ path: ":memory:" });
  registerJobsMigration(store);
  store.migrate();
  let n = 0;
  bindEnqueueContext(store.db, { now: () => "2026-07-19T00:00:00.000Z", nextJobId: () => `job-${n++}`, defaultMaxAttempts: 5 });
  return store;
}

const OID = "d".repeat(40);

describe("index:reconcile enqueue", () => {
  it("is idempotent on (workflow, idempotencyKey=run OID) — a double-enqueue yields one row", () => {
    const store = jobsStore();
    try {
      const id1 = store.db.transaction(() =>
        enqueue(store.db, { workflow: INDEX_RECONCILE_WORKFLOW, idempotencyKey: OID, payload: { noteIds: ["n1"] } }),
      )();
      const id2 = store.db.transaction(() =>
        enqueue(store.db, { workflow: INDEX_RECONCILE_WORKFLOW, idempotencyKey: OID, payload: { noteIds: ["n1"] } }),
      )();
      expect(id2).toBe(id1);
      const row = store.db
        .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE workflow = ? AND idempotency_key = ?`)
        .get(INDEX_RECONCILE_WORKFLOW, OID) as { c: number };
      expect(row.c).toBe(1);
    } finally {
      store.close();
    }
  });

  it("enqueues distinct rows for distinct run OIDs (different cycles ⇒ different reindex)", () => {
    const store = jobsStore();
    try {
      const oidA = "a".repeat(40);
      const oidB = "b".repeat(40);
      const idA = store.db.transaction(() =>
        enqueue(store.db, { workflow: INDEX_RECONCILE_WORKFLOW, idempotencyKey: oidA, payload: { noteIds: ["n1"] } }),
      )();
      const idB = store.db.transaction(() =>
        enqueue(store.db, { workflow: INDEX_RECONCILE_WORKFLOW, idempotencyKey: oidB, payload: { noteIds: ["n2"] } }),
      )();
      expect(idB).not.toBe(idA);
      const row = store.db
        .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE workflow = ?`)
        .get(INDEX_RECONCILE_WORKFLOW) as { c: number };
      expect(row.c).toBe(2);
    } finally {
      store.close();
    }
  });
});

/**
 * The empty-registry regression (the Phase-3 verification gate). Before a real
 * `index:reconcile` handler existed, draining an enqueued reconcile hit the runner's
 * "no handler registered" path — which throws `{ code: "internal" }`, classified
 * TRANSIENT, so the job burned its whole attempt budget with backoff before failing at
 * exit 4. These two tests pin BOTH directions: the drain succeeds with the handler
 * registered, and reproduces the `internal` failure without it.
 */
describe("index:reconcile drain", () => {
  const passThroughLock: JobsDeps["withLock"] = (_scope, fn) => Promise.resolve(fn());

  function drainDeps(store: ReturnType<typeof jobsStore>, handlers: Record<string, JobHandler>): JobsDeps {
    return {
      store,
      handlers,
      withLock: passThroughLock,
      now: () => "2026-07-19T00:00:00.000Z",
      backoff: { baseMs: 1000, factor: 2, maxMs: 300_000 },
      defaultMaxAttempts: 5,
    };
  }

  function seedReconcileJob(store: ReturnType<typeof jobsStore>): void {
    store.db.transaction(() =>
      enqueue(store.db, { workflow: INDEX_RECONCILE_WORKFLOW, idempotencyKey: OID, payload: { noteIds: ["n1", "n2"] } }),
    )();
  }

  it("drains an enqueued index:reconcile to success (content-addressed result accepted)", async () => {
    const store = jobsStore();
    try {
      seedReconcileJob(store);
      // The real handler with the heavy reconcile stubbed — the point under test is the
      // runner integration: the workflow RESOLVES to a handler and the finalizer accepts
      // the content-addressed arm (no `commit`, no `sideEffectId`).
      const handler = buildIndexReconcileHandler({} as JobHandlerDeps, {
        reconcile: (_deps, noteIds) =>
          Promise.resolve({ scanned: noteIds.length, reembedded: noteIds.length, unchanged: 0, removed: 0, results: [] }),
      });
      const report = await runAll(drainDeps(store, { [INDEX_RECONCILE_WORKFLOW]: handler }), { all: true });
      expect(report.items).toHaveLength(1);
      expect(report.items[0]).toMatchObject({ outcome: "succeeded" });
      expect(report.aggregate.exitCode).toBe(0);
      expect(report.aggregate.failed).toBe(0);
      const state = store.db.prepare(`SELECT state FROM jobs WHERE workflow = ?`).get(INDEX_RECONCILE_WORKFLOW) as { state: string };
      expect(state.state).toBe("succeeded");
      // Content-addressed ⇒ the attempt records NO side-effect id.
      const att = store.db.prepare(`SELECT side_effect_id FROM job_attempts`).get() as { side_effect_id: string | null };
      expect(att.side_effect_id).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reproduces the pre-registration breakage: an EMPTY registry RETRIES the job (`internal` is transient)", async () => {
    const store = jobsStore();
    try {
      seedReconcileJob(store);
      const report = await runAll(drainDeps(store, {}), { all: true });
      // This is the exact pathology the registry closes: "no handler registered" throws
      // `{ code: "internal" }`, which classifies TRANSIENT — so a PERMANENT
      // misconfiguration is rescheduled with backoff and burns the whole attempt budget
      // before ever surfacing, instead of failing fast.
      expect(report.items[0]).toMatchObject({ outcome: "retry-scheduled" });
      const attempt = store.db.prepare(`SELECT error_code FROM job_attempts`).get() as { error_code: string | null };
      expect(attempt.error_code).toBe("internal");
      const row = store.db.prepare(`SELECT state, attempts FROM jobs WHERE workflow = ?`).get(INDEX_RECONCILE_WORKFLOW) as {
        state: string;
        attempts: number;
      };
      expect(row.state).toBe("pending"); // rescheduled, not terminal
      expect(row.attempts).toBe(1); // one attempt already consumed
    } finally {
      store.close();
    }
  });
});
