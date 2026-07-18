/**
 * `repo.projection` (console watch SP-1, Phase 1 Task 2) — the jobs-list
 * projection refactored at its owner. Proves: `listJobs` rows carry `updatedAt`
 * and equal `projectJobListRow` of the raw row; `listAllJobs` returns the full
 * table past the 500 page cap in ONE consistent read; and the overlap assertion
 * — `listAllJobs` equals the concatenation of `listJobs` paginated across the
 * full range — so both entry points resolve through the one query builder and
 * cannot fork.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openJobsStore,
  bindEnqueueContext,
  enqueue,
  listAllJobs,
  listJobs,
  projectJobListRow,
  claimNext,
  failJob,
  type JobSpec,
  type JobsRawRow,
} from "../src/index.js";
import type { Store } from "@atlas/sqlite-store";

let store: Store;
let t: number;

beforeEach(() => {
  store = openJobsStore({ path: ":memory:" });
  t = Date.parse("2026-07-14T00:00:00.000Z");
});
afterEach(() => store.close());

/** Enqueue one job with a distinct id + monotonically advancing created/updated time. */
function enq(spec: JobSpec, jobId: string): string {
  const iso = new Date(t).toISOString();
  t += 1000; // distinct created_at per row ⇒ fully deterministic (created_at DESC) order
  bindEnqueueContext(store.db, { now: () => iso, nextJobId: () => jobId, defaultMaxAttempts: 5 });
  return store.db.transaction(() => enqueue(store.db, spec))();
}

/** A raw SELECT mirroring the builder's columns — for the projector-equality proof. */
function rawRows(): JobsRawRow[] {
  return store.db
    .prepare(
      `SELECT j.job_id, j.workflow, j.state, j.attempts, j.max_attempts, j.next_run_at, j.updated_at,
              (SELECT a.error_code FROM job_attempts a
                WHERE a.job_id = j.job_id AND a.error_code IS NOT NULL
                ORDER BY a.attempt_no DESC LIMIT 1) AS last_error
         FROM jobs j
         ORDER BY j.created_at DESC, j.job_id DESC`,
    )
    .all() as JobsRawRow[];
}

describe("jobs-list projection (SSOT at @atlas/jobs)", () => {
  it("listJobs rows carry updatedAt and equal projectJobListRow of the raw row", () => {
    enq({ workflow: "capture", idempotencyKey: "k1", payload: { a: 1 } }, "job-001");
    const { rows } = listJobs(store.db, { limit: 50, offset: 0 });
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!.updatedAt).toBe("string");
    expect(rows[0]!.updatedAt.length).toBeGreaterThan(0);
    // The public row is exactly projectJobListRow applied to the raw row.
    const expected = rawRows().map(projectJobListRow);
    expect(rows).toEqual(expected);
  });

  it("the shared projector OMITS null optionals — exact projected shape, reused field-for-field", () => {
    // A freshly-enqueued (pending) job has next_run_at set (backoff clock) but no
    // failed attempt, so `lastError` must be ABSENT (not null), and `updatedAt` and
    // `nextRunAt` present. This is the exact shape `watch` and `jobs list` both emit.
    enq({ workflow: "capture", idempotencyKey: "k-shape", payload: { a: 1 } }, "job-shape");
    const [row] = listAllJobs(store.db);
    expect(row).toBeDefined();
    // Exact key set — proves null-optional omission (no `lastError` key, no `null`).
    expect(Object.keys(row!).sort()).toEqual(
      ["attempts", "jobId", "maxAttempts", "nextRunAt", "state", "updatedAt", "workflow"].sort(),
    );
    expect("lastError" in row!).toBe(false);
    expect(row!.nextRunAt).toBeDefined();
    // Key ORDER matches the `jobs list --json` golden (…maxAttempts, nextRunAt?,
    // lastError?, updatedAt) — the additive `updatedAt` is APPENDED, nothing moved.
    expect(Object.keys(row!)).toEqual([
      "jobId",
      "workflow",
      "state",
      "attempts",
      "maxAttempts",
      "nextRunAt",
      "updatedAt",
    ]);
  });

  it("folds the latest attempt's error_code into lastError via the shared projector", async () => {
    enq({ workflow: "cap", idempotencyKey: "k", payload: {} }, "job-err");
    const now = new Date(t).toISOString();
    const claimed = claimNext(store.db, now);
    expect(claimed?.jobId).toBe("job-err");
    // Record a failed terminal attempt carrying a stable error_code.
    failJob(store.db, "job-err", claimed!.attempt, now, "transient");
    const all = listAllJobs(store.db);
    expect(all).toHaveLength(1);
    expect(all[0]!.lastError).toBe("transient");
  });

  it("listAllJobs returns all 600 jobs (past the 500 page cap) in one consistent read", () => {
    for (let i = 0; i < 600; i++) {
      enq({ workflow: "capture", idempotencyKey: `k-${i}`, payload: { i } }, `job-${String(i).padStart(4, "0")}`);
    }
    const all = listAllJobs(store.db);
    expect(all).toHaveLength(600);
    // Each equals projectJobListRow of the raw row (same builder, same shape).
    expect(all).toEqual(rawRows().map(projectJobListRow));
  });

  it("overlap: listAllJobs equals the concatenation of listJobs paginated across the full range", () => {
    for (let i = 0; i < 600; i++) {
      enq({ workflow: "capture", idempotencyKey: `k-${i}`, payload: { i } }, `job-${String(i).padStart(4, "0")}`);
    }
    const all = listAllJobs(store.db);

    const paged: typeof all = [];
    const pageSize = 500; // the CLI page cap
    for (let offset = 0; offset < all.length; offset += pageSize) {
      const { rows } = listJobs(store.db, { limit: pageSize, offset });
      paged.push(...rows);
    }
    // Identical rows, identical order — proving neither reader forked the SELECT.
    expect(paged).toEqual(all);
  });
});
