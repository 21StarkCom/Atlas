/**
 * `synthesis-apply.e2e` — the Task 4.5 slice-B apply path driven through the REAL 2.5
 * engine over the Phase-2 harness (real workflow store + git-backed vault + broker
 * socket). It proves the apply ORCHESTRATION `applySynthesis` produces: retrieval-first
 * abort (no run/plan/commit), Tier-2 auto-integration under CAS with rebase-on-CAS-miss,
 * Tier-3 durable `review-pending` (no canonical move), the `GeneratedArtifactGuard`
 * boundary, and a provably side-effect-free preview.
 *
 * The canonical-install SEAM (`RunIntegrator`) is what Task 4.5 produces; the broker's
 * `advanceProtectedRef` it wraps is Task 1.6's already-tested primitive (a focused unit
 * test in `workflows-synthesis-integrate.test.ts` covers the wrapper's request/result
 * mapping). Here the seam is a controllable TEST DOUBLE that honours the broker CAS
 * contract exactly — it fast-forwards canonical via git on success and refuses
 * (`broker.cas_failed`) when the base moved — so the engine + apply orchestration are
 * exercised against real CAS semantics without re-testing broker internals.
 */
import { readFileSync, writeFileSync } from "node:fs";
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
import {
  applySynthesis,
  previewSynthesis,
  RetrievalRequiredError,
  type SynthesisApplyDeps,
} from "../../src/workflows/synthesis.js";
import {
  makePhase2Harness,
  snapshotSinks,
  assertSinksUnchanged,
  CANONICAL_REF,
  type Phase2Harness,
} from "./phase2-support.js";

const RISK = riskConfigFrom({ tier2_min_confidence: 0.8, tier2_max_changed_lines: 50, tier2_max_sections: 3 });
const ALPHA_PATH = "note-alpha.md";
const ALPHA_ID = "concept-alpha";

/** A recording quarantine sink for the GeneratedArtifactGuard (holds any tripped entry). */
class RecordingQuarantine implements QuarantineSink {
  readonly entries: { origin: string; findings: readonly SecretFinding[] }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.entries.push({ origin: input.origin, findings: input.findings });
    return Promise.resolve();
  }
}

/** Parse the harness's real note-alpha.md into a {@link ParsedNote} the seams return. */
function alphaNote(h: Phase2Harness): ParsedNote {
  const raw = readFileSync(join(h.vaultDir, ALPHA_PATH), "utf8").replace(/\r\n/g, "\n");
  const { body } = splitFrontmatter(raw);
  return {
    id: ALPHA_ID,
    path: ALPHA_PATH,
    type: "concept",
    schemaVersion: 1,
    title: "Alpha",
    status: "active",
    created: "2026-07-14",
    updated: "2026-07-14",
    aliases: [],
    sources: [],
    declaredSensitivity: "internal",
    links: [],
    sections: buildSectionTree(body),
    contentHash: "sha256:0",
    raw,
  };
}

/** An UpdateSection ChangePlan grounded on note-alpha's current `# Alpha` section. */
function updateAlphaPlan(h: Phase2Harness, newContent: string, over: Partial<ChangePlan> = {}): ChangePlan {
  const { body } = splitFrontmatter(alphaNote(h).raw);
  const alpha = resolveSections(body).find((s) => s.path === "Alpha")!;
  const hash = sectionContentHash(body.slice(alpha.bodyStart, alpha.bodyEnd));
  const operation: ChangePlanOperation = {
    op: "UpdateSection",
    opVersion: 1,
    selector: { path: "Alpha", expectedContentHash: hash },
    newContent,
  };
  return {
    target: ALPHA_ID,
    rationale: "enrich the alpha note",
    sourceIds: ["src-1"],
    retrievedEvidence: [],
    confidence: 0.95,
    proposedRisk: "tier-1",
    reversibility: "reversible",
    schemaVersion: 1,
    operation,
    ...over,
  } as ChangePlan;
}

function retrievalResult(items: RetrievalResult["items"]): RetrievalResult {
  return { items, layersUsed: ["vector"], retrievalRunId: "ret-1", mode: "vector", degraded: false };
}

function rankedItem(): RetrievalResult["items"][number] {
  return {
    noteId: ALPHA_ID,
    sectionPath: "Alpha",
    score: 1,
    contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }],
    sensitivity: "internal",
    trust: "verified",
    sections: [{ sectionPath: "Alpha", text: "The alpha note." }],
  } as RetrievalResult["items"][number];
}

