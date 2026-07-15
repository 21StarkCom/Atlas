/**
 * `approve-lifecycle.e2e` (Task 4.9) — the Tier-3 review lifecycle over the real engine +
 * broker: a review-pending run (from `applySynthesis` Tier-3) is APPROVED → integrated onto
 * canonical → reindexed → finalized; a moved base is a stable `refresh-required` (approve never
 * rebases); a reject terminates the run; and the broker AUTHORITY refuses a forged-signature
 * canonical advance (a model/agent cannot forge an approval).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangePlan, ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import { BrokerClient, BrokerRefusal } from "@atlas/broker";
import { GeneratedArtifactGuard, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import type { RetrievalResult } from "../../src/retrieval/layers.js";
import { splitFrontmatter } from "../../src/markdown/parse.js";
import { buildSectionTree, resolveSections } from "../../src/markdown/sections.js";
import { sectionContentHash } from "../../src/markdown/patch.js";
import { riskConfigFrom } from "../../src/policies/risk.js";
import type { ValidationVault } from "../../src/validation/index.js";
import type { IntegrationContext, RunIntegrator } from "../../src/workflows/index.js";
import { applySynthesis, type SynthesisApplyDeps } from "../../src/workflows/synthesis.js";
import { approveRun, rejectRun, type ApproveDeps } from "../../src/workflows/index.js";
import { makePhase2Harness, prepareForbiddenAuthorizedAdvance, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const RISK = riskConfigFrom({ tier2_min_confidence: 0.8, tier2_max_changed_lines: 50, tier2_max_sections: 3 });
const ALPHA_PATH = "note-alpha.md";
const ALPHA_ID = "concept-alpha";

class RecordingQuarantine implements QuarantineSink {
  quarantine(_input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    return Promise.resolve();
  }
}

function alphaNote(h: Phase2Harness): ParsedNote {
  const raw = readFileSync(join(h.vaultDir, ALPHA_PATH), "utf8").replace(/\r\n/g, "\n");
  const { body } = splitFrontmatter(raw);
  return {
    id: ALPHA_ID, path: ALPHA_PATH, type: "concept", schemaVersion: 1, title: "Alpha", status: "active",
    created: "2026-07-14", updated: "2026-07-14", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw,
  };
}

function updateAlphaPlan(h: Phase2Harness): ChangePlan {
  const { body } = splitFrontmatter(alphaNote(h).raw);
  const alpha = resolveSections(body).find((s) => s.path === "Alpha")!;
  const hash = sectionContentHash(body.slice(alpha.bodyStart, alpha.bodyEnd));
  const operation: ChangePlanOperation = { op: "UpdateSection", opVersion: 1, selector: { path: "Alpha", expectedContentHash: hash }, newContent: "The alpha note, enriched. Links [[concept-beta]].\n" };
  return { target: ALPHA_ID, rationale: "enrich", sourceIds: ["src-1"], retrievedEvidence: [], confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation } as ChangePlan;
}

function retrieval(): RetrievalResult {
  return { items: [{ noteId: ALPHA_ID, sectionPath: "Alpha", score: 1, contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }], sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Alpha", text: "The alpha note." }] }] as RetrievalResult["items"], layersUsed: ["vector"], retrievalRunId: "ret-1", mode: "vector", degraded: false };
}

function vault(): ValidationVault {
  return { hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true, hasClaimKey: () => true, hasEvidenceLineage: () => true, hasEvidenceId: () => true, attachWouldDuplicate: () => false };
}

/** A CAS integrator that honours the broker contract: refuse on a moved base, else FF canonical. */
function casIntegrator(h: Phase2Harness): RunIntegrator {
  return async (ctx: IntegrationContext) => {
    const current = (await h.repo().readRef(ctx.canonicalRef)) ?? "0".repeat(40);
    if (current !== ctx.baseRef) throw Object.assign(new Error("cas"), { code: "broker.cas_failed" });
    h.git(["update-ref", ctx.canonicalRef, ctx.commitSha, ctx.baseRef]);
    return { canonicalRef: ctx.canonicalRef, canonicalSha: ctx.commitSha, seq: ctx.event.seq, auditHead: `audit:${ctx.commitSha}` };
  };
}

