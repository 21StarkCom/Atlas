/**
 * `broker-integrator.e2e` (Task 4.9/4.11) — the PRODUCTION synthesis integrator does a REAL
 * canonical install through the broker's `signAndAdvanceProtectedRef` (no test double). A Tier-2
 * synthesis run integrates onto canonical: the broker signs the `run.integrated` event internally
 * and advances under CAS — proving the keystone RPC + the engine's allocated-seq / prevAuditHead
 * coordination line up end-to-end. This is the loop the earlier apply e2e stubbed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangePlan, ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import { BrokerClient } from "@atlas/broker";
import { GeneratedArtifactGuard, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import type { RetrievalResult } from "../../src/retrieval/layers.js";
import { splitFrontmatter } from "../../src/markdown/parse.js";
import { buildSectionTree, resolveSections } from "../../src/markdown/sections.js";
import { sectionContentHash } from "../../src/markdown/patch.js";
import { riskConfigFrom } from "../../src/policies/risk.js";
import type { ValidationVault } from "../../src/validation/index.js";
import { applySynthesis, type SynthesisApplyDeps } from "../../src/workflows/synthesis.js";
import { makeBrokerIntegrator } from "../../src/workflows/index.js";
import { foldProvenanceFromCanonical } from "../../src/ingest/manifests.js";
import { makePhase2Harness, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const RISK = riskConfigFrom({ tier2_min_confidence: 0.8, tier2_max_changed_lines: 50, tier2_max_sections: 3 });
const ALPHA_ID = "concept-alpha";

class Q implements QuarantineSink { quarantine(_i: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> { return Promise.resolve(); } }

function alphaNote(h: Phase2Harness): ParsedNote {
  const raw = readFileSync(join(h.vaultDir, "note-alpha.md"), "utf8").replace(/\r\n/g, "\n");
  const { body } = splitFrontmatter(raw);
  return { id: ALPHA_ID, path: "note-alpha.md", type: "concept", schemaVersion: 1, title: "Alpha", status: "active", created: "2026-07-14", updated: "2026-07-14", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw };
}
function plan(h: Phase2Harness): ChangePlan {
  const { body } = splitFrontmatter(alphaNote(h).raw);
  const alpha = resolveSections(body).find((s) => s.path === "Alpha")!;
  const op: ChangePlanOperation = { op: "UpdateSection", opVersion: 1, selector: { path: "Alpha", expectedContentHash: sectionContentHash(body.slice(alpha.bodyStart, alpha.bodyEnd)) }, newContent: "Enriched via the real broker.\n" };
  return { target: ALPHA_ID, rationale: "enrich", sourceIds: ["s"], retrievedEvidence: [], confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation: op } as ChangePlan;
}
function retrieval(): RetrievalResult {
  return { items: [{ noteId: ALPHA_ID, sectionPath: "Alpha", score: 1, contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }], sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Alpha", text: "t" }] }] as RetrievalResult["items"], layersUsed: ["vector"], retrievalRunId: "r", mode: "vector", degraded: false };
}
function vault(): ValidationVault {
  return { hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true, hasClaimKey: () => true, hasEvidenceLineage: () => true, hasEvidenceId: () => true, attachWouldDuplicate: () => false };
}

describe("production broker integrator (Task 4.9/4.11)", () => {
  let h: Phase2Harness;
  let client: BrokerClient;
  beforeEach(async () => { h = await makePhase2Harness(); client = await BrokerClient.connect(h.socketPath); });
  afterEach(async () => { client.close(); await h.cleanup(); });

  it("Tier-2 synthesis integrates onto canonical through the REAL broker signAndAdvanceProtectedRef", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const store = h.openStore();
    try {
      const deps: SynthesisApplyDeps = {
        retrieve: async () => retrieval(), generatePlan: async () => plan(h), readNote: () => alphaNote(h), validationVault: vault(),
        supportingEvidenceStates: () => [], evidenceValid: () => true, inputsTrusted: () => true, // Tier-2
        config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true, risk: RISK },
        store, broker: client, backup: h.backup, repo: h.repo(),
        integrate: makeBrokerIntegrator(client, undefined, () => "2026-07-14T00:00:00.000Z"),
        guard: new GeneratedArtifactGuard(new Q()),
        foldProjections: async () => { await foldProvenanceFromCanonical(store, h.repo(), CANONICAL_REF); },
        worktreesPath: h.worktreesPath, canonicalRef: CANONICAL_REF, now: () => "2026-07-14T00:00:00.000Z",
      };
      const res = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "x" }, deps);
      expect(res.mode).toBe("integrated");
      // Canonical genuinely advanced to the agent commit via the broker (CLI never signed).
      const after = h.git(["rev-parse", CANONICAL_REF]);
      expect(after).not.toBe(before);
      expect(after).toBe(res.commitSha);
      expect(h.git(["show", `${CANONICAL_REF}:note-alpha.md`])).toContain("Enriched via the real broker.");
      // The broker's audit chain is intact after the real install.
      const status = await client.getAuditChainStatus();
      expect(status.ok).toBe(true);
    } finally {
      store.close();
    }
  });
});