function vault(over: Partial<ValidationVault> = {}): ValidationVault {
  return {
    hasNoteId: () => true,
    identityOwners: () => [],
    hasSourceRef: () => true,
    hasClaimKey: () => true,
    hasEvidenceLineage: () => true,
    hasEvidenceId: () => true,
    attachWouldDuplicate: () => false,
    ...over,
  };
}

/**
 * A TEST DOUBLE for the Tier-2 canonical-install seam that honours the broker CAS
 * contract: refuse (`broker.cas_failed`) when canonical moved off the run's base, else
 * fast-forward canonical to the agent commit via git. `onFirstIntegrate` lets a test
 * simulate a concurrent writer winning the race exactly once.
 */
function casIntegrator(h: Phase2Harness, hooks: { onFirstIntegrate?: () => void } = {}): RunIntegrator {
  let calls = 0;
  return async (ctx: IntegrationContext) => {
    calls += 1;
    if (calls === 1 && hooks.onFirstIntegrate) hooks.onFirstIntegrate();
    const current = (await h.repo().readRef(ctx.canonicalRef)) ?? "0".repeat(40);
    if (current !== ctx.baseRef) {
      throw Object.assign(new Error(`CAS failed: expected ${ctx.baseRef}, found ${current}`), { code: "broker.cas_failed" });
    }
    h.git(["update-ref", ctx.canonicalRef, ctx.commitSha, ctx.baseRef]);
    return { canonicalRef: ctx.canonicalRef, canonicalSha: ctx.commitSha, seq: ctx.event.seq, auditHead: `audit:${ctx.commitSha}` };
  };
}

