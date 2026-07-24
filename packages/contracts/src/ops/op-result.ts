/**
 * Shared op-payload building blocks (Task 2.0 — Phase-2 contracts gate).
 *
 * Every `ChangePlanOperation` variant lives in its own file under `ops/` and
 * imports its shared enums + the per-op result shape from here. `changeplan.ts`
 * imports the ops; the ops import this module — so there is no import cycle
 * (op file → op-result; changeplan → op files → op-result).
 *
 * These are the cross-op primitives fixed once so two processes serialize op
 * payloads BYTE-IDENTICALLY (the seam contract proven by
 * `contracts.operations.test`): stable enums, a stable section-selector +
 * precondition-token shape, and a stable per-op result envelope.
 */
import { z } from "zod";
import { Sha256Digest } from "../primitives.js";
import { parseSourceHandle } from "../ids.js";

/**
 * The closed set of operation discriminants — the `op` literal every payload
 * carries. This is the SSOT the discriminated union in `changeplan.ts` and the
 * `contracts.operations.test` fixture matrix are both checked against, so a new
 * op cannot be added to one without the other.
 *
 * 12 operations total (v2 contract demolition + the phase-4 persistence strip that
 * retired the rendition-pinned claims/evidence ops): 10 active + the 2 reserved task
 * ops. `ProposeDelete` is intentionally NOT part of this gate — it is the Tier-3
 * deletion-*proposal* op the Phase-4 `maintain`/`reconcile` loop emits and is
 * gated with that phase (its op file is not in the Task 2.0 file list). The v1
 * `CreateClaim`/`AttachEvidence`/`UpdateEvidenceVerification` ops were removed with
 * the flat vault-derived `evidence` model (#337) — evidence is authored via the
 * dedicated evidence commands, not a ChangePlan op.
 */
export const CHANGE_PLAN_OPS = [
  "CreateNote",
  "UpdateSection",
  "AppendSection",
  "SetFrontmatterField",
  "AddAlias",
  "SetLink",
  "CreateRelationship",
  "ProposeMerge",
  "ProposeRename",
  "ProposeArchive",
  // reserved forward-compatible surface (schemas ship + validate; policy-rejected in V1)
  "CreateTask",
  "UpdateTaskState",
] as const;

export type ChangePlanOpName = (typeof CHANGE_PLAN_OPS)[number];

/**
 * The reserved operation names. Their schemas ship and validate so a future
 * task workflow slots in without a schema break, but the validation layer
 * rejects any ChangePlan carrying one with the stable code `reserved-operation`
 * (owned by Phase-4's operation gate — this package only declares the surface).
 */
export const RESERVED_OPS = ["CreateTask", "UpdateTaskState"] as const;
export type ReservedOpName = (typeof RESERVED_OPS)[number];

/** True if `op` is a reserved (policy-rejected in V1) operation name. */
export function isReservedOp(op: string): op is ReservedOpName {
  return (RESERVED_OPS as readonly string[]).includes(op);
}

/**
 * Every op payload is versioned independently (`opVersion`) so a payload shape
 * can evolve without a ChangePlan-envelope schema break. V1 pins every op to 1.
 */
export const OpVersion1 = z.literal(1);

/**
 * A stable section selector within a note (dictionary §0: sections addressed by
 * a stable path, not by ordinal). `expectedContentHash` is the precondition
 * token — the section's current normalized content hash the proposer observed;
 * a mismatch at apply time is a typed precondition failure, never a silent
 * overwrite. Optional only where the op semantics allow creation of an absent
 * section.
 */
export const SectionSelector = z.object({
  path: z.string().min(1),
  expectedContentHash: Sha256Digest.optional(),
});
export type SectionSelector = z.infer<typeof SectionSelector>;

/**
 * A pinned provenance reference carried by ops that assert factual content
 * (claims/evidence). It is a FULL serialized `contentId` or `renditionId` (D3) —
 * never the mutable `sourceId` alias, never raw quoted content (plan §2.5:
 * allowlisted metadata only).
 *
 * Fixes R3-F4: validated by the contracts SSOT parser (`parseSourceHandle`),
 * not a lenient `nonempty string`. This enforces the D3 rules — lowercase-hex
 * 64-char hash, colon-delimited media type, and (for renditions) integer
 * extractor/normalizer versions — from the single module that owns handle
 * parsing across the process seam, so a producer and verifier can never disagree
 * on what a provenance ref means.
 */
export const ProvenanceRef = z.string().superRefine((s, ctx) => {
  try {
    parseSourceHandle(s);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
  }
});
export type ProvenanceRef = z.infer<typeof ProvenanceRef>;

/** Relationship predicate enum (spec: `CreateRelationship` predicate enum). */
export const RELATIONSHIP_PREDICATES = [
  "relates-to",
  "depends-on",
  "part-of",
  "supersedes",
  "contradicts",
  "derived-from",
] as const;
export type RelationshipPredicate = (typeof RELATIONSHIP_PREDICATES)[number];
export const RelationshipPredicate = z.enum(RELATIONSHIP_PREDICATES);

/**
 * Trust levels a source capture can hold. The mutating trust ChangePlan ops were
 * retired in v2 (contract demolition); this enum survives only for the read-only
 * trust surface (`source trust show`) still consumed by the CLI.
 */
export const TRUST_LEVELS = ["untrusted", "provisional", "trusted", "authoritative"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export const TrustLevel = z.enum(TRUST_LEVELS);

/** Reserved task lifecycle states (spec: reserved task surface). */
export const TASK_STATES = ["open", "in-progress", "blocked", "done", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TaskState = z.enum(TASK_STATES);

/**
 * The terminal disposition of an applied (or previewed) operation. `preview` is
 * the non-mutating default surface (`ingest`/`enrich`/… without `--apply`);
 * `applied` records a committed mutation; `rejected` carries a stable per-op
 * error code.
 */
export const OP_RESULT_STATUSES = ["preview", "applied", "rejected"] as const;
export type OpResultStatus = (typeof OP_RESULT_STATUSES)[number];

/**
 * A per-op result. `op` echoes the discriminant so a heterogeneous result array
 * (one entry per operation in a multi-op ChangePlan) stays self-describing;
 * `errorCode` is present iff `status === "rejected"` and is one of that op's
 * declared error codes.
 */
export interface OpResult<Name extends ChangePlanOpName, ErrorCode extends string> {
  readonly op: Name;
  readonly status: OpResultStatus;
  /** Stable per-op error code; only meaningful when `status` is `rejected`. */
  readonly errorCode?: ErrorCode;
  /** Human-readable detail (allowlisted metadata only — never raw content). */
  readonly detail?: string;
}
