/**
 * `brain jobs list|run|retry|cancel` (Task 2.7 / #33) — the queue CLI surface
 * (jobs-contract.md §8 + the committed `jobs-*.schema.json` batch protocol).
 *
 * All three mutating commands share the SSOT selector + batch protocol: the
 * selectors `[<jobId> | --all]` are MUTUALLY EXCLUSIVE (both ⇒ exit 5); `run`
 * defaults to `--all` when neither is given, while `retry`/`cancel` with NO
 * selector exit 5 (never a silent select-all); bulk selection is deterministic
 * (`(next_run_at, jobId)`); each job is processed independently; and the result
 * is one `{ items, aggregate }` object (never the single-error envelope).
 *
 * `jobs run` drains under the exclusive `jobs-runner` lock (`@atlas/jobs`'s
 * `runAll`, injected `ctx.withLock`); a second concurrent runner's `withLock`
 * throws `locked:jobs-runner` (exit 2), which propagates to `runCli`. The actual
 * per-workflow executors are registered by Phase-2 capture (Task 2.6) via
 * {@link registerJobHandler}; this module owns only the CLI wiring + batch shape.
 */
import { createHash } from "node:crypto";
import { canonicalStringify } from "@atlas/contracts";
import {
  runAll,
  listJobs,
  jobIdsInStates,
  cancelJob,
  retryJob,
  SqliteCancellationSource,
  type JobHandler,
  type JobsDeps,
  type JobRunReport,
  type JobState,
} from "@atlas/jobs";
import type { Store } from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openJobsCommandStore } from "./store-open.js";
import { installTestJobHandler } from "./jobs-test-handler.js";
import { beginIdempotentCommand, releaseIdempotent, type IdempotencyRequest } from "../workflows/index.js";

/** RFC-3339 UTC clock (ms precision; lexicographically monotonic for `next_run_at`). */
const nowIso = (): string => new Date().toISOString();

/**
 * The workflow→executor registry, populated by later phases (Task 2.6 capture
 * follow-ons register here at import time). A job whose workflow is unregistered
 * fails `internal` — a mis-enqueued job never silently no-ops.
 */
const JOB_HANDLERS: Record<string, JobHandler> = {};

/** Register a workflow executor (Phase-2 capture wiring seam). */
export function registerJobHandler(workflow: string, handler: JobHandler): void {
  JOB_HANDLERS[workflow] = handler;
}

const JOB_STATES: readonly JobState[] = ["pending", "running", "succeeded", "failed", "cancelled"];

/** The SSOT `[<jobId> | --all]` selector after parsing. */
interface Selector {
  jobId?: string;
  all: boolean;
  /** The caller's `--idempotency-key`, if supplied (key-accepting commands). */
  idempotencyKey?: string;
}

/**
 * Parse the shared mutating-command argv into a {@link Selector}. `<jobId>` and
 * `--all` are mutually exclusive (both ⇒ exit 5). `--idempotency-key <key>` binds the
 * caller-idempotency slot (see {@link runKeyed}). Unknown flags / multiple positionals
 * ⇒ exit 5.
 */
function parseSelector(command: string, argv: string[]): Selector {
  let jobId: string | undefined;
  let all = false;
  let idempotencyKey: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--all") all = true;
    else if (a === "--idempotency-key") {
      i++;
      if (i >= argv.length) throw CliError.usage(`\`${command}\`: --idempotency-key requires a value`);
      idempotencyKey = argv[i]!;
    } else if (a.startsWith("--")) {
      throw CliError.usage(`\`${command}\`: unknown flag ${a}`);
    } else if (jobId === undefined) {
      jobId = a;
    } else {
      throw CliError.usage(`\`${command}\`: unexpected extra argument ${a}`);
    }
  }
  if (jobId !== undefined && all) {
    throw CliError.usage(`\`${command}\`: <jobId> and --all are mutually exclusive`);
  }
  const base: Selector = all ? { all: true } : jobId !== undefined ? { jobId, all: false } : { all: false };
  return idempotencyKey !== undefined ? { ...base, idempotencyKey } : base;
}

// ---------------------------------------------------------------------------
// Caller-idempotency (contract §7 / key-accepting `jobs run|retry|cancel`)
// ---------------------------------------------------------------------------

/** The batch roll-up shared by `jobs run|retry|cancel` (exit code + counts). */
interface BatchAggregate {
  exitCode: number;
  succeeded: number;
  failed: number;
  skipped: number;
  actionRequired: number;
}