describe("synthesis apply (Task 4.5 slice B)", () => {
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

  function applyDeps(over: Partial<SynthesisApplyDeps> = {}): SynthesisApplyDeps {
    const store = h.openStore();
    return {
      // pure plan seams
      retrieve: async () => retrievalResult([rankedItem()]),
      generatePlan: async () => updateAlphaPlan(h, "The alpha note, enriched. Links [[concept-beta]].\n"),
      readNote: () => alphaNote(h),
      validationVault: vault(),
      supportingEvidenceStates: () => [],
      inputsTrusted: () => true,
      evidenceValid: () => true,
      config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true, risk: RISK },
      // apply seams
      store,
      broker: client,
      backup: h.backup,
      repo: h.repo(),
      integrate: casIntegrator(h),
      guard: new GeneratedArtifactGuard(quarantine),
      foldProjections: async () => {},
      worktreesPath: h.worktreesPath,
      canonicalRef: CANONICAL_REF,
      now: () => "2026-07-14T00:00:00.000Z",
      ...over,
    };
  }

  it("Tier-2: auto-integrates a clean plan to canonical (attempt 1) + finalizes", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const deps = applyDeps();
    let result;
    try {
      result = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, deps);
    } finally {
      deps.store.close();
    }
    expect(result.mode).toBe("integrated");
    expect(result.attempts).toBe(1);
    expect(result.plan.tier).toBe("tier-2");

    // Canonical advanced to the agent commit; the note change is on the canonical tree.
    const after = h.git(["rev-parse", CANONICAL_REF]);
    expect(after).not.toBe(before);
    expect(after).toBe(result.commitSha);
    const canonicalAlpha = h.git(["show", `${CANONICAL_REF}:${ALPHA_PATH}`]);
    expect(canonicalAlpha).toContain("enriched");

    // The run is durably finalized; the ephemeral worktree is cleaned.
    const store = h.openStore();
    try {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(result.runId) as { status: string };
      expect(row.status).toBe("finalized");
    } finally {
      store.close();
    }
  });

  it("concurrent-integration: canonical moves before commit ⇒ CAS fails, rebase+regenerate, no lost update / duplicate commit", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    // Simulate a concurrent writer landing a commit on canonical during the FIRST
    // integrate attempt, so the run's base is stale and the CAS refuses.
    const onFirstIntegrate = (): void => {
      const wt = join(h.worktreesPath, `concurrent-${before.slice(0, 8)}`);
      h.git(["worktree", "add", "-q", "-b", "concurrent-writer", wt, CANONICAL_REF]);
      const p = join(wt, "note-beta.md");
      const cur = readFileSync(p, "utf8");
      writeFileSync(p, cur + "\nConcurrent edit.\n", "utf8");
      h.gitIn(wt, ["add", "-A"]);
      h.gitIn(wt, ["commit", "-q", "-m", "concurrent writer"]);
      const concurrentSha = h.gitIn(wt, ["rev-parse", "HEAD"]);
      h.git(["update-ref", CANONICAL_REF, concurrentSha, before]);
      h.git(["worktree", "remove", "--force", wt]);
      h.git(["branch", "-D", "concurrent-writer"]);
    };
    const deps = applyDeps({ integrate: casIntegrator(h, { onFirstIntegrate }) });
    let result;
    try {
      result = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, deps);
    } finally {
      deps.store.close();
    }
    expect(result.mode).toBe("integrated");
    expect(result.attempts).toBe(2); // one CAS miss, one success

    // No lost update: BOTH the concurrent writer's commit AND the synthesis commit are on
    // canonical, and exactly ONE synthesis commit exists (no duplicate from the retry).
    const log = h.git(["log", "--format=%s", CANONICAL_REF]).split("\n");
    expect(log.filter((s) => s === "concurrent writer")).toHaveLength(1);
    expect(log.filter((s) => s.startsWith("synthesis(enrich)"))).toHaveLength(1);
    const canonicalAlpha = h.git(["show", `${CANONICAL_REF}:${ALPHA_PATH}`]);
    expect(canonicalAlpha).toContain("enriched");
    const canonicalBeta = h.git(["show", `${CANONICAL_REF}:note-beta.md`]);
    expect(canonicalBeta).toContain("Concurrent edit.");
  });

  it("retrieval-first (apply-side): retrieval failure aborts before any run / plan / commit", async () => {
    const before = snapshotSinks(h);
    const deps = applyDeps({ retrieve: async () => retrievalResult([]) });
    try {
      await expect(
        applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, deps),
      ).rejects.toBeInstanceOf(RetrievalRequiredError);
    } finally {
      deps.store.close();
    }
    // Nothing was persisted or committed: every sink is byte-identical.
    assertSinksUnchanged(before, snapshotSinks(h));
    const store = h.openStore();
    try {
      const runs = store.db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number };
      expect(runs.n).toBe(0);
    } finally {
      store.close();
    }
  });

  it("Tier-3: stops durably at review-pending, canonical UNMOVED (CLI surfaces exit 6)", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    // Untrusted-derived input forces Tier-3.
    const deps = applyDeps({ inputsTrusted: () => false });
    let result;
    try {
      result = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, deps);
    } finally {
      deps.store.close();
    }
    expect(result.mode).toBe("review-pending");
    expect(result.plan.tier).toBe("tier-3");

    // Canonical is UNMOVED; the durable run sits at review-pending with a real agent commit.
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
    const store = h.openStore();
    try {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(result.runId) as { status: string };
      expect(row.status).toBe("review-pending");
    } finally {
      store.close();
    }
    // The agent branch + commit persist (available for approve/refresh); worktree cleaned.
    expect(await h.repo().readRef(result.agentRef)).toBe(result.commitSha);
  });

  it("GeneratedArtifactGuard: a secret in the ChangePlan is quarantined + blocks before any persistence", async () => {
    const before = snapshotSinks(h);
    const secret = "AKIA" + "IOSFODNN7EXAMPLE"; // an AWS-access-key-shaped literal the scanner flags
    const poisoned = updateAlphaPlan(h, "enriched\n", { rationale: `leak ${secret}` });
    const deps = applyDeps({ generatePlan: async () => poisoned });
    try {
      await expect(
        applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, deps),
      ).rejects.toThrow(/secret/i);
    } finally {
      deps.store.close();
    }
    expect(quarantine.entries.length).toBeGreaterThan(0);
    // The guard tripped BEFORE the planned checkpoint — nothing persisted or committed.
    assertSinksUnchanged(before, snapshotSinks(h));
  });

  it("preview is provably side-effect-free across ALL sinks (acceptance parity with 2.6)", async () => {
    const before = snapshotSinks(h);
    // Preview takes only the pure plan seams (a strict subset of the apply deps).
    const deps = applyDeps();
    try {
      const preview = await previewSynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, deps);
      expect(preview.mode).toBe("preview");
      expect(preview.plan.changePlan.operation.op).toBe("UpdateSection");
    } finally {
      deps.store.close();
    }
    assertSinksUnchanged(before, snapshotSinks(h));
  });
});
