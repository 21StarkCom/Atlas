/**
 * `0007_job_cancellations` — the DURABLE cross-process cancel-intent table
 * (Task 2.7 / finding 3), owned by `@atlas/jobs` alongside `0002_jobs`.
 *
 * ## Why a durable table (finding 3)
 * `jobs cancel <runningJob>` and the draining `jobs run` are SEPARATE processes.
 * Recording the cancel intent only on the filesystem AFTER the cancel commit left a
 * crash/marker-write-failure window in which a `cancel-requested` success was
 * committed + published with NOTHING observable to actually stop the job — and
 * replay returned the published result before any repair could run. Persisting the
 * intent HERE lets `jobs cancel` write it ATOMICALLY inside the same transaction that
 * commits the idempotency result (see `cancelJob`), and lets the runner observe it
 * from DURABLE state (a SQLite poll) rather than only a filesystem marker. A crash
 * after commit therefore leaves the intent durably recorded — the next drain observes
 * it and reconciles the job to `cancelled`.
 *
 * `0002_jobs` is intentionally left untouched (its DDL is a fixed orchestrator
 * decision); this is an ADDITIVE jobs-owned migration discovered through the same
 * `registerJobsMigration` composition-root seam (gap-tolerant runner, Task 1.4).
 */
import type { Migration } from "@atlas/sqlite-store";
import { migrationChecksum } from "@atlas/sqlite-store";

/** The durable cancel-intent DDL: one row per job with an outstanding cancel request. */
export const JOB_CANCELLATIONS_DDL = `CREATE TABLE job_cancellations (
  job_id        TEXT NOT NULL PRIMARY KEY,
  requested_at  TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
) STRICT;`;

/** The `0007_job_cancellations` migration (id, checksum over the DDL, `up`). */
export const migration0007JobCancellations: Migration = {
  id: "0007_job_cancellations",
  checksum: migrationChecksum(JOB_CANCELLATIONS_DDL),
  up(db) {
    db.exec(JOB_CANCELLATIONS_DDL);
  },
};
