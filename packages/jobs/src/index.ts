/**
 * `@atlas/jobs` — the operational async queue (jobs-contract.md). SOLE owner of
 * the `jobs`/`job_attempts` DDL (`0002_jobs`), repository, and transactions;
 * `@atlas/sqlite-store` consumes it read-only via {@link readSnapshot}. Provides
 * the synchronous single-runner drain, startup dead-runner recovery, and the
 * `{ items, aggregate }` batch protocol for `jobs list|run|retry|cancel`.
 */
export { migration0002Jobs, JOBS_DDL } from "../migrations/0002_jobs.js";
export { migration0007JobCancellations, JOB_CANCELLATIONS_DDL } from "../migrations/0007_job_cancellations.js";
export { registerJobsMigration, openJobsStore, productionEnqueueContext, DEFAULT_MAX_ATTEMPTS } from "./register.js";

export {
  enqueue,
  bindEnqueueContext,
  readSnapshot,
  listJobs,
  listAllJobs,
  projectJobListRow,
  jobIdsInStates,
  jobState,
  cancelJob,
  cancellationRequested,
  clearCancellation,
  retryJob,
  claimNext,
  completeJob,
  scheduleRetry,
  resetForRetry,
  failJob,
  cancelRunning,
  payloadHash,
  assertMaxAttempts,
  MAX_ATTEMPTS_MIN,
  MAX_ATTEMPTS_MAX,
  PayloadIntegrityError,
  IllegalTransitionError,
  MaxAttemptsRangeError,
  SideEffectIdRequiredError,
  EnqueueContextRequiredError,
  StaleAttemptError,
} from "./repo.js";
export type {
  JobState,
  AttemptOutcome,
  RetryClass,
  LedgerTx,
  JobId,
  JobSpec,
  EnqueueContext,
  JobSnapshot,
  ClaimedJob,
  CancelOutcome,
  RetryOutcome,
  JobListRow,
  JobsRawRow,
  JobEffect,
  FinalizeResult,
} from "./repo.js";

export { recoverDeadRunners } from "./recovery.js";

export {
  runAll,
  backoffDelayMs,
  classifyError,
  JOBS_RUNNER_LOCK,
  CancellationRegistry,
  SqliteCancellationSource,
  requestJobCancellation,
} from "./runner.js";
export type {
  WithLock,
  BackoffConfig,
  CancellationSource,
  JobHandler,
  JobHandlerContext,
  JobHandlerResult,
  JobsDeps,
  JobSelector,
  JobRunItem,
  JobRunAggregate,
  JobRunReport,
  RunItemOutcome,
} from "./runner.js";
