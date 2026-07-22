/**
 * Synthesis plan pipeline + apply path (Task 4.5), REBUILT for the v2 direct-commit
 * mutation order (task 3-2/3-3b, ADR-0003). The plan FRONT is unchanged in spirit:
 * `retrieve → pack → generateObject<ChangePlan> → validate (4.4) → generatePatch (4.2)`.
 * The apply path no longer runs the retired trust/risk-tier/scan-gate machinery —
 * there is no `effectiveRisk`, no Tier-2/Tier-3 branch, no `review-pending`, no
 * `GeneratedArtifactGuard`, no broker CAS, no agent worktree. A validated + grounded
 * plan applies as ONE direct commit onto `refs/heads/main` via {@link runMutation}
 * (validate → ground → apply → commitPaths → refresh → exit 0).
 *
 * Two invariants the plan FRONT still OWNS:
 *  - **Retrieval-first (orchestration-enforced).** The plan is generated ONLY after a
 *    real retrieval; an empty/failed retrieval aborts with {@link RetrievalRequiredError}
 *    BEFORE any ChangePlan is generated.
 *  - **Side-effect-free preview.** {@link previewSynthesis} takes only read/compute
 *    seams — no store/repo/worktree sink — so it is provably free of every mutation.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newRunId, type ChangePlan, type NoteType, type ParsedNote } from "@atlas/contracts";
import type { SqliteDatabase, Store } from "@atlas/sqlite-store";
import type { Repo } from "@atlas/git";
import { packContext, type ContextPack } from "../retrieval/pack.js";
import type { RetrievalResult } from "../retrieval/layers.js";
import { generatePatch, isPatchableOp, type Patch } from "../markdown/patch.js";
import { applyPatch } from "../markdown/apply.js";
import { validatePlan, type ValidationReport, type ValidationVault } from "../validation/index.js";
import { executeOp, isExecutableOp, type OpContext } from "./ops/index.js";
import { runMutation, type Grounded } from "./mutation-order.js";
import type { RunContext } from "../handlers.js";
import { CliError, EXIT } from "../errors/envelope.js";

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

/** The output of the plan pipeline: the plan, its validation, and the patch. */
export interface SynthesisPlan {
  readonly retrievalRunId: string;
  readonly changePlan: ChangePlan;
  readonly report: ValidationReport;
  /** The materialized patch, or `null` when the op is unpatchable or validation blocked it. */
  readonly patch: Patch | null;
}

/** The read/compute seams the plan pipeline needs (no mutation sink among them). */
export interface SynthesisPlanDeps {
  /** Hybrid retrieval + RRF fusion (Task 3.3). */
  retrieve(query: { text: string; k?: number; filters?: { type?: string } }): Promise<RetrievalResult>;
  /** Generate a ChangePlan grounded on the packed context (in-process generateObject seam). */
  generatePlan(input: PlanGenerationInput): Promise<ChangePlan>;
  /** Resolve the target note (for patch generation + target type), or `null` if absent. */
  readNote(noteId: string): ParsedNote | null;
  /** The vault/graph resolvers the validator reads. */
  readonly validationVault: ValidationVault;
  /** Verification states of the evidence supporting a plan (evidence-gating input). */
  supportingEvidenceStates(plan: ChangePlan): readonly string[];
  readonly config: {
    readonly packBudgetTokens: number;
    readonly requireSourcesForSynthesis: boolean;
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
 * RetrievalRequiredError} before any plan exists. The returned {@link SynthesisPlan}
 * is pure data — nothing is persisted here.
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

  // 2. Generate the ChangePlan, grounded on the packed context (retrieval-first).
  const changePlan = await deps.generatePlan({
    kind,
    input,
    context,
    retrievalRunId: retrieval.retrievalRunId,
  });

  // 3. Validate (4.4). Reserved/immutable/schema violations block here (report.ok = false).
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

  return { retrievalRunId: retrieval.retrievalRunId, changePlan, report, patch };
}

/** A side-effect-free preview: the plan pipeline result, applied to no sink. */
export interface SynthesisPreview {
  readonly mode: "preview";
  readonly plan: SynthesisPlan;
}

/**
 * Preview a synthesis run: run the plan pipeline and return its result WITHOUT
 * touching any store/repo/worktree sink. Provably side-effect-free — the deps
 * carry no mutation seam.
 */
export async function previewSynthesis(
  kind: SynthesisKind,
  input: WorkflowInput,
  deps: SynthesisPlanDeps,
): Promise<SynthesisPreview> {
  return { mode: "preview", plan: await planSynthesis(kind, input, deps) };
}

