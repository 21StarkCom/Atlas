/**
 * Trust operations (Task 2.0): `PromoteTrust` and `RevokeTrust`. Both operate on
 * a source capture addressed by a pinned `contentId`/`renditionId` handle. These
 * are privileged, broker-authorized changes at execution time (Phase 4) — this
 * file fixes only the payload surface.
 */
import { z } from "zod";
import { OpVersion1, ProvenanceRef, TrustLevel, type OpResult } from "./op-result.js";

export const PromoteTrustOpSchema = z
  .object({
    op: z.literal("PromoteTrust"),
    opVersion: OpVersion1,
    /** The source handle whose trust is changing (D3 contentId/renditionId). */
    sourceHandle: ProvenanceRef,
    /** The trust level to promote to. */
    toLevel: TrustLevel,
    /** Justification (allowlisted metadata only). */
    reason: z.string().min(1),
  })
  .strict();

export type PromoteTrustOp = z.infer<typeof PromoteTrustOpSchema>;

export const PROMOTE_TRUST_ERROR_CODES = [
  "source-not-found",
  "not-a-promotion",
  "invalid-trust-level",
] as const;
export type PromoteTrustErrorCode = (typeof PROMOTE_TRUST_ERROR_CODES)[number];
export type PromoteTrustResult = OpResult<"PromoteTrust", PromoteTrustErrorCode>;

export const RevokeTrustOpSchema = z
  .object({
    op: z.literal("RevokeTrust"),
    opVersion: OpVersion1,
    sourceHandle: ProvenanceRef,
    /** Justification (allowlisted metadata only). */
    reason: z.string().min(1),
  })
  .strict();

export type RevokeTrustOp = z.infer<typeof RevokeTrustOpSchema>;

export const REVOKE_TRUST_ERROR_CODES = ["source-not-found", "already-untrusted"] as const;
export type RevokeTrustErrorCode = (typeof REVOKE_TRUST_ERROR_CODES)[number];
export type RevokeTrustResult = OpResult<"RevokeTrust", RevokeTrustErrorCode>;
