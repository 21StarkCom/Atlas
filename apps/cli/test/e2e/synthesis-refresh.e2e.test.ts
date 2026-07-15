/**
 * `synthesis-refresh.e2e` — Task 4.5 §refresh (slice B2) over the Phase-2 harness.
 *
 * Proves `refreshRun` regenerates a REAL review-pending run (produced by `applySynthesis`
 * Tier-3) against current canonical: a new superseding agent commit, a supersession
 * record, the run STAYS `review-pending`, canonical is UNMOVED, and a repeat refresh
 * against the same canonical head is idempotent (returns the existing superseding commit).
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
import { refreshRun, RefreshError, type SynthesisRefreshDeps } from "../../src/workflows/index.js";
import { makePhase2Harness, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const RISK = riskConfigFrom({ tier2_min_confidence: 0.8, tier2_max_changed_lines: 50, tier2_max_sections: 3 });
const ALPHA_PATH = "note-alpha.md";
const ALPHA_ID = "concept-alpha";

class RecordingQuarantine implements QuarantineSink {
  readonly entries: { origin: string; findings: readonly SecretFinding[] }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.entries.push({ origin: input.origin, findings: input.findings });
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

function updateAlphaPlan(h: Phase2Harness, newContent: string): ChangePlan {
  const { body } = splitFrontmatter(alphaNote(h).raw);
  const alpha = resolveSections(body).find((s) => s.path === "Alpha")!;
  const hash = sectionContentHash(body.slice(alpha.bodyStart, alpha.bodyEnd));
  const operation: ChangePlanOperation = { op: "UpdateSection", opVersion: 1, selector: { path: "Alpha", expectedContentHash: hash }, newContent };
  return {
    target: ALPHA_ID, rationale: "enrich the alpha note", sourceIds: ["src-1"], retrievedEvidence: [],
    confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation,
  } as ChangePlan;
}

function retrievalResult(): RetrievalResult {
  return {
    items: [{ noteId: ALPHA_ID, sectionPath: "Alpha", score: 1, contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }], sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Alpha", text: "The alpha note." }] }] as RetrievalResult["items"],
    layersUsed: ["vector"], retrievalRunId: "ret-1", mode: "vector", degraded: false,
  };
}

function vault(): ValidationVault {
  return { hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true, hasClaimKey: () => true, hasEvidenceLineage: () => true, hasEvidenceId: () => true, attachWouldDuplicate: () => false };
}

/** A CAS integrator (only used to build the Tier-3 review-pending run; it never integrates). */
function casIntegrator(h: Phase2Harness): RunIntegrator {
  return async (ctx: IntegrationContext) => {
    const current = (await h.repo().readRef(ctx.canonicalRef)) ?? "0".repeat(40);
    if (current !== ctx.baseRef) throw Object.assign(new Error("cas"), { code: "broker.cas_failed" });
    h.git(["update-ref", ctx.canonicalRef, ctx.commitSha, ctx.baseRef]);
    return { canonicalRef: ctx.canonicalRef, canonicalSha: ctx.commitSha, seq: ctx.event.seq, auditHead: `audit:${ctx.commitSha}` };
  };
}

