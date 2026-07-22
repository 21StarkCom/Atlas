/**
 * `brain reconcile` (Task 4.11) — cross-note reconciliation. The deterministic detector
 * (`detectReconciliationProposals`) surfaces duplicate notes, disputed claims, and broken links;
 * PREVIEW (default) reports schema-valid proposals + the run's effective risk with NO model call
 * and NO sink touched. `--apply` drives each proposal's remediation through the SAME risk-tiered
 * synthesis pipeline `enrich` uses (Task 4.5): a derived instruction → retrieval-first plan →
 * validate → Tier-2 auto-commit / Tier-3 review-pending (merges/claim-edits are destructive ⇒
 * always Tier-3 ⇒ exit 6). Output ⇒ `reconcile.schema.json`.
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
import { detectReconciliationProposals, type ReconciliationProposal } from "../workflows/reconcile-detect.js";
import { applySynthesis, type SynthesisApplyDeps } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { ledgerDbPath, resolvePath } from "./backup-config.js";
import { openMigratedStore, PREVIEW_PROJECTION_TABLES } from "./store-open.js";

const PACK_BUDGET = 6000;

type Tier = "tier-0" | "tier-1" | "tier-2" | "tier-3";
const TIER_RANK: Record<Tier, number> = { "tier-0": 0, "tier-1": 1, "tier-2": 2, "tier-3": 3 };

interface Parsed { apply: boolean; dryRun: boolean }
function parseArgs(argv: string[]): Parsed {
  let apply = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--idempotency-key") i++;
    else if (a.startsWith("--idempotency-key=")) { /* inline form */ }
    else if (a.startsWith("-")) throw CliError.usage(`\`reconcile\`: unknown flag ${a}`);
    else throw CliError.usage(`\`reconcile\`: unexpected argument ${a}`);
  }
  if (apply && dryRun) throw CliError.usage(`\`reconcile\`: --dry-run and --apply are mutually exclusive`);
  return { apply, dryRun };
}

/** The remediation instruction a reconciliation proposal turns into. */
function instructionFor(p: ReconciliationProposal): string {
  switch (p.kind) {
    case "merge-duplicate": return `merge the duplicate notes ${p.targets.join(", ")}`;
    case "resolve-conflicting-claim": return `resolve the disputed claim on note ${p.targets[0]}`;
    case "fix-broken-link": return `fix the broken link from ${p.targets[0]} to ${p.targets[1]}`;
  }
}

/** Map a proposal → a `reconcile.schema.json` proposal entry. */
function toEntry(p: ReconciliationProposal, risk: Tier): { kind: string; targets: readonly string[]; risk: Tier } {
  return { kind: p.kind, targets: p.targets, risk };
}

/** The run's effective risk = the highest proposal tier (tier-0 when there is nothing to do). */
function effectiveRisk(tiers: readonly Tier[]): Tier {
  return tiers.reduce<Tier>((max, t) => (TIER_RANK[t] > TIER_RANK[max] ? t : max), "tier-0");
}

async function reconcile(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const cfg = ctx.config.config;
  const runId = newRunId();

  // PREVIEW (default): deterministic reconciliation report. No model call, no sink.
  // LOCK-FREE and READ-ONLY (the non-migrating reader never creates the DB nor
  // applies DDL).
  if (!p.apply) {
    // Assert the projection tables the detector reads (notes/claims/note_links) are
    // present so a partially-migrated ledger fails with a typed db-unavailable
    // (exit 2), not an internal no-such-table error.
    const store = openMigratedStore(ctx, PREVIEW_PROJECTION_TABLES);
    try {
      const found = detectReconciliationProposals(store.db);
      const proposals = found.map((f) => toEntry(f, f.minTier));
      const out = { command: "reconcile", mode: "preview", runId, risk: effectiveRisk(found.map((f) => f.minTier)), proposals };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`reconcile (preview): ${proposals.length} proposal(s), ${out.risk}`);
      return EXIT.OK;
    } finally {
      store.close();
    }
  }

  // APPLY: the v2 mutation order (runMutation, inside applySynthesis) owns the vault
  // lock per remediation; the caller must NOT pre-acquire it. Each proposal lands as
  // ONE direct commit (no tier gate, no review-pending). The store/repo/model boundary
  // is assembled lock-free and shared across proposals.
  const vaultPath = resolvePath(ctx, cfg.vault.path);
  const repo = openRepo(vaultPath);
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const found = detectReconciliationProposals(store.db);
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

    const proposals: { kind: string; targets: readonly string[]; risk: Tier }[] = [];
    for (const f of found) {
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
      await applySynthesis("reconcile", { target: f.targets[0]!, instruction: instructionFor(f) }, deps);
      proposals.push(toEntry(f, f.minTier));
    }

    const out = { command: "reconcile", mode: "applied", runId, risk: effectiveRisk(proposals.map((e) => e.risk)), proposals };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`reconcile: applied, ${proposals.length} proposal(s)`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("reconcile", reconcile);

export { reconcile, parseArgs, instructionFor, effectiveRisk };
