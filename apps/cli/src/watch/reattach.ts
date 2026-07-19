/**
 * `watch/reattach` — mid-stream re-attach with the incarnation reset (SP-1
 * Phase 5 Task 2). Invoked by the orchestrator after the poll loop resolves
 * `"reattach"` (ledger vanish / atomic replace / schema-head change). Re-runs the
 * FULL atomic attach: `attachLedger` constructs a fresh `SourceBaselines` from
 * scratch — every dedup field (contiguous prefix, sparse set, high-space +
 * model-call sets, jobs map, backup row, daemon baselines) is re-seeded for the
 * NEW attach epoch and never carried across (a restore rewind can legitimately
 * re-issue seqs an older incarnation already observed; a stale set would suppress
 * the live-only high-space rows forever). On a still-absent ledger it returns a
 * `DetachedLedger`, so the orchestrator falls into its detached loop rather than
 * spinning here.
 */
import { attachLedger } from "./attach.js";
import type { AttachContext, Attachment, WatchOpts } from "./types.js";

/** A fresh `Attachment` with reset baselines; `DetachedLedger` if the ledger is still gone. */
export async function reattach(path: string, opts: WatchOpts, ctx: AttachContext): Promise<Attachment> {
  return attachLedger(path, opts, ctx);
}
