/**
 * `inprocess-integrator.e2e` (phase-2 in-process cutover, task 2.2, ADR-0003) —
 * a Tier-2 synthesis run integrates onto canonical through the IN-PROCESS seam
 * (`makeInProcessIntegrator` + `makeInProcessAuditBroker`), with NO broker daemon
 * and NO attestation-signed `refs/audit/runs` append / WORM anchor. Proves:
 *   - the ChangePlan applies + advances the canonical ref daemon-free;
 *   - the apply produces EXACTLY ONE commit touching only the ChangePlan's paths
 *     (partial one-commit-per-ChangePlan proof; full mutation order is Phase 3);
 *   - the audit ref is UNTOUCHED (no audit/WORM append rides the integrate step).
 *
 * The harness still stands up a broker (shared fixture), but this test never
 * connects it: the run drives entirely through the in-process factories.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRunId, type AuditEvent, type ChangePlan, type ChangePlanOperation, type ParsedNote, type RunManifest } from "@atlas/contracts";
import { GeneratedArtifactGuard, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import type { RetrievalResult } from "../../src/retrieval/layers.js";
import { splitFrontmatter } from "../../src/markdown/parse.js";
import { buildSectionTree, resolveSections } from "../../src/markdown/sections.js";
import { sectionContentHash } from "../../src/markdown/patch.js";
import { riskConfigFrom } from "../../src/policies/risk.js";
import type { ValidationVault } from "../../src/validation/index.js";
import { applySynthesis, type SynthesisApplyDeps } from "../../src/workflows/synthesis.js";
import { makeBrokerIntegrator, makeInProcessBrokerClient, type RunIntegrator } from "../../src/workflows/index.js";
import { foldProvenanceFromCanonical } from "../../src/ingest/manifests.js";
import { makePhase2Harness, CANONICAL_REF, AUDIT_REF, type Phase2Harness } from "./phase2-support.js";

const RISK = riskConfigFrom({ tier2_min_confidence: 0.8, tier2_max_changed_lines: 50, tier2_max_sections: 3 });
const ALPHA_ID = "concept-alpha";
const NOW = () => "2026-07-14T00:00:00.000Z";

class Q implements QuarantineSink {
  quarantine(_i: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    return Promise.resolve();
  }
}

function alphaNote(h: Phase2Harness): ParsedNote {
  const raw = readFileSync(join(h.vaultDir, "note-alpha.md"), "utf8").replace(/\r\n/g, "\n");
  const { body } = splitFrontmatter(raw);
  return { id: ALPHA_ID, path: "note-alpha.md", type: "concept", schemaVersion: 1, title: "Alpha", status: "active", created: "2026-07-14", updated: "2026-07-14", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw };
}
function plan(h: Phase2Harness): ChangePlan {
  const { body } = splitFrontmatter(alphaNote(h).raw);
  const alpha = resolveSections(body).find((s) => s.path === "Alpha")!;
  const op: ChangePlanOperation = { op: "UpdateSection", opVersion: 1, selector: { path: "Alpha", expectedContentHash: sectionContentHash(body.slice(alpha.bodyStart, alpha.bodyEnd)) }, newContent: "Enriched in-process, daemon-free.\n" };
  return { target: ALPHA_ID, rationale: "enrich", sourceIds: ["s"], retrievedEvidence: [], confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation: op } as ChangePlan;
}
function retrieval(): RetrievalResult {
  return { items: [{ noteId: ALPHA_ID, sectionPath: "Alpha", score: 1, contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }], sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Alpha", text: "t" }] }] as RetrievalResult["items"], layersUsed: ["vector"], retrievalRunId: "r", mode: "vector", degraded: false };
}
function vault(): ValidationVault {
  return { hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true, hasClaimKey: () => true, hasEvidenceLineage: () => true, hasEvidenceId: () => true, attachWouldDuplicate: () => false };
}

describe("in-process integrator (phase-2 cutover, ADR-0003)", () => {
  let h: Phase2Harness;
  beforeEach(async () => { h = await makePhase2Harness(); });
  afterEach(async () => { await h.cleanup(); });

  it("Tier-2 synthesis integrates onto canonical in-process — one commit, no audit/WORM append", async () => {
    // The audit ref head (or "<none>" when it has never been appended — in-process
    // captures never create it). Read null-safe: `rev-parse` throws on an absent ref.
    const auditHead = (): string => {
      try {
        return h.git(["rev-parse", "--verify", "--quiet", AUDIT_REF]) || "<none>";
      } catch {
        return "<none>";
      }
    };
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const auditBefore = auditHead();
    const repo = h.repo();
    const broker = makeInProcessBrokerClient(repo, CANONICAL_REF);
    const store = h.openStore();
    try {
      const deps: SynthesisApplyDeps = {
        retrieve: async () => retrieval(), generatePlan: async () => plan(h), readNote: () => alphaNote(h), validationVault: vault(),
        supportingEvidenceStates: () => [], evidenceValid: () => true, inputsTrusted: () => true, // Tier-2
        config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true, risk: RISK },
        store, broker, backup: h.backup, repo,
        integrate: makeBrokerIntegrator(broker, undefined, NOW),
        guard: new GeneratedArtifactGuard(new Q()),
        foldProjections: async () => { await foldProvenanceFromCanonical(store, repo, CANONICAL_REF); },
        worktreesPath: h.worktreesPath, canonicalRef: CANONICAL_REF, now: NOW,
      };
      const res = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "x" }, deps);
      expect(res.mode).toBe("integrated");

      // Canonical advanced to the agent commit, daemon-free.
      const after = h.git(["rev-parse", CANONICAL_REF]);
      expect(after).not.toBe(before);
      expect(after).toBe(res.commitSha);
      expect(h.git(["show", `${CANONICAL_REF}:note-alpha.md`])).toContain("Enriched in-process, daemon-free.");

      // Deterministic authorship: the agent commit is now FF-installed DIRECTLY onto
      // canonical (no broker re-authors it), so BOTH author and committer must be the
      // required `Aryeh Stark <aryeh@21stark.com>` (ADR-0003, finding #4).
      expect(h.git(["show", "-s", "--format=%an <%ae>", after])).toBe("Aryeh Stark <aryeh@21stark.com>");
      expect(h.git(["show", "-s", "--format=%cn <%ce>", after])).toBe("Aryeh Stark <aryeh@21stark.com>");

      // Exactly ONE commit, touching only the ChangePlan's path.
      expect(h.git(["rev-list", "--count", `${before}..${after}`])).toBe("1");
      const touched = h.git(["diff", "--name-only", before, after]).split("\n").filter(Boolean);
      expect(touched).toEqual(["note-alpha.md"]);

      // NO audit/WORM append: the audit ref head is unmoved by the integrate step.
      expect(auditHead()).toBe(auditBefore);
    } finally {
      store.close();
    }
  });

  it("crash after the in-process FF but before SQLite step 3 recovers FORWARD (containment-first, empty audit head)", async () => {
    // The v2 in-process integrator has NO audit append — the recovery probe's
    // `signAndAppendAuditEvent(run.integrated)` always refuses (`audit_kind_not_signable`),
    // so a naive "un-anchored ⇒ nothing installed ⇒ drop the intent" would STRAND an
    // advanced canonical ref against an agent-committed run. This drives exactly that
    // crash: `perform` advances canonical (the real in-process FF) then THROWS before
    // the engine's §2.8 step-3 SQLite write. Recovery must check canonical CONTAINMENT
    // first and complete the integration forward with an EMPTY audit head.
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const repo = h.repo();
    const broker = makeInProcessBrokerClient(repo, CANONICAL_REF);
    const store = h.openStore();
    try {
      const realIntegrate = makeBrokerIntegrator(broker, undefined, NOW);
      // A crash AFTER canonical fast-forwards but BEFORE the engine records step 3.
      const crashingIntegrate: RunIntegrator = async (ctx) => {
        await realIntegrate(ctx); // canonical genuinely advances in-process here
        throw new Error("crash after canonical FF, before SQLite step 3");
      };
      const deps: SynthesisApplyDeps = {
        retrieve: async () => retrieval(), generatePlan: async () => plan(h), readNote: () => alphaNote(h), validationVault: vault(),
        supportingEvidenceStates: () => [], evidenceValid: () => true, inputsTrusted: () => true,
        config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true, risk: RISK },
        store, broker, backup: h.backup, repo,
        integrate: crashingIntegrate,
        guard: new GeneratedArtifactGuard(new Q()),
        foldProjections: async () => { await foldProvenanceFromCanonical(store, repo, CANONICAL_REF); },
        worktreesPath: h.worktreesPath, canonicalRef: CANONICAL_REF, now: NOW,
      };
      const res = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "x" }, deps);

      // The run rolled FORWARD to integrated despite the crash — canonical advanced, and
      // the ledger recorded the integration (no stranded advanced-ref / pending intent).
      expect(res.mode).toBe("integrated");
      const after = h.git(["rev-parse", CANONICAL_REF]);
      expect(after).not.toBe(before);
      expect(after).toBe(res.commitSha);
      const runState = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(res.runId) as { status: string } | undefined;
      expect(runState?.status).not.toBe("agent-committed");
      // The recorded integration carries an EMPTY audit head (no audit ref this phase).
      const pending = store.db.prepare(`SELECT COUNT(*) AS n FROM audit_intents WHERE run_id = ? AND state = 'pending'`).get(res.runId) as { n: number };
      expect(pending.n).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("in-process general advance (phase-2 cutover, ADR-0003) — canonical-ref confinement + event/manifest binding", () => {
  let h: Phase2Harness;
  beforeEach(async () => { h = await makePhase2Harness(); });
  afterEach(async () => { await h.cleanup(); });

  const FIXED = "2026-07-14T00:00:00.000Z";

  /** A commit that fast-forwards canonical (child of canonical adding a note). */
  function buildFfCommit(): string {
    const branch = `ff-${newRunId()}`;
    const wtDir = join(h.worktreesPath, branch);
    h.git(["worktree", "add", "-q", "-b", branch, wtDir, CANONICAL_REF]);
    try {
      writeFileSync(join(wtDir, "advance.md"), "# advance\n", "utf8");
      h.gitIn(wtDir, ["add", "-A"]);
      h.gitIn(wtDir, ["commit", "-q", "-m", "ff candidate"]);
      return h.gitIn(wtDir, ["rev-parse", "HEAD"]);
    } finally {
      h.git(["worktree", "remove", "--force", wtDir]);
      try { h.git(["branch", "-D", branch]); } catch { /* best-effort */ }
    }
  }

  function manifestFor(runId: string, base: string): RunManifest {
    return { schemaVersion: 1, runId, state: "integrated", createdAt: FIXED, canonicalBaseCommit: base, targets: [] };
  }
  function eventFor(runId: string, canonicalCommit: string, kind: AuditEvent["kind"] = "run.integrated"): Omit<AuditEvent, "prevAuditHead"> {
    return { schemaVersion: 1, eventId: newRunId(), kind, seq: 0, occurredAt: FIXED, runId, subjects: [], canonicalCommit, detail: {} };
  }

  it("advances canonical on a well-bound request (the gate is not vacuously always-throwing)", async () => {
    const base = h.git(["rev-parse", CANONICAL_REF]);
    const broker = makeInProcessBrokerClient(h.repo(), CANONICAL_REF);
    const commit = buildFfCommit();
    const runId = newRunId();
    const res = await broker.signAndAdvanceProtectedRef({ ref: CANONICAL_REF, expectedOld: base, newCommit: commit, manifest: manifestFor(runId, base), event: eventFor(runId, commit) });
    expect(res.newCommit).toBe(commit);
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(commit);
  });

  it("refuses a ref that is not the configured canonical ref (confinement) — canonical immobile", async () => {
    const base = h.git(["rev-parse", CANONICAL_REF]);
    const broker = makeInProcessBrokerClient(h.repo(), CANONICAL_REF);
    const commit = buildFfCommit();
    const runId = newRunId();
    // A non-canonical protected-looking ref (the broker's general advance was protected-set-scoped;
    // in-process only canonical remains). Must refuse BEFORE any side effect.
    await expect(
      broker.signAndAdvanceProtectedRef({ ref: "refs/heads/other", expectedOld: base, newCommit: commit, manifest: manifestFor(runId, base), event: eventFor(runId, commit) }),
    ).rejects.toMatchObject({ code: "broker.ref_not_protected" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(base);
  });

  it("refuses an event whose runId ≠ the manifest runId — canonical immobile", async () => {
    const base = h.git(["rev-parse", CANONICAL_REF]);
    const broker = makeInProcessBrokerClient(h.repo(), CANONICAL_REF);
    const commit = buildFfCommit();
    const runId = newRunId();
    await expect(
      broker.signAndAdvanceProtectedRef({ ref: CANONICAL_REF, expectedOld: base, newCommit: commit, manifest: manifestFor(runId, base), event: eventFor(newRunId(), commit) }),
    ).rejects.toMatchObject({ code: "broker.event_binding_mismatch" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(base);
  });

  it("refuses an event whose canonicalCommit ≠ the commit being installed — canonical immobile", async () => {
    const base = h.git(["rev-parse", CANONICAL_REF]);
    const broker = makeInProcessBrokerClient(h.repo(), CANONICAL_REF);
    const commit = buildFfCommit();
    const runId = newRunId();
    // The event commits to `base` (a stale/forged sha), not the commit actually being installed.
    await expect(
      broker.signAndAdvanceProtectedRef({ ref: CANONICAL_REF, expectedOld: base, newCommit: commit, manifest: manifestFor(runId, base), event: eventFor(runId, base) }),
    ).rejects.toMatchObject({ code: "broker.event_binding_mismatch" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(base);
  });

  it("refuses a non-installing event kind (e.g. run.rejected) laundered onto a canonical move — canonical immobile", async () => {
    const base = h.git(["rev-parse", CANONICAL_REF]);
    const broker = makeInProcessBrokerClient(h.repo(), CANONICAL_REF);
    const commit = buildFfCommit();
    const runId = newRunId();
    await expect(
      broker.signAndAdvanceProtectedRef({ ref: CANONICAL_REF, expectedOld: base, newCommit: commit, manifest: manifestFor(runId, base), event: eventFor(runId, commit, "run.rejected") }),
    ).rejects.toMatchObject({ code: "broker.event_binding_mismatch" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(base);
  });
});
