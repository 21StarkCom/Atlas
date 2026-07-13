/**
 * `ProposeArchive` operation payload (Task 2.0). Proposes archiving a note
 * (lifecycle state → archived) without deleting it. Distinct from the Tier-3
 * `ProposeDelete` deletion-proposal (Phase 4) and from selector-based
 * `brain purge` erasure — archiving is reversible and keeps the note in the
 * vault.
 */
import { z } from "zod";
import { OpVersion1, type OpResult } from "./op-result.js";

export const ProposeArchiveOpSchema = z
  .object({
    op: z.literal("ProposeArchive"),
    opVersion: OpVersion1,
    /** Why the note is being archived (allowlisted metadata only). */
    reason: z.string().min(1),
  })
  .strict();

export type ProposeArchiveOp = z.infer<typeof ProposeArchiveOpSchema>;

export const PROPOSE_ARCHIVE_ERROR_CODES = ["already-archived", "note-not-found", "has-active-dependents"] as const;
export type ProposeArchiveErrorCode = (typeof PROPOSE_ARCHIVE_ERROR_CODES)[number];
export type ProposeArchiveResult = OpResult<"ProposeArchive", ProposeArchiveErrorCode>;
