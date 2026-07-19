/**
 * `watch/heartbeat` — the attached heartbeat + daemon re-probe (SP-1 Phase 4
 * Task 3). Every `heartbeatSeconds` (of quiet OR activity — the poll loop owns
 * the cadence), emit `watch.heartbeat` carrying `resume.auditHeadSeq` = the
 * contiguous prefix, then re-probe both daemons: a clean probe drives a `daemon`
 * event on reachability TRANSITION only (compared against the retained
 * `DaemonBaseline`); a probe `fault` emits a non-fatal `watch.error` and records
 * `{known:false}` — never `reachable:false`, so a later success does not
 * fabricate a phantom `false→true` transition.
 */
import { probeDaemon } from "../health/probe.js";
import { buildDaemonEvent, buildWatchError } from "./events.js";
import { contiguousPrefix } from "./incarnation.js";
import { nowIso, type AttachedLedger, type EmitLine, type SourceBaselines, type WatchErrorLine } from "./types.js";

export { buildWatchError };

/** Emit a non-fatal `watch.error` (the stream continues; fatal faults use the envelope). */
export async function emitWatchError(
  source: WatchErrorLine["source"],
  code: string,
  message: string,
  emit: EmitLine,
): Promise<void> {
  await emit(buildWatchError(source, code, message));
}

/** Re-probe one daemon against the retained baseline; emit transition / fault lines. */
async function probeAndEmit(
  state: SourceBaselines,
  name: "broker" | "egress",
  socketPath: string,
  emit: EmitLine,
): Promise<void> {
  const p = await probeDaemon(socketPath);
  const prior = state.daemonState[name];
  if (p.status === "fault") {
    state.daemonState[name] = { known: false };
    await emitWatchError(name, p.code, `daemon probe fault at ${socketPath}: ${p.message}`, emit);
    return;
  }
  const reachable = p.status === "reachable";
  if (prior.known && prior.reachable !== reachable) {
    await emit(buildDaemonEvent(name, socketPath, reachable, prior.reachable));
  }
  state.daemonState[name] = { known: true, reachable };
}

/**
 * One heartbeat turn on the serialized queue: the cursor heartbeat line, then the
 * two daemon re-probes (socket paths ride the attach-time snapshot).
 */
export async function heartbeatTick(att: AttachedLedger, emit: EmitLine): Promise<void> {
  await emit({
    v: 1,
    event: "watch.heartbeat",
    at: nowIso(),
    ledger: { attached: true, path: att.path },
    resume: { auditHeadSeq: contiguousPrefix(att.baselines) },
  });
  await probeAndEmit(att.baselines, "broker", att.snapshot.daemons.broker.socketPath, emit);
  await probeAndEmit(att.baselines, "egress", att.snapshot.daemons.egress.socketPath, emit);
}
