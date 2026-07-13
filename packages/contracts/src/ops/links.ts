/**
 * `SetLink` operation payload (Task 2.0). The spec's `Add/RemoveLink` — a single
 * op discriminated by `action`. Adds or removes a `[[wiki-link]]` occurrence.
 * `sectionPath` scopes the change to one section; when omitted the change
 * applies to the note's link set as a whole (add ⇒ appended to a canonical
 * links section; remove ⇒ every matching occurrence).
 */
import { z } from "zod";
import { OpVersion1, type OpResult } from "./op-result.js";

export const SetLinkOpSchema = z
  .object({
    op: z.literal("SetLink"),
    opVersion: OpVersion1,
    action: z.enum(["add", "remove"]),
    /** The link target's natural identifier. */
    linkTarget: z.string().min(1),
    /** Optional display alias for an added link (`[[target|alias]]`). */
    alias: z.string().min(1).optional(),
    /** Optional section scope (stable selector path). */
    sectionPath: z.string().min(1).optional(),
  })
  .strict();

export type SetLinkOp = z.infer<typeof SetLinkOpSchema>;

export const SET_LINK_ERROR_CODES = [
  "link-exists",
  "link-not-found",
  "section-not-found",
  "unresolved-target",
] as const;
export type SetLinkErrorCode = (typeof SET_LINK_ERROR_CODES)[number];
export type SetLinkResult = OpResult<"SetLink", SetLinkErrorCode>;
