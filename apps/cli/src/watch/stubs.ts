/**
 * `watch/stubs` — the Phase-4/5 symbols the Phase-3 orchestrator references,
 * declared with their FINAL signatures and minimal typed bodies so the build gate
 * passes with no forward reference to unwritten code (plan Phase 3 Task 4).
 * Phases 4/5 move these into their final modules (`diff.ts`, `replay.ts`,
 * `reattach.ts`, `heartbeat.ts`) and FILL THE BODIES — the signatures never
 * change. The registry row stays `implemented:false` until Phase 5 because these
 * are stubs: the handler is dispatchable for tests, but replay/re-attach/domain
 * semantics are incomplete until their phase lands (the flip is the completeness
 * gate).
 */
import type { SqliteDatabase } from "@atlas/sqlite-store";
import {
  nowIso,
  type AttachContext,
  type Attachment,
  type AttachedLedger,
  type EmitLine,
  type ReplayWindow,
  type SourceBaselines,
  type WatchErrorLine,
  type WatchEvent,
  type WatchOpts,
} from "./types.js";
import { attachLedger } from "./attach.js";

/** Phase 4 Task 1 fills this: per-source diff → ordered events. Phase 3: no domain events. */
export function diffSources(_conn: SqliteDatabase, _state: SourceBaselines): WatchEvent[] {
  return [];
}

/** Phase 5 Task 1 fills this: replay the immutable captured window. Phase 3: typed no-op. */
export async function runReplay(_window: ReplayWindow, _emit: EmitLine): Promise<void> {
  return;
}

/** Phase 5 Task 1 fills this: the immediate post-replay heartbeat. Phase 3: typed no-op. */
export async function emitPostReplayHeartbeat(_att: AttachedLedger, _emit: EmitLine): Promise<void> {
  return;
}

/** Phase 4 Task 3 owns the builder; Phase 5 Task 2 emits it on detach. Phase 3: typed no-op. */
export async function emitWatchError(
  _source: WatchErrorLine["source"],
  _code: string,
  _message: string,
  _emit: EmitLine,
): Promise<void> {
  return;
}

/**
 * Phase 5 Task 2 fills this with the incarnation-reset re-attach. The Phase-3 body
 * already does the honest core — re-run `attachLedger` (which seeds FRESH baselines
 * by construction, so the incarnation reset holds even before Phase 5 hardens it).
 */
export async function reattach(path: string, opts: WatchOpts, ctx: AttachContext): Promise<Attachment> {
  return attachLedger(path, opts, ctx);
}

/**
 * Phase 4 Task 3 fills the daemon-probe + watch.error branches. Phase 3 emits only
 * the bare cursor heartbeat line (attached shape; the detached loop owns its own).
 */
export async function heartbeatTick(att: AttachedLedger, emit: EmitLine): Promise<void> {
  await emit({
    v: 1,
    event: "watch.heartbeat",
    at: nowIso(),
    ledger: { attached: true, path: att.path },
    resume: { auditHeadSeq: att.baselines.auditContiguousPrefix },
  });
}
