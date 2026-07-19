/**
 * `watch/replay` — `--since-seq` replay over the IMMUTABLE captured window (SP-1
 * Phase 5 Task 1). `runReplay` iterates `ReplayWindow.rows` — the rows captured
 * inside the attach transaction — and NEVER re-queries the live connection: a row
 * that committed into range after the transaction closed is absent from the
 * window (keeping the announced `events` count exact) and surfaces through the
 * live diff instead. The hello announced the window; the rows re-send as
 * ordinary `audit` lines in strict `seq` order; then an IMMEDIATE heartbeat
 * advances `resume.auditHeadSeq` to the new contiguous prefix — the first
 * checkpoint a consumer may persist past the replay window (§7.4/§8.1).
 */
import { buildAuditEvent } from "./events.js";
import { contiguousPrefix } from "./incarnation.js";
import { nowIso, type AttachedLedger, type EmitLine, type ReplayWindow } from "./types.js";

/** Re-send the captured rows as ordinary `audit` lines. Takes NO live connection. */
export async function runReplay(window: ReplayWindow, emit: EmitLine): Promise<void> {
  for (const row of window.rows) {
    await emit(buildAuditEvent(row));
  }
}

/**
 * The immediate post-replay heartbeat: the first cursor that is safe to persist
 * past the replay window (the hello deliberately carried `min(sinceSeq, prefix)`,
 * the PRE-replay checkpoint — never the head).
 */
export async function emitPostReplayHeartbeat(att: AttachedLedger, emit: EmitLine): Promise<void> {
  await emit({
    v: 1,
    event: "watch.heartbeat",
    at: nowIso(),
    ledger: { attached: true, path: att.path },
    resume: { auditHeadSeq: contiguousPrefix(att.baselines) },
  });
}
