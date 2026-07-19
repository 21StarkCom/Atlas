/**
 * `brain git refresh <runId>` (Task 4.11) — regenerate a review-pending run against the current
 * canonical head. Reconstructs the run's synthesis input (KIND + TARGET from `agent_runs`, the
 * INSTRUCTION from the 0011 `run_inputs` record), replays the plan on top of the latest canonical,
 * and produces a new superseding agent commit — the run STAYS review-pending. NON-PRIVILEGED:
 * refresh performs no canonical/trust/erase mutation (only regenerates a pending proposal the
 * operator must still approve), so it needs no OS-presence authorization; it emits a `run.refreshed`
 * audit event through the normal audit path (engine core `refreshRun`). Output ⇒ `git-refresh.schema.json`.
 */
import { BrokerClient, EgressClient } from "@atlas/broker";
import { openRepo } from "@atlas/git";
import { GeneratedArtifactGuard } from "@atlas/scan";
import { ModelsClient, mintEgressCapability, type EgressLimits, type ModelCallReceipt } from "@atlas/models";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { readAgentRunStatus } from "../workflows/checkpoints.js";
import { makeRetrieveSeam } from "../retrieval/wiring.js";
import { makeModelPlanGenerator, PLAN_GENERATION_MAX_TOKENS, refreshRun, type SynthesisRefreshDeps } from "../workflows/index.js";
import { makeStoreValidationVault } from "../validation/store-vault.js";
import { readRunInput } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { riskConfigFrom } from "../policies/risk.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { backupConfig, ledgerDbPath, resolvePath } from "./backup-config.js";

const PACK_BUDGET = 6000;
const EGRESS = { maxBytes: 1_000_000, maxTokens: 200_000, costCeiling: 1_000_000 } as const;
const SYNTHESIS_KINDS = new Set(["enrich", "reconcile", "maintain"]);

interface Parsed { runId: string }
function parseArgs(argv: string[]): Parsed {
  let runId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--idempotency-key") i++;
    else if (a.startsWith("--idempotency-key=")) { /* inline form */ }
    else if (a.startsWith("-")) throw CliError.usage(`\`git refresh\`: unknown flag ${a}`);
    else if (runId === undefined) runId = a;
    else throw CliError.usage(`\`git refresh\`: unexpected argument ${a}`);
  }
  if (runId === undefined) throw CliError.usage(`\`git refresh\`: expected a <runId> argument`);
  return { runId };
}

