/**
 * `@atlas/jobs` runner — the synchronous single-runner drain (jobs-contract.md §5,
 * §2, §3, §6) and the `{ items, aggregate }` batch protocol (contract §8, CLI
 * schemas `jobs-run`).
 *
 * `runAll(deps, selector)`:
 *  1. acquires the EXCLUSIVE `jobs-runner` lock for the WHOLE drain (a second
 *     concurrent runner's `withLock` throws `locked:jobs-runner`, exit 2 — the
 *     lock lives in the CLI foundation and is INJECTED via `deps.withLock`, so
 *     `@atlas/jobs` never imports `apps/cli`, plan §2.5 module discipline);
 *  2. runs startup dead-runner recovery UNDER the lock ({@link recoverDeadRunners});
 *  3. drains jobs one at a time — claim (`pending → running`, atomic), execute the
 *     workflow handler, finalize (`succeeded` / retry-scheduled / `failed` /
 *     `cancelled`) per the classification + backoff — each job EXACTLY ONCE.
 *
 * The lock error is NOT caught here: it propagates so the CLI maps it to the
 * `locked:jobs-runner` envelope (exit 2). Per-job failures are captured into the
 * batch and never abort the drain.
 */
import { createHash } from "node:crypto";
import type { SqliteDatabase, Store } from "@atlas/sqlite-store";
import {
  cancelJob,
  cancelRunning,
  cancellationRequested,
  claimNext,
  completeJob,
  failJob,
  scheduleRetry,
  type CancelOutcome,
  type ClaimedJob,
} from "./repo.js";
import { recoverDeadRunners } from "./recovery.js";

/** The exclusive process-lock scope name (contract §5 / plan §2.5). */
export const JOBS_RUNNER_LOCK = "jobs-runner" as const;

/**
 * A source of per-attempt `AbortSignal`s the runner consults to observe a cancel
 * (contract §1 `cancel-observed`). The runner {@link register}s each running job for
 * the lifetime of its attempt and {@link unregister}s it when the attempt finishes;
 * the SOURCE decides what aborts the signal. Two implementations exist:
 *
 *  - {@link CancellationRegistry} — in-process: {@link CancellationRegistry.requestCancel}
 *    aborts the live controller (used by an in-process cancel path + the lifecycle tests);
 *  - the CLI's file-backed source — CROSS-PROCESS: a separate `brain jobs cancel`
 *    process persists a durable cancel-intent marker that the draining process's
 *    source observes and aborts on (finding 1). `@atlas/jobs` stays free of any
 *    filesystem/IPC concern — it only depends on this interface (plan §2.5).
 */
export interface CancellationSource {
  /** Register a starting attempt; returns the signal the runner passes the handler. */
  register(jobId: string): AbortSignal;
  /** Drop a finished attempt (called in the runner's `finally`); frees any resources. */
  unregister(jobId: string): void;
}

/**
 * The in-process OBSERVABLE cancellation mechanism (contract §1 `cancel-observed`).
 *
 * A running job's `AbortSignal` is not hidden inside the drain: the runner REGISTERS
 * an {@link AbortController} here keyed by `jobId` for the lifetime of each attempt,
 * and {@link requestJobCancellation} aborts it so the handler observes the cancel at
 * its next checkpoint and throws `AbortError` → the job is reconciled to `cancelled`.
 * This registry is process-local; the CLI's file-backed {@link CancellationSource}
 * covers the cross-process `jobs cancel` case (finding 1).
 */
export class CancellationRegistry implements CancellationSource {
  private readonly controllers = new Map<string, AbortController>();

  /** Register a fresh controller for a starting attempt; returns its signal. */
  register(jobId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return controller.signal;
  }

  /** Abort the live controller for `jobId` if one is registered. Returns whether it fired. */
  requestCancel(jobId: string): boolean {
    const controller = this.controllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Drop a finished attempt's controller (called in the runner's `finally`). */
  unregister(jobId: string): void {
    this.controllers.delete(jobId);
  }
}

