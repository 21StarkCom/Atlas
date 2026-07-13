/**
 * `ProposeMerge` operation payload (Task 2.0). Proposes merging one or more
 * source notes into a survivor. Review-gated (Tier-3 by construction): merging
 * is not auto-committable. `id` is never changed — the survivor keeps its id and
 * absorbs aliases/links per the reconcile policy.
 */
import { z } from "zod";
import { OpVersion1, type OpResult } from "./op-result.js";

export const ProposeMergeOpSchema = z
  .object({
    op: z.literal("ProposeMerge"),
    opVersion: OpVersion1,
    /** The note that survives the merge (natural id). */
    survivor: z.string().min(1),
    /** The notes merged into the survivor (natural ids); must be non-empty and exclude the survivor. */
    sourceNotes: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ProposeMergeOp = z.infer<typeof ProposeMergeOpSchema>;

export const PROPOSE_MERGE_ERROR_CODES = [
  "survivor-not-found",
  "source-not-found",
  "survivor-in-sources",
  "empty-source-set",
] as const;
export type ProposeMergeErrorCode = (typeof PROPOSE_MERGE_ERROR_CODES)[number];
export type ProposeMergeResult = OpResult<"ProposeMerge", ProposeMergeErrorCode>;
