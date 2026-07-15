/**
 * `CreateClaim` executor (Task 4.6). Serializes a new claim — with its backing
 * provenance resolved to pinned renditions — into the owning note's `claims:`
 * frontmatter block (the exact shape `foldClaimManifests` reproduces). Markdown is the
 * SSOT: the claim + its provenance evidence are re-derivable by `db rebuild`.
 */
import type { ChangePlanOperation } from "@atlas/contracts";
import { OpExecutionError, type OpContext, type OpOutcome } from "./index.js";
import { appendMap, findClaimNode, openNote, reassemble } from "./frontmatter-edit.js";

type CreateClaimOp = Extract<ChangePlanOperation, { op: "CreateClaim" }>;

export function executeCreateClaim(op: CreateClaimOp, ctx: OpContext): OpOutcome {
  if (ctx.hasClaim(op.claimKey)) {
    throw new OpExecutionError("claim-exists", `claim "${op.claimKey}" already exists in the projection`);
  }
  // Resolve every provenance handle to its concrete ACTIVE rendition — evidence pins
  // the rendition components, never the mutable sourceId alias (design §Claims).
  const renditions: string[] = [];
  for (const p of op.provenance) {
    const resolved = ctx.resolveRendition(p);
    if (resolved === null) {
      throw new OpExecutionError("unresolved-provenance", `provenance "${p}" resolves to no captured rendition`);
    }
    renditions.push(resolved);
  }
  const edit = openNote(ctx.note.raw);
  if (findClaimNode(edit.doc, op.claimKey)) {
    throw new OpExecutionError("claim-exists", `claim "${op.claimKey}" is already present in the note`);
  }
  // Each backing provenance becomes a pending evidence entry (verification defaults to
  // `pending` when omitted; a locator/quoteHash pair is attached later to reach `valid`).
  const evidence = renditions.map((rendition) => ({ rendition }));
  appendMap(edit.doc, "claims", {
    claim_id: op.claimKey,
    text: op.claimText,
    status: "active",
    created_at: ctx.now,
    ...(evidence.length > 0 ? { evidence } : {}),
  });
  return {
    nextText: reassemble(edit),
    summary: `CreateClaim ${op.claimKey} (${renditions.length} provenance)`,
  };
}
