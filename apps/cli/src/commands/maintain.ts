/**
 * `brain maintain` (Task 4.11) — vault-hygiene maintenance. The deterministic detector
 * (`detectMaintenanceIssues`) surfaces orphan notes + unverified evidence; PREVIEW (default) reports
 * the findings + the run's effective risk with NO model call and NO sink touched. `--apply` drives
 * each issue's remediation through the SAME risk-tiered synthesis pipeline `enrich` uses (Task 4.5):
 * a derived instruction → retrieval-first plan → validate → direct apply (v2 #335:
 * no tier gate, no review-pending — every remediation applies, git is the undo).
 * Output ⇒ `maintain.schema.json`.
 */
import { newRunId } from "@atlas/contracts";
import { openRepo } from "@atlas/git";
import { ModelsClient, createInProcessInvoker, type ModelCallReceipt } from "@atlas/models";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { makeRetrieveSeam } from "../retrieval/wiring.js";
import { makeModelPlanGenerator, PLAN_GENERATION_MAX_TOKENS } from "../workflows/index.js";
import { CANONICAL_BRANCH } from "../workflows/mutation-order.js";
import { makeStoreValidationVault } from "../validation/store-vault.js";
import { detectMaintenanceIssues, type MaintenanceIssue } from "../workflows/maintain.js";
import { applySynthesis, type SynthesisApplyDeps } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { ledgerDbPath, resolvePath } from "./backup-config.js";
import { openMigratedStore, PREVIEW_PROJECTION_TABLES } from "./store-open.js";

const PACK_BUDGET = 6000;

interface Parsed { apply: boolean; dryRun: boolean }
function parseArgs(argv: string[]): Parsed {
  let apply = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--idempotency-key") i++;
    else if (a.startsWith("--idempotency-key=")) { /* inline form */ }
    else if (a.startsWith("-")) throw CliError.usage(`\`maintain\`: unknown flag ${a}`);
    else throw CliError.usage(`\`maintain\`: unexpected argument ${a}`);
  }
  if (apply && dryRun) throw CliError.usage(`\`maintain\`: --dry-run and --apply are mutually exclusive`);
  return { apply, dryRun };
}

/** The remediation instruction a maintenance issue turns into. */
function instructionFor(issue: MaintenanceIssue): string {
  return issue.kind === "orphan-note"
    ? `link or archive the orphan note ${issue.noteId} (${issue.detail})`
    : `flag for re-verification: ${issue.detail} on note ${issue.noteId}`;
}

/** Map a detected issue → a `maintain.schema.json` finding (the detector's kinds → the contract's). */
function toFinding(issue: MaintenanceIssue): { kind: string; target: string; destructive: boolean } {
  const kind = issue.kind === "orphan-note" ? "orphan" : "stale-content";
  return { kind, target: issue.noteId, destructive: issue.destructive };
}

async function maintain(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const cfg = ctx.config.config;
  const runId = newRunId();

  // PREVIEW (default): deterministic maintenance report — the detected findings + the run's
  // effective risk. No model call, no retrieval, no sink. LOCK-FREE and READ-ONLY (the
  // non-migrating reader never creates the DB nor applies DDL).
  if (!p.apply) {
    // Assert the projection tables the detector reads (notes/note_links/claims) are
    // present so a partially-migrated ledger fails with a typed db-unavailable
    // (exit 2), not an internal no-such-table error.
    const store = openMigratedStore(ctx, PREVIEW_PROJECTION_TABLES);
    try {
      const issues = detectMaintenanceIssues(store.db);
      const findings = issues.map((i) => toFinding(i));
      const out = { command: "maintain", mode: "preview", runId, findings };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`maintain (preview): ${findings.length} finding(s)`);
      return EXIT.OK;
    } finally {
      store.close();
    }
  }

  // APPLY: the v2 mutation order (runMutation, inside applySynthesis) owns the vault
  // lock per remediation; the caller must NOT pre-acquire it. Each detected issue's
  // remediation lands as ONE direct commit (no tier gate, no review park). The
  // store/repo/model boundary is assembled lock-free and shared across issues.
  const vaultPath = resolvePath(ctx, cfg.vault.path);
  const repo = openRepo(vaultPath);
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const issues = detectMaintenanceIssues(store.db);
    // The in-process model boundary (no egress daemon, no capability mint).
    const receipts: ModelCallReceipt[] = [];
    const models = new ModelsClient(createInProcessInvoker({ env: ctx.env }), (r) => { receipts.push(r); });
    const indexingCfg = { chunker_version: cfg.indexing.chunker_version, embedding_model: cfg.indexing.embedding_model, dimensions: cfg.indexing.dimensions };
    const snapshot = await readVault(cfg);
    const noteById = new Map(snapshot.notes.map((n) => [n.id, n]));
    const generatePlan = makeModelPlanGenerator({
      models,
      model: cfg.models.generation_model,
      maxTokens: PLAN_GENERATION_MAX_TOKENS,
    });

    const findings: { kind: string; target: string; destructive: boolean }[] = [];
    for (const issue of issues) {
      const perRunId = newRunId();
      const retrieve = await makeRetrieveSeam({ ctx, store, models, indexingCfg, rrf: cfg.retrieval.rrf, fts: cfg.retrieval.fts, defaultSensitivity: cfg.policies.default_sensitivity, runId: perRunId, now: () => new Date().toISOString() });
      const deps: SynthesisApplyDeps = {
        retrieve, generatePlan,
        readNote: (id) => noteById.get(id) ?? null,
        validationVault: makeStoreValidationVault(store.db),
        supportingEvidenceStates: () => [],
        config: { packBudgetTokens: PACK_BUDGET, requireSourcesForSynthesis: cfg.policies.require_sources_for_synthesis },
        ctx, repo, store, vaultPath,
        refreshProjection: async (noteId) => {
          const { foldNotesForPaths } = await import("@atlas/sqlite-store");
          const { resolveAtRef } = await import("../sync/resolve-at-ref.js");
          const resolve = resolveAtRef(repo, CANONICAL_BRANCH, cfg.vault.note_globs);
          foldNotesForPaths(store, [noteId], resolve);
        },
        now: () => new Date().toISOString(),
      };
      await applySynthesis("maintain", { target: issue.noteId, instruction: instructionFor(issue) }, deps);
      findings.push(toFinding(issue));
    }

    const out = { command: "maintain", mode: "applied", runId, findings };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`maintain: applied, ${findings.length} finding(s)`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("maintain", maintain);

export { maintain, parseArgs, instructionFor };