describe("synthesis refresh (Task 4.5 slice B2)", () => {
  let h: Phase2Harness;
  let client: BrokerClient;
  let quarantine: RecordingQuarantine;

  beforeEach(async () => {
    h = await makePhase2Harness();
    client = await BrokerClient.connect(h.socketPath);
    quarantine = new RecordingQuarantine();
  });
  afterEach(async () => {
    client.close();
    await h.cleanup();
  });

  /** Common read/compute + engine seams, opening a FRESH store handle per operation. */
  function commonSeams(store: ReturnType<Phase2Harness["openStore"]>) {
    return {
      retrieve: async () => retrievalResult(),
      generatePlan: async () => updateAlphaPlan(h, "The alpha note, enriched. Links [[concept-beta]].\n"),
      readNote: () => alphaNote(h),
      validationVault: vault(),
      supportingEvidenceStates: () => [],
      evidenceValid: () => true,
      config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true, risk: RISK },
      store, broker: client, backup: h.backup, repo: h.repo(),
      guard: new GeneratedArtifactGuard(quarantine),
      worktreesPath: h.worktreesPath, canonicalRef: CANONICAL_REF,
      now: () => "2026-07-14T00:00:00.000Z",
    };
  }

  /** Run a callback against a fresh store handle, closing it after (matches production). */
  async function withStore<T>(fn: (store: ReturnType<Phase2Harness["openStore"]>) => Promise<T>): Promise<T> {
    const store = h.openStore();
    try {
      return await fn(store);
    } finally {
      store.close();
    }
  }

  /** Create a durable Tier-3 review-pending run to refresh. */
  async function makeReviewPendingRun(): Promise<{ runId: string; commitSha: string; agentRef: string }> {
    return withStore(async (store) => {
      const deps: SynthesisApplyDeps = {
        ...commonSeams(store),
        inputsTrusted: () => false, // force Tier-3
        integrate: casIntegrator(h),
        foldProjections: async () => {},
      };
      const res = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, deps);
      expect(res.mode).toBe("review-pending");
      return { runId: res.runId, commitSha: res.commitSha, agentRef: res.agentRef };
    });
  }

  async function doRefresh(runId: string): Promise<Awaited<ReturnType<typeof refreshRun>>> {
    return withStore((store) => refreshRun(runId, "enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, { ...commonSeams(store), inputsTrusted: () => false }));
  }

  it("refreshes a review-pending run: new superseding commit, stays review-pending, canonical UNMOVED", async () => {
    const canonicalBefore = h.git(["rev-parse", CANONICAL_REF]);
    const { runId, commitSha: superseded } = await makeReviewPendingRun();

    const result = await doRefresh(runId);

    expect(result.reused).toBe(false);
    expect(result.state).toBe("review-pending");
    expect(result.superseded).toBe(superseded);
    expect(result.newCommit).not.toBe(superseded);

    // Canonical UNMOVED (refresh never integrates); the run STAYS in the review gate.
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(canonicalBefore);
    // The agent ref advanced to the new superseding commit.
    expect(await h.repo().readRef(`refs/agent/${runId}`)).toBe(result.newCommit);

    await withStore(async (store) => {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("review-pending");
      const sup = store.db.prepare(`SELECT superseded_commit, new_commit FROM run_supersessions WHERE run_id = ?`).get(runId) as { superseded_commit: string; new_commit: string };
      expect(sup.superseded_commit).toBe(superseded);
      expect(sup.new_commit).toBe(result.newCommit);
      // A run.refreshed audit event was appended.
      const ev = store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND event_type = 'run.refreshed'`).get(runId) as { n: number };
      expect(ev.n).toBe(1);
    });
  });

  it("is key-accepting: a repeat refresh against the same canonical head returns the existing commit (idempotent)", async () => {
    const { runId } = await makeReviewPendingRun();
    const first = await doRefresh(runId);
    const second = await doRefresh(runId);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.newCommit).toBe(first.newCommit);
    expect(second.superseded).toBe(first.superseded);
    // Exactly ONE supersession row + ONE run.refreshed event (no duplicate).
    await withStore(async (store) => {
      const sup = store.db.prepare(`SELECT COUNT(*) AS n FROM run_supersessions WHERE run_id = ?`).get(runId) as { n: number };
      expect(sup.n).toBe(1);
      const ev = store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND event_type = 'run.refreshed'`).get(runId) as { n: number };
      expect(ev.n).toBe(1);
    });
  });

  it("refuses to refresh a run that is not review-pending", async () => {
    await expect(doRefresh("01J000000000000000000NORUN")).rejects.toBeInstanceOf(RefreshError);
  });
});
