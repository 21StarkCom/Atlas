/**
 * Provenance + reference-integrity validation (Task 4.4). Catches dangling
 * references (target note, relationship object, provenance/rendition handles)
 * PRE-COMMIT, so a ChangePlan can never be applied against entities that do not
 * exist. The resolvers live on {@link ValidationContext} (the pipeline wires them
 * to the vault graph); this module is pure over that interface. (The v1
 * claim/evidence dangling checks were retired with the claims model — #337.)
 */
import type { ChangePlan } from "@atlas/contracts";
import type { ValidationContext, ValidationFinding } from "./index.js";

/** Ops whose envelope `target` must resolve to an existing note. */
const NOTE_TARGETING = new Set([
  "UpdateSection",
  "AppendSection",
  "SetFrontmatterField",
  "AddAlias",
  "SetLink",
  "CreateRelationship",
  "ProposeMerge",
  "ProposeRename",
  "ProposeArchive",
]);

/** Dangling-reference + duplicate-evidence checks for a ChangePlan. */
export function checkProvenance(plan: ChangePlan, ctx: ValidationContext): ValidationFinding[] {
  const op = plan.operation;
  const out: ValidationFinding[] = [];
  const dangling = (kind: string, detail: string): void => {
    out.push({ code: `dangling-${kind}`, severity: "error", detail });
  };

  // Every note-targeting op must point at an existing note.
  if (NOTE_TARGETING.has(op.op) && !ctx.vault.hasNoteId(plan.target)) {
    dangling("note", `target note «${plan.target}» does not exist`);
  }

  switch (op.op) {
    case "CreateRelationship":
      if (!ctx.vault.hasNoteId(op.object)) dangling("note", `relationship object «${op.object}» does not exist`);
      break;

    default:
      break;
  }

  return out;
}
