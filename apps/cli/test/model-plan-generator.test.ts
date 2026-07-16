/**
 * `model-plan-generator` (Task 4.11) — the production plan stage calls
 * `generateObject<ChangePlan>` with the grounded retrieval context + instruction as input, the
 * ChangePlan schema referenced by its registry id, mints a per-generation capability, and returns
 * the model's ChangePlan.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChangePlan } from "@atlas/contracts";
import type { EgressCapability } from "@atlas/broker";
import { makeModelPlanGenerator, type PlanModelsClient } from "../src/workflows/model-plan-generator.js";
import type { PlanGenerationInput } from "../src/workflows/synthesis.js";

const PLAN: ChangePlan = {
  target: "note-a", rationale: "enrich", sourceIds: ["s"], retrievedEvidence: [], confidence: 0.95,
  proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1,
  operation: { op: "AppendSection", opVersion: 1, content: "x", createIfAbsent: true, selector: { path: "Log" } },
} as ChangePlan;

const INPUT: PlanGenerationInput = {
  kind: "enrich",
  input: { target: "note-a", instruction: "add a log entry" },
  context: { notes: [{ noteId: "note-a", sectionPath: "Log", text: "t" }] } as never,
  retrievalRunId: "ret-1",
};

describe("makeModelPlanGenerator (Task 4.11)", () => {
  it("calls generateObject<ChangePlan> with the grounded input + schema registry id, returns the plan", async () => {
    const generateObject = vi.fn((_req: { schemaId: string; input: string; prompt: { ref: string } }, _cap: unknown) => Promise.resolve(PLAN as never));
    const models: PlanModelsClient = { generateObject };
    const cap = { keyId: "k" } as unknown as EgressCapability;
    const mintCapability = vi.fn(() => cap);
    const generate = makeModelPlanGenerator({ models, mintCapability, model: "gemini-3.5-flash", maxTokens: 4096 });

    const plan = await generate(INPUT);
    expect(plan).toEqual(PLAN);

    // A per-generation capability was minted bound to the retrieval correlation id.
    expect(mintCapability).toHaveBeenCalledWith("ret-1");
    // The request carries the schema registry id + the grounded input (instruction + context).
    const req = generateObject.mock.calls[0]![0];
    expect(req.schemaId).toBe("ChangePlan");
    expect(req.prompt.ref).toBe("synthesis-plan");
    const grounded = JSON.parse(req.input);
    expect(grounded.instruction).toBe("add a log entry");
    expect(grounded.retrievalRunId).toBe("ret-1");
    expect(grounded.context.notes[0].noteId).toBe("note-a");
  });
});