/** A command's produced batch + its process-exit code (persisted for replay). */
interface CommandResult {
  readonly output: { command: string; items: unknown[]; aggregate: BatchAggregate };
  readonly exitCode: number;
}

/** `sha256(canonical(normalized request))` — the `requestHashScope` digest for a keyed command. */
function requestHash(command: string, selector: Selector): string {
  const normalized = { command, jobId: selector.jobId ?? null, all: selector.all };
  return createHash("sha256").update(canonicalStringify(normalized)).digest("hex");
}

/**
 * Run a key-accepting mutating command through the persisted caller-idempotency layer
 * (the same `beginIdempotentCommand` the workflow commands use). Without a key it runs
 * `work` directly. WITH `--idempotency-key`:
 *
 *  - an identical retry (same key + same normalized request) after completion REPLAYS
 *    the prior `{ items, aggregate }` + exit code WITHOUT re-running the work;
 *  - key reuse with a DIFFERENT request is REJECTED (`idempotency-key-conflict`, exit 1);
 *  - a concurrent duplicate still `in-progress` BLOCKS on the key
 *    (`idempotency-in-progress`, exit 6, retryable) rather than executing twice —
 *    for `jobs run` this happens BEFORE the `jobs-runner` lock, so a duplicate never
 *    even attempts the drain.
 *
 * A failure of `work` releases the in-progress slot so a later retry can re-claim it.
 */
async function runKeyed(
  ctx: RunContext,
  command: string,
  selector: Selector,
  work: (store: Store) => Promise<CommandResult> | CommandResult,
): Promise<number> {
  const store = openJobsCommandStore(ctx);
  const emit = (r: CommandResult): number => {
    if (ctx.output.mode === "json") emitJson(r.output);
    else ctx.render(renderBatch(command, r.output.aggregate));
    return r.exitCode;
  };
  try {
    if (selector.idempotencyKey === undefined) return emit(await work(store));

    const req: IdempotencyRequest = {
      command,
      key: selector.idempotencyKey,
      requestHash: requestHash(command, selector),
      runId: ctx.runId,
    };
    const start = beginIdempotentCommand<CommandResult>(store, req, nowIso);
    if (start.kind === "replay") return emit(start.result);
    try {
      const result = await work(store);
      start.complete(result); // publish the terminal result under owner/hash CAS
      return emit(result);
    } catch (e) {
      releaseIdempotent(store.db, req); // free the slot so a retry can re-claim the key
      throw e;
    }
  } finally {
    store.close();
  }
}

/**
 * Run a SYNCHRONOUS key-accepting mutating command (`jobs retry`/`jobs cancel`) with
 * CRASH-SAFE result publication (finding 2). The reviewer flagged that the async
 * {@link runKeyed} publishes the idempotency result AFTER the queue mutation commits —
 * a crash in that window leaves committed work whose slot the reconciler later releases,
 * so a retry re-executes and returns a DIFFERENT result than the original.
 *
 * Because a retry/cancel batch is pure SQLite (no async handler), the whole thing runs
 * synchronously, so the queue mutation AND the idempotency completion commit in ONE
 * IMMEDIATE transaction: they land together (a replay returns the identical result) or
 * neither lands (a crash rolls both back — nothing committed — and a retry re-drives a
 * clean, identical redo). The `in-progress` claim itself is committed first (the
 * serialization point for concurrent duplicates); if the atomic body throws, the claim
 * is released so a retry can re-claim the key. `afterCommit` runs only after a durable
 * commit (used by cancel to write cross-process cancel-intent markers, finding 1).
 *
 * `jobs run` keeps the async {@link runKeyed} path: its drain is multi-transaction with
 * external side effects and cannot be one atomic transaction, but re-execution after a
 * crash is safe — each job is individually crash-safe (a completed job is terminal and
 * never re-claimed), so a released slot only re-drains the still-eligible remainder.
 */
