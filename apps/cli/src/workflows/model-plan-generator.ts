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
import type { EgressCapability } from "@atlas/broker";
import type { PlanGenerationInput } from "./synthesis.js";

/** The minimal `generateObject` surface the generator needs (a `ModelsClient`). */
export interface PlanModelsClient {
  generateObject<T>(
    req: { model: string; prompt: { ref: string }; input: string; schema: unknown; schemaId: string; maxTokens?: number },
    cap: EgressCapability,
  ): Promise<T>;
}

/** Options binding the generator to a model + the per-generation capability minter. */
export interface PlanGeneratorDeps {
  readonly models: PlanModelsClient;
  /** Mint an egress capability bound to this generation (the run/retrieval correlation id). */
  mintCapability(correlationId: string): EgressCapability;
  readonly model: string;
  readonly maxTokens?: number;
  /** The prompt ref (a stable id, never the prompt body — it lives broker-side). */
  readonly promptRef?: string;
}

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
    const cap = deps.mintCapability(input.retrievalRunId);
    return deps.models.generateObject<ChangePlan>(
      {
        model: deps.model,
        prompt: { ref: deps.promptRef ?? "synthesis-plan" },
        input: planInput(input),
        schema: SCHEMA_REGISTRY.ChangePlan,
        schemaId: "ChangePlan",
        ...(deps.maxTokens !== undefined ? { maxTokens: deps.maxTokens } : {}),
      },
      cap,
    );
  };
}
