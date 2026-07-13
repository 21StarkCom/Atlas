/**
 * `ChangePlanSchema` — the Phase-2 contracts gate (Task 2.0, fixes R3-F1).
 *
 * A ChangePlan is the stable Phase-1 ENVELOPE (`changeplan-envelope.ts`) crossed
 * with a per-operation discriminated payload. This module assembles the
 * `ChangePlanOperation` union over ALL 17 operations (15 active + the 2 reserved
 * task ops) from the per-op files under `ops/`, then extends the envelope with a
 * schema version + the `operation` payload.
 *
 * Byte-identity of a serialized ChangePlan across the CLI/broker process seam is
 * THE hard contract (`contracts.operations.test`): the CLI mints a plan, the
 * broker re-derives and re-verifies it, and both must produce byte-identical
 * `canonicalSerialize` output. The discriminant `op` + independently-versioned
 * `opVersion` per payload keep the surface evolvable without breaking that seam.
 */
import { z } from "zod";
import { ChangePlanEnvelopeSchema } from "./changeplan-envelope.js";
import { SchemaVersion1 } from "./primitives.js";
import { CHANGE_PLAN_OPS, type ChangePlanOpName } from "./ops/op-result.js";

import { CreateNoteOpSchema } from "./ops/create-note.js";
import { UpdateSectionOpSchema } from "./ops/update-section.js";
import { AppendSectionOpSchema } from "./ops/append-section.js";
import { SetFrontmatterFieldOpSchema } from "./ops/frontmatter.js";
import { AddAliasOpSchema } from "./ops/add-alias.js";
import { SetLinkOpSchema } from "./ops/links.js";
import { CreateRelationshipOpSchema } from "./ops/relationship.js";
import { CreateClaimOpSchema } from "./ops/claim.js";
import {
  AttachEvidenceOpSchema,
  UpdateEvidenceVerificationOpSchema,
  refineAttachEvidence,
} from "./ops/evidence.js";
import { ProposeMergeOpSchema } from "./ops/merge.js";
import { ProposeRenameOpSchema, refineProposeRename } from "./ops/rename.js";
import { refineSetFrontmatterField } from "./ops/frontmatter.js";
import { ProposeArchiveOpSchema } from "./ops/archive.js";
import { PromoteTrustOpSchema, RevokeTrustOpSchema } from "./ops/trust.js";
import { CreateTaskOpSchema, UpdateTaskStateOpSchema } from "./ops/task.js";

/**
 * The discriminated union over every operation payload, keyed on `op`. The
 * member list is checked against `CHANGE_PLAN_OPS` (the SSOT of op names) at
 * module load so the union and the name list can never silently diverge.
 */
export const ChangePlanOperationSchema = z.discriminatedUnion("op", [
  CreateNoteOpSchema,
  UpdateSectionOpSchema,
  AppendSectionOpSchema,
  SetFrontmatterFieldOpSchema,
  AddAliasOpSchema,
  SetLinkOpSchema,
  CreateRelationshipOpSchema,
  CreateClaimOpSchema,
  AttachEvidenceOpSchema,
  UpdateEvidenceVerificationOpSchema,
  ProposeMergeOpSchema,
  ProposeRenameOpSchema,
  ProposeArchiveOpSchema,
  PromoteTrustOpSchema,
  RevokeTrustOpSchema,
  CreateTaskOpSchema,
  UpdateTaskStateOpSchema,
]);

export type ChangePlanOperation = z.infer<typeof ChangePlanOperationSchema>;

/**
 * The set of `op` discriminants the union actually declares, derived from the
 * union's option schemas — used to assert coverage against `CHANGE_PLAN_OPS`.
 */
export const CHANGE_PLAN_OPERATION_NAMES: readonly ChangePlanOpName[] =
  ChangePlanOperationSchema.options.map((o) => o.shape.op.value as ChangePlanOpName);

// Load-time invariant: the union covers EXACTLY the 17 declared op names (no
// missing member, no stray/duplicate). A drift here is a build-time throw, not a
// silently incomplete gate.
{
  const declared = [...CHANGE_PLAN_OPS].sort();
  const inUnion = [...CHANGE_PLAN_OPERATION_NAMES].sort();
  const same = declared.length === inUnion.length && declared.every((n, i) => n === inUnion[i]);
  if (!same) {
    throw new Error(
      `ChangePlanOperation union (${inUnion.join(",")}) does not match CHANGE_PLAN_OPS (${declared.join(",")})`,
    );
  }
}

/**
 * The full ChangePlan: the Phase-1 envelope + a schema version + one operation
 * payload. `.strict()` IS applied at this layer (fixes R3-F2): an unknown
 * top-level field must be a hard rejection, never silently stripped before
 * `canonicalSerialize` — otherwise a stowaway envelope key would be dropped on
 * one side of the CLI/broker seam and the two processes could disagree on the
 * canonical bytes. The nested `operation` payload is itself `.strict()`, so
 * unknown keys are rejected at both the envelope and payload levels.
 */
export const ChangePlanSchema = ChangePlanEnvelopeSchema.extend({
  schemaVersion: SchemaVersion1,
  operation: ChangePlanOperationSchema,
})
  .strict()
  // Per-op cross-field invariants (fixes R3-F3) that a single `ZodObject` cannot
  // express are dispatched here from the op files, so each op's rules stay
  // co-located with its schema while the union members remain plain
  // `ZodObject`s (a `discriminatedUnion` rejects refined members).
  .superRefine((plan, ctx) => {
    switch (plan.operation.op) {
      case "SetFrontmatterField":
        refineSetFrontmatterField(plan.operation, ctx);
        break;
      case "ProposeRename":
        refineProposeRename(plan.operation, ctx);
        break;
      case "AttachEvidence":
        refineAttachEvidence(plan.operation, ctx);
        break;
      default:
        break;
    }
  });

export type ChangePlan = z.infer<typeof ChangePlanSchema>;

export {
  CHANGE_PLAN_OPS,
  RESERVED_OPS,
  isReservedOp,
  type ChangePlanOpName,
  type ReservedOpName,
  type OpResult,
  type OpResultStatus,
  OP_RESULT_STATUSES,
} from "./ops/op-result.js";
