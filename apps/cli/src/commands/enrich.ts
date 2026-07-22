/**
 * `brain enrich <note>` (Task 4.11) — the model-authored single-note enrichment. Non-mutating
 * PREVIEW by default (retrieval-first plan, no sinks); `--apply` runs tiered integration (Tier-2
 * auto-commits under the broker; Tier-3 stops at review-pending, exit 6). This is the CAPSTONE
 * assembly of the merged pipeline pieces: the retrieval seam (lancedb + egress embedder), the
 * model-plan generator (generateObject<ChangePlan>), the store-backed validation vault, and — on
 * apply — the broker integrator. Output matches `enrich.schema.json`.
 */
import { newRunId } from "@atlas/contracts";
import { openRepo } from "@atlas/git";
import { GeneratedArtifactGuard } from "@atlas/scan";
import { ModelsClient, createInProcessInvoker, type ModelCallReceipt } from "@atlas/models";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { makeRetrieveSeam } from "../retrieval/wiring.js";
import { makeModelPlanGenerator, PLAN_GENERATION_MAX_TOKENS } from "../workflows/index.js";
import { makeCanonicalIntegrator, inProcessAuditBroker, CANONICAL_BRANCH } from "../workflows/direct-integrator.js";
import { makeStoreValidationVault } from "../validation/store-vault.js";
import { applySynthesis, previewSynthesis, type SynthesisApplyDeps, type SynthesisPlanDeps } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { riskConfigFrom } from "../policies/risk.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { backupConfig, ledgerDbPath, resolvePath } from "./backup-config.js";
import { openMigratedStore, PREVIEW_PROJECTION_TABLES } from "./store-open.js";
import { withVaultMutation } from "../locks/mutation-guard.js";

const PACK_BUDGET = 6000;

interface Parsed { note: string; apply: boolean; dryRun: boolean }
function parseArgs(argv: string[]): Parsed {
  let note: string | undefined, apply = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--idempotency-key") i++; // consume its value (key-accepting; idempotency owned downstream)
    else if (a.startsWith("--idempotency-key=")) { /* inline form; accepted */ }
    else if (a.startsWith("-")) throw CliError.usage(`\`enrich\`: unknown flag ${a}`);
    else if (note === undefined) note = a;
    else throw CliError.usage(`\`enrich\`: unexpected argument ${a}`);
  }
  if (note === undefined) throw CliError.usage(`\`enrich\`: expected a <note> argument`);
  if (apply && dryRun) throw CliError.usage(`\`enrich\`: --dry-run and --apply are mutually exclusive`);
  return { note, apply, dryRun };
}

