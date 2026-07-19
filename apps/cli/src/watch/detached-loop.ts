/**
 * `watch/detached-loop` — the explicit detached re-probe loop (SP-1 Phase 3
 * Task 4): while the ledger is absent/unmigrated, re-run `attachLedger` every
 * `pollMs` until it appears; at the heartbeat cadence, emit a detached
 * `watch.heartbeat` (no cursor) AND re-probe the daemons — a reachability
 * transition against the carried `daemonState` emits a `daemon` event, a probe
 * `fault` emits a non-fatal `watch.error` (daemon health stays observable while
 * the ledger is gone).
 *
 * Single serialized queue, exactly like `runPollLoop`: an attach attempt and a
 * heartbeat/daemon-probe emission never overlap, and the next attach attempt does
 * not start until the prior attempt's promise resolves (a 500 ms poll with a 2 s
 * probe must not race several in-flight attaches into two fresh AttachedLedgers).
 * `stop()` drains the in-flight emission then resolves `"stopped"`.
 */
import { probeDaemon } from "../health/probe.js";
import { attachLedger } from "./attach.js";
import { nowIso, type AttachContext, type AttachedLedger, type DetachedLedger, type EmitLine, type WatchOpts } from "./types.js";

export interface DetachedHandle {
  stop(): void;
  done: Promise<"stopped" | { attached: AttachedLedger }>;
}

/** Re-probe one daemon against the carried baseline; emit transition / fault lines. */
async function probeAndEmit(
  att: DetachedLedger,
  name: "broker" | "egress",
  socketPath: string,
  emit: EmitLine,
): Promise<void> {
  const p = await probeDaemon(socketPath);
  const prior = att.daemonState[name];
  if (p.status === "fault") {
    // A fault is "unknown", never recorded as reachable:false (no phantom transition).
    att.daemonState[name] = { known: false };
    await emit({
      v: 1,
      event: "watch.error",
      at: nowIso(),
      source: name,
      code: p.code,
      message: `daemon probe fault at ${socketPath}: ${p.message}`,
    });
    return;
  }
  const reachable = p.status === "reachable";
  if (prior.known && prior.reachable !== reachable) {
    await emit({
      v: 1,
      event: "daemon",
      at: nowIso(),
      daemon: name,
      socketPath,
      reachable,
      previousReachable: prior.reachable,
    });
  }
  att.daemonState[name] = { known: true, reachable };
}

/** Run the detached loop until the ledger attaches or `stop()` is called. */
export function runDetachedLoop(
  att: DetachedLedger,
  opts: WatchOpts,
  ctx: AttachContext,
  emit: EmitLine,
): DetachedHandle {
  let resolveDone!: (v: "stopped" | { attached: AttachedLedger }) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<"stopped" | { attached: AttachedLedger }>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  let finished = false;
  let lastHeartbeatAt = Date.now();
  let queue: Promise<void> = Promise.resolve();

  const finish = (v: "stopped" | { attached: AttachedLedger }): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    void queue.then(() => resolveDone(v));
  };

  /** A thrown attach attempt / emission is an internal fault: reject `done` (the
   *  orchestrator maps it) rather than leaving the queue rejected and `done` pending. */
  const fail = (e: unknown): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    rejectDone(e);
  };

  const tick = (): void => {
    if (finished) return;
    queue = queue.then(async () => {
      if (finished) return;
      // Re-probe for the ledger. A successful attach hands the fresh AttachedLedger
      // back to the orchestrator (which emits the fresh hello + deferred replay).
      const next = await attachLedger(att.path, opts, ctx);
      if (finished) {
        // stop() won the race — release the freshly opened handle, never leak it.
        if (next.attached) next.ledger.close();
        return;
      }
      if (next.attached) {
        finish({ attached: next });
        return;
      }
      // Still detached: at the heartbeat cadence, emit the cursor-less heartbeat
      // and re-probe the daemons for transitions/faults.
      if (Date.now() - lastHeartbeatAt >= opts.heartbeatSeconds * 1000) {
        lastHeartbeatAt = Date.now();
        await emit({ v: 1, event: "watch.heartbeat", at: nowIso(), ledger: { attached: false, path: att.path } });
        await probeAndEmit(att, "broker", ctx.brokerSocket, emit);
        await probeAndEmit(att, "egress", ctx.egressSocket, emit);
      }
    }).catch(fail);
  };

  // NOT unref'd — the detached loop is what keeps the stream process alive.
  const timer = setInterval(tick, opts.pollMs);

  return { stop: () => finish("stopped"), done };
}
