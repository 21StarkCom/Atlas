/**
 * `AppendSection` operation payload (Task 2.0). Appends content to a section, or
 * creates the section when absent and `createIfAbsent` is set. The selector's
 * `expectedContentHash` is optional: appending is tolerant of trailing growth,
 * but when supplied it still pins the observed tail.
 */
import { z } from "zod";
import { OpVersion1, SectionSelector, type OpResult } from "./op-result.js";

export const AppendSectionOpSchema = z
  .object({
    op: z.literal("AppendSection"),
    opVersion: OpVersion1,
    selector: SectionSelector,
    /** Content appended to the section body (Markdown). */
    content: z.string().min(1),
    /** When true, create the section (at the selector path) if it does not exist. */
    createIfAbsent: z.boolean().optional(),
  })
  .strict();

export type AppendSectionOp = z.infer<typeof AppendSectionOpSchema>;

export const APPEND_SECTION_ERROR_CODES = [
  "section-not-found",
  "content-hash-mismatch",
  "ambiguous-section",
] as const;
export type AppendSectionErrorCode = (typeof APPEND_SECTION_ERROR_CODES)[number];
export type AppendSectionResult = OpResult<"AppendSection", AppendSectionErrorCode>;
