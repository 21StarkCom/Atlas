/**
 * Evidence operations (Task 2.0): `AttachEvidence` and
 * `UpdateEvidenceVerification`. Two discriminated members share this file
 * because they operate on the same claim-evidence surface.
 *
 * Evidence is ALWAYS pinned to a concrete `renditionId` (the four
 * `source_renditions` composite-key components) plus an optional `locator` +
 * `quoteHash` — never raw quoted content, never the mutable `sourceId` alias
 * (design §"Claims & provenance"; `claim_evidence` DDL). A `sourceId` supplied
 * at the CLI boundary is resolved to its active `renditionId` there, so the
 * ChangePlan op carries only the pinned form.
 *
 * `UpdateEvidenceVerification` is the **atomic re-anchor / supersede** the
 * rendition-upgrade / evidence-staleness protocol emits: it inserts a NEW
 * evidence head (new immutable `evidenceId`, new pinned `renditionId`, new
 * `locator`/`quoteHash`) and tombstones the prior head linked by
 * `supersedesEvidenceId`, inheriting the stable `lineageId`. The precondition
 * `expectedSupersededRenditionId` is the rendition the proposer observed the old
 * head pinned to, so a concurrent re-point is a typed precondition failure
 * rather than a silent double-supersede.
 */
import { z } from "zod";
import {
  OpVersion1,
  PinnedRenditionRef,
  VerificationState,
  type OpResult,
} from "./op-result.js";

export const AttachEvidenceOpSchema = z
  .object({
    op: z.literal("AttachEvidence"),
    opVersion: OpVersion1,
    /** The claim this evidence supports (natural key). */
    claimKey: z.string().min(1),
    /**
     * Pinned rendition the evidence is drawn from (D3 renditionId). The CLI has
     * already resolved any `sourceId` alias to this concrete active rendition.
     */
    renditionId: PinnedRenditionRef,
    /**
     * Locator into the rendition (scheme-specific: char span, pdf page+span, DOM
     * anchor). Optional at attach; a `locator` + `quoteHash` pair is REQUIRED for
     * any evidence that may later become `valid` (design §"Claims & provenance").
     */
    locator: z.string().min(1).optional(),
    /** Hash of the exact quoted span — the re-anchoring key across renditions. */
    quoteHash: z.string().min(1).optional(),
    /** Initial verification verdict (defaults to `pending` when omitted). */
    verification: VerificationState.optional(),
  })
  .strict();

export type AttachEvidenceOp = z.infer<typeof AttachEvidenceOpSchema>;

/**
 * Cross-field invariant for `AttachEvidence` (fixes R3-F3). `locator` and
 * `quoteHash` are the re-anchoring pair, so they must be supplied together —
 * never one without the other — and BOTH are required whenever the evidence is
 * attached already `valid` (a `valid` verdict asserts the quote was matched, so
 * it cannot lack the anchor it was matched against; design §"Claims &
 * provenance"). `pending` (the default) may still omit the anchor. Encoded as a
 * dispatched refinement (not `.refine` on the schema) so the op schema stays a
 * plain `ZodObject` usable as a `discriminatedUnion` member; `changeplan.ts`
 * runs it at parse time via the ChangePlan-level `superRefine`.
 */
export function refineAttachEvidence(op: AttachEvidenceOp, ctx: z.RefinementCtx): void {
  const hasLocator = op.locator !== undefined;
  const hasQuoteHash = op.quoteHash !== undefined;
  if (hasLocator !== hasQuoteHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation", hasLocator ? "quoteHash" : "locator"],
      message: "locator and quoteHash must be supplied together (the re-anchoring pair)",
    });
  }
  if (op.verification === "valid" && !(hasLocator && hasQuoteHash)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation", "verification"],
      message: "valid evidence requires both locator and quoteHash (the matched-quote anchor)",
    });
  }
}

export const ATTACH_EVIDENCE_ERROR_CODES = [
  "claim-not-found",
  "evidence-exists",
  "unresolved-rendition-ref",
  "invalid-rendition-ref",
  "invalid-locator",
  "missing-quote-anchor",
] as const;
export type AttachEvidenceErrorCode = (typeof ATTACH_EVIDENCE_ERROR_CODES)[number];
export type AttachEvidenceResult = OpResult<"AttachEvidence", AttachEvidenceErrorCode>;

export const UpdateEvidenceVerificationOpSchema = z
  // OPEN (Phase-4 verification, tracked on the Phase-2 gate issue): this shape
  // models only the RE-ANCHOR-to-valid transition — it always requires a
  // replacement rendition + locator + quoteHash. The verification lifecycle also
  // needs STATUS-ONLY outcomes with no re-anchor: `stale` (rendition drifted),
  // `pending` (not yet anchorable), and `failed` (quote-not-found). Phase 4 must
  // extend this op with status-only variants (a discriminated `toVerification`
  // where the non-`valid` arms omit the rendition/locator/quoteHash requirement)
  // before the verification workflow lands. Kept minimal here rather than guessing
  // the Phase-4 semantics into the contract.
  .object({
    op: z.literal("UpdateEvidenceVerification"),
    opVersion: OpVersion1,
    claimKey: z.string().min(1),
    /** Stable lineage key (root head's `evidenceId`) inherited by the new head. */
    lineageId: z.string().min(1),
    /** The current head being re-anchored/superseded — lineage link + precondition. */
    supersedesEvidenceId: z.string().min(1),
    /**
     * Precondition token: the `renditionId` the proposer observed the superseded
     * head pinned to. A mismatch at apply time is a typed precondition failure
     * (`supersede-precondition-failed`), never a silent double re-anchor.
     */
    expectedSupersededRenditionId: PinnedRenditionRef,
    /** The new verification verdict for the re-anchored head. */
    toVerification: VerificationState,
    /** The NEW pinned rendition the head is re-anchored to (the re-pointed active rendition). */
    replacementRenditionId: PinnedRenditionRef,
    /** The re-anchored locator in the new rendition's locator namespace. */
    locator: z.string().min(1),
    /** The quote hash carried across the re-anchor (the deterministic match key). */
    quoteHash: z.string().min(1),
  })
  .strict();

export type UpdateEvidenceVerificationOp = z.infer<typeof UpdateEvidenceVerificationOpSchema>;

export const UPDATE_EVIDENCE_VERIFICATION_ERROR_CODES = [
  "claim-not-found",
  "evidence-not-found",
  "lineage-not-found",
  "supersede-precondition-failed",
  "invalid-rendition-ref",
  "invalid-verification-state",
] as const;
export type UpdateEvidenceVerificationErrorCode =
  (typeof UPDATE_EVIDENCE_VERIFICATION_ERROR_CODES)[number];
export type UpdateEvidenceVerificationResult = OpResult<
  "UpdateEvidenceVerification",
  UpdateEvidenceVerificationErrorCode
>;
