/**
 * `jobs.lifecycle` — the queue state machine + recovery under CONTROLLED CLOCKS
 * and CRASH INJECTION (jobs-contract.md §1–§7, Task 2.7 acceptance).
 *
 * Covers: idempotency collisions (`enqueue` per `(workflow, key)`); retry
 * exhaustion → terminal `failed` at `maxAttempts` (transient) and immediate
 * `failed` (permanent); startup dead-runner recovery (a crashed `running` job
 * resets to `pending`, its interrupted attempt finalized `failed`/`interrupted`
 * WITHOUT consuming the attempt budget); cancel queued-vs-running; the durable
 * payload hash guard (Task 2.7 decision 2); and the transactional side-effect id
 * (Task 2.7 decision 1). The lock is a pass-through here — exclusion is proven by
 * `apps/cli/test/jobs.single-runner-exclusion.test.ts` against the real manager.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  openJobsStore,
  registerJobsMigration,
  productionEnqueueContext,
  DEFAULT_MAX_ATTEMPTS,
  enqueue,
  bindEnqueueContext,
  runAll,
  claimNext,
  completeJob,
  listJobs,
  recoverDeadRunners,
  readSnapshot,
  cancelJob,
  cancellationRequested,
  retryJob,
  CancellationRegistry,
  requestJobCancellation,
  scheduleRetry,
  failJob,
  cancelRunning,
  PayloadIntegrityError,
  MaxAttemptsRangeError,
  SideEffectIdRequiredError,
  EnqueueContextRequiredError,
  StaleAttemptError,
  type JobHandler,
  type JobsDeps,
  type JobSpec,
} from "../src/index.js";
import { openStore, type Store } from "@atlas/sqlite-store";

/** A steppable RFC-3339 clock (controlled time for deterministic backoff eligibility). */
function makeClock(startIso = "2026-07-14T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const passThroughLock: JobsDeps["withLock"] = async (_scope, fn) => fn();

let store: Store;
let clock: ReturnType<typeof makeClock>;

beforeEach(() => {
  store = openJobsStore({ path: ":memory:" });
  clock = makeClock();
});
afterEach(() => store.close());

function enq(spec: JobSpec, jobId: string): string {
  // Inject the deterministic enqueue seam (clock + this row's id + default budget) for
  // this connection, then use the plan's 2-arg public `enqueue(tx, job)` (finding 1).
  bindEnqueueContext(store.db, { now: () => clock.now(), nextJobId: () => jobId, defaultMaxAttempts: 5 });
  return store.db.transaction(() => enqueue(store.db, spec))();
}

function deps(handlers: Record<string, JobHandler>, overrides: Partial<JobsDeps> = {}): JobsDeps {
  return {
    store,
    handlers,
    withLock: passThroughLock,
    now: clock.now,
    backoff: { baseMs: 1000, factor: 2, maxMs: 300_000 },
    defaultMaxAttempts: 5,
    ...overrides,
  };
}

describe("jobs.lifecycle", () => {
  it("migration adds the durable payload + transactional side_effect_id columns", () => {
    const jobCols = (store.db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map((c) => c.name);
    const attCols = (store.db.prepare(`PRAGMA table_info(job_attempts)`).all() as { name: string }[]).map((c) => c.name);
    expect(jobCols).toContain("payload");
    expect(jobCols).toContain("payload_hash");
    expect(attCols).toContain("side_effect_id");
  });

  it("enqueue is idempotent per (workflow, idempotency_key) — a collision returns the same jobId, one row", () => {
    const spec: JobSpec = { workflow: "capture", idempotencyKey: "k1", payload: { a: 1 } };
    const id1 = enq(spec, "job-a");
    const id2 = enq({ ...spec, payload: { a: 999 } }, "job-b"); // same key, different id/payload
    expect(id2).toBe(id1); // ON CONFLICT DO NOTHING → the existing row's id
    const n = (store.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n;
    expect(n).toBe(1);
    // A DIFFERENT key for the same workflow is a distinct row.
    enq({ workflow: "capture", idempotencyKey: "k2", payload: {} }, "job-c");
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(2);
  });

  it("succeeds a job once and records its transactional side-effect id", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: { x: 1 } }, "job-1");
    const handler: JobHandler = () => ({ sideEffectId: "capture:abc" });
    const report = await runAll(deps({ cap: handler }), { all: true });
    expect(report.items).toEqual([{ jobId: "job-1", workflow: "cap", outcome: "succeeded", attempts: 1 }]);
    expect(report.aggregate.exitCode).toBe(0);
    expect(readSnapshot(store, "job-1")!.state).toBe("succeeded");
    const sid = store.db.prepare(`SELECT side_effect_id AS s FROM job_attempts WHERE job_id = ?`).get("job-1") as {
      s: string;
    };
    expect(sid.s).toBe("capture:abc");
  });

  it("retries a transient failure with backoff, then drives it terminal at maxAttempts", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 3 }, "job-1");
    let calls = 0;
    const handler: JobHandler = () => {
      calls++;
      throw { kind: "timeout", message: "provider timed out" };
    };
    const d = deps({ cap: handler });

    // Attempt 1 → retry-scheduled (next_run_at in the future).
    let r = await runAll(d, { all: true });
    expect(r.items[0]!.outcome).toBe("retry-scheduled");
    expect(readSnapshot(store, "job-1")!.state).toBe("pending");

    // A second drain WITHOUT advancing the clock is a no-op (backoff not elapsed).
    r = await runAll(d, { all: true });
    expect(r.items).toEqual([]);

    // Advance past the backoff ceiling → attempt 2 retries, attempt 3 exhausts → failed.
    clock.advance(400_000);
    r = await runAll(d, { all: true });
    expect(r.items[0]!.outcome).toBe("retry-scheduled");
    clock.advance(400_000);
    r = await runAll(d, { all: true });
    expect(r.items[0]!.outcome).toBe("failed");
    expect(r.items[0]!.error!.retryable).toBe(true); // exhausted transient is provider-retryable
    expect(r.aggregate.exitCode).toBe(7);

    const snap = readSnapshot(store, "job-1")!;
    expect(snap.state).toBe("failed");
    expect(snap.attempts).toBe(3);
    expect(calls).toBe(3);
    const attempts = store.db.prepare(`SELECT COUNT(*) AS n FROM job_attempts WHERE job_id = ?`).get("job-1") as {
      n: number;
    };
    expect(attempts.n).toBe(3);
  });

  it("fails a permanent error immediately (one attempt, no retry)", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 5 }, "job-1");
    const handler: JobHandler = () => {
      throw { kind: "validation", message: "bad payload" };
    };
    const r = await runAll(deps({ cap: handler }), { all: true });
    expect(r.items[0]!.outcome).toBe("failed");
    expect(r.items[0]!.error!.retryable).toBe(false);
    expect(r.aggregate.exitCode).toBe(1);
    const snap = readSnapshot(store, "job-1")!;
    expect(snap.state).toBe("failed");
    expect(snap.attempts).toBe(1);
  });

  it("startup recovery resets a crashed running job to pending and finalizes its interrupted attempt without consuming budget", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: { n: 1 }, maxAttempts: 3 }, "job-1");
    // CRASH INJECTION: claim the job (commits `running` + a `running` attempt row),
    // then "die" before finalizing — exactly a dead-runner's mid-flight state.
    const claimed = claimNext(store.db, clock.now());
    expect(claimed!.attempt).toBe(1);
    expect(readSnapshot(store, "job-1")!.state).toBe("running");

    // Recovery (idempotent): running → pending, attempt finalized failed/interrupted,
    // attempts preserved (still 1), backoff untouched.
    const recovered = recoverDeadRunners(store.db, clock.now());
    expect(recovered).toEqual(["job-1"]);
    const snap = readSnapshot(store, "job-1")!;
    expect(snap.state).toBe("pending");
    expect(snap.attempts).toBe(1); // preserved — NOT a fresh attempt
    const interrupted = store.db
      .prepare(`SELECT outcome, error_code FROM job_attempts WHERE job_id = ? AND attempt_no = 1`)
      .get("job-1") as { outcome: string; error_code: string };
    expect(interrupted).toEqual({ outcome: "failed", error_code: "interrupted" });

    // Second recovery pass converges (no running row → no-op).
    expect(recoverDeadRunners(store.db, clock.now())).toEqual([]);

    // The recovered job now drains normally as attempt 2.
    const r = await runAll(deps({ cap: () => ({}) }), { all: true });
    expect(r.items[0]).toMatchObject({ outcome: "succeeded", attempts: 2 });
  });

  it("cancels a queued job directly, and a running job cooperatively via its AbortSignal", async () => {
    // Queued (pending) → cancelled directly.
    enq({ workflow: "cap", idempotencyKey: "q", payload: {} }, "job-q");
    expect(cancelJob(store.db, "job-q", clock.now())).toBe("cancelled");
    expect(readSnapshot(store, "job-q")!.state).toBe("cancelled");

    // Running → cooperative cancel: the handler observes an already-aborted signal.
    enq({ workflow: "cap", idempotencyKey: "r", payload: {} }, "job-r");
    const controller = new AbortController();
    controller.abort();
    const handler: JobHandler = ({ signal }) => {
      if (signal.aborted) throw { name: "AbortError", message: "cancelled" };
      return {};
    };
    const r = await runAll(deps({ cap: handler }, { makeSignal: () => controller.signal }), { all: true });
    expect(r.items[0]!.outcome).toBe("cancelled");
    expect(readSnapshot(store, "job-r")!.state).toBe("cancelled");
  });

  it("re-queues a failed job via retry (failed → pending, budget granted one more attempt)", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 1 }, "job-1");
    await runAll(deps({ cap: () => { throw { kind: "timeout" }; } }), { all: true });
    expect(readSnapshot(store, "job-1")!.state).toBe("failed");
    expect(retryJob(store.db, "job-1", clock.now())).toBe("requeued");
    const snap = readSnapshot(store, "job-1")!;
    expect(snap.state).toBe("pending");
    expect(snap.attempts).toBe(1); // preserved (attempt history stays monotonic)
    expect(snap.maxAttempts).toBe(2); // granted one more so the claim guard admits it
    expect(retryJob(store.db, "job-1", clock.now())).toBe("not-failed"); // now pending
  });

  it("manual retry after exhaustion runs exactly one more attempt within the granted budget", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 1 }, "job-1");
    let calls = 0;
    const handler: JobHandler = () => {
      calls++;
      throw { kind: "validation", message: "permanent" }; // fail immediately (1 attempt)
    };
    const d = deps({ cap: handler });
    // First cycle: exactly one attempt, then terminal failed.
    await runAll(d, { all: true });
    expect(readSnapshot(store, "job-1")!.attempts).toBe(1);
    expect(readSnapshot(store, "job-1")!.state).toBe("failed");

    // WITHOUT a retry the exhausted job is un-claimable (the claim-SQL budget guard).
    expect(claimNext(store.db, clock.now())).toBeNull();

    // Operator retry grants exactly ONE more attempt (max_attempts 1 → 2) → claimable.
    expect(retryJob(store.db, "job-1", clock.now())).toBe("requeued");
    await runAll(d, { all: true });
    const snap = readSnapshot(store, "job-1")!;
    expect(snap.state).toBe("failed");
    expect(snap.attempts).toBe(2); // one further attempt, within the granted budget
    expect(snap.maxAttempts).toBe(2);
    expect(calls).toBe(2); // one execution per explicit budget cycle — not unbounded
    // The re-run's attempt_no stays within the CURRENT budget (never runs beyond it).
    const maxAttemptNo = (
      store.db.prepare(`SELECT MAX(attempt_no) AS m FROM job_attempts WHERE job_id = ?`).get("job-1") as { m: number }
    ).m;
    expect(maxAttemptNo).toBe(snap.maxAttempts);
  });

  it("recovery of a crash on the FINAL attempt drives the job terminal (no maxAttempts+1 execution)", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 1 }, "job-1");
    // Claim consumes the only attempt (attempts → 1 == max_attempts), then "crash".
    const claimed = claimNext(store.db, clock.now());
    expect(claimed!.attempt).toBe(1);
    expect(readSnapshot(store, "job-1")!.state).toBe("running");

    // Recovery: the interrupted attempt was the budget's last, so the job is closed
    // out as `failed` (attempts-exhausted) — NOT re-queued (which would let a later
    // claim run a 2nd == maxAttempts+1 attempt, or wedge it pending under the guard).
    expect(recoverDeadRunners(store.db, clock.now())).toEqual(["job-1"]);
    const snap = readSnapshot(store, "job-1")!;
    expect(snap.state).toBe("failed");
    expect(snap.attempts).toBe(1);
    const interrupted = store.db
      .prepare(`SELECT outcome, error_code FROM job_attempts WHERE job_id = ? AND attempt_no = 1`)
      .get("job-1") as { outcome: string; error_code: string };
    expect(interrupted).toEqual({ outcome: "failed", error_code: "interrupted" });

    // No further work is claimable, and the drain runs nothing.
    expect(claimNext(store.db, clock.now())).toBeNull();
    const r = await runAll(deps({ cap: () => ({}) }), { all: true });
    expect(r.items).toEqual([]);
  });

  it("rejects a job whose durable payload no longer matches its payload_hash (Task 2.7 decision 2)", () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: { real: true } }, "job-1");
    // Tamper the durable payload without updating the hash.
    store.db.prepare(`UPDATE jobs SET payload = ? WHERE job_id = ?`).run(JSON.stringify({ real: false }), "job-1");
    expect(() => readSnapshot(store, "job-1")).toThrow(PayloadIntegrityError);
  });

  it("crash injection at claim (onClaimed throws) is a transient failure that reschedules", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 3 }, "job-1");
    const r = await runAll(
      deps(
        { cap: () => ({}) },
        {
          onClaimed: () => {
            throw { code: "internal", message: "crash between claim and execute" };
          },
        },
      ),
      { all: true },
    );
    expect(r.items[0]!.outcome).toBe("retry-scheduled");
    expect(readSnapshot(store, "job-1")!.state).toBe("pending");
    expect(readSnapshot(store, "job-1")!.attempts).toBe(1);
  });

  it("commits a mutable side effect + its side_effect_id in ONE transaction (crash injection rolls back both)", () => {
    // A table the effect mutates; a crash mid-transaction must leave NO trace of it.
    store.db.exec(`CREATE TABLE fx (job_id TEXT PRIMARY KEY, note TEXT)`);
    enq({ workflow: "cap", idempotencyKey: "ok", payload: {} }, "job-ok");
    enq({ workflow: "cap", idempotencyKey: "boom", payload: {} }, "job-boom");

    // Happy path: effect row + side_effect_id + terminal state all land together.
    claimNext(store.db, clock.now(), "job-ok");
    completeJob(store.db, "job-ok", 1, clock.now(), "fx:ok", (tx) => {
      tx.prepare(`INSERT INTO fx (job_id, note) VALUES (?, ?)`).run("job-ok", "applied");
    });
    expect(readSnapshot(store, "job-ok")!.state).toBe("succeeded");
    expect((store.db.prepare(`SELECT note FROM fx WHERE job_id = ?`).get("job-ok") as { note: string }).note).toBe("applied");
    expect(
      (store.db.prepare(`SELECT side_effect_id AS s FROM job_attempts WHERE job_id = ?`).get("job-ok") as { s: string }).s,
    ).toBe("fx:ok");

    // Crash injection: the effect writes its row, then throws BEFORE the id/flip are
    // recorded. The whole transaction rolls back — no fx row, no side_effect_id, and
    // the job stays `running` (recoverable) rather than `succeeded`.
    claimNext(store.db, clock.now(), "job-boom");
    expect(() =>
      completeJob(store.db, "job-boom", 1, clock.now(), "fx:boom", (tx) => {
        tx.prepare(`INSERT INTO fx (job_id, note) VALUES (?, ?)`).run("job-boom", "half");
        throw new Error("crash mid-effect");
      }),
    ).toThrow(/crash mid-effect/);
    expect(store.db.prepare(`SELECT note FROM fx WHERE job_id = ?`).get("job-boom")).toBeUndefined();
    expect(readSnapshot(store, "job-boom")!.state).toBe("running"); // not succeeded
    const att = store.db
      .prepare(`SELECT outcome, side_effect_id AS s FROM job_attempts WHERE job_id = ?`)
      .get("job-boom") as { outcome: string; s: string | null };
    expect(att.outcome).toBe("running"); // attempt row untouched
    expect(att.s).toBeNull(); // no side-effect id recorded
  });

  it("cancels a RUNNING job concurrently via the observable registry (blocked handler observes the signal)", async () => {
    enq({ workflow: "cap", idempotencyKey: "run", payload: {} }, "job-run");
    const cancellation = new CancellationRegistry();

    // The handler parks on a gate (simulating an in-flight step), polling its signal.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const handler: JobHandler = async ({ signal }) => {
      started();
      await gate;
      if (signal.aborted) throw { name: "AbortError", message: "cancelled mid-flight" };
      return {};
    };

    const draining = runAll(deps({ cap: handler }, { cancellation }), { all: true });
    await startedP; // the job is now running and registered

    // Concurrent cancel: observable — aborts the live signal (not merely "cancel-requested").
    expect(requestJobCancellation(cancellation, store.db, "job-run", clock.now())).toBe("cancel-requested");
    release();

    const r = await draining;
    expect(r.items[0]!.outcome).toBe("cancelled");
    expect(readSnapshot(store, "job-run")!.state).toBe("cancelled");
  });

  it("enforces the normative maxAttempts range [1, 20] on the override AND the default (finding 4)", () => {
    // Boundary: 1 and 20 are accepted.
    expect(() => enq({ workflow: "cap", idempotencyKey: "min", payload: {}, maxAttempts: 1 }, "job-min")).not.toThrow();
    expect(() => enq({ workflow: "cap", idempotencyKey: "max", payload: {}, maxAttempts: 20 }, "job-max")).not.toThrow();

    // Out-of-range overrides: zero (permanently unclaimable), negative, fractional, oversized.
    for (const [key, bad] of [["z", 0], ["neg", -1], ["frac", 1.5], ["big", 21]] as const) {
      expect(
        () => enq({ workflow: "cap", idempotencyKey: key, payload: {}, maxAttempts: bad }, `job-${key}`),
        `maxAttempts=${bad}`,
      ).toThrow(MaxAttemptsRangeError);
    }

    // A bad CONFIGURED DEFAULT is rejected too (validated independent of the override).
    bindEnqueueContext(store.db, { now: () => clock.now(), nextJobId: () => "job-bd", defaultMaxAttempts: 0 });
    expect(() =>
      store.db.transaction(() => enqueue(store.db, { workflow: "cap", idempotencyKey: "bd", payload: {} }))(),
    ).toThrow(MaxAttemptsRangeError);

    // Only the two in-range boundary rows were actually written.
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(2);
  });

  it("rejects a mutable commit effect that omits a non-empty side_effect_id (finding 5)", () => {
    enq({ workflow: "cap", idempotencyKey: "se", payload: {} }, "job-se");
    claimNext(store.db, clock.now(), "job-se");
    // completeJob is the repository-boundary guard: an effect + NULL/empty id is refused.
    expect(() => completeJob(store.db, "job-se", 1, clock.now(), null, () => {})).toThrow(SideEffectIdRequiredError);
    expect(() => completeJob(store.db, "job-se", 1, clock.now(), "", () => {})).toThrow(SideEffectIdRequiredError);
    // The job stayed running (nothing committed); a proper id then succeeds it.
    expect(readSnapshot(store, "job-se")!.state).toBe("running");
    completeJob(store.db, "job-se", 1, clock.now(), "fx:se", () => {});
    expect(readSnapshot(store, "job-se")!.state).toBe("succeeded");
  });

  it("fails (permanently) a handler that returns a commit effect without a sideEffectId (finding 5, runner guard)", async () => {
    enq({ workflow: "cap", idempotencyKey: "bad", payload: {}, maxAttempts: 5 }, "job-bad");
    // A handler bypassing the discriminated type (JS caller) → the runner classifies the
    // missing-id as `validation` (permanent) so it fails immediately, not retries forever.
    const rogue = (() => ({ commit: () => {} })) as unknown as JobHandler;
    const r = await runAll(deps({ cap: rogue }), { all: true });
    expect(r.items[0]!.outcome).toBe("failed");
    expect(r.items[0]!.error!.retryable).toBe(false); // permanent — one attempt, no retry
    expect(readSnapshot(store, "job-bad")!.attempts).toBe(1);
  });

  it("lists jobs newest-first (created_at DESC, jobId DESC) with stable pagination (finding 6)", () => {
    // Two rows share a created_at so the jobId tie-breaker is exercised; a later row is newer.
    enq({ workflow: "cap", idempotencyKey: "a", payload: {} }, "job-a"); // t0
    enq({ workflow: "cap", idempotencyKey: "b", payload: {} }, "job-b"); // t0 (same tick)
    clock.advance(1000);
    enq({ workflow: "cap", idempotencyKey: "c", payload: {} }, "job-c"); // t1 (newest)

    const all = listJobs(store.db, { limit: 50, offset: 0 });
    expect(all.total).toBe(3);
    // Newest created_at first; within the t0 tie, jobId DESC (job-b before job-a).
    expect(all.rows.map((r) => r.jobId)).toEqual(["job-c", "job-b", "job-a"]);

    // Pagination preserves the same total order across pages (no row skipped/repeated).
    const page1 = listJobs(store.db, { limit: 2, offset: 0 });
    const page2 = listJobs(store.db, { limit: 2, offset: 2 });
    expect(page1.rows.map((r) => r.jobId)).toEqual(["job-c", "job-b"]);
    expect(page2.rows.map((r) => r.jobId)).toEqual(["job-a"]);
  });

  it("does not re-run a zero-backoff retry within the same drain (each job claimed once per invocation)", async () => {
    enq({ workflow: "cap", idempotencyKey: "z", payload: {}, maxAttempts: 5 }, "job-z");
    let calls = 0;
    const handler: JobHandler = () => {
      calls++;
      // A provider retry with retryAfterMs=0 reschedules `next_run_at = now` — eligible
      // again immediately; the drain must NOT re-claim it this invocation.
      throw { kind: "rate_limit", message: "slow down", retryAfter: 0 };
    };
    const r = await runAll(deps({ cap: handler }), { all: true });
    expect(calls).toBe(1); // claimed + run exactly once despite the zero-delay reschedule
    expect(r.items).toEqual([{ jobId: "job-z", workflow: "cap", outcome: "retry-scheduled", attempts: 1, retryAfterMs: 0 }]);
    expect(readSnapshot(store, "job-z")!.state).toBe("pending"); // rescheduled, awaiting the NEXT drain
  });

  it("enqueue requires a bound EnqueueContext — the plan's 2-arg public signature (finding 1)", () => {
    // A RAW store connection (openStore + register + migrate, WITHOUT the production
    // composition root) has no bound context → enqueue refuses rather than silently
    // minting a row with an unseeded clock/id. (openJobsStore, the production path, binds
    // one — covered by the production-path test below.)
    const fresh = openStore({ path: ":memory:" });
    registerJobsMigration(fresh);
    fresh.migrate();
    try {
      expect(() =>
        fresh.db.transaction(() => enqueue(fresh.db, { workflow: "cap", idempotencyKey: "x", payload: {} }))(),
      ).toThrow(EnqueueContextRequiredError);
    } finally {
      fresh.close();
    }
    // The bound context supplies the id/clock/default behind the 2-arg signature.
    const id = enq({ workflow: "cap", idempotencyKey: "bound", payload: { a: 1 } }, "job-bound");
    expect(id).toBe("job-bound");
    expect(readSnapshot(store, "job-bound")!.state).toBe("pending");
  });

  it("openJobsStore binds a production EnqueueContext — the 2-arg enqueue works with no manual bind (finding 1)", () => {
    // The production composition root: open the store the way a downstream enqueuer
    // (Task 2.6 capture, #32) would, then call the plan's 2-arg `enqueue(tx, job)`
    // WITHOUT any bindEnqueueContext — it must succeed, minting a real id and defaulting
    // the attempt budget from the bound production context (no runtime EnqueueContextRequiredError).
    const prod = openJobsStore({ path: ":memory:" });
    try {
      const id = prod.db.transaction(() => enqueue(prod.db, { workflow: "cap", idempotencyKey: "p", payload: { a: 1 } }))();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      const snap = readSnapshot(prod, id)!;
      expect(snap.state).toBe("pending");
      expect(snap.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS); // config-default budget from the bound context
      expect(snap.payload).toEqual({ a: 1 });

      // Idempotent re-enqueue on the SAME key returns the SAME id (never a second row).
      const again = prod.db.transaction(() => enqueue(prod.db, { workflow: "cap", idempotencyKey: "p", payload: { a: 1 } }))();
      expect(again).toBe(id);
      expect((prod.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(1);

      // A composition root may inject a config-driven default budget via productionEnqueueContext.
      bindEnqueueContext(prod.db, productionEnqueueContext({ defaultMaxAttempts: 3 }));
      const id2 = prod.db.transaction(() => enqueue(prod.db, { workflow: "cap", idempotencyKey: "p2", payload: {} }))();
      expect(readSnapshot(prod, id2)!.maxAttempts).toBe(3);
    } finally {
      prod.close();
    }
  });

  // ── finding 2: each finalizer requires EXACTLY ONE active attempt, else rolls back ──
  describe("finalizers assert the single active attempt (finding 2)", () => {
    /**
     * Drive `job-1` to: attempt 1 finalized `failed` (a STALE attempt) and attempt 2
     * freshly claimed `running` (the single ACTIVE attempt). A finalizer aimed at the
     * stale attempt (1) or a never-existed attempt (99) must roll back.
     */
    function jobWithStaleAttempt(): void {
      enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 5 }, "job-1");
      expect(claimNext(store.db, clock.now())!.attempt).toBe(1);
      scheduleRetry(store.db, "job-1", 1, clock.now(), "timeout", clock.now()); // attempt 1 → failed
      expect(claimNext(store.db, clock.now())!.attempt).toBe(2); // attempt 2 is now the active one
    }

    /** The active (attempt 2) row is still `running` and the job is still `running`. */
    function expectUntouched(): void {
      expect(readSnapshot(store, "job-1")!.state).toBe("running");
      const active = store.db
        .prepare(`SELECT outcome FROM job_attempts WHERE job_id = ? AND attempt_no = 2`)
        .get("job-1") as { outcome: string };
      expect(active.outcome).toBe("running");
    }

    for (const bad of [
      { label: "wrong (never-existed) attempt", attempt: 99 },
      { label: "stale (already-finalized) attempt", attempt: 1 },
    ] as const) {
      it(`completeJob rolls back for a ${bad.label} (no state flip, no effect)`, () => {
        store.db.exec(`CREATE TABLE fx1 (job_id TEXT PRIMARY KEY)`);
        jobWithStaleAttempt();
        expect(() =>
          completeJob(store.db, "job-1", bad.attempt, clock.now(), "fx:x", (tx) => {
            tx.prepare(`INSERT INTO fx1 (job_id) VALUES (?)`).run("job-1");
          }),
        ).toThrow(StaleAttemptError);
        // The mutable effect was NOT committed (validated before the effect ran).
        expect(store.db.prepare(`SELECT COUNT(*) AS n FROM fx1`).get()).toEqual({ n: 0 });
        expectUntouched();
      });

      it(`scheduleRetry rolls back for a ${bad.label}`, () => {
        jobWithStaleAttempt();
        expect(() => scheduleRetry(store.db, "job-1", bad.attempt, clock.now(), "timeout", clock.now())).toThrow(
          StaleAttemptError,
        );
        expectUntouched();
      });

      it(`failJob rolls back for a ${bad.label}`, () => {
        jobWithStaleAttempt();
        expect(() => failJob(store.db, "job-1", bad.attempt, clock.now(), "validation")).toThrow(StaleAttemptError);
        expectUntouched();
      });

      it(`cancelRunning rolls back for a ${bad.label}`, () => {
        jobWithStaleAttempt();
        expect(() => cancelRunning(store.db, "job-1", bad.attempt, clock.now())).toThrow(StaleAttemptError);
        expectUntouched();
      });
    }

    it("the CORRECT active attempt still finalizes normally after the guard", () => {
      jobWithStaleAttempt();
      completeJob(store.db, "job-1", 2, clock.now(), null); // attempt 2 is the active one
      expect(readSnapshot(store, "job-1")!.state).toBe("succeeded");
    });
  });

  // ── finding 1: the active-attempt guard also requires `finished_at IS NULL` ──
  // A logically FINISHED attempt (outcome still 'running' but finished_at set — a
  // malformed/stale row) must NOT pass the active-unfinished guard, transition the job,
  // or (for completeJob) let its effect commit.
  describe("finalizers reject a logically-finished (finished_at set) running attempt (finding 1)", () => {
    /** Claim attempt 1 (running), then corrupt it: outcome stays 'running' but finished_at is set. */
    function jobWithFinishedButRunningAttempt(): void {
      enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 5 }, "job-1");
      expect(claimNext(store.db, clock.now())!.attempt).toBe(1);
      store.db
        .prepare(`UPDATE job_attempts SET finished_at = @now WHERE job_id = 'job-1' AND attempt_no = 1`)
        .run({ now: clock.now() });
    }

    /** The job is still `running` and its (malformed) attempt row is untouched by the failed finalizer. */
    function expectRunning(): void {
      expect(readSnapshot(store, "job-1")!.state).toBe("running");
      const outcome = (
        store.db.prepare(`SELECT outcome FROM job_attempts WHERE job_id = 'job-1' AND attempt_no = 1`).get() as {
          outcome: string;
        }
      ).outcome;
      expect(outcome).toBe("running"); // still the malformed running row — the flip rolled back
    }

    it("completeJob rolls back (no state flip, no effect) for a finished-but-running attempt", () => {
      store.db.exec(`CREATE TABLE fx2 (job_id TEXT PRIMARY KEY)`);
      jobWithFinishedButRunningAttempt();
      expect(() =>
        completeJob(store.db, "job-1", 1, clock.now(), "fx:x", (tx) => {
          tx.prepare(`INSERT INTO fx2 (job_id) VALUES (?)`).run("job-1");
        }),
      ).toThrow(StaleAttemptError);
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM fx2`).get()).toEqual({ n: 0 });
      expectRunning();
    });

    it("scheduleRetry rolls back for a finished-but-running attempt", () => {
      jobWithFinishedButRunningAttempt();
      expect(() => scheduleRetry(store.db, "job-1", 1, clock.now(), "timeout", clock.now())).toThrow(StaleAttemptError);
      expectRunning();
    });

    it("failJob rolls back for a finished-but-running attempt", () => {
      jobWithFinishedButRunningAttempt();
      expect(() => failJob(store.db, "job-1", 1, clock.now(), "validation")).toThrow(StaleAttemptError);
      expectRunning();
    });

    it("cancelRunning rolls back for a finished-but-running attempt", () => {
      jobWithFinishedButRunningAttempt();
      expect(() => cancelRunning(store.db, "job-1", 1, clock.now())).toThrow(StaleAttemptError);
      expectRunning();
    });
  });

  // ── finding 2 (cancel race): a durable cancel intent committed before finalization is
  // arbitrated INSIDE the finalization transaction and wins over success/retry/failure ──
  describe("finalizers honor a durable cancel intent atomically (finding 2 — cancel race)", () => {
    /** Claim attempt 1 (running), then record a DURABLE cancel intent (as a separate `jobs cancel` would). */
    function runningWithDurableCancel(): void {
      enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 5 }, "job-1");
      expect(claimNext(store.db, clock.now())!.attempt).toBe(1);
      expect(cancelJob(store.db, "job-1", clock.now())).toBe("cancel-requested"); // durable intent for the running job
      expect(cancellationRequested(store.db, "job-1")).toBe(true);
    }

    /** The job is cancelled, the attempt row is `cancelled`, and the intent was consumed. */
    function expectCancelledAndConsumed(): void {
      expect(readSnapshot(store, "job-1")!.state).toBe("cancelled");
      const att = store.db
        .prepare(`SELECT outcome FROM job_attempts WHERE job_id = 'job-1' AND attempt_no = 1`)
        .get() as { outcome: string };
      expect(att.outcome).toBe("cancelled");
      expect(cancellationRequested(store.db, "job-1")).toBe(false); // intent consumed by the reconciling txn
    }

    it("completeJob honors the intent over success — effect never runs (success/effect race)", () => {
      store.db.exec(`CREATE TABLE fx3 (job_id TEXT PRIMARY KEY)`);
      runningWithDurableCancel();
      const done = completeJob(store.db, "job-1", 1, clock.now(), "fx:x", (tx) => {
        tx.prepare(`INSERT INTO fx3 (job_id) VALUES (?)`).run("job-1");
      });
      expect(done.cancelled).toBe(true);
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM fx3`).get()).toEqual({ n: 0 }); // effect never committed
      expectCancelledAndConsumed();
    });

    it("scheduleRetry honors the intent over a re-queue (failure/retry race)", () => {
      runningWithDurableCancel();
      const done = scheduleRetry(store.db, "job-1", 1, clock.now(), "timeout", clock.now());
      expect(done.cancelled).toBe(true);
      expectCancelledAndConsumed();
    });

    it("failJob honors the intent over a terminal failure (failure race)", () => {
      runningWithDurableCancel();
      const done = failJob(store.db, "job-1", 1, clock.now(), "validation");
      expect(done.cancelled).toBe(true);
      expectCancelledAndConsumed();
    });

    it("the runner reports `cancelled` when a cancel lands between the signal check and finalization", async () => {
      enq({ workflow: "cap", idempotencyKey: "late", payload: {} }, "job-late");
      // A handler that returns success WITHOUT observing the signal, but records the
      // durable cancel intent just before it returns — exactly the window the wing
      // flagged (cancel committed after the final signal check, before finalization).
      const handler: JobHandler = () => {
        cancelJob(store.db, "job-late", clock.now());
        return { sideEffectId: "capture:late" };
      };
      const r = await runAll(deps({ cap: handler }), { all: true });
      expect(r.items[0]!.outcome).toBe("cancelled"); // not succeeded — arbitrated at finalization
      expect(readSnapshot(store, "job-late")!.state).toBe("cancelled");
      expect(cancellationRequested(store.db, "job-late")).toBe(false);
    });
  });

  // ── finding 3: dead-runner recovery honors a durable cancel intent before budget handling ──
  it("recovery honors a durable cancel intent on a crashed FINAL-attempt job (finding 3 — no stranded intent)", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: {}, maxAttempts: 1 }, "job-1");
    // Crash injection: claim consumes the only attempt (attempts 1 == max_attempts), then "die".
    expect(claimNext(store.db, clock.now())!.attempt).toBe(1);
    // A separate `jobs cancel` records the durable intent while the (crashed) job is running.
    expect(cancelJob(store.db, "job-1", clock.now())).toBe("cancel-requested");

    // Without the finding-3 fix this at-budget job would recover to `failed` and strand the
    // intent forever; now recovery reconciles it to `cancelled` and consumes the intent.
    expect(recoverDeadRunners(store.db, clock.now())).toEqual(["job-1"]);
    expect(readSnapshot(store, "job-1")!.state).toBe("cancelled");
    expect(cancellationRequested(store.db, "job-1")).toBe(false);
    const att = store.db
      .prepare(`SELECT outcome, error_code FROM job_attempts WHERE job_id = 'job-1' AND attempt_no = 1`)
      .get() as { outcome: string; error_code: string };
    expect(att.outcome).toBe("failed"); // the attempt itself was genuinely interrupted
    expect(att.error_code).toBe("interrupted");

    // A subsequent drain has nothing to claim (the job is terminal cancelled).
    expect(claimNext(store.db, clock.now())).toBeNull();
    const r = await runAll(deps({ cap: () => ({}) }), { all: true });
    expect(r.items).toEqual([]);
  });
});
