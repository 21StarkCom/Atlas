/**
 * `AddAlias` operation payload (Task 2.0). Adds an alias to a note. The
 * normalized identity key is recomputed canonically by the applying layer
 * (`normalizeIdentityKey`); a caller-supplied `normalizedKey` is advisory and
 * validated against the recomputation — a mismatch is a typed failure.
 */
import { z } from "zod";
import { OpVersion1, type OpResult } from "./op-result.js";

export const AddAliasOpSchema = z
  .object({
    op: z.literal("AddAlias"),
    opVersion: OpVersion1,
    /** The human-readable alias text (may be mixed-script, e.g. Hebrew/English). */
    alias: z.string().min(1),
    /** Advisory normalized identity key (recomputed + verified by the applier). */
    normalizedKey: z.string().min(1).optional(),
  })
  .strict();

export type AddAliasOp = z.infer<typeof AddAliasOpSchema>;

export const ADD_ALIAS_ERROR_CODES = [
  "alias-exists",
  "alias-collision",
  "normalized-key-mismatch",
] as const;
export type AddAliasErrorCode = (typeof ADD_ALIAS_ERROR_CODES)[number];
export type AddAliasResult = OpResult<"AddAlias", AddAliasErrorCode>;
