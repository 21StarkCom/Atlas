/**
 * `brain reconcile` (Task 4.11) — cross-note reconciliation. The deterministic detector
 * (`detectReconciliationProposals`) surfaces duplicate notes, disputed claims, and broken links;
 * PREVIEW (default) reports schema-valid proposals + the run's effective risk with NO model call
 * and NO sink touched. `--apply` drives each proposal's remediation through the SAME risk-tiered
 * synthesis pipeline `enrich` uses (Task 4.5): a derived instruction → retrieval-first plan →
 * validate → Tier-2 auto-commit / Tier-3 review-pending (merges/claim-edits are destructive ⇒
 * always Tier-3 ⇒ exit 6). Output ⇒ `reconcile.schema.json`.
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
import { detectReconciliationProposals, type ReconciliationProposal } from "../workflows/reconcile-detect.js";
import { applySynthesis, type SynthesisApplyDeps } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { riskConfigFrom } from "../policies/risk.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { backupConfig, ledgerDbPath, resolvePath } from "./backup-config.js";

const PACK_BUDGET = 6000;
const EGRESS = { maxBytes: 1_000_000, maxTokens: 200_000, costCeiling: 1_000_000 } as const;

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
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });

  try {
    const found = detectReconciliationProposals(store.db);

    // PREVIEW (default): deterministic reconciliation report. No model call, no sink.
    if (!p.apply) {
      const proposals = found.map((f) => toEntry(f, f.minTier));
      const out = { command: "reconcile", mode: "preview", runId, risk: effectiveRisk(found.map((f) => f.minTier)), proposals };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`reconcile (preview): ${proposals.length} proposal(s), ${out.risk}`);
      return EXIT.OK;
    }

    // APPLY: drive each proposal through the risk-tiered synthesis pipeline (same seams as enrich).
    let egressClient: EgressClient;
    try {
      egressClient = await EgressClient.connect(cfg.broker.egress_socket_path);
    } catch (e) {
      throw new CliError({ code: "broker-unreachable", message: `the egress broker is unreachable at ${cfg.broker.egress_socket_path}`, hint: "Start the egress broker daemon before --apply.", exitCode: EXIT.CONFIG, cause: e });
    }
    let brokerClient: BrokerClient;
    try {
      brokerClient = await BrokerClient.connect(cfg.broker.socket_path);
    } catch (e) {
      egressClient.close();
      throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable at ${cfg.broker.socket_path}`, hint: "Start the broker daemon before --apply.", exitCode: EXIT.CONFIG, cause: e });
    }

    try {
      const receipts: ModelCallReceipt[] = [];
      const models = new ModelsClient((params, signal) => egressClient.invoke(params, signal), (r) => { receipts.push(r); });
      const indexingCfg = { chunker_version: cfg.indexing.chunker_version, embedding_model: cfg.indexing.embedding_model, dimensions: cfg.indexing.dimensions };
      const snapshot = await readVault(cfg);
      const noteById = new Map(snapshot.notes.map((n) => [n.id, n]));
      const generatePlan = makeModelPlanGenerator({
        models,
        model: cfg.models.generation_model,
        maxTokens: PLAN_GENERATION_MAX_TOKENS,
        mintCapability: (correlationId) => mintEgressCapability({ runId: correlationId }, { operation: "generateObject", model: cfg.models.generation_model, maxBytes: EGRESS.maxBytes, maxTokens: EGRESS.maxTokens, costCeiling: EGRESS.costCeiling, allowedSensitivity: cfg.policies.default_sensitivity } satisfies EgressLimits),
      });

      const proposals: { kind: string; targets: readonly string[]; risk: Tier }[] = [];
      let anyReviewPending = false;
      for (const f of found) {
        const perRunId = newRunId();
        const retrieve = await makeRetrieveSeam({ ctx, store, models, indexingCfg, rrf: cfg.retrieval.rrf, fts: cfg.retrieval.fts, defaultSensitivity: cfg.policies.default_sensitivity, runId: perRunId, now: () => new Date().toISOString() });
        const deps: SynthesisApplyDeps = {
          retrieve, generatePlan,
          readNote: (id) => noteById.get(id) ?? null,
          validationVault: makeStoreValidationVault(store.db),
          supportingEvidenceStates: () => [],
          inputsTrusted: () => true,
          evidenceValid: () => true,
          config: { packBudgetTokens: PACK_BUDGET, requireSourcesForSynthesis: cfg.policies.require_sources_for_synthesis, risk: riskConfigFrom(cfg.policies) },
          store, broker: brokerClient, backup: backupConfig(ctx), repo: openRepo(resolvePath(ctx, cfg.vault.path)),
          integrate: makeBrokerIntegrator(brokerClient),
          guard: new GeneratedArtifactGuard(quarantineStoreFromContext(ctx)),
          foldProjections: async () => {},
          worktreesPath: resolvePath(ctx, cfg.git.worktrees_path),
          canonicalRef: cfg.git.canonical_ref,
          now: () => new Date().toISOString(),
        };
        const res = await applySynthesis("reconcile", { target: f.targets[0]!, instruction: instructionFor(f) }, deps);
        if (res.mode === "review-pending") anyReviewPending = true;
        proposals.push(toEntry(f, res.plan.tier as Tier));
      }

      const out = { command: "reconcile", mode: anyReviewPending ? "review_pending" : "applied", runId, risk: effectiveRisk(proposals.map((e) => e.risk)), proposals };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`reconcile: ${out.mode}, ${proposals.length} proposal(s)`);
      return anyReviewPending ? EXIT.ACTION_REQUIRED : EXIT.OK;
    } finally {
      brokerClient.close();
      egressClient.close();
    }
  } finally {
    store.close();
  }
}

registerCommand("reconcile", reconcile);

export { reconcile, parseArgs, instructionFor, effectiveRisk };
