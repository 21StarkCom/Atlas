/**
 * `brain watch` (SP-1 Phase 3) — the long-lived NDJSON stream over the read-only
 * ledger: `watch.hello` snapshot, `--once`, the `data_version` poll loop, and the
 * `runWatch` orchestrator driving both ledger states (attached poll loop +
 * detached re-probe loop) through each loop's completion channel.
 *
 * Machine-only: `--json` is REQUIRED (validated from `ctx.output.mode`, never
 * parsed from argv — the router owns global flags). The registry row stays
 * `implemented:false` until Phase 5 (replay/re-attach/domain semantics are typed
 * stubs here — the flip is the completeness gate); the handler IS registered, so
 * tests dispatch it directly.
 *
 * Read-only by construction: the ledger opens `readonly:true`, no Atlas lock is
 * taken, no git repository is opened, and the only broker call is the read-only
 * `getAuditChainStatus` snapshot probe (best-effort). See `watch.schema.json`
 * `x-atlas-contract.prohibitedEffects`.
 */
import { BrokerClient } from "@atlas/broker";
import { CliError, EXIT, emitLineAwaitable, StdoutClosedError } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { ledgerDbPath } from "./backup-config.js";
import { attachLedger, emitHello, flushPendingDaemonFaults } from "../watch/attach.js";
import { runPollLoop } from "../watch/poll-loop.js";
import { runDetachedLoop } from "../watch/detached-loop.js";
import { diffSources } from "../watch/diff.js";
import { emitWatchError, heartbeatTick } from "../watch/heartbeat.js";
import { emitPostReplayHeartbeat, reattach, runReplay } from "../watch/stubs.js";
import type { AttachContext, AttachedLedger, EmitLine, WatchOpts } from "../watch/types.js";

/** Flag defaults + bounds (§5). */
const POLL_MS_DEFAULT = 500;
const POLL_MS_MIN = 100;
const POLL_MS_MAX = 10_000;
const HEARTBEAT_S_DEFAULT = 30;
const HEARTBEAT_S_MIN = 5;
const HEARTBEAT_S_MAX = 300;

/** Strict base-10 integer lexical form (optionally negative) — no `Number()` laxity. */
const INT_RE = /^-?(0|[1-9]\d*)$/;

