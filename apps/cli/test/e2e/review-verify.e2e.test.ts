/**
 * `review-verify.e2e` (Task 4.9) — the read-only `git review` + `git verify` surface: review
 * renders a review-pending run's state/tier/commit + whether it's still FF-integrable; verify
 * confirms the recorded git evidence converges with the observable refs (and detects a
 * divergence), all without mutating anything.
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
import type { IntegrationContext, RunIntegrator } from "../../src/workflows/index.js";
import { applySynthesis, type SynthesisApplyDeps } from "../../src/workflows/synthesis.js";
import { reviewRun, verifyRun } from "../../src/workflows/index.js";
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
  const op: ChangePlanOperation = { op: "UpdateSection", opVersion: 1, selector: { path: "Alpha", expectedContentHash: sectionContentHash(body.slice(alpha.bodyStart, alpha.bodyEnd)) }, newContent: "Enriched.\n" };
  return { target: ALPHA_ID, rationale: "enrich", sourceIds: ["s"], retrievedEvidence: [], confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation: op } as ChangePlan;
}
function retrieval(): RetrievalResult {
  return { items: [{ noteId: ALPHA_ID, sectionPath: "Alpha", score: 1, contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }], sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Alpha", text: "t" }] }] as RetrievalResult["items"], layersUsed: ["vector"], retrievalRunId: "r", mode: "vector", degraded: false };
}
function vault(): ValidationVault {
  return { hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true, hasClaimKey: () => true, hasEvidenceLineage: () => true, hasEvidenceId: () => true, attachWouldDuplicate: () => false };
}
function casIntegrator(h: Phase2Harness): RunIntegrator {
  return async (ctx: IntegrationContext) => {
    const cur = (await h.repo().readRef(ctx.canonicalRef)) ?? "0".repeat(40);
    if (cur !== ctx.baseRef) throw Object.assign(new Error("cas"), { code: "broker.cas_failed" });
    h.git(["update-ref", ctx.canonicalRef, ctx.commitSha, ctx.baseRef]);
    return { canonicalRef: ctx.canonicalRef, canonicalSha: ctx.commitSha, seq: ctx.event.seq, auditHead: "a" };
  };
}

describe("git review + verify (read-only, Task 4.9)", () => {
  let h: Phase2Harness;
  let client: BrokerClient;
  beforeEach(async () => { h = await makePhase2Harness(); client = await BrokerClient.connect(h.socketPath); });
  afterEach(async () => { client.close(); await h.cleanup(); });

  async function reviewPending(): Promise<{ runId: string; commitSha: string }> {
    const store = h.openStore();
    try {
      const deps: SynthesisApplyDeps = {
        retrieve: async () => retrieval(), generatePlan: async () => plan(h), readNote: () => alphaNote(h), validationVault: vault(),
        supportingEvidenceStates: () => [], evidenceValid: () => true, inputsTrusted: () => false,
        config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true, risk: RISK },
        store, broker: client, backup: h.backup, repo: h.repo(), integrate: casIntegrator(h),
        guard: new GeneratedArtifactGuard(new Q()), foldProjections: async () => {}, worktreesPath: h.worktreesPath, canonicalRef: CANONICAL_REF, now: () => "2026-07-14T00:00:00.000Z",
      };
      const res = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "x" }, deps);
      return { runId: res.runId, commitSha: res.commitSha };
    } finally { store.close(); }
  }

  it("review renders a review-pending run + FF-integrable while the base is unmoved", async () => {
    const { runId, commitSha } = await reviewPending();
    const store = h.openStore();
    try {
      const report = await reviewRun(store.db, h.repo(), runId, CANONICAL_REF);
      expect(report.state).toBe("review-pending");
      expect(report.tier).toBe(3);
      expect(report.commitSha).toBe(commitSha);
      expect(report.ffIntegrable).toBe(true);
    } finally { store.close(); }
  });

  it("verify converges when the agent ref matches the recorded commit; detects a mismatch", async () => {
    const { runId, commitSha } = await reviewPending();
    const store = h.openStore();
    try {
      const ok = await verifyRun(store.db, h.repo(), runId);
      expect(ok.convergent).toBe(true);

      // Corrupt the ledger's recorded agent commit → verify detects the divergence.
      store.db.prepare(`UPDATE git_operations SET commit_sha = ? WHERE git_op_id = ?`).run("f".repeat(40), `${runId}:agent-committed`);
      const bad = await verifyRun(store.db, h.repo(), runId);
      expect(bad.convergent).toBe(false);
      expect(bad.divergences[0]!.kind).toBe("agent-commit-missing");
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    } finally { store.close(); }
  });
});
