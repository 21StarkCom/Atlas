/**
 * `@atlas/jobs` repository — the queue's transactional core (jobs-contract.md).
 *
 * This module is the SOLE writer of `jobs`/`job_attempts` (plan §2.5 module
 * discipline); `sqlite-store` consumes the queue read-only via {@link readSnapshot}.
 * It owns: idempotent `enqueue`, the atomic single-runner claim (`pending → running`
 * in one transaction), the legal state transitions (contract §1), the exponential
 * full-jitter backoff (contract §3, deterministic in `(jobId, attemptNo)`), the
 * retry classification (contract §2), and durable-payload verification (Task 2.7
 * decision 2 — `payload_hash` re-checked on every read).
 *
 * Every mutation is a `better-sqlite3` IMMEDIATE transaction so the claim's
 * `pending → running` flip + its `job_attempts` insert land atomically and two
 * writers serialize on the SQLite write lock rather than racing a claim.
 */
import { createHash } from "node:crypto";
import { canonicalSerialize, canonicalStringify } from "@atlas/contracts";
import type { SqliteDatabase, Store } from "@atlas/sqlite-store";

/** The closed job-state set (contract §1 / dictionary §4 CHECK). */
export type JobState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** Per-attempt outcome (dictionary §4 CHECK). */
export type AttemptOutcome = "running" | "succeeded" | "failed" | "cancelled";

/** Retry classification of an attempt failure (contract §2). */
export type RetryClass = "transient" | "permanent" | "cancelled";

/** A transaction handle: a `SqliteDatabase` used INSIDE an active `db.transaction`. */
export type LedgerTx = SqliteDatabase;

/** A job's opaque identity (the `jobs.job_id` primary key). */
export type JobId = string;

/**
 * The caller's enqueue spec (plan Task 2.7 interface). `payload` is the durable,
 * allowlisted work payload; it is persisted canonically and hash-verified on read.
 */
export interface JobSpec {
  readonly workflow: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  /** Per-job attempt budget; falls back to `defaultMaxAttempts` when unset. */
  readonly maxAttempts?: number;
}

/**
 * The injected repository context that supplies {@link enqueue}'s non-deterministic
 * seams — the clock, the id generator, and the configured default attempt budget —
 * WITHOUT leaking them into the plan's 2-arg public signature (`enqueue(tx, job):
 * JobId`, plan §2.7 Produces). The context is bound to a connection with
 * {@link bindEnqueueContext} (a connection-scoped seam: the CLI composition root binds
 * a real clock + id generator + `jobs.max_attempts`; tests bind deterministic ones), so
 * `enqueue` stays a free function that takes only `(tx, job)`.
 */
export interface EnqueueContext {
  /** RFC-3339 UTC clock for `created_at`/`updated_at` (evaluated per enqueue). */
  now(): string;
  /** Mint the id for a freshly-inserted row (unique; unused on idempotent conflict). */
  nextJobId(): JobId;
  /** Attempt budget used when `JobSpec.maxAttempts` is unset. */
  readonly defaultMaxAttempts: number;
}

/** The public read projection (`sqlite-store` consumers use this one-way API). */
export interface JobSnapshot {
  readonly jobId: string;
  readonly workflow: string;
  readonly idempotencyKey: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseEpoch: number;
  readonly nextRunAt: string | null;
  /** The durable payload, hash-verified against `payload_hash` before return. */
  readonly payload: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Stable classification of the latest attempt failure, if any. */
  readonly lastError: string | null;
}

/** The raw `jobs` row shape. */
interface JobRow {
  job_id: string;
  workflow: string;
  idempotency_key: string;
  state: JobState;
  attempts: number;
  max_attempts: number;
  lease_epoch: number;
  next_run_at: string | null;
  payload: string;
  payload_hash: string;
  created_at: string;
  updated_at: string;
}

