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
import { mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSerialize, newRunId, type ChangePlan, type ChangePlanOperation, type NoteType, type ParsedNote, type RiskTier, type RunManifest } from "@atlas/contracts";
import type { AuditBroker, LedgerBackupConfig, Store } from "@atlas/sqlite-store";
import type { Repo } from "@atlas/git";
import { GeneratedArtifactGuard } from "@atlas/scan";
import { packContext, type ContextPack } from "../retrieval/pack.js";
import type { RetrievalResult } from "../retrieval/layers.js";
import { generatePatch, isPatchableOp, type Patch } from "../markdown/patch.js";
import { applyPatch } from "../markdown/apply.js";
import { effectiveRisk, type PolicyContext, type RiskConfig } from "../policies/risk.js";
import { validatePlan, type ValidationReport, type ValidationVault } from "../validation/index.js";
import { startRun, sha256Canonical, type IntegratedResult, type RunIntegrator, type WorkflowDeps } from "./index.js";
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

// ── apply path (Task 4.5, slice B): plan → worktree → agent commit → tier branch ─

/** The default canonical protected ref a synthesis run fast-forwards. */
const DEFAULT_CANONICAL_REF = "refs/heads/main";
/** The all-zero placeholder for an unborn canonical ref. */
const ZERO_OID = "0".repeat(40);

/** RFC-3339 UTC millisecond timestamp. */
function rfc3339MsNow(): string {
  return new Date().toISOString();
}

/**
 * The mutation seams the apply path needs ON TOP of the pure {@link SynthesisPlanDeps}.
 * The workflow engine (`store`/`broker`/`backup`/`repo`) drives the persisted run; the
 * `integrate` seam performs the Tier-2 canonical install (see {@link
 * import("./integrate.js").makeSynthesisIntegrator}); the `guard` scans every persisted
 * synthesis artifact before its sink; `foldProjections` re-derives projections from the
 * immutable canonical commit after integration.
 */
export interface SynthesisApplyDeps extends SynthesisPlanDeps {
  readonly store: Store;
  readonly broker: AuditBroker;
  readonly backup: LedgerBackupConfig;
  readonly repo: Repo;
  /** The Tier-2 canonical-install seam. A `broker.cas_failed` refusal triggers a retry. */
  readonly integrate: RunIntegrator;
  /** The generated-artifact scan boundary — every persisted synthesis artifact passes it. */
  readonly guard: GeneratedArtifactGuard;
  /** Re-derive projections from the immutable canonical commit (post-integration). */
  foldProjections(canonicalRef: string): Promise<void>;
  /** `git.worktrees_path` — where the ephemeral agent worktree is created. */
  readonly worktreesPath: string;
  /** The canonical protected ref (default {@link DEFAULT_CANONICAL_REF}). */
  readonly canonicalRef?: string;
  /** Max attempts across CAS-miss rebases (default 3). */
  readonly maxAttempts?: number;
  readonly now?: () => string;
}

/** The terminal outcome of an applied synthesis run. */
export interface SynthesisApplyResult {
  /** `integrated` — auto-committed to canonical (Tier-2); `review-pending` — awaiting approval (Tier-3). */
  readonly mode: "integrated" | "review-pending";
  readonly runId: string;
  /** The `refs/agent/<runId>` the agent commit lives on. */
  readonly agentRef: string;
  readonly commitSha: string;
  readonly plan: SynthesisPlan;
  /** The canonical sha after integration (`integrated` mode only). */
  readonly canonicalSha?: string;
  /** How many attempts ran (1 + CAS-miss rebases). */
  readonly attempts: number;
}

/** A synthesis apply failure the CLI boundary maps to an exit code. */
export class SynthesisApplyError extends CliError {}

/** `true` iff `err` is the broker's CAS-miss refusal (canonical advanced concurrently). */
function isCasFailed(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "broker.cas_failed";
}

