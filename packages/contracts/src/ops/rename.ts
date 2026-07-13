/**
 * `ProposeRename` operation payload (Task 2.0). Proposes changing a note's
 * title/slug/filename/aliases — NEVER its `id` (immutable in V1; there is no
 * ID-migration operation, spec §"AddAlias/rename"). At least one rename field
 * must be present — an empty rename is rejected in-schema via `refineProposeRename`
 * (fixes R3-F3), kept out of the schema object so this stays a plain `ZodObject`
 * usable as a `discriminatedUnion` member; `changeplan.ts` runs it at parse time.
 */
import { z } from "zod";
import { OpVersion1, type OpResult } from "./op-result.js";

export const ProposeRenameOpSchema = z
  .object({
    op: z.literal("ProposeRename"),
    opVersion: OpVersion1,
    newTitle: z.string().min(1).optional(),
    newSlug: z.string().min(1).optional(),
    newFilename: z.string().min(1).optional(),
    newAliases: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ProposeRenameOp = z.infer<typeof ProposeRenameOpSchema>;

/**
 * Cross-field invariant for `ProposeRename` (fixes R3-F3): at least one of
 * `newTitle` / `newSlug` / `newFilename` / `newAliases` must be present — an
 * empty rename (which would target only the immutable `id`, or nothing) is
 * rejected rather than validating as a no-op. Run at parse time via the
 * ChangePlan-level `superRefine`.
 */
export function refineProposeRename(op: ProposeRenameOp, ctx: z.RefinementCtx): void {
  const hasAny =
    op.newTitle !== undefined ||
    op.newSlug !== undefined ||
    op.newFilename !== undefined ||
    op.newAliases !== undefined;
  if (!hasAny) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation"],
      message: "ProposeRename requires at least one rename field (id is immutable)",
    });
  }
}

export const PROPOSE_RENAME_ERROR_CODES = [
  "no-rename-fields",
  "slug-collision",
  "filename-collision",
  "immutable-id",
] as const;
export type ProposeRenameErrorCode = (typeof PROPOSE_RENAME_ERROR_CODES)[number];
export type ProposeRenameResult = OpResult<"ProposeRename", ProposeRenameErrorCode>;
