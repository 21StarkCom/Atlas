/**
 * `support/change-plan-fixtures` — the valid-ChangePlan builder extracted from the
 * retired phase2 e2e harness (#334): `model-output-export-surface.test.ts` still
 * gates the synthesis operation gate with it.
 */
import { ChangePlanSchema, type ChangePlan, type ChangePlanOpName, type RiskTier } from "@atlas/contracts";

const HASH = "a".repeat(64);
const RENDITION_ID = `sha256:${HASH}:text/markdown:1:1`;

const OP_FIXTURES: Readonly<Record<ChangePlanOpName, Record<string, unknown>>> = {
  CreateNote: { op: "CreateNote", opVersion: 1, noteType: "concept", title: "Model Derived", frontmatter: { status: "active" }, body: "# Model\n\nbody", expectedAbsent: true },
  UpdateSection: { op: "UpdateSection", opVersion: 1, newContent: "replaced body", selector: { path: "Overview", expectedContentHash: `sha256:${HASH}` } },
  AppendSection: { op: "AppendSection", opVersion: 1, content: "appended line", createIfAbsent: true, selector: { path: "Log" } },
  SetFrontmatterField: { op: "SetFrontmatterField", opVersion: 1, field: "status", value: "archived", mode: "update", expectedCurrentValueHash: `sha256:${HASH}` },
  AddAlias: { op: "AddAlias", opVersion: 1, alias: "Alias" },
  SetLink: { op: "SetLink", opVersion: 1, action: "add", linkTarget: "note/2026/other", alias: "Other" },
  CreateRelationship: { op: "CreateRelationship", opVersion: 1, predicate: "depends-on", object: "note/2026/other" },
  CreateClaim: { op: "CreateClaim", opVersion: 1, claimText: "A claim.", claimKey: "claim/x", provenance: [RENDITION_ID] },
  AttachEvidence: { op: "AttachEvidence", opVersion: 1, claimKey: "claim/x", renditionId: RENDITION_ID, locator: "char:0-42", quoteHash: `sha256:${HASH}`, verification: "valid" },
  UpdateEvidenceVerification: { op: "UpdateEvidenceVerification", opVersion: 1, claimKey: "claim/x", lineageId: `sha256:${HASH}`, supersedesEvidenceId: `sha256:${HASH}`, expectedSupersededRenditionId: RENDITION_ID, toVerification: "valid", replacementRenditionId: `sha256:${HASH}:text/markdown:1:2`, locator: "char:0-42", quoteHash: `sha256:${HASH}` },
  ProposeMerge: { op: "ProposeMerge", opVersion: 1, survivor: "note/2026/survivor", sourceNotes: ["note/2026/dup"] },
  ProposeRename: { op: "ProposeRename", opVersion: 1, newTitle: "Renamed", newAliases: ["Old Name"] },
  ProposeArchive: { op: "ProposeArchive", opVersion: 1, reason: "superseded by a newer note" },
  CreateTask: { op: "CreateTask", opVersion: 1, title: "Reserved task", state: "open", due: "2026-08-01" },
  UpdateTaskState: { op: "UpdateTaskState", opVersion: 1, taskId: "note/2026/task", toState: "done" },
};

export function validChangePlan(
  opName: ChangePlanOpName,
  over: { proposedRisk?: RiskTier; injection?: string } = {},
): ChangePlan {
  const operation = OP_FIXTURES[opName];
  if (operation === undefined) throw new Error(`no valid fixture for op "${opName}" — add one to OP_FIXTURES`);
  const injection = over.injection ?? "model-derived change";
  return ChangePlanSchema.parse({
    target: injection.slice(0, 60) || "concept-alpha",
    rationale: injection,
    sourceIds: [injection],
    retrievedEvidence: [],
    confidence: 0.99,
    proposedRisk: over.proposedRisk ?? "tier-1",
    reversibility: "reversible",
    schemaVersion: 1,
    operation,
  });
}