/** Best-effort worktree removal (the reconciler's orphan sweep is the durable backstop). */
async function cleanupWorktree(repo: Repo, dir: string): Promise<void> {
  try {
    await repo.removeWorktree(dir);
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Apply a synthesis run through the 2.5 engine: `plan (retrieval-first) → validate →
 * patch → worktree apply → agent commit → tier branch`. Tier-2 auto-integrates via the
 * injected {@link SynthesisApplyDeps.integrate} seam under CAS (a `broker.cas_failed`
 * rebases, regenerates, and revalidates — no lost update / duplicate commit); Tier-3
 * stops durably at `review-pending` (the CLI surfaces exit 6 + a `review_pending` payload).
 *
 * The {@link GeneratedArtifactGuard} scans the ChangePlan, the applied note text, the
 * commit message, and the run manifest before each reaches its sink — so a secret a
 * model emits never lands unscanned. Retrieval-first is inherited from {@link
 * planSynthesis}: an empty/failed retrieval throws {@link RetrievalRequiredError} BEFORE
 * any run, plan, worktree, or commit exists.
 */
export async function applySynthesis(
  kind: SynthesisKind,
  input: WorkflowInput,
  deps: SynthesisApplyDeps,
): Promise<SynthesisApplyResult> {
  const now = deps.now ?? rfc3339MsNow;
  const canonicalRef = deps.canonicalRef ?? DEFAULT_CANONICAL_REF;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 3);

  let lastCasError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const base = (await deps.repo.readRef(canonicalRef)) ?? ZERO_OID;

    // 1. Plan (retrieval-first). Throws RetrievalRequiredError BEFORE any run exists.
    const plan = await planSynthesis(kind, input, deps);
    if (!plan.report.ok) {
      throw new SynthesisApplyError({
        code: "synthesis-validation-failed",
        message: `synthesis plan failed validation: ${plan.report.findings.filter((f) => f.severity === "error").map((f) => f.code).join(", ") || "invalid"}`,
        hint: "The ChangePlan violates a structural/identity/provenance/accessibility rule; no mutation was applied.",
        exitCode: EXIT.VALIDATION,
      });
    }
    const note = deps.readNote(input.target);
    if (note === null) {
      throw new SynthesisApplyError({
        code: "synthesis-note-not-found",
        message: `synthesis target note "${input.target}" does not exist`,
        hint: "Enrich/reconcile/maintain operate on an existing note; check the target id.",
        exitCode: EXIT.VALIDATION,
      });
    }
    // Slice-B scope: patchable single-note edits. Non-patchable ops (CreateNote,
    // ProposeMerge, claims, trust) land in Tasks 4.6+ — reject them explicitly here.
    if (plan.patch === null) {
      throw new SynthesisApplyError({
        code: "synthesis-op-not-applicable",
        message: `operation "${plan.changePlan.operation.op}" has no patchable single-note apply path yet`,
        hint: "This slice applies UpdateSection/AppendSection/SetFrontmatterField/AddAlias; other ops are pending.",
        exitCode: EXIT.VALIDATION,
      });
    }
    const patch = plan.patch;

    const runId = newRunId();
    const tierNum: 2 | 3 = plan.tier === "tier-2" ? 2 : 3;
    const planHash = sha256Canonical(plan.changePlan);

    // 2. GUARD the ChangePlan BEFORE it is persisted at `planned` (sqlite sink).
    await deps.guard.assertClean({ text: JSON.stringify(plan.changePlan), sink: "sqlite", runId });

    const wdeps: WorkflowDeps = { store: deps.store, broker: deps.broker, backup: deps.backup, repo: deps.repo, now };
    const handle = await startRun(wdeps, { operation: kind, runId, targetNoteId: note.id, canonicalCommit: base });

    let worktreeDir: string | null = null;
    try {
      await handle.checkpoint("planned", {
        planId: `${runId}-plan`,
        tier: tierNum,
        confidence: plan.changePlan.confidence,
        summary: `${plan.changePlan.operation.op}: ${plan.changePlan.rationale.slice(0, 60)}`,
        planHash,
        canonicalRef,
        baseRef: base,
      });

      // 3. Create the agent branch + worktree; apply the patch to the target note file.
      const agentRef = await deps.repo.createAgentBranch(runId, canonicalRef);
      const wtParent = deps.worktreesPath && existsSync(deps.worktreesPath) ? deps.worktreesPath : tmpdir();
      worktreeDir = await mkdtemp(join(wtParent, `atlas-syn-${runId}-`));
      const worktree = await deps.repo.addWorktree(agentRef, worktreeDir);

      const notePath = join(worktreeDir, note.path);
      const currentText = readFileSync(notePath, "utf8");
      const applied = applyPatch(currentText, patch);
      if (!applied.ok) {
        // Stale context (a concurrent edit changed the note since the plan was read).
        await handle.fail("planned", `synthesis-stale-context: ${applied.error.code}`);
        await cleanupWorktree(deps.repo, worktreeDir);
        worktreeDir = null;
        throw new SynthesisApplyError({
          code: "synthesis-stale-context",
          message: `patch preconditions no longer hold for "${note.id}": ${applied.error.code}`,
          hint: "The note changed since the plan was generated; re-run synthesis to re-ground the plan.",
          exitCode: EXIT.VALIDATION,
          retryable: true,
        });
      }
      // GUARD the applied note text BEFORE it is written to the worktree.
      await deps.guard.assertClean({ text: applied.next, sink: "worktree", runId });
      writeFileSync(notePath, applied.next, "utf8");

      await handle.checkpoint("patched", {
        patchId: `${runId}-patch`,
        planId: `${runId}-plan`,
        noteId: note.id,
        changedLines: changedLinesOf(patch),
        changedSections: sectionsOf(patch),
        patchHash: sha256Canonical(patch),
        planHash,
      });

      // The applied-tree evidence is persisted BEFORE the commit (crash-recoverable).
      const treeHash = sha256Canonical({ path: note.path, text: applied.next });
      await handle.checkpoint("worktree-applied", { worktreePath: worktreeDir, treeHash, agentRef });

      // 4. Agent commit carrying the run manifest (ChangePlan digest + proposed risk).
      const commitMsg = `synthesis(${kind}): ${plan.changePlan.operation.op} ${note.id}`;
      // The manifest carries the ChangePlan digest (provenance). The EFFECTIVE risk
      // tier lives on `agent_runs.tier` (recorded at planned/agent-committed) — it is
      // deliberately NOT stamped into the manifest's model-proposed-risk field, which
      // no module reads for control flow (the Task-4.3 grep-guard pins that invariant).
      const commitManifest: RunManifest = {
        schemaVersion: 1,
        runId,
        state: "agent-committed",
        createdAt: now(),
        canonicalBaseCommit: base,
        targets: [note.id],
        changePlanDigest: planHash,
      };
      // GUARD the commit message + manifest BEFORE they are written to a git object.
      await deps.guard.assertClean({ text: commitMsg, sink: "git-object", runId });
      await deps.guard.assertClean({ text: canonicalSerialize(commitManifest).toString(), sink: "git-object", runId });
      const commitSha = await worktree.commit(commitMsg, commitManifest);
      await handle.checkpoint("agent-committed", { commitSha, treeHash, agentRef, tier: tierNum });

      // 5. Tier branch.
      if (tierNum === 3 || !plan.tier2Eligible) {
        // Tier-3: stop durably at review-pending (the agent commit persists on its ref).
        await handle.checkpoint("review-pending", { commitSha, agentRef });
        await cleanupWorktree(deps.repo, worktreeDir);
        worktreeDir = null;
        return { mode: "review-pending", runId, agentRef, commitSha, plan, attempts: attempt };
      }

      // Tier-2: auto-integrate under CAS.
      let integrated: IntegratedResult;
      try {
        integrated = await handle.integrate(deps.integrate);
      } catch (e) {
        if (isCasFailed(e)) {
          // Canonical advanced between plan and commit: the engine dropped the pending
          // intent and left the run at `agent-committed`. Fail it and rebase — the next
          // attempt regenerates + revalidates against the advanced canonical (§4.5).
          await handle.fail("agent-committed", "broker.cas_failed: canonical advanced during integration; rebasing");
          await cleanupWorktree(deps.repo, worktreeDir);
          worktreeDir = null;
          lastCasError = e;
          continue;
        }
        throw e;
      }

      // Post-CAS: re-derive projections from the immutable canonical commit (replayable),
      // advance to reindexed, then finalize.
      await deps.foldProjections(canonicalRef);
      await handle.checkpoint("reindexed", { indexGeneration: 1, canonicalSha: integrated.canonicalSha });
      await handle.finalize();
      await cleanupWorktree(deps.repo, worktreeDir);
      worktreeDir = null;
      return { mode: "integrated", runId, agentRef, commitSha, canonicalSha: integrated.canonicalSha, plan, attempts: attempt };
    } finally {
      if (worktreeDir) await cleanupWorktree(deps.repo, worktreeDir);
    }
  }

  // Every attempt lost the CAS race — surface it retryable.
  throw new SynthesisApplyError({
    code: "synthesis-cas-exhausted",
    message: `synthesis integration lost the canonical CAS race ${maxAttempts} times`,
    hint: "Canonical is advancing faster than synthesis can rebase; retry when contention subsides.",
    exitCode: EXIT.INTERNAL,
    retryable: true,
    ...(lastCasError instanceof Error ? { cause: lastCasError } : {}),
  });
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
