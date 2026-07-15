/**
 * Synthesis plan pipeline (Task 4.5, slice A) — the retrieval-first, fully
 * deterministic-given-its-seams FRONT of the synthesis workflow: `retrieve →
 * pack → generateObject<ChangePlan> → validate (4.4) → effectiveRisk (4.3) →
 * generatePatch (4.2)`. It produces the {@link SynthesisPlan} the apply path
 * (slice B) drives through the 2.5 engine (plan→patch→worktree→commit→integrate).
 *
 * Two invariants this stage OWNS:
 *  - **Retrieval-first (orchestration-enforced).** The plan is generated ONLY
 *    after a real retrieval, and the packed retrieval context is a REQUIRED input
 *    the generator must present. An empty or failed retrieval aborts with {@link
 *    RetrievalRequiredError} BEFORE any ChangePlan is generated — no grounding,
 *    no synthesis (the `retrieval.order-invariant` guarantee).
 *  - **Side-effect-free.** This stage takes only read/compute seams (retrieve,
 *    generate, readNote) — no store/repo/broker/worktree sink. `previewSynthesis`
 *    is therefore provably free of every mutation sink; persistence + the
 *    `GeneratedArtifactGuard` boundary live in the apply slice.
 */
import type { ChangePlan, ChangePlanOperation, NoteType, ParsedNote, RiskTier } from "@atlas/contracts";
import { packContext, type ContextPack } from "../retrieval/pack.js";
import type { RetrievalResult } from "../retrieval/layers.js";
import { generatePatch, isPatchableOp, type Patch } from "../markdown/patch.js";
import { effectiveRisk, type PolicyContext, type RiskConfig } from "../policies/risk.js";
import { validatePlan, type ValidationReport, type ValidationVault } from "../validation/index.js";

/** The three model-authored synthesis workflows (plan §D11 / §2.5). */
export type SynthesisKind = "enrich" | "reconcile" | "maintain";

/** What drives a synthesis run: the target note + the instruction that seeds retrieval + planning. */
export interface WorkflowInput {
  /** The natural id of the note the change targets. */
  readonly target: string;
  /** The instruction/query text that seeds retrieval and the plan generation. */
  readonly instruction: string;
  /** Optional retrieval breadth (defaults to the retriever's own default). */
  readonly retrievalK?: number;
  /** Optional retrieval type filter. */
  readonly typeFilter?: string;
}

/** The grounded input a plan generator receives — it MUST present the packed context. */
export interface PlanGenerationInput {
  readonly kind: SynthesisKind;
  readonly input: WorkflowInput;
  /** The packed retrieval context the model grounds on (retrieval-first). */
  readonly context: ContextPack;
  /** The retrieval run id correlating this plan to its grounding retrieval. */
  readonly retrievalRunId: string;
}

/** The output of the plan pipeline: the plan, its validation, patch, and tier. */
export interface SynthesisPlan {
  readonly retrievalRunId: string;
  readonly changePlan: ChangePlan;
  readonly report: ValidationReport;
  /** The materialized patch, or `null` when the op is unpatchable or validation blocked it. */
  readonly patch: Patch | null;
  /** The effective risk tier (`tier-2` auto-commit vs `tier-3` review). */
  readonly tier: RiskTier;
  /** Whether the plan cleared every Tier-2 gate (validator + policy). */
  readonly tier2Eligible: boolean;
}

/** The read/compute seams the plan pipeline needs (no mutation sink among them). */
export interface SynthesisPlanDeps {
  /** Hybrid retrieval + RRF fusion (Task 3.3). */
  retrieve(query: { text: string; k?: number; filters?: { type?: string } }): Promise<RetrievalResult>;
  /** Generate a ChangePlan grounded on the packed context (broker egress generateObject seam). */
  generatePlan(input: PlanGenerationInput): Promise<ChangePlan>;
  /** Resolve the target note (for patch generation + target type), or `null` if absent. */
  readNote(noteId: string): ParsedNote | null;
  /** The vault/graph resolvers the validator reads. */
  readonly validationVault: ValidationVault;
  /** Verification states of the evidence supporting a plan (evidence-gating input). */
  supportingEvidenceStates(plan: ChangePlan): readonly string[];
  /** Whether every contributing source is trusted (Task 4.8 seam; default supplied by caller). */
  inputsTrusted(plan: ChangePlan): boolean;
  /** Whether every anchored evidence item is `valid` (Task 4.7 seam). */
  evidenceValid(plan: ChangePlan): boolean;
  readonly config: {
    readonly packBudgetTokens: number;
    readonly requireSourcesForSynthesis: boolean;
    readonly risk: RiskConfig;
  };
}

/** Thrown when retrieval fails or returns nothing — no grounding ⇒ no synthesis. */
export class RetrievalRequiredError extends Error {
  readonly code = "retrieval-required" as const;
  constructor(detail: string) {
    super(`synthesis requires a non-empty retrieval grounding: ${detail}`);
    this.name = "RetrievalRequiredError";
  }
}

