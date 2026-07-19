/**
 * `watch/stubs` — the remaining Phase-5 symbols the orchestrator references,
 * declared with their FINAL signatures and minimal typed bodies so the build gate
 * passes with no forward reference to unwritten code (plan Phase 3 Task 4).
 * Phase 5 moves these into their final modules (`replay.ts`, `reattach.ts`) and
 * FILLS THE BODIES — the signatures never change. The registry row stays
 * `implemented:false` until Phase 5 (the flip is the completeness gate).
 *
 * Phase 4 already landed the real `diffSources` (`diff.ts`), `heartbeatTick` +
 * `emitWatchError` (`heartbeat.ts`), and the payload builders (`events.ts`).
 */
import type {
  AttachContext,
  Attachment,
  AttachedLedger,
  EmitLine,
  ReplayWindow,
  WatchOpts,
} from "./types.js";
import { attachLedger } from "./attach.js";

/** Phase 5 Task 1 fills this: replay the immutable captured window. Typed no-op until then. */
export async function runReplay(_window: ReplayWindow, _emit: EmitLine): Promise<void> {
  return;
}

/** Phase 5 Task 1 fills this: the immediate post-replay heartbeat. Typed no-op until then. */
export async function emitPostReplayHeartbeat(_att: AttachedLedger, _emit: EmitLine): Promise<void> {
  return;
}

/**
 * Phase 5 Task 2 fills this with the incarnation-reset re-attach. The current body
 * already does the honest core — re-run `attachLedger` (which seeds FRESH baselines
 * by construction, so the incarnation reset holds even before Phase 5 hardens it).
 */
export async function reattach(path: string, opts: WatchOpts, ctx: AttachContext): Promise<Attachment> {
  return attachLedger(path, opts, ctx);
}
