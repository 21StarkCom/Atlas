/**
 * `@atlas/jobs` startup dead-runner recovery (jobs-contract.md §6).
 *
 * On runner startup — BEFORE claiming any job, and UNDER the exclusive
 * `jobs-runner` lock — the runner reconciles jobs a previous (now-dead) runner
 * left mid-flight. Because the lock is exclusive and single-runner, holding it
 * proves no live runner owns any `running` row, so recovery is UNCONDITIONAL over
 * `running` jobs:
 *
 *  - its interrupted `job_attempts` row (still `outcome = 'running'`,
 *    `finished_at IS NULL`) is finalized in place as `outcome = 'failed'`,
 *    `error_code = 'interrupted'`, `finished_at = now` — NOT counted as a fresh
 *    attempt (the `attempts` counter is left unchanged);
 *  - a DURABLE cancel intent (finding 3) is honored FIRST, before any attempt-budget
 *    handling: if `job_cancellations` holds a row for the job, it is driven terminal
 *    `cancelled` and the intent consumed in the SAME transaction. This closes the
 *    stranded-intent bug — a crash on the final attempt of a `maxAttempts`-exhausted
 *    job used to be marked `failed` and never re-claimed, so the cancel intent was never
 *    observed (the job ended `failed`, the intent row leaked forever). Recovery now
 *    reconciles the cancel directly rather than relying on a re-claim that never happens;
 *  - otherwise the job is reconciled by its remaining attempt budget:
 *      - `attempts < max_attempts` → reset to `pending` (`dead-runner-recovery`),
 *        backoff (`next_run_at`) UNTOUCHED — it re-runs within its remaining budget;
 *      - `attempts >= max_attempts` (the crash struck the FINAL attempt) → driven
 *        terminal `failed` (`attempts-exhausted`), NOT re-queued. Re-queuing an
 *        at-budget job would let a subsequent claim execute a `maxAttempts+1`
 *        attempt (the claim guard would then refuse it and wedge it `pending`
 *        forever) — so recovery closes it out instead. This is the same terminal
 *        the live runner reaches when the last attempt fails (contract §6).
 *
 * Idempotent: a second pass sees no `running` row and is a no-op (the reserved
 * `lease_epoch` is `0` in V1; multi-worker leasing would key recovery on
 * `(jobId, lease_epoch)`). Returns the recovered job ids (both re-queued and
 * driven-terminal).
 */
import type { SqliteDatabase } from "@atlas/sqlite-store";
import { cancellationRequested, clearCancellation } from "./repo.js";

export function recoverDeadRunners(db: SqliteDatabase, now: string): string[] {
  const tx = db.transaction((): string[] => {
    const running = db
      .prepare(`SELECT job_id, attempts, max_attempts FROM jobs WHERE state = 'running'`)
      .all() as { job_id: string; attempts: number; max_attempts: number }[];
    const finalize = db.prepare(
      `UPDATE job_attempts SET outcome = 'failed', error_code = 'interrupted', finished_at = @now
        WHERE job_id = @id AND outcome = 'running' AND finished_at IS NULL`,
    );
    const requeue = db.prepare(`UPDATE jobs SET state = 'pending', updated_at = @now WHERE job_id = @id`);
    const terminal = db.prepare(
      `UPDATE jobs SET state = 'failed', next_run_at = NULL, updated_at = @now WHERE job_id = @id`,
    );
    const cancelled = db.prepare(
      `UPDATE jobs SET state = 'cancelled', next_run_at = NULL, updated_at = @now WHERE job_id = @id`,
    );
    const ids: string[] = [];
    for (const { job_id, attempts, max_attempts } of running) {
      finalize.run({ now, id: job_id });
      // Finding 3: honor a durable cancel intent BEFORE attempt-budget handling. Without
      // this, a crash on the final attempt (attempts >= max_attempts) took the terminal
      // `failed` branch and left the cancel intent stranded — the job never re-claimed,
      // the cancel never observed. Reconcile it directly to `cancelled` and consume the
      // intent in this same transaction.
      if (cancellationRequested(db, job_id)) {
        cancelled.run({ now, id: job_id });
        clearCancellation(db, job_id);
      } else if (attempts >= max_attempts) {
        terminal.run({ now, id: job_id });
      } else {
        requeue.run({ now, id: job_id });
      }
      ids.push(job_id);
    }
    return ids;
  });
  return tx.immediate();
}
