/**
 * `CreateRelationship` operation payload (Task 2.0). Records a typed, directed
 * relationship from the envelope `target` note to `object`, with a predicate
 * from the closed relationship enum.
 */
import { z } from "zod";
import { OpVersion1, RelationshipPredicate, type OpResult } from "./op-result.js";

export const CreateRelationshipOpSchema = z
  .object({
    op: z.literal("CreateRelationship"),
    opVersion: OpVersion1,
    predicate: RelationshipPredicate,
    /** The related note's natural identifier (relationship object). */
    object: z.string().min(1),
    /** Optional short qualifier (allowlisted metadata only — never raw content). */
    qualifier: z.string().optional(),
  })
  .strict();

export type CreateRelationshipOp = z.infer<typeof CreateRelationshipOpSchema>;

export const CREATE_RELATIONSHIP_ERROR_CODES = [
  "relationship-exists",
  "unresolved-object",
  "self-relationship",
] as const;
export type CreateRelationshipErrorCode = (typeof CREATE_RELATIONSHIP_ERROR_CODES)[number];
export type CreateRelationshipResult = OpResult<"CreateRelationship", CreateRelationshipErrorCode>;
