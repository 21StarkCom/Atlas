/**
 * `SetFrontmatterField` operation payload (Task 2.0). The spec's
 * `Add/UpdateFrontmatterField` — a single add-or-update op discriminated by
 * `mode`. `id` is immutable in V1 and can never be the target field (the
 * validation layer rejects `field: "id"`). `expectedCurrentValueHash` pins the
 * observed value for an `update` so a concurrent change is a typed failure.
 */
import { z } from "zod";
import { Sha256Digest } from "../primitives.js";
import { OpVersion1, type OpResult } from "./op-result.js";

/** A frontmatter scalar/array value (no nested objects in V1). */
export const FrontmatterValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);
export type FrontmatterValue = z.infer<typeof FrontmatterValue>;

export const SetFrontmatterFieldOpSchema = z
  .object({
    op: z.literal("SetFrontmatterField"),
    opVersion: OpVersion1,
    /** `add` requires the field absent; `update` requires it present. */
    mode: z.enum(["add", "update"]),
    /**
     * Frontmatter key. `id` is the immutable identity field and can never be the
     * target (fixes R3-F3): rejected in-schema (field-level refinement) rather
     * than deferred to a later validation layer.
     */
    field: z
      .string()
      .min(1)
      .refine((f) => f !== "id", { message: "field 'id' is immutable and cannot be set" }),
    value: FrontmatterValue,
    /** Precondition token for `update`: hash of the observed current value. */
    expectedCurrentValueHash: Sha256Digest.optional(),
  })
  .strict();

export type SetFrontmatterFieldOp = z.infer<typeof SetFrontmatterFieldOpSchema>;

/**
 * Cross-field invariant for `SetFrontmatterField` (fixes R3-F3): a `mode:
 * "update"` MUST carry `expectedCurrentValueHash` — the precondition token that
 * makes a concurrent change a typed failure instead of a silent overwrite. An
 * `add` (no prior value to pin) must NOT carry it. Kept out of the schema object
 * so the op stays a plain `ZodObject` usable as a `discriminatedUnion` member;
 * run at parse time via the ChangePlan-level `superRefine`.
 */
export function refineSetFrontmatterField(op: SetFrontmatterFieldOp, ctx: z.RefinementCtx): void {
  if (op.mode === "update" && op.expectedCurrentValueHash === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation", "expectedCurrentValueHash"],
      message: "mode 'update' requires expectedCurrentValueHash (the precondition token)",
    });
  }
  if (op.mode === "add" && op.expectedCurrentValueHash !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation", "expectedCurrentValueHash"],
      message: "mode 'add' must not carry expectedCurrentValueHash (no prior value to pin)",
    });
  }
}

export const SET_FRONTMATTER_FIELD_ERROR_CODES = [
  "field-exists",
  "field-not-found",
  "value-hash-mismatch",
  "immutable-field",
  "invalid-value-type",
] as const;
export type SetFrontmatterFieldErrorCode = (typeof SET_FRONTMATTER_FIELD_ERROR_CODES)[number];
export type SetFrontmatterFieldResult = OpResult<"SetFrontmatterField", SetFrontmatterFieldErrorCode>;
