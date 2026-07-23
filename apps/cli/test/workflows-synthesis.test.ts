import { describe, it, expect, vi } from "vitest";
import type { ChangePlan, ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import type { RetrievalResult } from "../src/retrieval/layers.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { buildSectionTree, resolveSections } from "../src/markdown/sections.js";
import { sectionContentHash } from "../src/markdown/patch.js";
import type { ValidationVault } from "../src/validation/index.js";
import {
  planSynthesis,
  previewSynthesis,
  RetrievalRequiredError,
  type PlanGenerationInput,
  type SynthesisPlanDeps,
} from "../src/workflows/synthesis.js";

const NOTE_RAW = `---
id: note-a
type: concept
title: Alpha
status: active
---
# Overview

Intro paragraph.

## Goals

- goal one
`;

function mkNote(raw = NOTE_RAW, id = "note-a"): ParsedNote {
  const { body } = splitFrontmatter(raw);
  return {
    id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw,
  };
}

function retrievalResult(items: RetrievalResult["items"]): RetrievalResult {
  return { items, layersUsed: ["vector"], retrievalRunId: "ret-1", mode: "vector", degraded: false };
}

function rankedItem(noteId: string, sectionPath: string, text: string): RetrievalResult["items"][number] {
  return {
    noteId, sectionPath, score: 1, contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }],
    sensitivity: "internal", trust: "verified", sections: [{ sectionPath, text }],
  } as RetrievalResult["items"][number];
}

/** An UpdateSection ChangePlan grounded on the fixture note's current Goals body. */
function updateGoalsPlan(newContent = "- goal one\n- goal two\n", over: Partial<ChangePlan> = {}): ChangePlan {
  const { body } = splitFrontmatter(NOTE_RAW);
  const goals = resolveSections(body).find((s) => s.path === "Overview/Goals")!;
  const hash = sectionContentHash(body.slice(goals.bodyStart, goals.bodyEnd));
  const operation: ChangePlanOperation = {
    op: "UpdateSection", opVersion: 1, selector: { path: "Overview/Goals", expectedContentHash: hash }, newContent,
  };
  return {
    target: "note-a", rationale: "enrich goals", sourceIds: ["src-1"], retrievedEvidence: [],
    confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation, ...over,
  } as ChangePlan;
}

function vault(over: Partial<ValidationVault> = {}): ValidationVault {
  return {
    hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true, ...over,
  };
}

function deps(over: Partial<SynthesisPlanDeps> = {}): SynthesisPlanDeps {
  return {
    retrieve: async () => retrievalResult([rankedItem("note-a", "Overview/Goals", "- goal one")]),
    generatePlan: async () => updateGoalsPlan(),
    readNote: () => mkNote(),
    validationVault: vault(),
    supportingEvidenceStates: () => [],
    config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true },
    ...over,
  };
}

describe("synthesis: retrieval-first (order-invariant)", () => {
  it("aborts BEFORE generating a plan when retrieval fails — no ChangePlan produced", async () => {
    const generatePlan = vi.fn(async () => updateGoalsPlan());
    await expect(
      planSynthesis("enrich", { target: "note-a", instruction: "add goals" }, deps({ retrieve: async () => { throw new Error("index down"); }, generatePlan })),
    ).rejects.toThrow("index down");
    expect(generatePlan).not.toHaveBeenCalled();
  });

  it("aborts with RetrievalRequiredError on EMPTY retrieval — no ChangePlan produced", async () => {
    const generatePlan = vi.fn(async () => updateGoalsPlan());
    await expect(
      planSynthesis("enrich", { target: "note-a", instruction: "add goals" }, deps({ retrieve: async () => retrievalResult([]), generatePlan })),
    ).rejects.toBeInstanceOf(RetrievalRequiredError);
    expect(generatePlan).not.toHaveBeenCalled();
  });

  it("presents the packed retrieval context to the generator (retrieval precedes + grounds generation)", async () => {
    const generatePlan = vi.fn(async (_input: PlanGenerationInput) => updateGoalsPlan());
    await planSynthesis("enrich", { target: "note-a", instruction: "add goals" }, deps({ generatePlan }));
    expect(generatePlan).toHaveBeenCalledOnce();
    const arg = generatePlan.mock.calls[0]![0];
    expect(arg.retrievalRunId).toBe("ret-1");
    expect(arg.context.notes.map((n) => n.noteId)).toContain("note-a");
  });
});

describe("synthesis: plan → validate → patch (no tier gate)", () => {
  it("produces a patch for a clean, patchable op against a real note", async () => {
    const plan = await planSynthesis("enrich", { target: "note-a", instruction: "add a goal" }, deps());
    expect(plan.report.ok).toBe(true);
    expect(plan.patch).not.toBeNull();
    expect(plan.patch!.noteId).toBe("note-a");
  });

  it("validates a large edit clean — there is no changed-lines tier bound", async () => {
    const big = Array.from({ length: 60 }, (_, i) => `- goal ${i}`).join("\n") + "\n";
    const plan = await planSynthesis("enrich", { target: "note-a", instruction: "add many goals" }, deps({ generatePlan: async () => updateGoalsPlan(big) }));
    expect(plan.report.ok).toBe(true);
    expect(plan.patch).not.toBeNull();
  });

  it("blocks (report.ok=false) and produces no patch when validation rejects the op", async () => {
    // A reserved op is rejected by validation; no patch is materialized.
    const reserved = { op: "CreateTask", opVersion: 1 } as ChangePlanOperation;
    const plan = await planSynthesis("maintain", { target: "note-a", instruction: "x" }, deps({ generatePlan: async () => updateGoalsPlan(undefined, { operation: reserved }) }));
    expect(plan.report.ok).toBe(false);
    expect(plan.report.findings.map((f) => f.code)).toContain("reserved-operation");
    expect(plan.patch).toBeNull();
  });
});

describe("synthesis: preview is side-effect-free", () => {
  it("returns the plan result touching no mutation sink (deps carry none)", async () => {
    const d = deps();
    const preview = await previewSynthesis("enrich", { target: "note-a", instruction: "add a goal" }, d);
    expect(preview.mode).toBe("preview");
    expect(preview.plan.changePlan.operation.op).toBe("UpdateSection");
    // The deps interface exposes only read/compute seams — there is no store/repo/
    // commit sink to assert-unused; side-effect-freedom is structural.
    expect(Object.keys(d)).toEqual(
      expect.arrayContaining(["retrieve", "generatePlan", "readNote", "validationVault", "config"]),
    );
    expect(Object.keys(d)).not.toContain("store");
    expect(Object.keys(d)).not.toContain("repo");
    expect(Object.keys(d)).not.toContain("broker");
  });
});
