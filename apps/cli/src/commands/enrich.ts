/**
 * `brain enrich <note>` (Task 4.11) — the model-authored single-note enrichment.
 * Non-mutating PREVIEW by default (retrieval-first plan, no sinks); `--apply` lands
 * the validated + grounded plan as ONE direct commit onto `refs/heads/main` via the
 * v2 mutation order (validate → ground → apply → commitPaths → refresh → exit 0). No
 * tier gate, no review-pending, no exit 6 (the trust/scan-gate machinery is retired,
 * ADR-0003). Output matches `enrich.schema.json`.
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
import { applySynthesis, previewSynthesis, type SynthesisApplyDeps, type SynthesisPlanDeps } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { ledgerDbPath, resolvePath } from "./backup-config.js";
import { openMigratedStore, PREVIEW_PROJECTION_TABLES } from "./store-open.js";

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
  const planConfig = { packBudgetTokens: PACK_BUDGET, requireSourcesForSynthesis: cfg.policies.require_sources_for_synthesis };

  if (!p.apply) {
    // PREVIEW: LOCK-FREE and READ-ONLY. Open the ledger through the non-migrating
    // reader (never creates the DB, never applies DDL) and ground read-only — no
    // sink is touched.
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
        config: planConfig,
      };
      const preview = await previewSynthesis("enrich", { target: p.note, instruction: `enrich note ${p.note}` }, planDeps);
      const out = enrichPreviewOutput(runId, preview.plan);
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`enrich ${p.note} (preview): ${preview.plan.report.ok ? "valid" : "invalid"}`);
      return EXIT.OK;
    } finally {
      store.close();
    }
  }

  // --apply: the v2 mutation order (runMutation, inside applySynthesis) owns the vault
  // lock across grounding → apply → commitPaths → refresh; the caller must NOT
  // pre-acquire it. The store is opened lock-free here and threaded in.
  const vaultPath = resolvePath(ctx, cfg.vault.path);
  const repo = openRepo(vaultPath);
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
    const applyDeps: SynthesisApplyDeps = {
      retrieve, generatePlan,
      readNote: (id) => noteById.get(id) ?? null,
      validationVault: makeStoreValidationVault(store.db),
      supportingEvidenceStates: () => [],
      config: planConfig,
      ctx, repo, store, vaultPath,
      refreshProjection: async (noteId) => {
        const { foldNotesForPaths } = await import("@atlas/sqlite-store");
        const { resolveAtRef } = await import("../sync/resolve-at-ref.js");
        const resolve = resolveAtRef(repo, CANONICAL_BRANCH, cfg.vault.note_globs);
        foldNotesForPaths(store, [noteId], resolve);
      },
      now,
    };
    const res = await applySynthesis("enrich", { target: p.note, instruction: `enrich note ${p.note}` }, applyDeps);
    const out = { command: "enrich", mode: "applied" as const, runId: res.runId, note: p.note, integratedCommit: res.commitSha };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`enrich ${p.note}: applied`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

function enrichPreviewOutput(runId: string, plan: import("../workflows/synthesis.js").SynthesisPlan): Record<string, unknown> {
  return {
    command: "enrich",
    mode: "preview",
    runId,
    ...(plan.patch ? { changedLines: plan.patch.ops.length, sections: 1 } : {}),
    plan: { operation: plan.changePlan.operation.op, ok: plan.report.ok },
  };
}

registerCommand("enrich", enrich);

export { enrich, parseArgs, enrichPreviewOutput };