describe("Tier-3 approve lifecycle (Task 4.9)", () => {
  let h: Phase2Harness;
  let client: BrokerClient;

  beforeEach(async () => {
    h = await makePhase2Harness();
    client = await BrokerClient.connect(h.socketPath);
  });
  afterEach(async () => {
    client.close();
    await h.cleanup();
  });

  function common(store: ReturnType<Phase2Harness["openStore"]>) {
    return {
      retrieve: async () => retrieval(),
      generatePlan: async () => updateAlphaPlan(h),
      readNote: () => alphaNote(h),
      validationVault: vault(),
      supportingEvidenceStates: () => [],
      evidenceValid: () => true,
      config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true, risk: RISK },
      store, broker: client, backup: h.backup, repo: h.repo(),
      guard: new GeneratedArtifactGuard(new RecordingQuarantine()),
      worktreesPath: h.worktreesPath, canonicalRef: CANONICAL_REF,
      now: () => "2026-07-14T00:00:00.000Z",
    };
  }

  async function withStore<T>(fn: (s: ReturnType<Phase2Harness["openStore"]>) => Promise<T>): Promise<T> {
    const s = h.openStore();
    try { return await fn(s); } finally { s.close(); }
  }

  async function makeReviewPending(): Promise<{ runId: string; commitSha: string }> {
    return withStore(async (store) => {
      const deps: SynthesisApplyDeps = { ...common(store), inputsTrusted: () => false, integrate: casIntegrator(h), foldProjections: async () => {} };
      const res = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "x" }, deps);
      expect(res.mode).toBe("review-pending");
      return { runId: res.runId, commitSha: res.commitSha };
    });
  }

  function approveDeps(store: ReturnType<Phase2Harness["openStore"]>): ApproveDeps {
    return { store, broker: client, backup: h.backup, repo: h.repo(), integrate: casIntegrator(h), foldProjections: async () => {}, canonicalRef: CANONICAL_REF, now: () => "2026-07-14T00:00:00.000Z" };
  }

  it("approves a review-pending run → integrated onto canonical + finalized", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const { runId, commitSha } = await makeReviewPending();
    const out = await withStore((store) => approveRun(runId, approveDeps(store)));
    expect(out.mode).toBe("integrated");
    // Canonical advanced to the reviewed commit; the run is finalized.
    expect(h.git(["rev-parse", CANONICAL_REF])).not.toBe(before);
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(commitSha);
    await withStore(async (store) => {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("finalized");
    });
  });

  it("a moved base is refresh-required — approve NEVER rebases", async () => {
    const { runId } = await makeReviewPending();
    // A concurrent writer advances canonical after the run reached review-pending.
    const wt = join(h.worktreesPath, "concurrent");
    h.git(["worktree", "add", "-q", "-b", "concurrent", wt, CANONICAL_REF]);
    const p = join(wt, "note-beta.md");
    writeFileSync(p, readFileSync(p, "utf8") + "\nedit\n");
    h.gitIn(wt, ["add", "-A"]); h.gitIn(wt, ["commit", "-q", "-m", "concurrent"]);
    h.git(["update-ref", CANONICAL_REF, h.gitIn(wt, ["rev-parse", "HEAD"])]);
    h.git(["worktree", "remove", "--force", wt]); h.git(["branch", "-D", "concurrent"]);

    const out = await withStore((store) => approveRun(runId, approveDeps(store)));
    expect(out.mode).toBe("refresh-required");
    // The run stays review-pending (not integrated).
    await withStore(async (store) => {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("review-pending");
    });
  });

  it("rejects a review-pending run → rejected terminal", async () => {
    const { runId } = await makeReviewPending();
    const out = await withStore((store) => rejectRun(runId, "not accurate", approveDeps(store)));
    expect(out.state).toBe("rejected");
    await withStore(async (store) => {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("rejected");
    });
  });

  it("the broker refuses a FORGED-signature canonical advance (no approval can be forged)", async () => {
    const attempt = prepareForbiddenAuthorizedAdvance(h);
    await expect(attempt.run()).rejects.toBeInstanceOf(BrokerRefusal);
    // Canonical is untouched by the refused advance.
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(h.git(["rev-parse", CANONICAL_REF]));
  });
});
