/**
 * Canonical sample ChangePlan per operation (Task 2.0 fixture matrix).
 *
 * Plain data (no Zod) so BOTH the in-process schema-validation test and the
 * out-of-process serialization worker (`serialize-op-worker.mjs`) consume the
 * exact same objects — the byte-identity assertion in `contracts.operations.test`
 * is meaningful only if the two sides serialize identical input.
 *
 * There is exactly one sample per member of `CHANGE_PLAN_OPS` (all 15). Keys are
 * intentionally written in a NON-sorted order so canonical serialization's
 * key-sorting is actually exercised across the seam.
 */
const HASH = "a".repeat(64);
const CONTENT_ID = `sha256:${HASH}:text/markdown`;
const RENDITION_ID = `sha256:${HASH}:text/markdown:1:1`;

/** Wrap an operation payload in a stable ChangePlan envelope. */
function plan(operation, over = {}) {
  return {
    target: "note/2026/example",
    rationale: "seam byte-identity fixture",
    sourceIds: [CONTENT_ID],
    retrievedEvidence: [RENDITION_ID],
    confidence: 0.9,
    proposedRisk: "tier-2",
    reversibility: "reversible",
    schemaVersion: 1,
    operation,
    ...over,
  };
}

export const OP_SAMPLES = [
  plan({
    op: "CreateNote",
    opVersion: 1,
    noteType: "concept",
    title: "Example Note",
    frontmatter: { status: "active", tags: ["a", "b"] },
    body: "# Example\n\nbody",
    expectedAbsent: true,
  }),
  plan({
    op: "UpdateSection",
    opVersion: 1,
    newContent: "replaced body",
    selector: { path: "Overview", expectedContentHash: `sha256:${HASH}` },
  }),
  plan({
    op: "AppendSection",
    opVersion: 1,
    content: "appended line",
    createIfAbsent: true,
    selector: { path: "Log" },
  }),
  plan({
    op: "SetFrontmatterField",
    opVersion: 1,
    field: "status",
    value: "archived",
    mode: "update",
    expectedCurrentValueHash: `sha256:${HASH}`,
  }),
  plan({ op: "AddAlias", opVersion: 1, alias: "אריה Aryeh" }),
  plan({ op: "SetLink", opVersion: 1, action: "add", linkTarget: "note/2026/other", alias: "Other" }),
  plan({ op: "CreateRelationship", opVersion: 1, predicate: "depends-on", object: "note/2026/other" }),
  plan({
    op: "CreateClaim",
    opVersion: 1,
    claimText: "Atlas serializes deterministically.",
    claimKey: "claim/determinism",
    provenance: [RENDITION_ID],
  }),
  plan({
    op: "AttachEvidence",
    opVersion: 1,
    claimKey: "claim/determinism",
    renditionId: RENDITION_ID,
    locator: "char:0-42",
    quoteHash: `sha256:${HASH}`,
    verification: "valid",
  }),
  plan({
    op: "UpdateEvidenceVerification",
    opVersion: 1,
    claimKey: "claim/determinism",
    lineageId: `sha256:${HASH}`,
    supersedesEvidenceId: `sha256:${HASH}`,
    expectedSupersededRenditionId: RENDITION_ID,
    toVerification: "valid",
    replacementRenditionId: `sha256:${HASH}:text/markdown:1:2`,
    locator: "char:0-42",
    quoteHash: `sha256:${HASH}`,
  }),
  plan({ op: "ProposeMerge", opVersion: 1, survivor: "note/2026/survivor", sourceNotes: ["note/2026/dup"] }),
  plan({ op: "ProposeRename", opVersion: 1, newTitle: "Renamed", newAliases: ["Old Name"] }),
  plan({ op: "ProposeArchive", opVersion: 1, reason: "superseded by a newer note" }),
  plan({ op: "CreateTask", opVersion: 1, title: "Reserved task", state: "open", due: "2026-08-01" }),
  plan({ op: "UpdateTaskState", opVersion: 1, taskId: "note/2026/task", toState: "done" }),
];