async function enrich(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const cfg = ctx.config.config;
  const runId = newRunId();
  const now = (): string => new Date().toISOString();
  const indexingCfg = { chunker_version: cfg.indexing.chunker_version, embedding_model: cfg.indexing.embedding_model, dimensions: cfg.indexing.dimensions };
  const planConfig = { packBudgetTokens: PACK_BUDGET, requireSourcesForSynthesis: cfg.policies.require_sources_for_synthesis, risk: riskConfigFrom(cfg.policies) };

  if (!p.apply) {
    // PREVIEW: LOCK-FREE and READ-ONLY. Open the ledger through the non-migrating
    // reader (never creates the DB, never applies DDL) and ground read-only — no
    // sink is touched, so it takes no vault lock. Assert the projection tables the
    // validation vault reads are present so a partially-migrated ledger fails with a
    // typed db-unavailable (exit 2), not an internal no-such-table error.
    const store = openMigratedStore(ctx, PREVIEW_PROJECTION_TABLES);
    try {
      const receipts: ModelCallReceipt[] = [];
      const models = new ModelsClient(createInProcessInvoker({ env: ctx.env }), (r) => { receipts.push(r); });
      const retrieve = await makeRetrieveSeam({ ctx, store, models, indexingCfg, rrf: cfg.retrieval.rrf, fts: cfg.retrieval.fts, defaultSensitivity: cfg.policies.default_sensitivity, runId, now });
      const generatePlan = makeModelPlanGenerator({ models, model: cfg.models.generation_model, maxTokens: PLAN_GENERATION_MAX_TOKENS });
      const snapshot = await readVault(cfg);
      const noteById = new Map(snapshot.notes.map((n) => [n.id, n]));
      const planDeps: SynthesisPlanDeps = {
        retrieve, generatePlan,
        readNote: (id) => noteById.get(id) ?? null,
        validationVault: makeStoreValidationVault(store.db),
        supportingEvidenceStates: () => [],
        inputsTrusted: () => true,
        evidenceValid: () => true,
        config: planConfig,
      };
      const preview = await previewSynthesis("enrich", { target: p.note, instruction: `enrich note ${p.note}` }, planDeps);
      const out = enrichPreviewOutput(runId, preview.plan);
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`enrich ${p.note} (preview): ${out.risk}, ${preview.plan.report.ok ? "valid" : "invalid"}`);
      return EXIT.OK;
    } finally {
      store.close();
    }
  }

  // --apply: acquire the vault lock BEFORE opening the migrating apply-side store or
  // doing ANY grounding, so a lock loser / git-index-locked invocation never mutates
  // SQLite (store.migrate) nor reads stale grounding before exiting 2. Everything —
  // store open, grounding, apply, commit, refresh — runs under the held lock.
  const vaultPath = resolvePath(ctx, cfg.vault.path);
  return withVaultMutation(ctx, vaultPath, async (preApply) => {
    const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
    try {
      // The in-process model boundary (retrieval embed + plan generateObject) — no
      // egress daemon, no capability mint. The credential is resolved lazily.
      const receipts: ModelCallReceipt[] = [];
      const models = new ModelsClient(createInProcessInvoker({ env: ctx.env }), (r) => { receipts.push(r); });
      const retrieve = await makeRetrieveSeam({ ctx, store, models, indexingCfg, rrf: cfg.retrieval.rrf, fts: cfg.retrieval.fts, defaultSensitivity: cfg.policies.default_sensitivity, runId, now });
      const generatePlan = makeModelPlanGenerator({ models, model: cfg.models.generation_model, maxTokens: PLAN_GENERATION_MAX_TOKENS });
      const snapshot = await readVault(cfg);
      const noteById = new Map(snapshot.notes.map((n) => [n.id, n]));
      // Daemon-free canonical integrator (v2): FF-advance refs/heads/main in-process
      // via makeCanonicalIntegrator — no broker socket, no audit/WORM append.
      const repo = openRepo(vaultPath);
      const broker = inProcessAuditBroker();
      const applyDeps: SynthesisApplyDeps = {
        retrieve, generatePlan,
        readNote: (id) => noteById.get(id) ?? null,
        validationVault: makeStoreValidationVault(store.db),
        supportingEvidenceStates: () => [],
        inputsTrusted: () => true,
        evidenceValid: () => true,
        config: planConfig,
        store, broker, backup: backupConfig(ctx), repo,
        integrate: makeCanonicalIntegrator(repo),
        guard: new GeneratedArtifactGuard(quarantineStoreFromContext(ctx)),
        foldProjections: async () => {
          const { foldNotesForPaths } = await import("@atlas/sqlite-store");
          const { resolveAtRef } = await import("../sync/resolve-at-ref.js");
          const resolve = resolveAtRef(repo, CANONICAL_BRANCH, cfg.vault.note_globs);
          foldNotesForPaths(store, [p.note], resolve);
        },
        worktreesPath: resolvePath(ctx, cfg.git.worktrees_path),
        canonicalRef: CANONICAL_BRANCH,
        // Threaded INTO applySynthesis so the index.lock re-check fires at the true
        // post-grounding boundary (after retrieval + model planning, before the
        // first durable mutation), on every CAS-rebase retry — not before grounding.
        preApply,
        now,
      };
      const res = await applySynthesis("enrich", { target: p.note, instruction: `enrich note ${p.note}` }, applyDeps);
      const out = res.mode === "review-pending"
        ? { command: "enrich", mode: "review_pending" as const, runId: res.runId, note: p.note, risk: res.plan.tier }
        : { command: "enrich", mode: "applied" as const, runId: res.runId, note: p.note, risk: res.plan.tier, integratedCommit: res.canonicalSha ?? res.commitSha };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`enrich ${p.note}: ${out.mode}`);
      return res.mode === "review-pending" ? EXIT.ACTION_REQUIRED : EXIT.OK;
    } finally {
      store.close();
    }
  });
}

function enrichPreviewOutput(runId: string, plan: import("../workflows/synthesis.js").SynthesisPlan): Record<string, unknown> {
  return {
    command: "enrich",
    mode: "preview",
    runId,
    risk: plan.tier,
    validationConfidence: plan.report.gates.tier2Eligible ? 1 : 0,
    ...(plan.patch ? { changedLines: plan.patch.ops.length, sections: 1 } : {}),
    plan: { operation: plan.changePlan.operation.op, tier: plan.tier, ok: plan.report.ok },
  };
}

registerCommand("enrich", enrich);

export { enrich, parseArgs, enrichPreviewOutput };
