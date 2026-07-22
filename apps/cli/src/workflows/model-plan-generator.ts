/**
 * `workflows/model-plan-generator` — the synthesis pipeline's PLAN stage backed by the real model
 * boundary (Task 4.11). It turns the retrieval-first `PlanGenerationInput` into a
 * `generateObject<ChangePlan>` call over the egress broker: the packed retrieval context + the
 * instruction are the grounded input, the ChangePlan schema is referenced by its registry id, and
 * the returned object is re-validated locally against the same schema. This is what replaces the
 * injected `generatePlan` seam the 4.5 apply/refresh paths used — the same shape, now backed by the
 * models client (the credential + network live INSIDE the egress broker; this never touches either).
 */
import { SCHEMA_REGISTRY, type ChangePlan } from "@atlas/contracts";
import { PROMPT_REFS, type RunBinding } from "@atlas/models";
import type { PlanGenerationInput } from "./synthesis.js";

/** The minimal `generateObject` surface the generator needs (a `ModelsClient`). */
export interface PlanModelsClient {
  generateObject<T>(
    req: { model: string; prompt: { ref: string }; input: string; schema: unknown; schemaId: string; maxTokens?: number },
    run: RunBinding,
  ): Promise<T>;
}

/** Options binding the generator to a model + the prompt registry. */
export interface PlanGeneratorDeps {
  readonly models: PlanModelsClient;
  readonly model: string;
  readonly maxTokens?: number;
  /** The prompt ref (a stable id, never the prompt body). */
  readonly promptRef?: string;
}

/**
 * The per-CALL output cap for plan generation. Distinct from the per-RUN egress
 * ceiling: the egress budget projects `input + maxTokens` per call, so passing the
 * run ceiling here made every projection exceed the ceiling by construction —
 * `enrich` was structurally refused (#210, layer 2). 4096 fits Gemini 3.5's
 * thinking spend (~1k tokens, billed inside `maxOutputTokens`) plus a ChangePlan.
 */
export const PLAN_GENERATION_MAX_TOKENS = 4096;

/** Serialize the grounded plan input the model receives (packed retrieval context + instruction). */
function planInput(input: PlanGenerationInput): string {
  return JSON.stringify({
    kind: input.kind,
    instruction: input.input.instruction,
    target: input.input.target,
    retrievalRunId: input.retrievalRunId,
    context: input.context,
  });
}

/**
 * Build the production `generatePlan` seam: `(PlanGenerationInput) => Promise<ChangePlan>` backed by
 * `models.generateObject<ChangePlan>`. The ChangePlan schema is the shared-registry object (id
 * `"ChangePlan"`); the models client re-validates the returned object against it locally.
 */
export function makeModelPlanGenerator(deps: PlanGeneratorDeps): (input: PlanGenerationInput) => Promise<ChangePlan> {
  return async (input: PlanGenerationInput): Promise<ChangePlan> => {
    return deps.models.generateObject<ChangePlan>(
      {
        model: deps.model,
        // The default MUST come from the PROMPT_REFS SSOT — a hand-typed ref here
        // shipped unregistered and killed every synthesis command at the first live
        // daemon (#210).
        prompt: { ref: deps.promptRef ?? PROMPT_REFS.synthesisPlan },
        input: planInput(input),
        schema: SCHEMA_REGISTRY.ChangePlan,
        schemaId: "ChangePlan",
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
      },
      // The transmission binds to the retrieval correlation id (no capability mint).
      { runId: input.retrievalRunId },
    );
  };
}