function runKeyedAtomic(
  ctx: RunContext,
  command: string,
  selector: Selector,
  work: (store: Store) => CommandResult,
  afterCommit?: (result: CommandResult) => void,
): number {
  const store = openJobsCommandStore(ctx);
  const emit = (r: CommandResult): number => {
    if (ctx.output.mode === "json") emitJson(r.output);
    else ctx.render(renderBatch(command, r.output.aggregate));
    return r.exitCode;
  };
  try {
    if (selector.idempotencyKey === undefined) {
      const result = work(store);
      afterCommit?.(result);
      return emit(result);
    }

    const req: IdempotencyRequest = {
      command,
      key: selector.idempotencyKey,
      requestHash: requestHash(command, selector),
      runId: ctx.runId,
    };
    const start = beginIdempotentCommand<CommandResult>(store, req, nowIso);
    if (start.kind === "replay") return emit(start.result);
    let result: CommandResult;
    try {
      result = store.db.transaction(() => {
        const r = work(store); // queue mutation …
        start.complete(r); // … and result publication, in the SAME transaction
        return r;
      }).immediate();
    } catch (e) {
      releaseIdempotent(store.db, req); // free the slot so a retry can re-claim the key
      throw e;
    }
    afterCommit?.(result);
    return emit(result);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// jobs list
// ---------------------------------------------------------------------------

function parseListArgs(argv: string[]): { state?: JobState; limit: number; offset: number } {
  let state: JobState | undefined;
  let limit = 50;
  let offset = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const need = (): string => {
      i++;
      if (i >= argv.length) throw CliError.usage(`\`jobs list\`: ${a} requires a value`);
      return argv[i]!;
    };
    if (a === "--state") {
      const v = need();
      if (!JOB_STATES.includes(v as JobState)) throw CliError.usage(`\`jobs list\`: unknown --state ${v}`);
      state = v as JobState;
    } else if (a === "--limit") {
      limit = Number(need());
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw CliError.usage(`\`jobs list\`: --limit must be an integer in [1, 500]`);
      }
    } else if (a === "--offset") {
      offset = Number(need());
      if (!Number.isInteger(offset) || offset < 0) throw CliError.usage(`\`jobs list\`: --offset must be an integer ≥ 0`);
    } else {
      throw CliError.usage(`\`jobs list\`: unknown flag/argument ${a}`);
    }
  }
  return state !== undefined ? { state, limit, offset } : { limit, offset };
}

function jobsList(ctx: RunContext): number {
  const { state, limit, offset } = parseListArgs(ctx.argv);
  const store = openJobsCommandStore(ctx);
  try {
    const { rows, total } = listJobs(store.db, state !== undefined ? { state, limit, offset } : { limit, offset });
    // No second shape transformation (Phase 1 Task 2 finding): `projectJobListRow`
    // already owns null-optional omission, so the projected rows ARE the final
    // `jobs list --json` shape — the SAME field-for-field rows `watch` reuses.
    const out = {
      command: "jobs list",
      jobs: rows,
      pagination: { limit, offset, total, hasMore: offset + rows.length < total },
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`jobs: ${rows.length} of ${total}${state ? ` (state=${state})` : ""}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// jobs run
// ---------------------------------------------------------------------------

function jobsRun(ctx: RunContext): Promise<number> {
  const selector = parseSelector("jobs run", ctx.argv);
  const j = ctx.config.config.jobs;
  return runKeyed(ctx, "jobs run", selector, async (store) => {
    // Cross-process cancel (finding 3): the drain observes DURABLE cancel intents a
    // separate `jobs cancel` records atomically in `job_cancellations`, aborting a
    // running job at its next checkpoint — observed from durable SQLite state, not a
    // filesystem marker (so a crash after the cancel commit cannot lose it).
    const cancellation = new SqliteCancellationSource(store.db);
    const deps: JobsDeps = {
      store,
      handlers: JOB_HANDLERS,
      withLock: ctx.withLock,
      now: nowIso,
      backoff: { baseMs: j.backoff_base_ms, factor: j.backoff_factor, maxMs: j.backoff_max_ms },
      defaultMaxAttempts: j.max_attempts,
      cancellation,
    };
    // A `locked:jobs-runner` from `withLock` propagates (runCli → exit 2 envelope).
    // Bare invocation (no <jobId>, no --all) defaults to --all (contract §8).
    const runSelector = selector.jobId !== undefined ? { jobId: selector.jobId } : { all: true };
    const report: JobRunReport = await runAll(deps, runSelector);
    return {
      output: { command: "jobs run", items: report.items, aggregate: report.aggregate },
      exitCode: report.aggregate.exitCode,
    };
  });
}

// ---------------------------------------------------------------------------
// jobs retry / cancel — shared per-item batch driver
// ---------------------------------------------------------------------------

interface BatchItem {
  jobId: string;
  outcome: string;
  error?: { code: string; message: string; retryable: boolean };
}

/** Aggregate a retry/cancel batch (no `run`-only outcomes; exit 4 iff a write failed). */
function batchAggregate(items: BatchItem[]): BatchAggregate {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const it of items) {
    if (it.outcome === "failed") failed++;
    else if (it.outcome === "requeued" || it.outcome === "cancelled" || it.outcome === "cancel-requested") succeeded++;
    else skipped++; // not-failed / not-found / already-terminal / skipped:state-changed
  }
  return { exitCode: failed > 0 ? EXIT.INTERNAL : EXIT.OK, succeeded, failed, skipped, actionRequired: 0 };
}

/** Bare invocation (no `<jobId>`, no `--all`) ⇒ exit 5 (never a silent select-all). */
function requireSelector(command: string, selector: Selector): void {
  if (selector.jobId === undefined && !selector.all) {
    throw CliError.usage(`\`${command}\`: a selector is required — pass <jobId> or --all (bare invocation is refused)`);
  }
}

