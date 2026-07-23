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
  SqliteCancellationSource,
  type JobHandler,
  type JobsDeps,
  type JobRunReport,
  type JobState,
} from "@atlas/jobs";
import type { Store } from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { assertOffsetInRange, parseLimit, parseOffset } from "./pagination.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openJobsCommandStore } from "./store-open.js";
import { installTestJobHandler } from "./jobs-test-handler.js";
import { buildJobHandlers } from "./job-handlers.js";
import { beginIdempotentCommand, releaseIdempotent, type IdempotencyRequest } from "../workflows/index.js";

/** RFC-3339 UTC clock (ms precision; lexicographically monotonic for `next_run_at`). */
const nowIso = (): string => new Date().toISOString();

/**
 * Import-time registry, now carrying ONLY the env-gated test handler. Production
 * executors need a `RunContext` + open `Store`, neither of which exists at import
 * time, so they are built per-drain by `buildJobHandlers` (see `job-handlers.ts`)
 * and merged in at `jobsRun`. A job whose workflow is unregistered fails
 * `internal` — a mis-enqueued job never silently no-ops.
 */
const JOB_HANDLERS: Record<string, JobHandler> = {};

/** Register a workflow executor (env-gated test seam; see `jobs-test-handler.ts`). */
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
 *    (`idempotency-in-progress`, exit 6, retryable) rather than executing twice.
 *    For `jobs run` the caller now holds `jobs-runner` around this whole call
 *    (round-2 finding), so store open + the idempotency claim + the drain are all
 *    serialized under the one lock — a concurrent runner is rejected `locked:jobs-runner`
 *    (exit 2) at the lock BEFORE it can open a store or write an in-progress claim.
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
      // The SSOT pagination contract (Phase 6 fix-forward, SP-1 plan Task 6.2):
      // strict lexical parse — `--limit 1e2`/`0x10`/`""` are usage errors here
      // exactly as in `source list`/`note *`, never silently coerced by Number().
      limit = parseLimit("jobs list", need());
    } else if (a === "--offset") {
      offset = parseOffset("jobs list", need());
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
    // Out-of-range offsets are usage errors (exit 5), never a silent empty page —
    // the same contract every other paginated read enforces.
    assertOffsetInRange("jobs list", offset, total);
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
  // Acquire `jobs-runner` OUTERMOST — around store open, the idempotency claim, AND
  // the drain (round-2 finding). Previously `runKeyed` opened the store and wrote the
  // in-progress idempotency claim BEFORE `runAll` took the lock, so a lock loser (or a
  // crash) could strand a claim / write a derived store while another runner held the
  // lock. Now every derived-store write for `jobs run` is serialized under the one
  // lock. A `locked:jobs-runner` here fails fast (exit 2, no queueing) BEFORE any store
  // open or idempotency write. Bare invocation (no <jobId>, no --all) defaults to --all.
  return ctx.withLock("jobs-runner", () =>
    runKeyed(ctx, "jobs run", selector, async (store) => {
      // Cross-process cancel (finding 3): the drain observes DURABLE cancel intents a
      // separate `jobs cancel` records atomically in `job_cancellations`, aborting a
      // running job at its next checkpoint — observed from durable SQLite state, not a
      // filesystem marker (so a crash after the cancel commit cannot lose it).
      const cancellation = new SqliteCancellationSource(store.db);
      const deps: JobsDeps = {
        store,
        // Production executors are built per-drain (they close over ctx + the open
        // store); the import-time map carries only the env-gated test handler. The
        // test handler is spread FIRST so a production workflow can never be
        // shadowed by `ATLAS_TEST_JOB_WORKFLOW` naming collision.
        handlers: { ...JOB_HANDLERS, ...buildJobHandlers({ ctx, store }) },
        // The `jobs-runner` lock is ALREADY held by the outer `ctx.withLock` above;
        // `runAll` MUST NOT re-take it (re-acquiring the same scope in one process is
        // an order violation → exit 4). Pass a passthrough so the existing `runAll`
        // body runs under the already-held lock.
        withLock: (_scope, fn) => Promise.resolve(fn()),
        now: nowIso,
        backoff: { baseMs: j.backoff_base_ms, factor: j.backoff_factor, maxMs: j.backoff_max_ms },
        defaultMaxAttempts: j.max_attempts,
        cancellation,
      };
      const runSelector = selector.jobId !== undefined ? { jobId: selector.jobId } : { all: true };
      const report: JobRunReport = await runAll(deps, runSelector);
      return {
        output: { command: "jobs run", items: report.items, aggregate: report.aggregate },
        exitCode: report.aggregate.exitCode,
      };
    }),
  );
}

function renderBatch(command: string, a: { succeeded: number; failed: number; skipped: number; actionRequired: number }): string {
  return `${command}: ${a.succeeded} ok, ${a.failed} failed, ${a.skipped} skipped, ${a.actionRequired} action-required`;
}

// Env-gated (`ATLAS_TEST_JOB_HANDLER=1`) test workflow executor for the real-process
// acceptance tests (findings 1 & 3); a no-op in production. Registered at import time
// on the same registry Phase-2 capture will populate.
installTestJobHandler(process.env, registerJobHandler);

registerCommand("jobs list", jobsList);
registerCommand("jobs run", jobsRun);

export { jobsList, jobsRun };
