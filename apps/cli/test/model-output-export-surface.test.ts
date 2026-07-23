/**
 * `model-output-export-surface` — the EXPORT-SURFACE regression the wing reviewer
 * required (round-2 finding 1). The prior design shipped a `MODEL_OUTPUT_TEST_SEAM`
 * symbol + a `modelOutputInternals` object from PRODUCTION `src/`, so any caller could
 * import them and submit a no-op gate / phase 4 — defect #1 survived through an
 * alternate SHIPPED API. This test PINS the production module's export surface to a
 * strict allowlist so no gate/phase-injection hook can ever be re-added to `src/`, and
 * proves the production entry point ignores any extra caller key.
 */
import { describe, it, expect } from "vitest";
import * as modelOutput from "../src/synthesis/model-output.js";
import { OperationForbiddenError, submitModelDerivedOperation, type ModelOutputSubmission } from "../src/synthesis/model-output.js";
import { validChangePlan } from "./support/change-plan-fixtures.js";

describe("model-output export surface: no shipped bypass (round-2 wing finding 1)", () => {
  it("exports EXACTLY the allowlist — no seam symbol, no internals object", () => {
    // The runtime export surface is exactly these three values. `SynthesisExecutor` and
    // `ModelOutputSubmission` are types (erased at runtime) and never appear here.
    expect(Object.keys(modelOutput).sort()).toEqual(["OperationForbiddenError", "assertOperationAllowed", "submitModelDerivedOperation"]);
    // NO CUSTOM symbol-keyed export (the rejected design keyed the bypass by a `unique
    // symbol`). An ESM namespace object carries the well-known `Symbol.toStringTag`
    // ("Module") — that is expected; any OTHER symbol would be a smuggled seam.
    const customSymbols = Object.getOwnPropertySymbols(modelOutput).filter((s) => s !== Symbol.toStringTag);
    expect(customSymbols).toHaveLength(0);
    // Belt-and-braces: the specific bypass names from the rejected design are absent.
    const surface = modelOutput as Record<string, unknown>;
    expect(surface.modelOutputInternals).toBeUndefined();
    expect(surface.MODEL_OUTPUT_TEST_SEAM).toBeUndefined();
    expect(surface.submitThroughGate).toBeUndefined();
    expect(surface.submitWithGate).toBeUndefined();
  });

  it("the production entry point ignores any extra caller key — a RESERVED op is STILL rejected, its executor never runs", async () => {
    // The Phase-2 blanket synthesis refusal is retired (ADR-0003): a synthesis op now
    // executes. What survives is the minimal membership gate — a RESERVED op (CreateTask)
    // is refused fail-closed. Even a caller who CASTS a submission carrying a no-op `gate`
    // + `phase: 4` cannot weaken it: `submitModelDerivedOperation` consults the SSOT gate
    // FIXED inside the boundary, so the reserved op is refused and `execute` never runs.
    const bypassAttempt = {
      execute: () => {
        throw new Error("executor must NOT run — the gate must reject a reserved op first");
      },
      gate: () => {
        /* a no-op gate a caller WISHES were honored */
      },
      phase: 4,
    } as unknown as ModelOutputSubmission;
    await expect(submitModelDerivedOperation(validChangePlan("CreateTask"), bypassAttempt)).rejects.toBeInstanceOf(OperationForbiddenError);
  });

  it("a permitted synthesis op now EXECUTES through the production entry point (no tier gate)", async () => {
    // The v2 gate permits every recognized synthesis op — the injected executor runs.
    let ran = false;
    await submitModelDerivedOperation(validChangePlan("CreateNote"), { execute: () => { ran = true; } });
    expect(ran).toBe(true);
  });
});
