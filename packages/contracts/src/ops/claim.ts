/**
 * `CreateClaim` operation payload (Task 2.0). Records a factual claim on the
 * target note. `claimKey` is the stable natural key used for dedup/upsert;
 * `provenance` carries pinned `contentId`/`renditionId` references only (never
 * the mutable `sourceId` alias, never raw quoted content).
 */
import { z } from "zod";
import { OpVersion1, ProvenanceRef, type OpResult } from "./op-result.js";

export const CreateClaimOpSchema = z
  .object({
    op: z.literal("CreateClaim"),
    opVersion: OpVersion1,
    /** Stable natural key for the claim (upsert conflict target). */
    claimKey: z.string().min(1),
    /** The claim statement (canonical Markdown text). */
    claimText: z.string().min(1),
    /** Pinned provenance references backing the claim (D3 handles). */
    provenance: z.array(ProvenanceRef).min(1),
  })
  .strict();

export type CreateClaimOp = z.infer<typeof CreateClaimOpSchema>;

export const CREATE_CLAIM_ERROR_CODES = ["claim-exists", "missing-provenance", "unresolved-provenance"] as const;
export type CreateClaimErrorCode = (typeof CREATE_CLAIM_ERROR_CODES)[number];
export type CreateClaimResult = OpResult<"CreateClaim", CreateClaimErrorCode>;
