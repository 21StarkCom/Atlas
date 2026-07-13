/**
 * `CreateNote` operation payload (Task 2.0). Creates a new canonical note whose
 * natural id is the ChangePlan envelope `target`. Precondition: the id must not
 * already resolve (`expectedAbsent: true`) — a matching id is a typed conflict,
 * never a silent overwrite.
 */
import { z } from "zod";
import { OpVersion1, type OpResult } from "./op-result.js";

export const CreateNoteOpSchema = z
  .object({
    op: z.literal("CreateNote"),
    opVersion: OpVersion1,
    /** Note kind in the wiki taxonomy (project/concept/person/…). */
    noteType: z.string().min(1),
    /** Canonical human-readable title (projected to `notes.title`). */
    title: z.string().min(1),
    /** Initial frontmatter fields (typed scalars/arrays; no nested objects in V1). */
    frontmatter: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]))
      .optional(),
    /** Initial note body (Markdown), if any. */
    body: z.string().optional(),
    /** Precondition token: the target id must not already exist. */
    expectedAbsent: z.literal(true),
  })
  .strict();

export type CreateNoteOp = z.infer<typeof CreateNoteOpSchema>;

export const CREATE_NOTE_ERROR_CODES = ["target-exists", "invalid-frontmatter", "invalid-note-type"] as const;
export type CreateNoteErrorCode = (typeof CREATE_NOTE_ERROR_CODES)[number];
export type CreateNoteResult = OpResult<"CreateNote", CreateNoteErrorCode>;