/**
 * Run the retrieval-first plan pipeline. Retrieval happens FIRST and its packed
 * result is presented to the generator; an empty/failed retrieval throws {@link
 * RetrievalRequiredError} before any plan exists. The returned {@link
 * SynthesisPlan} is pure data — nothing is persisted here.
 */
export async function planSynthesis(
  kind: SynthesisKind,
  input: WorkflowInput,
  deps: SynthesisPlanDeps,
): Promise<SynthesisPlan> {
  // 1. Retrieval-first: a real retrieval must precede — and ground — the plan.
  const retrieval = await deps.retrieve({
    text: input.instruction,
    ...(input.retrievalK !== undefined ? { k: input.retrievalK } : {}),
    ...(input.typeFilter ? { filters: { type: input.typeFilter } } : {}),
  });
  if (retrieval.items.length === 0) {
    throw new RetrievalRequiredError(`retrieval ${retrieval.retrievalRunId} returned no grounding notes`);
  }
  const context = packContext(retrieval, { maxTokens: deps.config.packBudgetTokens });

  // 2. Generate the ChangePlan, grounded on the packed context (retrieval-first:
  // the generator cannot be reached without the packed retrieval result).
  const changePlan = await deps.generatePlan({
    kind,
    input,
    context,
    retrievalRunId: retrieval.retrievalRunId,
  });

  // 3. Validate (4.4). Reserved/immutable/schema violations block here (report.ok
  // = false); review/evidence gates clear tier2Eligible.
  const note = deps.readNote(input.target);
  const targetType: NoteType = note?.type ?? "";
  const report = validatePlan(changePlan, {
    targetType,
    vault: deps.validationVault,
    supportingEvidenceStates: () => deps.supportingEvidenceStates(changePlan),
    config: { requireSourcesForSynthesis: deps.config.requireSourcesForSynthesis },
  });

  // 4. Patch (4.2) — only for a validation-clean, patchable op against a real note.
  const patch =
    report.ok && note !== null && isPatchableOp(changePlan.operation.op)
      ? generatePatch(note, changePlan.operation)
      : null;

  // 5. Effective risk (4.3) — the SOLE risk producer. validationConfidence is
  // derived from the validator's own Tier-2 gate (a cleared gate ⇒ 1, else 0 ⇒
  // fail-closed to Tier-3).
  const policyContext: PolicyContext = {
    targetType,
    changedLines: patch ? changedLinesOf(patch) : 0,
    sections: patch ? sectionsOf(patch) : 0,
    singleNote: true,
    destructive: isDestructive(changePlan.operation),
    inputsTrusted: deps.inputsTrusted(changePlan),
    evidenceValid: deps.evidenceValid(changePlan),
    validationConfidence: report.gates.tier2Eligible ? 1 : 0,
    config: deps.config.risk,
  };
  const tier = effectiveRisk(changePlan, policyContext);

  return {
    retrievalRunId: retrieval.retrievalRunId,
    changePlan,
    report,
    patch,
    tier,
    tier2Eligible: report.gates.tier2Eligible,
  };
}

/** A side-effect-free preview: the plan pipeline result, applied to no sink. */
export interface SynthesisPreview {
  readonly mode: "preview";
  readonly plan: SynthesisPlan;
}

/**
 * Preview a synthesis run: run the plan pipeline and return its result WITHOUT
 * touching any store/repo/broker/worktree sink. Provably side-effect-free — the
 * deps carry no mutation seam.
 */
export async function previewSynthesis(
  kind: SynthesisKind,
  input: WorkflowInput,
  deps: SynthesisPlanDeps,
): Promise<SynthesisPreview> {
  return { mode: "preview", plan: await planSynthesis(kind, input, deps) };
}

/** Count the changed lines a patch introduces (replacement/append bodies + scalar edits). */
function changedLinesOf(patch: Patch): number {
  let lines = 0;
  for (const op of patch.ops) {
    if (op.kind === "replace-section-body") lines += Math.max(1, op.newBody.split("\n").filter((l) => l.trim() !== "").length);
    else if (op.kind === "append-to-section") lines += Math.max(1, op.content.split("\n").filter((l) => l.trim() !== "").length);
    else lines += 1; // frontmatter/alias edits are single-line
  }
  return lines;
}

/** Count the distinct sections a patch touches (at least one — the note itself). */
function sectionsOf(patch: Patch): number {
  const paths = new Set<string>();
  for (const op of patch.ops) {
    if (op.kind === "replace-section-body" || op.kind === "append-to-section") paths.add(op.path);
  }
  return Math.max(1, paths.size);
}

/** Whether an operation removes/replaces existing content (destructive class → Tier-3). */
function isDestructive(op: ChangePlanOperation): boolean {
  switch (op.op) {
    case "ProposeArchive":
    case "ProposeMerge":
    case "ProposeRename":
      return true;
    case "SetLink":
      return op.action === "remove";
    default:
      return false;
  }
}