function resolveTargets(command: string, selector: Selector, all: () => string[]): string[] {
  if (selector.jobId !== undefined) return [selector.jobId];
  if (selector.all) return all();
  requireSelector(command, selector); // defensive — callers guard before store open
  return [];
}

/** Assemble a retry/cancel batch into a {@link CommandResult} (shared by keyed + bare paths). */
function batchResult(command: string, items: BatchItem[]): CommandResult {
  const aggregate = batchAggregate(items);
  return { output: { command, items, aggregate }, exitCode: aggregate.exitCode };
}

function jobsRetry(ctx: RunContext): number {
  const selector = parseSelector("jobs retry", ctx.argv);
  requireSelector("jobs retry", selector); // bare (no selector) ⇒ exit 5, before any store open
  return runKeyedAtomic(ctx, "jobs retry", selector, (store) => {
    const targets = resolveTargets("jobs retry", selector, () => jobIdsInStates(store.db, ["failed"]));
    const bulk = selector.all;
    const items: BatchItem[] = targets.map((id) => {
      try {
        const r = retryJob(store.db, id, nowIso());
        const outcome = r === "not-failed" && bulk ? "skipped:state-changed" : r;
        return { jobId: id, outcome };
      } catch (e) {
        return { jobId: id, outcome: "failed", error: { code: "internal", message: errMsg(e), retryable: false } };
      }
    });
    return batchResult("jobs retry", items);
  });
}

function jobsCancel(ctx: RunContext): number {
  const selector = parseSelector("jobs cancel", ctx.argv);
  requireSelector("jobs cancel", selector); // bare (no selector) ⇒ exit 5, before any store open
  // Finding 3: `cancelJob` records a `running` job's cancel intent DURABLY in
  // `job_cancellations` INSIDE its transaction — the same transaction `runKeyedAtomic`
  // uses to commit the idempotency result. Intent + published result therefore land
  // atomically (or neither does), so a crash can never leave a replayable
  // `cancel-requested` success with nothing observable to stop the job. No post-commit
  // filesystem write is needed; the draining runner observes the intent from SQLite.
  return runKeyedAtomic(ctx, "jobs cancel", selector, (store) => {
    const targets = resolveTargets("jobs cancel", selector, () => jobIdsInStates(store.db, ["pending", "running"]));
    const items: BatchItem[] = targets.map((id) => {
      try {
        return { jobId: id, outcome: cancelJob(store.db, id, nowIso()) };
      } catch (e) {
        return { jobId: id, outcome: "failed", error: { code: "internal", message: errMsg(e), retryable: false } };
      }
    });
    return batchResult("jobs cancel", items);
  });
}

function renderBatch(command: string, a: { succeeded: number; failed: number; skipped: number; actionRequired: number }): string {
  return `${command}: ${a.succeeded} ok, ${a.failed} failed, ${a.skipped} skipped, ${a.actionRequired} action-required`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Env-gated (`ATLAS_TEST_JOB_HANDLER=1`) test workflow executor for the real-process
// acceptance tests (findings 1 & 3); a no-op in production. Registered at import time
// on the same registry Phase-2 capture will populate.
installTestJobHandler(process.env, registerJobHandler);

registerCommand("jobs list", jobsList);
registerCommand("jobs run", jobsRun);
registerCommand("jobs retry", jobsRetry);
registerCommand("jobs cancel", jobsCancel);

export { jobsList, jobsRun, jobsRetry, jobsCancel };
