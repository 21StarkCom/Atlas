/**
 * `brain enrich <note>` (Task 4.11) — the model-authored single-note enrichment. Non-mutating
 * PREVIEW by default (retrieval-first plan, no sinks); `--apply` runs tiered integration (Tier-2
 * auto-commits under the broker; Tier-3 stops at review-pending, exit 6). This is the CAPSTONE
 * assembly of the merged pipeline pieces: the retrieval seam (lancedb + egress embedder), the
 * model-plan generator (generateObject<ChangePlan>), the store-backed validation vault, and — on
 * apply — the broker integrator. Output matches `enrich.schema.json`.
 */
import { BrokerClient, EgressClient } from "@atlas/broker";
import { newRunId } from "@atlas/contracts";
import { openRepo } from "@atlas/git";
import { GeneratedArtifactGuard } from "@atlas/scan";
import { ModelsClient, mintEgressCapability, type EgressLimits, type ModelCallReceipt } from "@atlas/models";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { makeRetrieveSeam } from "../retrieval/wiring.js";
import { makeModelPlanGenerator, PLAN_GENERATION_MAX_TOKENS, makeBrokerIntegrator } from "../workflows/index.js";
import { makeStoreValidationVault } from "../validation/store-vault.js";
import { applySynthesis, previewSynthesis, type SynthesisApplyDeps, type SynthesisPlanDeps } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { riskConfigFrom } from "../policies/risk.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { backupConfig, ledgerDbPath, resolvePath } from "./backup-config.js";

const CANONICAL_REF = "refs/heads/main";
const PACK_BUDGET = 6000;
const EGRESS = { maxBytes: 1_000_000, maxTokens: 200_000, costCeiling: 1_000_000 } as const;

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
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });

  // Connect the egress model boundary (retrieval embed + plan generateObject).
  let egressClient: EgressClient;
  try {
    egressClient = await EgressClient.connect(cfg.broker.egress_socket_path);
  } catch (e) {
    store.close();
    throw new CliError({ code: "broker-unreachable", message: `the egress broker is unreachable at ${cfg.broker.egress_socket_path}`, hint: "Start the egress broker daemon.", exitCode: EXIT.CONFIG, cause: e });
  }
  const receipts: ModelCallReceipt[] = [];
  const models = new ModelsClient((params, signal) => egressClient.invoke(params, signal), (r) => { receipts.push(r); });

  try {
    const indexingCfg = { chunker_version: cfg.indexing.chunker_version, embedding_model: cfg.indexing.embedding_model, dimensions: cfg.indexing.dimensions };
    const retrieve = await makeRetrieveSeam({ ctx, store, models, indexingCfg, rrf: cfg.retrieval.rrf, fts: cfg.retrieval.fts, defaultSensitivity: cfg.policies.default_sensitivity, runId, now });
    const generatePlan = makeModelPlanGenerator({
      models,
      model: cfg.models.generation_model,
      maxTokens: PLAN_GENERATION_MAX_TOKENS,
      mintCapability: (correlationId) => mintEgressCapability({ runId: correlationId }, { operation: "generateObject", model: cfg.models.generation_model, maxBytes: EGRESS.maxBytes, maxTokens: EGRESS.maxTokens, costCeiling: EGRESS.costCeiling, allowedSensitivity: cfg.policies.default_sensitivity } satisfies EgressLimits),
    });
    const snapshot = await readVault(cfg);
    const noteById = new Map(snapshot.notes.map((n) => [n.id, n]));
    const planDeps: SynthesisPlanDeps = {
      retrieve,
      generatePlan,
      readNote: (id) => noteById.get(id) ?? null,
      validationVault: makeStoreValidationVault(store.db),
      supportingEvidenceStates: () => [],
      inputsTrusted: () => true,
      evidenceValid: () => true,
      config: { packBudgetTokens: PACK_BUDGET, requireSourcesForSynthesis: cfg.policies.require_sources_for_synthesis, risk: riskConfigFrom(cfg.policies) },
    };

    if (!p.apply) {
      const preview = await previewSynthesis("enrich", { target: p.note, instruction: `enrich note ${p.note}` }, planDeps);
      const out = enrichPreviewOutput(runId, preview.plan);
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`enrich ${p.note} (preview): ${out.risk}, ${preview.plan.report.ok ? "valid" : "invalid"}`);
      return EXIT.OK;
    }

    // --apply: connect the broker + wire the Tier-2 integrator; run the full apply.
    let brokerClient: BrokerClient;
    try {
      brokerClient = await BrokerClient.connect(cfg.broker.socket_path);
    } catch (e) {
      throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable at ${cfg.broker.socket_path}`, hint: "Start the broker daemon before --apply.", exitCode: EXIT.CONFIG, cause: e });
    }
    try {
      const applyDeps: SynthesisApplyDeps = {
        ...planDeps,
        store, broker: brokerClient, backup: backupConfig(ctx), repo: openRepo(resolvePath(ctx, cfg.vault.path)),
        integrate: makeBrokerIntegrator(brokerClient),
        guard: new GeneratedArtifactGuard(quarantineStoreFromContext(ctx)),
        foldProjections: async () => {},
        worktreesPath: resolvePath(ctx, cfg.git.worktrees_path),
        canonicalRef: CANONICAL_REF,
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
      brokerClient.close();
    }
  } finally {
    egressClient.close();
    store.close();
  }
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