/**
 * A {@link CancellationSource} that observes DURABLE cross-process cancel intents from
 * SQLite (finding 3). A separate `jobs cancel` process records a job's cancel intent
 * atomically in `job_cancellations` (see `cancelJob`); the draining `jobs run` process
 * wires THIS source into the runner, which polls the durable table for each claimed job
 * and aborts the attempt's `AbortSignal` when the intent appears — so the runner
 * observes cancellation from durable state, not only a filesystem marker.
 *
 * The intent is cleared on {@link unregister} (attempt finished) so a stale intent can
 * never cancel an unrelated future claim of the same job id. This lives in `@atlas/jobs`
 * (which solely owns the queue tables) and depends only on the SQLite connection — no
 * filesystem/IPC concern (plan §2.5 module discipline).
 */
export class SqliteCancellationSource implements CancellationSource {
  private readonly controllers = new Map<string, AbortController>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pollMs: number;

  constructor(
    private readonly db: SqliteDatabase,
    opts: { pollMs?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? 50;
  }

  register(jobId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    // A cancel intent recorded BEFORE the job started (e.g. between claim and execute,
    // or by a prior crashed runner) is observed immediately; otherwise poll for it.
    if (cancellationRequested(this.db, jobId)) {
      controller.abort();
      return controller.signal;
    }
    const timer = setInterval(() => {
      if (cancellationRequested(this.db, jobId)) {
        controller.abort();
        this.stop(jobId);
      }
    }, this.pollMs);
    timer.unref?.(); // never keep the event loop alive on account of the poller alone
    this.timers.set(jobId, timer);
    return controller.signal;
  }

  unregister(jobId: string): void {
    this.stop(jobId);
    this.controllers.delete(jobId);
    // The durable intent is NOT cleared here (finding 2). It is consumed only by the
    // finalization transaction that reconciles the job to `cancelled` (arbitration in
    // completeJob/scheduleRetry/failJob, or cancelRunning). Clearing it unconditionally
    // here reintroduced the race: an intent committed after the handler's final signal
    // check would be deleted before any finalizer could observe it. If this attempt did
    // NOT cancel (e.g. it succeeded before the intent landed), the intent simply targets
    // an already-terminal job and a later `cancelJob` reports `already-terminal`.
  }

  private stop(jobId: string): void {
    const t = this.timers.get(jobId);
    if (t !== undefined) {
      clearInterval(t);
      this.timers.delete(jobId);
    }
  }
}

/**
 * Cancel a job with an OBSERVABLE running-cancel: record the durable transition via
 * {@link cancelJob} and, when the job is `running`, abort its live `AbortSignal`
 * through `registry` so the in-flight handler observes the cancel at its next
 * checkpoint (contract §1). Used by the concurrent-cancel path (and tests) so a
 * `running` job is not merely marked `cancel-requested` with nothing to observe.
 */
export function requestJobCancellation(
  registry: CancellationRegistry,
  db: SqliteDatabase,
  jobId: string,
  now: string,
): CancelOutcome {
  const outcome = cancelJob(db, jobId, now);
  if (outcome === "cancel-requested") registry.requestCancel(jobId);
  return outcome;
}

/**
 * The injected lock seam (CLI foundation's `withLock`, plan interface 1.8). Scoped
 * to `"jobs-runner"` — the only lock `@atlas/jobs` acquires — so the CLI's wider
 * `withLock(scope: LockScope, …)` is assignable here without `@atlas/jobs`
 * importing the CLI's `LockScope` union (plan §2.5 module discipline).
 */
export type WithLock = <T>(scope: typeof JOBS_RUNNER_LOCK, fn: () => Promise<T> | T) => Promise<T>;

/** Deterministic exponential-full-jitter backoff config (contract §3). */
export interface BackoffConfig {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
}

/** What a job handler receives (payload + cooperative cancel signal + clock). */
export interface JobHandlerContext {
  readonly jobId: string;
  readonly workflow: string;
  readonly attempt: number;
  readonly payload: unknown;
  /** Cooperative-cancel signal; a handler observes it at checkpoints (contract §1). */
  readonly signal: AbortSignal;
  readonly now: string;
}

/** Fields common to both handler-result arms. */
interface JobHandlerResultBase {
  /** A produced run id; its presence + `actionRequired` decides the item outcome. */
  readonly runId?: string;
  /** The produced run needs human action (Tier-3 review) — item outcome `action-required`. */
  readonly actionRequired?: boolean;
}

/**
 * A successful handler result (Task 2.7). A DISCRIMINATED union (finding 5) that makes
 * the mutable-effect invariant unrepresentable-when-violated: supplying a `commit`
 * closure REQUIRES a non-empty `sideEffectId`, so the type system rejects
 * `{ commit }` without an id. Two arms:
 *
 *  - **content-addressed** (no `commit`): an optional `sideEffectId` may still be
 *    recorded, but a Phase-2 capture effect is content-addressed and leaves it absent
 *    (recorded NULL) — it relies on content-addressing, not a per-attempt id;
 *  - **mutable-effect** (`commit` present): the mutable SQLite side effect (evidence
 *    re-verification status, backup pruning, quarantine expiry — Phase-4) is committed
 *    ATOMICALLY with this job's terminal state + its REQUIRED, non-empty `sideEffectId`
 *    (Task 2.7 decision 1). The handler returns the closure INSTEAD of applying the
 *    effect itself, so a crash cannot land the effect without its recorded id — see
 *    {@link completeJob}.
 */
export type JobHandlerResult =
  | (JobHandlerResultBase & {
      readonly commit?: undefined;
      /** Transactional side-effect id (absent/NULL = content-addressed). */
      readonly sideEffectId?: string;
    })
  | (JobHandlerResultBase & {
      /** REQUIRED non-empty id for a mutable committed effect (finding 5). */
      readonly sideEffectId: string;
      /** A mutable SQLite side effect committed atomically with the terminal flip + id. */
      readonly commit: (tx: SqliteDatabase) => void;
    });

/** A workflow executor. Throws (classified) to fail/cancel an attempt. */
export type JobHandler = (ctx: JobHandlerContext) => Promise<JobHandlerResult> | JobHandlerResult;

/** Everything `runAll` needs (all injectable). */
export interface JobsDeps {
  /** A migrated store (0002 applied via {@link registerJobsMigration}). */
  readonly store: Store;
  /** Workflow → executor. A job whose workflow is unregistered fails `internal`. */
  readonly handlers: Record<string, JobHandler>;
  /** The CLI lock manager's `withLock`, bound to the process. */
  readonly withLock: WithLock;
  /** RFC-3339 UTC clock (controlled in tests). */
  readonly now: () => string;
  readonly backoff: BackoffConfig;
  /** Attempt budget used when a job has no `max_attempts` override. */
  readonly defaultMaxAttempts: number;
  /**
   * The observable cancellation source (contract §1). The runner registers each
   * running job here so an in-flight cancel is observable — an in-process
   * {@link CancellationRegistry} or the CLI's cross-process file-backed source
   * (finding 1). When absent, each attempt gets a private, never-aborted signal.
   */
  readonly cancellation?: CancellationSource;
  /** Per-job cancel signal (tests abort it to exercise cooperative cancel). */
  readonly makeSignal?: (jobId: string) => AbortSignal;
  /** Post-claim hook (test barrier / crash injection); may throw to abort a job. */
  readonly onClaimed?: (job: ClaimedJob) => void | Promise<void>;
}

/** The drain selector (SSOT `[<jobId> | --all]`). */
export interface JobSelector {
  readonly jobId?: string;
  readonly all?: boolean;
}

/** A non-failed item outcome (jobs-run schema). */
export type RunItemOutcome = "succeeded" | "retry-scheduled" | "action-required" | "skipped:state-changed" | "cancelled";

/** One processed-job entry in the batch. */
export interface JobRunItem {
  readonly jobId: string;
  readonly workflow?: string;
  readonly outcome: RunItemOutcome | "failed";
  readonly attempts?: number;
  readonly runId?: string;
  readonly retryAfterMs?: number;
  readonly error?: { code: string; message: string; retryable: boolean; retryAfterMs?: number };
}

/** The batch roll-up (jobs-run schema `aggregate`). */
export interface JobRunAggregate {
  readonly exitCode: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly actionRequired: number;
}

/** The `runAll` return (the CLI adds `command`). */
export interface JobRunReport {
  readonly items: JobRunItem[];
  readonly aggregate: JobRunAggregate;
}

// ---------------------------------------------------------------------------
// Backoff (contract §3) — deterministic in (jobId, attemptNo).
// ---------------------------------------------------------------------------

/** A deterministic [0,1) draw seeded by `(jobId, attemptNo)` (stable across processes). */
function seededUnit(jobId: string, attemptNo: number): number {
  const h = createHash("sha256").update(`${jobId}:${attemptNo}`).digest();
  // First 6 bytes → 48-bit integer → [0,1); 48 bits is exact in a float64 mantissa.
  const int48 = h.readUIntBE(0, 6);
  return int48 / 2 ** 48;
}

/** `ceiling(n) = min(maxMs, baseMs * factor^(n-1))`; jittered delay ∈ [0, ceiling]. */
export function backoffDelayMs(cfg: BackoffConfig, jobId: string, attemptNo: number): number {
  const ceiling = Math.min(cfg.maxMs, cfg.baseMs * cfg.factor ** (attemptNo - 1));
  return Math.floor(seededUnit(jobId, attemptNo) * ceiling);
}

// ---------------------------------------------------------------------------
// Classification (contract §2).
// ---------------------------------------------------------------------------

const TRANSIENT_PROVIDER = new Set(["timeout", "transport", "rate_limit", "quota", "partial_batch"]);
const PERMANENT_PROVIDER = new Set(["validation", "authentication", "model_incompatible"]);

interface Classified {
  readonly cls: "transient" | "permanent" | "cancelled";
  readonly code: string;
  readonly message: string;
  readonly retryAfterMs?: number;
}

/** Classify a thrown attempt error deterministically (contract §2). */
export function classifyError(err: unknown): Classified {
  const e = err as { name?: string; kind?: string; code?: string; message?: string; retryAfter?: number };
  const message = e?.message ?? String(err);

  // Cooperative cancel (AbortSignal) or an explicit cancelled classification.
  if (e?.name === "AbortError" || e?.kind === "cancelled" || e?.code === "cancelled") {
    return { cls: "cancelled", code: "cancelled", message };
  }
  // Provider-error taxonomy (discriminated by `kind`).
  if (typeof e?.kind === "string") {
    if (TRANSIENT_PROVIDER.has(e.kind)) {
      const out: Classified = { cls: "transient", code: e.kind, message };
      return e.retryAfter !== undefined ? { ...out, retryAfterMs: e.retryAfter } : out;
    }
    if (PERMANENT_PROVIDER.has(e.kind)) return { cls: "permanent", code: e.kind, message };
  }
  // CLI/internal error codes.
  if (typeof e?.code === "string") {
    if (e.code.startsWith("locked:")) return { cls: "transient", code: e.code, message };
    if (e.code === "validation" || e.code === "reserved-operation") return { cls: "permanent", code: e.code, message };
    if (e.code === "secret-detected" || e.code === "secret-scan") return { cls: "permanent", code: e.code, message };
  }
  // Unknown → transient (retry until budget exhausted), stable code `internal`.
  return { cls: "transient", code: e?.code ?? "internal", message };
}

/** Exit-code candidate for a per-item outcome (aggregate precedence input). */
function itemExit(item: JobRunItem): number {
  if (item.outcome === "action-required") return 6;
  if (item.outcome === "failed") {
    const code = item.error?.code ?? "internal";
    if (code === "internal") return 4;
    if (code.startsWith("locked:")) return 2;
    // A transient-but-exhausted failure stays provider-retryable (7); a permanent
    // failure is a validation-class user error (1).
    return item.error?.retryable ? 7 : 1;
  }
  // succeeded / retry-scheduled / cancelled / skipped:* do not raise the code.
  return 0;
}

/** Deterministic aggregate exit precedence 4 ⊐ 2 ⊐ 1 ⊐ 7 ⊐ 6 ⊐ 5 (contract §8). */
function aggregateExit(items: JobRunItem[]): number {
  const present = new Set(items.map(itemExit));
  for (const code of [4, 2, 1, 7, 6, 5]) if (present.has(code)) return code;
  return 0;
}

function rollup(items: JobRunItem[]): JobRunAggregate {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let actionRequired = 0;
  for (const it of items) {
    if (it.outcome === "succeeded") succeeded++;
    else if (it.outcome === "failed") failed++;
    else if (it.outcome === "action-required") actionRequired++;
    else if (it.outcome === "skipped:state-changed") skipped++;
    // retry-scheduled / cancelled are neither success nor failure nor skip.
  }
  return { exitCode: aggregateExit(items), succeeded, failed, skipped, actionRequired };
}

// ---------------------------------------------------------------------------
// Drain.
// ---------------------------------------------------------------------------

/**
 * Execute one claimed job and finalize it, returning its batch item. Never throws
 * for a job-level failure (captured into the item); a repository/integrity fault
 * surfaces as an `internal` failed item.
 */
async function runOne(deps: JobsDeps, job: ClaimedJob): Promise<JobRunItem> {
  const db = deps.store.db;
  const now = deps.now();
  // Prefer an explicit test signal; else register with the observable cancellation
  // registry (so a concurrent cancel can abort this attempt); else a private signal.
  const signal = deps.makeSignal?.(job.jobId) ?? deps.cancellation?.register(job.jobId) ?? new AbortController().signal;

  try {
    if (deps.onClaimed) await deps.onClaimed(job); // test barrier / crash injection

    const handler = deps.handlers[job.workflow];
    if (!handler) throw { code: "internal", message: `no handler registered for workflow "${job.workflow}"` };

    // Pre-execution cancel check (a cancel observed before the first step).
    if (signal.aborted) throw { name: "AbortError", message: "cancelled before execution" };

    const result = await handler({
      jobId: job.jobId,
      workflow: job.workflow,
      attempt: job.attempt,
      payload: job.payload,
      signal,
      now,
    });

    // A cancel observed during execution (cooperative handlers may return instead of
    // throwing) still reconciles to `cancelled`, not `succeeded`.
    if (signal.aborted) throw { name: "AbortError", message: "cancelled during execution" };

    // Runtime guard (finding 5): a handler that returns a mutable `commit` effect MUST
    // supply a non-empty side-effect id. Classify a violation `validation` (permanent)
    // so a misbehaving handler fails the job immediately rather than retrying forever.
    if (result.commit !== undefined && (result.sideEffectId === undefined || result.sideEffectId.length === 0)) {
      throw {
        kind: "validation",
        message: `handler for workflow "${job.workflow}" returned a commit effect without a non-empty sideEffectId`,
      };
    }

    const fin = deps.now();
    // The mutable effect (if any) commits atomically with the terminal flip + id. If a
    // durable cancel intent was committed during/after execution, completeJob arbitrates
    // it INSIDE that transaction (finding 2) and reconciles the job to `cancelled`
    // instead of `succeeded` — the effect never runs and the item is reported cancelled.
    const done = completeJob(db, job.jobId, job.attempt, fin, result.sideEffectId ?? null, result.commit);
    if (done.cancelled) {
      return { jobId: job.jobId, workflow: job.workflow, outcome: "cancelled", attempts: job.attempt };
    }
    if (result.actionRequired) {
      const item: JobRunItem = { jobId: job.jobId, workflow: job.workflow, outcome: "action-required", attempts: job.attempt };
      return result.runId ? { ...item, runId: result.runId } : item;
    }
    const ok: JobRunItem = { jobId: job.jobId, workflow: job.workflow, outcome: "succeeded", attempts: job.attempt };
    return result.runId ? { ...ok, runId: result.runId } : ok;
  } catch (err) {
    const c = classifyError(err);
    const fin = deps.now();

    if (c.cls === "cancelled") {
      cancelRunning(db, job.jobId, job.attempt, fin);
      return { jobId: job.jobId, workflow: job.workflow, outcome: "cancelled", attempts: job.attempt };
    }

    if (c.cls === "transient" && job.attempt < job.maxAttempts) {
      const delay = c.retryAfterMs ?? backoffDelayMs(deps.backoff, job.jobId, job.attempt);
      const nextRunAt = new Date(Date.parse(fin) + delay).toISOString();
      // A durable cancel intent committed during the attempt is honored over the retry
      // (finding 2): the job is cancelled rather than re-queued.
      if (scheduleRetry(db, job.jobId, job.attempt, fin, c.code, nextRunAt).cancelled) {
        return { jobId: job.jobId, workflow: job.workflow, outcome: "cancelled", attempts: job.attempt };
      }
      const item: JobRunItem = { jobId: job.jobId, workflow: job.workflow, outcome: "retry-scheduled", attempts: job.attempt };
      return c.retryAfterMs !== undefined ? { ...item, retryAfterMs: c.retryAfterMs } : item;
    }

    // Permanent, or transient with the attempt budget exhausted → terminal failed. A
    // durable cancel intent is honored over the failure (finding 2) → cancelled.
    if (failJob(db, job.jobId, job.attempt, fin, c.code).cancelled) {
      return { jobId: job.jobId, workflow: job.workflow, outcome: "cancelled", attempts: job.attempt };
    }
    const error = { code: c.code, message: c.message, retryable: c.cls === "transient" };
    return {
      jobId: job.jobId,
      workflow: job.workflow,
      outcome: "failed",
      attempts: job.attempt,
      error: c.retryAfterMs !== undefined ? { ...error, retryAfterMs: c.retryAfterMs } : error,
    };
  } finally {
    // Drop this attempt's cancellation controller — the job is no longer running.
    deps.cancellation?.unregister(job.jobId);
  }
}

/**
 * Drain the queue under the exclusive `jobs-runner` lock (contract §5/§6/§8).
 * `selector.all` (or neither field) drains every eligible job; `selector.jobId`
 * drains exactly that job (reporting `skipped:state-changed` if it is no longer an
 * eligible `pending` job).
 */
export function runAll(deps: JobsDeps, selector: JobSelector): Promise<JobRunReport> {
  return deps.withLock(JOBS_RUNNER_LOCK, async () => {
    const db = deps.store.db;

    // Startup dead-runner recovery BEFORE any claim, under the exclusive lock.
    recoverDeadRunners(db, deps.now());

    const items: JobRunItem[] = [];

    if (selector.jobId !== undefined) {
      const job = claimNext(db, deps.now(), selector.jobId);
      if (!job) {
        items.push({ jobId: selector.jobId, outcome: "skipped:state-changed" });
      } else {
        items.push(await runOne(deps, job));
      }
      return { items, aggregate: rollup(items) };
    }

    // --all (default): claim → run until nothing is eligible. Each claimed id is
    // recorded in `processed` and excluded from every later claim THIS drain, so a
    // retry rescheduled with a zero backoff (`next_run_at = now`, e.g. provider
    // `retryAfterMs = 0` or a zero-jitter draw) is NOT re-claimed and re-run in the
    // same invocation — every job is claimed at most once per drain (contract §5).
    const processed = new Set<string>();
    for (;;) {
      const job = claimNext(db, deps.now(), undefined, processed);
      if (!job) break;
      processed.add(job.jobId);
      items.push(await runOne(deps, job));
    }
    return { items, aggregate: rollup(items) };
  });
}
