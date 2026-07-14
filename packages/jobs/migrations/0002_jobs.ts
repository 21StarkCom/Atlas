/**
 * `0002_jobs` — the jobs-queue migration owned **solely** by `@atlas/jobs`
 * (plan §2.7 / D5). Creates the two queue tables — `jobs` (per-`(workflow,
 * idempotency_key)` unique work rows + durable payload) and `job_attempts`
 * (one finalized-in-place row per attempt).
 *
 * ## Ownership + discovery (plan §2.7, Review-Hint)
 * `@atlas/sqlite-store` owns `0001_core`/`0003`/`0004` and pre-registers them in
 * `openStore`; it does NOT register `0002`. Instead the CLI composition root that
 * opens a jobs store calls {@link registerJobsMigration} (`Store.registerMigration`)
 * BEFORE `Store.migrate()`, so `db migrate` discovers `0002` through the normal
 * checksum-guarded, gap-tolerant runner — there is no undiscoverable migration.
 * This is the FEATURE half of the plan's retained-vs-feature split (the exact
 * pattern `0006_workflow_idempotency` uses for the workflows layer).
 *
 * ## Gap tolerance
 * `0003_provenance` (retained PR-A) can land BEFORE this feature PR-B, so a DB may
 * already have `0003` applied when `0002` is first registered. The gap-tolerant
 * runner (Task 1.4) applies the registered-but-unapplied set by id order and never
 * assumes contiguous numbering — do NOT renumber.
 *
 * Every `CREATE TABLE`/`CREATE INDEX` below is copied **VERBATIM** from
 * `docs/specs/sqlite-data-dictionary.md` §4 (dictionary §0 binding conventions),
 * including the two Task-2.7 columns the orchestrator decided:
 *   1. nullable `job_attempts.side_effect_id` — transactional side-effect id for
 *      mutable Phase-4 effects (NULL for content-addressed Phase-2 effects);
 *   2. `jobs.payload` NOT NULL — the durable canonical-JSON work payload verified
 *      against `payload_hash` on read, so startup recovery reconstructs work from
 *      the row itself (`raw_payloads` is deferred out of V1, default off).
 */
import type { Migration } from "@atlas/sqlite-store";
import { migrationChecksum } from "@atlas/sqlite-store";

/** The verbatim jobs DDL (dictionary §4), in FK-dependency-safe order. */
export const JOBS_DDL = `CREATE TABLE jobs (
  job_id           TEXT    NOT NULL PRIMARY KEY,
  workflow         TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  state            TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 1,
  lease_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),  -- reserved fencing token (design; multi-worker leases deferred post-V1)
  next_run_at      TEXT,                                  -- eligibility time; null => not scheduled
  payload          TEXT    NOT NULL,                      -- durable canonical-JSON work payload (Task 2.7 decision 2)
  payload_hash     TEXT    NOT NULL,                      -- sha256(canonicalSerialize(payload)); verified against payload on read
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  UNIQUE (workflow, idempotency_key)
) STRICT;

CREATE INDEX idx_jobs_eligibility ON jobs(state, next_run_at);

CREATE TABLE job_attempts (
  job_id          TEXT    NOT NULL,
  attempt_no      INTEGER NOT NULL,
  outcome         TEXT    NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed', 'cancelled')),
  error_code      TEXT,
  side_effect_id  TEXT,                                   -- transactional side-effect id (Task 2.7 decision 1); NULL for content-addressed effects
  started_at      TEXT    NOT NULL,
  finished_at     TEXT,
  PRIMARY KEY (job_id, attempt_no),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
) STRICT;`;

/** The `0002_jobs` migration (id, checksum over {@link JOBS_DDL}, `up`). */
export const migration0002Jobs: Migration = {
  id: "0002_jobs",
  checksum: migrationChecksum(JOBS_DDL),
  up(db) {
    db.exec(JOBS_DDL);
  },
};
