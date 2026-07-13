/**
 * `UpdateSection` operation payload (Task 2.0). Replaces the body of an existing
 * section addressed by a stable selector. `selector.expectedContentHash` is
 * REQUIRED here — an update must pin the content it observed so a concurrent
 * edit is a typed precondition failure, not a lost update.
 */
import { z } from "zod";
import { OpVersion1, SectionSelector, type OpResult } from "./op-result.js";

export const UpdateSectionOpSchema = z
  .object({
    op: z.literal("UpdateSection"),
    opVersion: OpVersion1,
    selector: SectionSelector.extend({
      expectedContentHash: SectionSelector.shape.expectedContentHash.unwrap(),
    }),
    /** The replacement section body (Markdown). */
    newContent: z.string(),
  })
  .strict();

export type UpdateSectionOp = z.infer<typeof UpdateSectionOpSchema>;

export const UPDATE_SECTION_ERROR_CODES = [
  "section-not-found",
  "content-hash-mismatch",
  "ambiguous-section",
] as const;
export type UpdateSectionErrorCode = (typeof UPDATE_SECTION_ERROR_CODES)[number];
export type UpdateSectionResult = OpResult<"UpdateSection", UpdateSectionErrorCode>;
