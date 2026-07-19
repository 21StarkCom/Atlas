/**
 * `watch/incarnation` — the sole owner of `SourceBaselines` MUTATION (SP-1
 * Phase 4 Task 1 / Phase 5 Task 3). Every piece of dedup state here is scoped to
 * one ledger incarnation (one attach epoch): seeded by the attach, advanced by
 * the diff, and NEVER carried across a re-attach.
 */
import type { SourceBaselines } from "./types.js";

/**
 * The `resume.auditHeadSeq` accessor: the contiguous-committed-prefix high-water
 * mark of the low (`run.%`) seq space among rows this incarnation has emitted or
 * baseline-seen — NEVER the max emitted seq (a resume from the prefix re-delivers
 * anything in-flight above a gap: boundary duplicates, zero loss). −1 = none.
 */
export function contiguousPrefix(state: SourceBaselines): number {
  return state.auditContiguousPrefix;
}

/**
 * Record a low-space seq as emitted and advance the contiguous prefix through any
 * now-contiguous run absorbed from the sparse set (late gap-fills collapse in).
 */
export function recordLowSpaceEmitted(state: SourceBaselines, seq: number): void {
  state.auditSparseEmitted.add(seq);
  while (state.auditSparseEmitted.has(state.auditContiguousPrefix + 1)) {
    state.auditContiguousPrefix += 1;
    state.auditSparseEmitted.delete(state.auditContiguousPrefix);
  }
}
