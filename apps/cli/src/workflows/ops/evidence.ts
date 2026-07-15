/**
 * Evidence executors (Task 4.6): `AttachEvidence` and `UpdateEvidenceVerification`.
 *
 * Both serialize into the owning claim's `evidence:` list inside the `claims:`
 * frontmatter block. Evidence pins the concrete `renditionId` (resolved from any
 * sourceId alias at the boundary), never raw quoted content. `UpdateEvidenceVerification`
 * is the atomic re-anchor/supersede: it tombstones the prior current head (pinning its
 * explicit `evidence_id` + `lineage_id` so the supersession FK links deterministically)
 * and appends a new current head — leaving exactly one current head per lineage, as the
 * fold's lineage invariant requires.
 */
import { isMap, type YAMLMap } from "yaml";
import type { ChangePlanOperation } from "@atlas/contracts";
import { OpExecutionError, type OpContext, type OpOutcome } from "./index.js";
import { claimEvidenceSeq, findClaimNode, openNote, reassemble } from "./frontmatter-edit.js";

type AttachEvidenceOp = Extract<ChangePlanOperation, { op: "AttachEvidence" }>;
type UpdateEvidenceVerificationOp = Extract<ChangePlanOperation, { op: "UpdateEvidenceVerification" }>;

/** Whether an evidence entry map is a current (non-tombstoned) head. */
function isCurrent(entry: YAMLMap): boolean {
  const c = entry.get("current");
  return c === undefined ? true : c === true;
}

export function executeAttachEvidence(op: AttachEvidenceOp, ctx: OpContext): OpOutcome {
  const rendition = ctx.resolveRendition(op.renditionId);
  if (rendition === null) {
    throw new OpExecutionError("unresolved-rendition-ref", `evidence rendition "${op.renditionId}" resolves to no captured rendition`);
  }
  const edit = openNote(ctx.note.raw);
  const claim = findClaimNode(edit.doc, op.claimKey);
  if (!claim) {
    throw new OpExecutionError("claim-not-found", `claim "${op.claimKey}" is not present in the note`);
  }
  const evSeq = claimEvidenceSeq(edit.doc, claim);
  // Idempotency guard: an identical current pin (rendition + locator) already present.
  for (const it of evSeq.items) {
    if (isMap(it) && isCurrent(it as YAMLMap) && (it as YAMLMap).get("rendition") === rendition && (it as YAMLMap).get("locator") === op.locator) {
      throw new OpExecutionError("evidence-exists", `evidence pinned to ${rendition} is already attached to "${op.claimKey}"`);
    }
  }
  const entry: Record<string, unknown> = { rendition };
  if (op.locator !== undefined) entry.locator = op.locator;
  if (op.quoteHash !== undefined) entry.quote_hash = op.quoteHash;
  if (op.verification !== undefined) entry.verification = op.verification;
  evSeq.add(edit.doc.createNode(entry));
  return { nextText: reassemble(edit), summary: `AttachEvidence to ${op.claimKey} (${op.verification ?? "pending"})` };
}

export function executeUpdateEvidenceVerification(op: UpdateEvidenceVerificationOp, ctx: OpContext): OpOutcome {
  const replacement = ctx.resolveRendition(op.replacementRenditionId);
  if (replacement === null) {
    throw new OpExecutionError("invalid-rendition-ref", `replacement rendition "${op.replacementRenditionId}" resolves to no captured rendition`);
  }
  const edit = openNote(ctx.note.raw);
  const claim = findClaimNode(edit.doc, op.claimKey);
  if (!claim) {
    throw new OpExecutionError("claim-not-found", `claim "${op.claimKey}" is not present in the note`);
  }
  const evSeq = claimEvidenceSeq(edit.doc, claim);
  // Precondition: the current head must still be pinned to the rendition the proposer
  // observed — a concurrent re-point is a typed failure, never a silent double-supersede.
  let prior: YAMLMap | null = null;
  for (const it of evSeq.items) {
    if (isMap(it) && isCurrent(it as YAMLMap) && (it as YAMLMap).get("rendition") === op.expectedSupersededRenditionId) {
      prior = it as YAMLMap;
      break;
    }
  }
  if (!prior) {
    throw new OpExecutionError(
      "supersede-precondition-failed",
      `no current evidence on "${op.claimKey}" is pinned to ${op.expectedSupersededRenditionId} (re-pointed since the plan was read)`,
    );
  }
  // Tombstone the prior head, pinning its explicit id + lineage so the new head's
  // supersedes_evidence_id FK resolves deterministically on rebuild.
  prior.set("evidence_id", op.supersedesEvidenceId);
  prior.set("lineage_id", op.lineageId);
  prior.set("current", false);
  prior.set("tombstoned_at", ctx.now);
  // Append the new re-anchored head (exactly one current head per lineage remains).
  evSeq.add(
    edit.doc.createNode({
      rendition: replacement,
      locator: op.locator,
      quote_hash: op.quoteHash,
      verification: op.toVerification,
      current: true,
      lineage_id: op.lineageId,
      supersedes_evidence_id: op.supersedesEvidenceId,
    }),
  );
  return { nextText: reassemble(edit), summary: `UpdateEvidenceVerification ${op.claimKey} → ${op.toVerification}` };
}