// ── apply path (v2): plan → ground → apply → commitPaths → refresh → exit 0 ─────────

/** RFC-3339 UTC millisecond timestamp. */
function rfc3339MsNow(): string {
  return new Date().toISOString();
}

/**
 * The mutation seams the apply path needs ON TOP of the pure {@link SynthesisPlanDeps}.
 * The whole sequence runs through {@link runMutation}, which owns the advisory vault
 * lock + the direct {@link import("@atlas/git").commitPaths} install onto
 * `refs/heads/main` — no broker, no worktree, no CAS. The `refreshIndex`/`refreshProjection`
 * seams re-derive the affected note's derived-store rows (index-then-projection).
 */
export interface SynthesisApplyDeps extends SynthesisPlanDeps {
  /** The run context (owns env + the lock manager `runMutation` acquires). */
  readonly ctx: RunContext;
  /** The vault git repo handle. */
  readonly repo: Repo;
  /** The projection store (dirty-vault comparison + the caller's refresh seams). */
  readonly store: Store;
  /** Absolute vault working-tree path (the git repo root). */
  readonly vaultPath: string;
  /**
   * Op-execution seams (Task 4.6) — consulted for the projection-serializing ops
   * (claims/evidence) the 4.2 patch generator cannot express. Optional: a run whose
   * op IS patch-expressible never reads them.
   */
  resolveRendition?(handle: string): string | null;
  hasClaim?(claimKey: string): boolean;
  hasNote?(noteId: string): boolean;
  /** Refresh the LanceDB retrieval index for the affected note (runs BEFORE the projection). */
  refreshIndex?(noteId: string, commitSha: string): Promise<void>;
  /** Refresh the SQLite projection for the affected note (advances `notes.content_hash`). */
  refreshProjection?(noteId: string, commitSha: string): Promise<void>;
  readonly now?: () => string;
}

/** The terminal outcome of an applied synthesis run — always integrated (no tier gate). */
export interface SynthesisApplyResult {
  readonly runId: string;
  /** The direct commit on `refs/heads/main` the change landed as. */
  readonly commitSha: string;
  readonly plan: SynthesisPlan;
}

/** A synthesis apply failure the CLI boundary maps to an exit code. */
export class SynthesisApplyError extends CliError {}

/**
 * Apply a synthesis run through the v2 mutation order: `plan (retrieval-first) → validate →
 * ground (compute the new note text) → apply → commitPaths → refresh`. Every validated +
 * grounded plan lands as ONE commit onto `refs/heads/main`; there is no tier gate, no
 * `review-pending`, and no exit 6 — a would-be Tier-3 change applies directly. Retrieval-first
 * is inherited from {@link planSynthesis}: an empty/failed retrieval throws {@link
 * RetrievalRequiredError} BEFORE any mutation.
 */