async function gitRefresh(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const cfg = ctx.config.config;
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });

  try {
    // The run must be at the review gate (refreshRun re-checks, but fail fast with a clear message).
    const status = readAgentRunStatus(store.db, p.runId);
    if (status !== "review-pending") {
      throw new CliError({ code: "not-review-pending", message: `run ${p.runId} is at ${status ?? "<unknown>"}, not review-pending; only a review-pending run can be refreshed`, hint: "Refresh regenerates a run awaiting approval.", exitCode: EXIT.VALIDATION });
    }

    // Reconstruct the synthesis input: KIND + TARGET from agent_runs, INSTRUCTION from run_inputs.
    const runRow = store.db.prepare(`SELECT operation, target_note_id FROM agent_runs WHERE run_id = ?`).get(p.runId) as { operation: string; target_note_id: string | null } | undefined;
    if (runRow === undefined || !SYNTHESIS_KINDS.has(runRow.operation)) {
      throw new CliError({ code: "not-refreshable", message: `run ${p.runId} is a ${runRow?.operation ?? "<unknown>"} run, not a refreshable synthesis run`, hint: "Only enrich/reconcile/maintain runs can be refreshed.", exitCode: EXIT.VALIDATION });
    }
    const persisted = readRunInput(store.db, p.runId);
    if (persisted === null || runRow.target_note_id === null) {
      throw new CliError({ code: "input-unavailable", message: `run ${p.runId} has no recorded synthesis input; its generation cannot be reconstructed`, hint: "Refresh needs the run's original instruction (recorded from Task 4.11 onward); older runs cannot be refreshed.", exitCode: EXIT.VALIDATION });
    }
    const kind = runRow.operation as "enrich" | "reconcile" | "maintain";
    const input = { target: runRow.target_note_id, instruction: persisted.instruction, ...(persisted.retrievalK !== undefined ? { retrievalK: persisted.retrievalK } : {}), ...(persisted.typeFilter !== undefined ? { typeFilter: persisted.typeFilter } : {}) };

    // Connect the egress model boundary (retrieval embed + plan generateObject) + the audit broker.
    let egressClient: EgressClient;
    try {
      egressClient = await EgressClient.connect(cfg.broker.egress_socket_path);
    } catch (e) {
      throw new CliError({ code: "broker-unreachable", message: `the egress broker is unreachable at ${cfg.broker.egress_socket_path}`, hint: "Start the egress broker daemon.", exitCode: EXIT.CONFIG, cause: e });
    }
    let brokerClient: BrokerClient;
    try {
      brokerClient = await BrokerClient.connect(cfg.broker.socket_path);
    } catch (e) {
      egressClient.close();
      throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable at ${cfg.broker.socket_path}`, hint: "Start the broker daemon.", exitCode: EXIT.CONFIG, cause: e });
    }

    try {
      const receipts: ModelCallReceipt[] = [];
      const models = new ModelsClient((params, signal) => egressClient.invoke(params, signal), (r) => { receipts.push(r); });
      const indexingCfg = { chunker_version: cfg.indexing.chunker_version, embedding_model: cfg.indexing.embedding_model, dimensions: cfg.indexing.dimensions };
      const snapshot = await readVault(cfg);
      const noteById = new Map(snapshot.notes.map((n) => [n.id, n]));
      const retrieve = await makeRetrieveSeam({ ctx, store, models, indexingCfg, rrf: cfg.retrieval.rrf, fts: cfg.retrieval.fts, defaultSensitivity: cfg.policies.default_sensitivity, runId: p.runId, now: () => new Date().toISOString() });
      const generatePlan = makeModelPlanGenerator({
        models,
        model: cfg.models.generation_model,
        maxTokens: PLAN_GENERATION_MAX_TOKENS,
        mintCapability: (correlationId) => mintEgressCapability({ runId: correlationId }, { operation: "generateObject", model: cfg.models.generation_model, maxBytes: EGRESS.maxBytes, maxTokens: EGRESS.maxTokens, costCeiling: EGRESS.costCeiling, allowedSensitivity: cfg.policies.default_sensitivity } satisfies EgressLimits),
      });
      const deps: SynthesisRefreshDeps = {
        retrieve, generatePlan,
        readNote: (id: string) => noteById.get(id) ?? null,
        validationVault: makeStoreValidationVault(store.db),
        supportingEvidenceStates: () => [],
        inputsTrusted: () => true,
        evidenceValid: () => true,
        config: { packBudgetTokens: PACK_BUDGET, requireSourcesForSynthesis: cfg.policies.require_sources_for_synthesis, risk: riskConfigFrom(cfg.policies) },
        store, broker: brokerClient, backup: backupConfig(ctx), repo: openRepo(resolvePath(ctx, cfg.vault.path)),
        guard: new GeneratedArtifactGuard(quarantineStoreFromContext(ctx)),
        worktreesPath: resolvePath(ctx, cfg.git.worktrees_path),
        canonicalRef: cfg.git.canonical_ref,
      };

      const res = await refreshRun(p.runId, kind, input, deps);
      const out = { command: "git refresh", runId: res.runId, newCommit: res.newCommit, superseded: res.superseded, baseCommit: res.baseCommit, state: res.state };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`refreshed ${res.runId}: ${res.superseded.slice(0, 8)} → ${res.newCommit.slice(0, 8)} (${res.state})`);
      return EXIT.OK;
    } finally {
      brokerClient.close();
      egressClient.close();
    }
  } finally {
    store.close();
  }
}

registerCommand("git refresh", gitRefresh);

export { gitRefresh, parseArgs };
