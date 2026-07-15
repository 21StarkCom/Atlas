/**
 * Provenance + reference-integrity validation (Task 4.4). Catches dangling
 * references (target note, relationship object, claim key, provenance/rendition
 * handles, evidence lineage/head) and idempotent-duplicate evidence PRE-COMMIT,
 * so a ChangePlan can never be applied against entities that do not exist. The
 * resolvers live on {@link ValidationContext} (the pipeline wires them to the
 * vault + claims graph); this module is pure over that interface.
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
  "CreateClaim",
  "AttachEvidence",
  "UpdateEvidenceVerification",
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

    case "CreateClaim":
      for (const ref of op.provenance) {
        if (!ctx.vault.hasSourceRef(ref)) dangling("source", `claim provenance «${ref}» resolves to no captured source`);
      }
      break;

    case "AttachEvidence":
      if (!ctx.vault.hasClaimKey(op.claimKey)) dangling("claim", `evidence targets unknown claim «${op.claimKey}»`);
      if (!ctx.vault.hasSourceRef(op.renditionId)) dangling("source", `evidence rendition «${op.renditionId}» resolves to no captured source`);
      if (ctx.vault.attachWouldDuplicate(op)) {
        out.push({ code: "duplicate-evidence", severity: "gate", detail: `evidence for claim «${op.claimKey}» is already attached (idempotent duplicate)` });
      }
      break;

    case "UpdateEvidenceVerification":
      if (!ctx.vault.hasClaimKey(op.claimKey)) dangling("claim", `verification update targets unknown claim «${op.claimKey}»`);
      if (!ctx.vault.hasEvidenceLineage(op.lineageId)) dangling("evidence", `verification update names unknown lineage «${op.lineageId}»`);
      if (!ctx.vault.hasEvidenceId(op.supersedesEvidenceId)) dangling("evidence", `verification update supersedes unknown evidence «${op.supersedesEvidenceId}»`);
      break;

    default:
      break;
  }

  return out;
}