function parseIntStrict(raw: string): number | null {
  if (!INT_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Consume a flag's value (either `--flag value` or `--flag=value`). */
function takeValue(argv: string[], i: number, flag: string): { raw: string; next: number } {
  const a = argv[i]!;
  const eq = a.indexOf("=");
  if (eq !== -1) return { raw: a.slice(eq + 1), next: i + 1 };
  const v = argv[i + 1];
  if (v === undefined) throw CliError.usage(`\`watch\`: ${flag} requires a value`);
  return { raw: v, next: i + 2 };
}

/**
 * Parse + validate the watch flag set. Throws a usage error (exit 5) unless
 * `outputMode === "json"` — `watch` is machine-only (§5).
 */
export function parseWatchFlags(argv: string[], outputMode: string): WatchOpts {
  if (outputMode !== "json") {
    throw CliError.usage("`watch` is machine-only: invoke with --json (NDJSON stream)");
  }
  let sinceSeq: number | undefined;
  let once = false;
  let pollMs = POLL_MS_DEFAULT;
  let heartbeatSeconds = HEARTBEAT_S_DEFAULT;
  for (let i = 0; i < argv.length; ) {
    const a = argv[i]!;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    switch (name) {
      case "--since-seq": {
        const { raw, next } = takeValue(argv, i, "--since-seq");
        const n = parseIntStrict(raw);
        if (n === null || n < -1) {
          throw CliError.usage(`\`watch\`: --since-seq must be an integer >= -1 (got "${raw}")`);
        }
        sinceSeq = n;
        i = next;
        break;
      }
      case "--once": {
        if (a.includes("=")) throw CliError.usage("`watch`: --once takes no value");
        once = true;
        i += 1;
        break;
      }
      case "--poll-ms": {
        const { raw, next } = takeValue(argv, i, "--poll-ms");
        const n = parseIntStrict(raw);
        if (n === null || n < POLL_MS_MIN || n > POLL_MS_MAX) {
          throw CliError.usage(`\`watch\`: --poll-ms must be an integer in [${POLL_MS_MIN}, ${POLL_MS_MAX}] (got "${raw}")`);
        }
        pollMs = n;
        i = next;
        break;
      }
      case "--heartbeat-seconds": {
        const { raw, next } = takeValue(argv, i, "--heartbeat-seconds");
        const n = parseIntStrict(raw);
        if (n === null || n < HEARTBEAT_S_MIN || n > HEARTBEAT_S_MAX) {
          throw CliError.usage(
            `\`watch\`: --heartbeat-seconds must be an integer in [${HEARTBEAT_S_MIN}, ${HEARTBEAT_S_MAX}] (got "${raw}")`,
          );
        }
        heartbeatSeconds = n;
        i = next;
        break;
      }
      default:
        throw CliError.usage(`unknown flag/argument for \`watch\`: ${a}`);
    }
  }
  if (once && sinceSeq !== undefined) {
    throw CliError.usage("`watch`: --once and --since-seq are mutually exclusive (a one-shot snapshot has no live tail to resume into)");
  }
  return { once, pollMs, heartbeatSeconds, ...(sinceSeq !== undefined ? { sinceSeq } : {}) };
}

/** The active-loop stop seam + persistent latch the signal handlers drive (§10.1, hardened in Phase 5). */
interface Shutdown {
  stopRequested: boolean;
  activeStop: (() => void) | null;
}

/**
 * The `runWatch` orchestrator — the sole caller of the loops, `reattach`, and the
 * emitters; owns the whole lifecycle across both ledger states (plan Phase 3
 * Task 4). Returns the process exit code.
 */
export async function runWatch(
  path: string,
  opts: WatchOpts,
  ctx: AttachContext,
  emit: EmitLine,
  shutdown: Shutdown,
): Promise<number> {
  let att = await attachLedger(path, opts, ctx);
  await emitHello(att, emit);
  await flushPendingDaemonFaults(att, emit);
  if (opts.once) {
    if (att.attached) att.ledger.close();
    return EXIT.OK;
  }
  const stopped = (): boolean => shutdown.stopRequested;
  for (;;) {
    if (stopped()) {
      if (att.attached) att.ledger.close();
      return EXIT.OK;
    }
    if (att.attached) {
      const attached: AttachedLedger = att;
      if (attached.replay) {
        await runReplay(attached.replay, emit);
        await emitPostReplayHeartbeat(attached, emit);
        if (stopped()) {
          attached.ledger.close();
          return EXIT.OK;
        }
      }
      const h = runPollLoop(
        attached,
        opts,
        async (a) => {
          // Phase 4 fills diffSources; Phase 3 diffs to nothing (no domain events yet).
          for (const e of diffSources(a.connection, a.baselines)) await emit(e);
          return "continue";
        },
        () => heartbeatTick(attached, emit),
      );
      shutdown.activeStop = () => h.stop();
      let outcome: "stopped" | "reattach";
      try {
        outcome = await h.done;
      } finally {
        // A rejected `done` (a thrown tick/heartbeat — an internal fault) must not
        // leak the handle or a stale stop seam; the throw maps to exit 4 upstream.
        shutdown.activeStop = null;
        attached.ledger.close();
      }
      if (outcome === "stopped" || stopped()) return EXIT.OK;
      // Ledger vanished / replaced / schema moved — surface it, then re-attach
      // (fresh incarnation; Phase 5 hardens the error line + reset semantics).
      await emitWatchError("ledger", "ledger-detached", `ledger changed or vanished at ${path}; re-attaching`, emit);
      att = await reattach(path, opts, ctx);
      await emitHello(att, emit);
      await flushPendingDaemonFaults(att, emit);
    } else {
      const d = runDetachedLoop(att, opts, ctx, emit);
      shutdown.activeStop = () => d.stop();
      let outcome: "stopped" | { attached: AttachedLedger };
      try {
        outcome = await d.done;
      } finally {
        shutdown.activeStop = null;
      }
      if (outcome === "stopped" || stopped()) {
        if (outcome !== "stopped" && typeof outcome === "object") outcome.attached.ledger.close();
        return EXIT.OK;
      }
      att = outcome.attached;
      await emitHello(att, emit);
      await flushPendingDaemonFaults(att, emit);
    }
  }
}

async function watch(ctx: RunContext): Promise<number> {
  const opts = parseWatchFlags(ctx.argv, ctx.output.mode);
  const path = ledgerDbPath(ctx);

  // Best-effort broker connect for the read-only snapshot probe — a down broker
  // degrades the snapshot to `sqlite-only` and never fails the stream (§5.2).
  let broker: BrokerClient | null = null;
  try {
    broker = await BrokerClient.connect(ctx.config.config.broker.socket_path);
  } catch {
    broker = null;
  }

  const attachCtx: AttachContext = {
    anchorPath: ctx.config.config.git.audit_anchor_path,
    env: ctx.env,
    broker,
    brokerSocket: ctx.config.config.broker.socket_path,
    egressSocket: ctx.config.config.broker.egress_socket_path,
  };
  // The BLOCKING NDJSON writer (Phase 4 Task 4): per-line flush, honors `drain`
  // under backpressure — nothing is dropped or reordered for a slow consumer.
  const emit: EmitLine = (line) => emitLineAwaitable(line);

  // A single persistent shutdown latch, installed once — a signal arriving between
  // loop handles is remembered and honored at the next await boundary (§10.1;
  // Phase 5 hardens the full boundary sweep + EPIPE/fatal mapping).
  const shutdown: Shutdown = { stopRequested: false, activeStop: null };
  const onSignal = (): void => {
    shutdown.stopRequested = true;
    shutdown.activeStop?.();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await runWatch(path, opts, attachCtx, emit, shutdown);
  } catch (e) {
    // The consumer closed the pipe (a `head -1`-style reader): detaching a watcher
    // is success — exit 0 quietly, never SIGPIPE/141 (§10.1).
    if (e instanceof StdoutClosedError) return EXIT.OK;
    throw e;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    broker?.close();
  }
}

registerCommand("watch", watch);

export { watch };