export async function applySynthesis(
  kind: SynthesisKind,
  input: WorkflowInput,
  deps: SynthesisApplyDeps,
): Promise<SynthesisApplyResult> {
  const now = deps.now ?? rfc3339MsNow;

  // Grounding-phase state, captured for the refresh + result seams.
  let plan!: SynthesisPlan;
  let note!: ParsedNote;

  return runMutation<SynthesisApplyResult>({
    ctx: deps.ctx,
    repo: deps.repo,
    vaultPath: deps.vaultPath,
    store: deps.store,
    async ground(preApply): Promise<Grounded> {
      // 1. Plan (retrieval-first). Throws RetrievalRequiredError before any mutation.
      plan = await planSynthesis(kind, input, deps);
      if (!plan.report.ok) {
        throw new SynthesisApplyError({
          code: "synthesis-validation-failed",
          message: `synthesis plan failed validation: ${plan.report.findings.filter((f) => f.severity === "error").map((f) => f.code).join(", ") || "invalid"}`,
          hint: "The ChangePlan violates a structural/identity/provenance/accessibility rule; no mutation was applied.",
          exitCode: EXIT.VALIDATION,
        });
      }
      const resolved = deps.readNote(input.target);
      if (resolved === null) {
        throw new SynthesisApplyError({
          code: "synthesis-note-not-found",
          message: `synthesis target note "${input.target}" does not exist`,
          hint: "Enrich/reconcile/maintain operate on an existing note; check the target id.",
          exitCode: EXIT.VALIDATION,
        });
      }
      note = resolved;
      // The op must have EITHER a materialized patch (section/frontmatter edits, Task 4.2)
      // OR a projection-serializing executor (claims/evidence, Task 4.6). Anything else
      // (CreateNote, ProposeMerge, …) is not yet applicable.
      const op = plan.changePlan.operation;
      if (plan.patch === null && !isExecutableOp(op.op)) {
        throw new SynthesisApplyError({
          code: "synthesis-op-not-applicable",
          message: `operation "${op.op}" has no single-note apply path yet`,
          hint: "Supported: UpdateSection/AppendSection/SetFrontmatterField/AddAlias (patch) and CreateClaim/AttachEvidence/UpdateEvidenceVerification (executor).",
          exitCode: EXIT.VALIDATION,
        });
      }

      // Produce the note's new text via the patch path (4.2) or the op executor (4.6).
      const notePath = join(deps.vaultPath, note.path);
      const currentText = readFileSync(notePath, "utf8");
      let nextText: string;
      if (plan.patch !== null) {
        const applied = applyPatch(currentText, plan.patch);
        if (!applied.ok) {
          // Stale context (a concurrent edit changed the note since the plan was read).
          throw new SynthesisApplyError({
            code: "synthesis-stale-context",
            message: `patch preconditions no longer hold for "${note.id}": ${applied.error.code}`,
            hint: "The note changed since the plan was generated; re-run synthesis to re-ground the plan.",
            exitCode: EXIT.VALIDATION,
            retryable: true,
          });
        }
        nextText = applied.next;
      } else {
        // Projection-serializing op (claims/evidence). A business-rule violation is a
        // typed OpExecutionError (validation, exit 1) — it propagates out of runMutation.
        const opCtx: OpContext = {
          note,
          resolveRendition: deps.resolveRendition ?? (() => null),
          hasClaim: deps.hasClaim ?? (() => false),
          hasNote: deps.hasNote ?? (() => false),
          now: now(),
        };
        const outcome = executeOp(op, opCtx);
        nextText = outcome.nextText;
      }

      // Post-grounding boundary: re-check the external git index.lock (+ test barrier).
      preApply();

      return {
        touchedPaths: [note.path],
        commitMessage: `synthesis(${kind}): ${op.op} ${note.id}`,
        affectedNoteIds: [note.id],
        dirtyCheckPaths: [note.path],
        apply(): void {
          writeFileSync(notePath, nextText, "utf8");
        },
      };
    },
    async refreshIndex(_g, commitSha): Promise<void> {
      if (deps.refreshIndex) await deps.refreshIndex(note.id, commitSha);
    },
    async refreshProjection(_g, commitSha): Promise<void> {
      if (deps.refreshProjection) await deps.refreshProjection(note.id, commitSha);
    },
    buildResult(commitSha): SynthesisApplyResult {
      return { runId: newRunId(), commitSha, plan };
    },
  });
}

// ── run-input persistence (git refresh reconstruction, Task 4.11) ───────────────────

/** The persisted synthesis input for a run, reconstructed by `git refresh` (Task 4.11). */
export interface PersistedRunInput {
  readonly instruction: string;
  readonly retrievalK?: number;
  readonly typeFilter?: string;
}

/** True when the 0011 `run_inputs` table exists in `db` (feature-migration presence). */
function hasRunInputsTable(db: SqliteDatabase): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_inputs'`).get() !== undefined;
}

/**
 * Record a run's synthesis input (idempotent). Guarded on the 0011 table so a store that predates
 * the migration is never broken; `INSERT OR REPLACE` makes a checkpoint replay a no-op.
 */
export function persistRunInput(db: SqliteDatabase, runId: string, input: WorkflowInput): void {
  if (!hasRunInputsTable(db)) return;
  db.prepare(`INSERT OR REPLACE INTO run_inputs (run_id, instruction, retrieval_k, type_filter) VALUES (?, ?, ?, ?)`).run(
    runId,
    input.instruction,
    input.retrievalK ?? null,
    input.typeFilter ?? null,
  );
}

/** Read a run's persisted synthesis input, or `null` when absent (pre-0011 / non-synthesis run). */
export function readRunInput(db: SqliteDatabase, runId: string): PersistedRunInput | null {
  if (!hasRunInputsTable(db)) return null;
  const row = db.prepare(`SELECT instruction, retrieval_k, type_filter FROM run_inputs WHERE run_id = ?`).get(runId) as
    | { instruction: string; retrieval_k: number | null; type_filter: string | null }
    | undefined;
  if (row === undefined) return null;
  return {
    instruction: row.instruction,
    ...(row.retrieval_k !== null ? { retrievalK: row.retrieval_k } : {}),
    ...(row.type_filter !== null ? { typeFilter: row.type_filter } : {}),
  };
}