/** Raised when a persisted payload fails its `payload_hash` check (corruption/tamper). */
export class PayloadIntegrityError extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId}: payload_hash does not match the stored payload (corruption or tampering)`);
    this.name = "PayloadIntegrityError";
  }
}

/** Raised when a state transition not in the contract §1 table is attempted. */
export class IllegalTransitionError extends Error {
  constructor(readonly jobId: string, from: string, to: string) {
    super(`job ${jobId}: illegal transition ${from} → ${to} (not in the jobs-contract §1 table)`);
    this.name = "IllegalTransitionError";
  }
}

/** Normative bounded-attempt range (jobs-contract.md §2): an integer in [1, 20]. */
export const MAX_ATTEMPTS_MIN = 1;
export const MAX_ATTEMPTS_MAX = 20;

/**
 * Raised when a `maxAttempts` value is outside the normative `[1, 20]` integer
 * range (jobs-contract §2). Zero/negative would create a permanently-unclaimable
 * pending job (the claim guard needs `attempts < max_attempts`); fractional or
 * oversized values violate the bounded-attempt contract.
 */
export class MaxAttemptsRangeError extends Error {
  constructor(readonly value: number, source: string) {
    super(
      `${source} must be an integer in [${MAX_ATTEMPTS_MIN}, ${MAX_ATTEMPTS_MAX}] (jobs-contract §2); got ${value}`,
    );
    this.name = "MaxAttemptsRangeError";
  }
}

/** Raised when a mutable `commit` effect is supplied without a non-empty `side_effect_id`. */
export class SideEffectIdRequiredError extends Error {
  constructor(readonly jobId: string) {
    super(
      `job ${jobId}: a mutable commit effect requires a non-empty side_effect_id (Task 2.7 decision 1) — a committed effect must never record a NULL id`,
    );
    this.name = "SideEffectIdRequiredError";
  }
}

/** Raised when {@link enqueue} runs on a connection with no bound {@link EnqueueContext}. */
export class EnqueueContextRequiredError extends Error {
  constructor() {
    super(
      `enqueue: no EnqueueContext bound for this connection — call bindEnqueueContext(tx, ctx) at the composition root (or in a test) before enqueueing`,
    );
    this.name = "EnqueueContextRequiredError";
  }
}

/**
 * Raised when a finalizer's supplied `attempt` does NOT identify the single active
 * (unfinished, `outcome = 'running'`) attempt — the attempt UPDATE affected a number
 * of rows other than exactly one. Rolls the finalization back so a stale/wrong attempt
 * number can never transition the job (nor commit a side effect) against the real,
 * still-`running` attempt.
 */
export class StaleAttemptError extends Error {
  constructor(readonly jobId: string, attempt: number, affected: number) {
    super(
      `job ${jobId}: attempt ${attempt} is not the single active (running) attempt — the attempt update affected ${affected} rows, expected exactly 1; finalization rolled back`,
    );
    this.name = "StaleAttemptError";
  }
}

/**
 * The connection-scoped {@link EnqueueContext} registry (finding 1). Keyed by the
 * `better-sqlite3` connection object (the `tx` handle IS the connection), so a context
 * bound on a store is visible to every `enqueue(tx, job)` on that same connection. A
 * `WeakMap` lets the context be GC'd with its connection — no global mutable singleton.
 */
const enqueueContexts = new WeakMap<object, EnqueueContext>();

/**
 * Bind the injected {@link EnqueueContext} for a connection so a subsequent
 * `enqueue(tx, job)` on it resolves the clock / id generator / default budget without
 * the seams appearing in the public signature (finding 1). Idempotent per connection —
 * a later call replaces the binding (tests rebind per enqueue to assign a specific id).
 */
export function bindEnqueueContext(tx: LedgerTx, ctx: EnqueueContext): void {
  enqueueContexts.set(tx, ctx);
}

/** Assert a `maxAttempts` value is an integer within the normative `[1, 20]` range. */
export function assertMaxAttempts(value: number, source: string): void {
  if (!Number.isInteger(value) || value < MAX_ATTEMPTS_MIN || value > MAX_ATTEMPTS_MAX) {
    throw new MaxAttemptsRangeError(value, source);
  }
}

/** `sha256(canonicalSerialize(payload))` — the stored + verified payload hash. */
export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalSerialize(payload)).digest("hex");
}

/** Verify + parse a row's durable payload (Task 2.7 decision 2). */
function decodePayload(row: JobRow): unknown {
  const payload = JSON.parse(row.payload) as unknown;
  if (payloadHash(payload) !== row.payload_hash) throw new PayloadIntegrityError(row.job_id);
  return payload;
}

/**
 * Enqueue a job idempotently per `(workflow, idempotency_key)` (contract §7). The
 * `UNIQUE (workflow, idempotency_key)` + `ON CONFLICT DO NOTHING` make a duplicate
 * enqueue return the EXISTING `jobId` (never a second row). Must be called inside an
 * active `db.transaction` (the `tx` handle IS the connection).
 */
export function enqueue(tx: LedgerTx, job: JobSpec): JobId {
  const ctx = enqueueContexts.get(tx);
  if (ctx === undefined) throw new EnqueueContextRequiredError();
  // Enforce the normative `[1, 20]` bound (contract §2) on BOTH the per-job override
  // and the configured default BEFORE the row is written — a zero/negative bound would
  // wedge the job permanently unclaimable, a fractional/oversized one breaks the
  // bounded-attempt contract.
  if (job.maxAttempts !== undefined) assertMaxAttempts(job.maxAttempts, "JobSpec.maxAttempts");
  assertMaxAttempts(ctx.defaultMaxAttempts, "EnqueueContext.defaultMaxAttempts");
  const now = ctx.now();
  const jobId = ctx.nextJobId();
  const payloadJson = canonicalStringify(job.payload);
  const hash = payloadHash(job.payload);
  const maxAttempts = job.maxAttempts ?? ctx.defaultMaxAttempts;
  tx.prepare(
    `INSERT INTO jobs
       (job_id, workflow, idempotency_key, state, attempts, max_attempts, lease_epoch,
        next_run_at, payload, payload_hash, created_at, updated_at)
     VALUES
       (@job_id, @workflow, @idempotency_key, 'pending', 0, @max_attempts, 0,
        @now, @payload, @payload_hash, @now, @now)
     ON CONFLICT (workflow, idempotency_key) DO NOTHING`,
  ).run({
    job_id: jobId,
    workflow: job.workflow,
    idempotency_key: job.idempotencyKey,
    max_attempts: maxAttempts,
    now,
    payload: payloadJson,
    payload_hash: hash,
  });
  // Return the surviving row's id (the new row, or the pre-existing one on conflict).
  const existing = tx
    .prepare(`SELECT job_id FROM jobs WHERE workflow = ? AND idempotency_key = ?`)
    .get(job.workflow, job.idempotencyKey) as { job_id: string };
  return existing.job_id;
}

/** Read the hash-verified public snapshot of a job (or null if absent). */
export function readSnapshot(store: Store, id: string): JobSnapshot | null {
  const row = store.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(id) as JobRow | undefined;
  if (!row) return null;
  return toSnapshot(row, decodePayload(row), lastError(store.db, id));
}

function toSnapshot(row: JobRow, payload: unknown, lastErr: string | null): JobSnapshot {
  return {
    jobId: row.job_id,
    workflow: row.workflow,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseEpoch: row.lease_epoch,
    nextRunAt: row.next_run_at,
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: lastErr,
  };
}

/** The stable classification (`error_code`) of a job's latest failed/cancelled attempt. */
function lastError(db: SqliteDatabase, jobId: string): string | null {
  const r = db
    .prepare(
      `SELECT error_code FROM job_attempts
        WHERE job_id = ? AND error_code IS NOT NULL
        ORDER BY attempt_no DESC LIMIT 1`,
    )
    .get(jobId) as { error_code: string } | undefined;
  return r?.error_code ?? null;
}

/** A claimed job handed to the runner for execution. */
export interface ClaimedJob {
  readonly jobId: string;
  readonly workflow: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly payload: unknown;
}

/**
 * Atomically claim the next eligible job (`pending`, `next_run_at ≤ now`, AND
 * `attempts < max_attempts`), flipping it `pending → running` and recording a fresh
 * `job_attempts` row (`outcome = 'running'`). Deterministic order `(next_run_at,
 * jobId)` (index-backed). Increments `attempts` so the running row has already
 * consumed one of its budget (a crash then costs exactly that attempt — contract §6).
 * Returns null when nothing is eligible.
 *
 * ## Attempt-budget guard (contract §2 / §6 — fixes the `maxAttempts+1` execution)
 * The `attempts < max_attempts` predicate is the SINGLE enforcement point for the
 * bounded-attempt budget: a job that has already consumed its budget is NEVER
 * claimable, so neither a manual `jobs retry` after exhaustion nor dead-runner
 * recovery of a crash on the final attempt can execute a `maxAttempts+1` attempt.
 * `jobs retry` re-enables an exhausted job by resetting `attempts` to 0 (a fresh
 * budget, {@link retryJob}); recovery drives an at-budget interrupted job terminal
 * rather than re-queuing it ({@link recoverDeadRunners}).
 *
 * When `only` is set, claims THAT job iff it is eligible (single-`<jobId>` drain);
 * returns null otherwise (the caller reports `skipped:state-changed`).
 *
 * `exclude` (a set of job ids) is subtracted from the eligible set so a single drain
 * never re-claims a job it already processed this invocation — the runner passes the
 * ids it has claimed, so a zero-backoff retry (`next_run_at = now`) rescheduled inside
 * the same drain is not re-selected (each job claimed at most once per invocation,
 * contract §5 — fixes the zero-delay re-drain).
 */
export function claimNext(
  db: SqliteDatabase,
  now: string,
  only?: string,
  exclude?: ReadonlySet<string>,
): ClaimedJob | null {
  // Named placeholders for the exclusion set (better-sqlite3 forbids mixing `?`
  // anonymous params with the `@named` params this statement already uses).
  const excluded = exclude && exclude.size > 0 ? [...exclude] : [];
  const excludeParams: Record<string, string> = {};
  excluded.forEach((id, i) => (excludeParams[`ex${i}`] = id));
  const notIn = excluded.length > 0 ? `AND job_id NOT IN (${excluded.map((_, i) => `@ex${i}`).join(", ")})` : "";
  const tx = db.transaction((): ClaimedJob | null => {
    const row = (
      only === undefined
        ? db
            .prepare(
              `SELECT * FROM jobs
                WHERE state = 'pending' AND (next_run_at IS NULL OR next_run_at <= @now)
                  AND attempts < max_attempts ${notIn}
                ORDER BY next_run_at IS NULL DESC, next_run_at ASC, job_id ASC
                LIMIT 1`,
            )
            .get({ now, ...excludeParams })
        : db
            .prepare(
              `SELECT * FROM jobs
                WHERE job_id = @id AND state = 'pending'
                  AND (next_run_at IS NULL OR next_run_at <= @now)
                  AND attempts < max_attempts`,
            )
            .get({ id: only, now })
    ) as JobRow | undefined;
    if (!row) return null;

    const payload = decodePayload(row); // hash-verify BEFORE we mark it running
    const attempt = row.attempts + 1;
    db.prepare(
      `UPDATE jobs SET state = 'running', attempts = @attempt, updated_at = @now WHERE job_id = @id`,
    ).run({ attempt, now, id: row.job_id });
    db.prepare(
      `INSERT INTO job_attempts (job_id, attempt_no, outcome, error_code, side_effect_id, started_at, finished_at)
       VALUES (@id, @attempt, 'running', NULL, NULL, @now, NULL)`,
    ).run({ id: row.job_id, attempt, now });
    return { jobId: row.job_id, workflow: row.workflow, attempt, maxAttempts: row.max_attempts, payload };
  });
  return tx.immediate();
}

/**
 * A mutable SQLite side effect committed ATOMICALLY with a job's terminal state
 * (Task 2.7 decision 1). The runner hands {@link completeJob} the closure INSTEAD of
 * applying the effect itself, so the effect, its `side_effect_id`, and the
 * `running → succeeded` flip land in ONE transaction — never two.
 */
export type JobEffect = (tx: LedgerTx) => void;

/**
 * The outcome of a finalizer ({@link completeJob} / {@link scheduleRetry} /
 * {@link failJob}). `cancelled` is true when a DURABLE cancel intent (finding 2) was
 * observed INSIDE the finalization transaction and honored — the job was driven
 * `running → cancelled` instead of the requested success/retry/failure, and NO mutable
 * effect ran. The runner reports the item as `cancelled` in that case.
 */
export interface FinalizeResult {
  readonly cancelled: boolean;
}

/**
 * Arbitrate a durable cancel intent (finding 2) INSIDE a finalization transaction,
 * BEFORE any mutable effect or success/retry/failure state change. If `jobId` has a
 * durable cancel intent in `job_cancellations`, finalize its single active attempt as
 * `cancelled`, drive the job `running → cancelled`, and CONSUME the intent — all in the
 * caller's IMMEDIATE transaction. Returns whether cancellation was honored; a false
 * return means the caller proceeds with its normal finalization.
 *
 * Consuming the intent ONLY here (never unconditionally when the runner unregisters an
 * attempt) closes the race the wing flagged: a cancel committed after the handler's
 * final signal check but before finalization is still observed — the finalizer sees the
 * durable row and honors it rather than publishing an unobservable success. The attempt
 * UPDATE is guarded on the single active (`outcome = 'running'`, unfinished) attempt, so
 * a stale/wrong `attempt` rolls the whole transaction back and does NOT consume the
 * intent — cancellation is only reconciled against the real running attempt.
 */
function arbitrateCancellation(db: SqliteDatabase, jobId: string, attempt: number, now: string): boolean {
  if (!cancellationRequested(db, jobId)) return false;
  finalizeActiveAttempt(jobId, attempt, () =>
    db
      .prepare(
        `UPDATE job_attempts SET outcome = 'cancelled', error_code = 'cancelled', finished_at = @now
          WHERE job_id = @id AND attempt_no = @attempt AND outcome = 'running' AND finished_at IS NULL`,
      )
      .run({ now, id: jobId, attempt }),
  );
  db.prepare(`UPDATE jobs SET state = 'cancelled', next_run_at = NULL, updated_at = @now WHERE job_id = @id`).run({
    now,
    id: jobId,
  });
  clearCancellation(db, jobId);
  return true;
}

/**
 * Finalize a running attempt as `succeeded` and flip the job terminal
 * (`running → succeeded`). `sideEffectId` (Task 2.7 decision 1) is recorded on the
 * attempt row in the SAME transaction as the state flip.
 *
 * ## Crash-idempotent mutable effects (fixes the effect-before-record window)
 * When `effect` is supplied it is executed INSIDE this same IMMEDIATE transaction,
 * BEFORE the attempt row + terminal flip are written. A mutable SQLite side effect
 * (evidence re-verification status, backup pruning, quarantine expiry — Phase-4)
 * therefore commits atomically with its `side_effect_id`: a crash cannot leave the
 * effect applied without the recorded id (or vice-versa). If `effect` throws, the
 * whole transaction rolls back — the job stays `running` (recovered later) and NO
 * partial effect is durable. A content-addressed Phase-2 effect passes no `effect`
 * (and a NULL `sideEffectId`), relying on content-addressing (contract §7).
 */
export function completeJob(
  db: SqliteDatabase,
  jobId: string,
  attempt: number,
  now: string,
  sideEffectId: string | null,
  effect?: JobEffect,
): FinalizeResult {
  // Repository-boundary invariant (finding 5): a mutable side effect MUST carry a
  // non-empty `side_effect_id`. Committing an effect while recording NULL would make
  // the effect non-idempotent under crash recovery — reject it before any write.
  if (effect !== undefined && (sideEffectId === null || sideEffectId.length === 0)) {
    throw new SideEffectIdRequiredError(jobId);
  }
  return db.transaction((): FinalizeResult => {
    assertState(db, jobId, "running", "succeeded");
    // Finding 2 (cancel race): a cancel committed after the handler's final signal check
    // but before this finalization is honored HERE, in the same IMMEDIATE transaction,
    // BEFORE the mutable effect or the success flip. When honored the job is driven
    // `cancelled` and the intent consumed — the effect never runs and no unobservable
    // success is published.
    if (arbitrateCancellation(db, jobId, attempt, now)) return { cancelled: true };
    // Finding 2 (stale attempt): assert the supplied attempt IS the single active
    // attempt and finalize it — BEFORE the effect runs — so a stale/wrong attempt rolls
    // the whole transaction back (no effect committed, job stays `running`) rather than
    // committing a mutable side effect against an attempt that is not the running one.
    finalizeActiveAttempt(jobId, attempt, () =>
      db
        .prepare(
          `UPDATE job_attempts SET outcome = 'succeeded', side_effect_id = @sid, finished_at = @now
            WHERE job_id = @id AND attempt_no = @attempt AND outcome = 'running' AND finished_at IS NULL`,
        )
        .run({ sid: sideEffectId, now, id: jobId, attempt }),
    );
    if (effect) effect(db); // mutable SQLite effect INSIDE the terminal txn
    db.prepare(`UPDATE jobs SET state = 'succeeded', next_run_at = NULL, updated_at = @now WHERE job_id = @id`).run({
      now,
      id: jobId,
    });
    return { cancelled: false };
  }).immediate();
}

/**
 * Finalize a running attempt as `failed` and re-queue the job for a later retry
 * (`running → pending`, contract §1 `retry-scheduled`). `nextRunAt` is the backoff
 * eligibility time (contract §3). Used only while the attempt budget remains.
 */
export function scheduleRetry(
  db: SqliteDatabase,
  jobId: string,
  attempt: number,
  now: string,
  errorCode: string,
  nextRunAt: string,
): FinalizeResult {
  return db.transaction((): FinalizeResult => {
    assertState(db, jobId, "running", "pending");
    // Finding 2 (cancel race): honor a durable cancel intent over a re-queue — a cancel
    // requested while the attempt was in flight wins, so the job is cancelled (not
    // rescheduled) even when the attempt happened to fail transiently.
    if (arbitrateCancellation(db, jobId, attempt, now)) return { cancelled: true };
    finalizeActiveAttempt(jobId, attempt, () =>
      db
        .prepare(
          `UPDATE job_attempts SET outcome = 'failed', error_code = @code, finished_at = @now
            WHERE job_id = @id AND attempt_no = @attempt AND outcome = 'running' AND finished_at IS NULL`,
        )
        .run({ code: errorCode, now, id: jobId, attempt }),
    );
    db.prepare(`UPDATE jobs SET state = 'pending', next_run_at = @next, updated_at = @now WHERE job_id = @id`).run({
      next: nextRunAt,
      now,
      id: jobId,
    });
    return { cancelled: false };
  }).immediate();
}

/**
 * Finalize a running attempt as `failed` and drive the job terminal
 * (`running → failed`, contract §1 `attempts-exhausted` / `permanent-error`).
 */
export function failJob(
  db: SqliteDatabase,
  jobId: string,
  attempt: number,
  now: string,
  errorCode: string,
): FinalizeResult {
  return db.transaction((): FinalizeResult => {
    assertState(db, jobId, "running", "failed");
    // Finding 2 (cancel race): a cancel requested while the attempt was in flight is
    // honored over a terminal failure — the job is cancelled, not failed.
    if (arbitrateCancellation(db, jobId, attempt, now)) return { cancelled: true };
    finalizeActiveAttempt(jobId, attempt, () =>
      db
        .prepare(
          `UPDATE job_attempts SET outcome = 'failed', error_code = @code, finished_at = @now
            WHERE job_id = @id AND attempt_no = @attempt AND outcome = 'running' AND finished_at IS NULL`,
        )
        .run({ code: errorCode, now, id: jobId, attempt }),
    );
    db.prepare(`UPDATE jobs SET state = 'failed', next_run_at = NULL, updated_at = @now WHERE job_id = @id`).run({
      now,
      id: jobId,
    });
    return { cancelled: false };
  }).immediate();
}

/**
 * Finalize a running attempt as `cancelled` and drive the job terminal
 * (`running → cancelled`, contract §1 `cancel-observed`).
 */
export function cancelRunning(db: SqliteDatabase, jobId: string, attempt: number, now: string): void {
  db.transaction(() => {
    assertState(db, jobId, "running", "cancelled");
    finalizeActiveAttempt(jobId, attempt, () =>
      db
        .prepare(
          `UPDATE job_attempts SET outcome = 'cancelled', error_code = 'cancelled', finished_at = @now
            WHERE job_id = @id AND attempt_no = @attempt AND outcome = 'running' AND finished_at IS NULL`,
        )
        .run({ now, id: jobId, attempt }),
    );
    db.prepare(`UPDATE jobs SET state = 'cancelled', next_run_at = NULL, updated_at = @now WHERE job_id = @id`).run({
      now,
      id: jobId,
    });
    // Consume any durable cancel intent in the SAME transaction that reconciles the job
    // to `cancelled` (finding 2): the intent is cleared only when cancellation is durably
    // honored, never unconditionally on the runner's attempt unregister.
    clearCancellation(db, jobId);
  }).immediate();
}

/** The result of a {@link cancelJob} (mirrors the CLI `jobs cancel` outcomes). */
export type CancelOutcome = "cancelled" | "cancel-requested" | "already-terminal" | "not-found";

/**
 * Cancel a job by id (the `jobs cancel` operational path). A `pending` job is driven
 * terminal directly (`pending → cancelled`); a `running` job is `cancel-requested` and
 * its cancel intent is recorded DURABLY in `job_cancellations` in THIS same transaction
 * (finding 3) so the draining runner observes it from durable state — not only a
 * filesystem marker — and reconciles the job to `cancelled` cooperatively via its
 * `AbortSignal` at a checkpoint (contract §1); a terminal job is `already-terminal`; an
 * unknown id is `not-found`.
 *
 * Because the intent INSERT lands in the same transaction the caller uses to commit the
 * idempotency result, a `cancel-requested` success is never published without its
 * durable intent: a crash (or a downstream marker-write failure) can no longer leave a
 * replayable success with nothing observable to stop the job.
 */
export function cancelJob(db: SqliteDatabase, jobId: string, now: string): CancelOutcome {
  const tx = db.transaction((): CancelOutcome => {
    const row = db.prepare(`SELECT state FROM jobs WHERE job_id = ?`).get(jobId) as { state: JobState } | undefined;
    if (!row) return "not-found";
    if (row.state === "pending") {
      db.prepare(`UPDATE jobs SET state = 'cancelled', next_run_at = NULL, updated_at = @now WHERE job_id = @id`).run({
        now,
        id: jobId,
      });
      return "cancelled";
    }
    if (row.state === "running") {
      db.prepare(
        `INSERT INTO job_cancellations (job_id, requested_at) VALUES (@id, @now)
           ON CONFLICT (job_id) DO UPDATE SET requested_at = @now`,
      ).run({ id: jobId, now });
      return "cancel-requested";
    }
    return "already-terminal";
  });
  return tx.immediate();
}

/**
 * Whether a durable cancel intent (finding 3) is recorded for `jobId`. The runner polls
 * this from durable state — the intent survives a crash of the process that requested it,
 * so a subsequent drain still observes it and reconciles the job to `cancelled`.
 */
export function cancellationRequested(db: SqliteDatabase, jobId: string): boolean {
  return db.prepare(`SELECT 1 FROM job_cancellations WHERE job_id = ?`).get(jobId) !== undefined;
}

/**
 * Clear a job's durable cancel intent (finding 3). Called when the attempt that observed
 * (or could have observed) the intent finishes, so a stale intent cannot cancel an
 * unrelated future claim of the same job id.
 */
export function clearCancellation(db: SqliteDatabase, jobId: string): void {
  db.prepare(`DELETE FROM job_cancellations WHERE job_id = ?`).run(jobId);
}

/** The result of a {@link retryJob} (mirrors the CLI `jobs retry` outcomes). */
export type RetryOutcome = "requeued" | "not-failed" | "not-found";

/**
 * Re-queue a `failed` job (`failed → pending`, contract §1 `jobs-retry`): backoff
 * cleared (`next_run_at = now`), attempt count PRESERVED, and — iff the budget is
 * exhausted — GRANTED one further attempt (`max_attempts = attempts + 1`). A
 * non-failed job is `not-failed`; an unknown id is `not-found`.
 *
 * ## Budget grant (contract §2/§4 — fixes the exhausted-retry `maxAttempts+1`)
 * `jobs retry` is the explicit operator re-drive of a terminal `failed` job. Because
 * {@link claimNext} refuses any job with `attempts >= max_attempts`, an EXHAUSTED job
 * would stay un-claimable — so retry raises `max_attempts` to `attempts + 1`, granting
 * exactly one further attempt (a job that failed with budget still remaining, e.g. a
 * `permanent` error, keeps its larger budget — `MAX(max_attempts, attempts + 1)`).
 * `attempts` is preserved so the retained `job_attempts` history keeps monotonically
 * increasing, collision-free `attempt_no`s (contract §4); the re-run is claimed as
 * `attempts + 1`, always within the (now-current) budget — never an uncontrolled
 * `maxAttempts+1` execution beyond a budget the operator did not extend.
 */
export function retryJob(db: SqliteDatabase, jobId: string, now: string): RetryOutcome {
  const tx = db.transaction((): RetryOutcome => {
    const row = db.prepare(`SELECT state FROM jobs WHERE job_id = ?`).get(jobId) as { state: JobState } | undefined;
    if (!row) return "not-found";
    if (row.state !== "failed") return "not-failed";
    db.prepare(
      `UPDATE jobs
          SET state = 'pending',
              max_attempts = MAX(max_attempts, attempts + 1),
              next_run_at = @now,
              updated_at = @now
        WHERE job_id = @id`,
    ).run({ now, id: jobId });
    return "requeued";
  });
  return tx.immediate();
}

/** Guard: `jobId` must currently be in `from` before a `from → to` transition. */
function assertState(db: SqliteDatabase, jobId: string, from: JobState, to: JobState): void {
  const row = db.prepare(`SELECT state FROM jobs WHERE job_id = ?`).get(jobId) as { state: JobState } | undefined;
  if (!row || row.state !== from) throw new IllegalTransitionError(jobId, row?.state ?? "absent", to);
}

/**
 * Finalize the single active attempt of `jobId` (finding 2). The attempt UPDATE is
 * scoped to `attempt_no = @attempt AND outcome = 'running'` — the one active, unfinished
 * attempt — and MUST affect exactly one row. A stale or wrong `attempt` matches zero
 * active rows, so `changes !== 1` ⇒ {@link StaleAttemptError} which rolls the enclosing
 * transaction back: a mis-supplied attempt can never transition the job (nor commit a
 * side effect) while the real attempt is still `running`. `run` is a prepared attempt
 * UPDATE bound with `{ id, attempt, ... }`; returns nothing (throws on violation).
 */
function finalizeActiveAttempt(
  jobId: string,
  attempt: number,
  run: () => { changes: number },
): void {
  const { changes } = run();
  if (changes !== 1) throw new StaleAttemptError(jobId, attempt, changes);
}

/** A row in the `jobs list` projection. */
export interface JobListRow {
  jobId: string;
  workflow: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string | null;
  lastError: string | null;
}

/**
 * Paginated, read-only list (contract §8 `jobs list`), newest-first stable order
 * `(created_at DESC, job_id DESC)` — the `jobs-list.schema.json` `x-atlas-contract`
 * ordering (`sortKey: createdAt`, `direction: desc`, `tieBreaker: jobId`). `job_id`
 * (the PK) is unique so a same-timestamp tie is fully resolved, keeping pagination
 * deterministic across pages.
 */
export function listJobs(
  db: SqliteDatabase,
  opts: { state?: JobState; limit: number; offset: number },
): { rows: JobListRow[]; total: number } {
  const where = opts.state ? `WHERE state = @state` : ``;
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`).get(opts.state ? { state: opts.state } : {}) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT job_id, workflow, state, attempts, max_attempts, next_run_at FROM jobs ${where}
        ORDER BY created_at DESC, job_id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ ...(opts.state ? { state: opts.state } : {}), limit: opts.limit, offset: opts.offset }) as {
    job_id: string;
    workflow: string;
    state: JobState;
    attempts: number;
    max_attempts: number;
    next_run_at: string | null;
  }[];
  return {
    total,
    rows: rows.map((r) => ({
      jobId: r.job_id,
      workflow: r.workflow,
      state: r.state,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      nextRunAt: r.next_run_at,
      lastError: lastError(db, r.job_id),
    })),
  };
}

/** Ids of jobs in a given state, deterministic `(next_run_at, job_id)` order (bulk selectors). */
export function jobIdsInStates(db: SqliteDatabase, states: readonly JobState[]): string[] {
  const placeholders = states.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT job_id FROM jobs WHERE state IN (${placeholders})
          ORDER BY next_run_at IS NULL DESC, next_run_at ASC, job_id ASC`,
      )
      .all(...states) as { job_id: string }[]
  ).map((r) => r.job_id);
}

/** The current state of a job (or null). */
export function jobState(db: SqliteDatabase, jobId: string): JobState | null {
  const r = db.prepare(`SELECT state FROM jobs WHERE job_id = ?`).get(jobId) as { state: JobState } | undefined;
  return r?.state ?? null;
}
