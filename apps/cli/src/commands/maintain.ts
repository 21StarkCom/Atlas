/**
 * `brain maintain` (Task 4.11) — vault-hygiene maintenance. The deterministic detector
 * (`detectMaintenanceIssues`) surfaces orphan notes + unverified evidence; PREVIEW (default) reports
 * the findings + the run's effective risk with NO model call and NO sink touched. `--apply` drives
 * each issue's remediation through the SAME risk-tiered synthesis pipeline `enrich` uses (Task 4.5):
 * a derived instruction → retrieval-first plan → validate → Tier-2 auto-commit / Tier-3
 * review-pending (destructive maintenance is always Tier-3 ⇒ exit 6). Output ⇒ `maintain.schema.json`.
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
import { detectMaintenanceIssues, type MaintenanceIssue } from "../workflows/maintain.js";
import { applySynthesis, type SynthesisApplyDeps } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { riskConfigFrom } from "../policies/risk.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { backupConfig, ledgerDbPath, resolvePath } from "./backup-config.js";

const CANONICAL_REF = "refs/heads/main";
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
    else if (a.startsWith("-")) throw CliError.usage(`\`maintain\`: unknown flag ${a}`);
    else throw CliError.usage(`\`maintain\`: unexpected argument ${a}`);
  }
  if (apply && dryRun) throw CliError.usage(`\`maintain\`: --dry-run and --apply are mutually exclusive`);
  return { apply, dryRun };
}

/** The remediation instruction a maintenance issue turns into (destructive ⇒ Tier-3). */
function instructionFor(issue: MaintenanceIssue): string {
  return issue.kind === "orphan-note"
    ? `link or archive the orphan note ${issue.noteId} (${issue.detail})`
    : `flag for re-verification: ${issue.detail} on note ${issue.noteId}`;
}

/** Map a detected issue → a `maintain.schema.json` finding (the detector's kinds → the contract's). */
function toFinding(issue: MaintenanceIssue, risk: Tier): { kind: string; target: string; destructive: boolean; risk: Tier } {
  const kind = issue.kind === "orphan-note" ? "orphan" : "stale-content";
  return { kind, target: issue.noteId, destructive: issue.kind === "orphan-note", risk };
}

/** The run's effective risk = the highest finding tier (tier-0 when there is nothing to do). */
function effectiveRisk(tiers: readonly Tier[]): Tier {
  return tiers.reduce<Tier>((max, t) => (TIER_RANK[t] > TIER_RANK[max] ? t : max), "tier-0");
}

async function maintain(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const cfg = ctx.config.config;
  const runId = newRunId();
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });

  try {
    const issues = detectMaintenanceIssues(store.db);

    // PREVIEW (default): deterministic maintenance report — the detected findings + the run's
    // effective risk. No model call, no retrieval, no sink. Provably side-effect-free.
    if (!p.apply) {
      const findings = issues.map((i) => toFinding(i, i.minTier));
      const out = { command: "maintain", mode: "preview", runId, risk: effectiveRisk(issues.map((i) => i.minTier)), findings };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`maintain (preview): ${findings.length} finding(s), ${out.risk}`);
      return EXIT.OK;
    }

    // APPLY: drive each issue's remediation through the risk-tiered synthesis pipeline. Connect
    // the egress model boundary + the broker; assemble the SAME seams `enrich` uses.
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

      const findings: { kind: string; target: string; destructive: boolean; risk: Tier }[] = [];
      let anyReviewPending = false;
      for (const issue of issues) {
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
          canonicalRef: CANONICAL_REF,
          now: () => new Date().toISOString(),
        };
        const res = await applySynthesis("maintain", { target: issue.noteId, instruction: instructionFor(issue) }, deps);
        if (res.mode === "review-pending") anyReviewPending = true;
        findings.push(toFinding(issue, res.plan.tier as Tier));
      }

      const out = { command: "maintain", mode: anyReviewPending ? "review_pending" : "applied", runId, risk: effectiveRisk(findings.map((f) => f.risk)), findings };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`maintain: ${out.mode}, ${findings.length} finding(s)`);
      return anyReviewPending ? EXIT.ACTION_REQUIRED : EXIT.OK;
    } finally {
      brokerClient.close();
      egressClient.close();
    }
  } finally {
    store.close();
  }
}

registerCommand("maintain", maintain);

export { maintain, parseArgs, instructionFor, effectiveRisk };
