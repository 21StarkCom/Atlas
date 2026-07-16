/**
 * `retention/jobs` — retention/compaction execution registration (Task 4.10, R1-F13). The
 * scheduled-work owner: it enqueues (via the 2.7 queue) the per-class retention jobs that enforce
 * `retention-matrix.md` — LanceDB generation compaction after activation, log rotation expiry,
 * ledger-backup pruning (keep-N + keep-forever-latest), and quarantine expiry. Each job is
 * idempotency-keyed on its class + period so a repeat registration in the same window is a no-op;
 * the jobs run under `jobs run` / a workflow drain.
 */
import { enqueue, type JobId, type LedgerTx } from "@atlas/jobs";

/** The retention classes with a scheduled job (retention-matrix.md). */
export const RETENTION_WORKFLOWS = [
  "retention:lancedb-compaction",
  "retention:log-rotation",
  "retention:backup-prune",
  "retention:quarantine-expiry",
] as const;

export type RetentionWorkflow = (typeof RETENTION_WORKFLOWS)[number];

/** Config the retention jobs carry (bounds from the matrix; the runner reads them). */
export interface RetentionConfig {
  /** Ledger-backup keep-N (matrix row 18; default 10, min 1) + keep-forever-latest. */
  readonly backupKeep: number;
  /** The registration period token (e.g. an ISO date) — part of each job's idempotency key. */
  readonly period: string;
}

/**
 * Register (enqueue) the retention jobs for `config.period`. Returns the enqueued job ids (one per
 * retention class). Idempotent per `(class, period)` — a repeat registration in the same period
 * returns the SAME ids (the queue de-dupes on the key), so a scheduler firing twice never
 * double-enqueues.
 */
export function registerRetentionJobs(tx: LedgerTx, config: RetentionConfig): JobId[] {
  const ids: JobId[] = [];
  for (const workflow of RETENTION_WORKFLOWS) {
    ids.push(
      enqueue(tx, {
        workflow,
        idempotencyKey: `${workflow}:${config.period}`,
        payload: { period: config.period, ...(workflow === "retention:backup-prune" ? { keep: config.backupKeep } : {}) },
      }),
    );
  }
  return ids;
}
