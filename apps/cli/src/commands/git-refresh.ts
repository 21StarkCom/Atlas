/**
 * `brain git refresh <runId>` (Task 4.11) — regenerate a review-pending run against the current
 * canonical head. Reconstructs the run's synthesis input (KIND + TARGET from `agent_runs`, the
 * INSTRUCTION from the 0011 `run_inputs` record), replays the plan on top of the latest canonical,
 * and produces a new superseding agent commit — the run STAYS review-pending. NON-PRIVILEGED:
 * refresh performs no canonical/trust/erase mutation (only regenerates a pending proposal the
 * operator must still approve), so it needs no OS-presence authorization; it emits a `run.refreshed`
 * audit event through the normal audit path (engine core `refreshRun`). Output ⇒ `git-refresh.schema.json`.
 */
import { openRepo } from "@atlas/git";
import { ModelsClient, createInProcessInvoker, type ModelCallReceipt } from "@atlas/models";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { readAgentRunStatus } from "../workflows/checkpoints.js";
import { makeRetrieveSeam } from "../retrieval/wiring.js";
import { makeModelPlanGenerator, PLAN_GENERATION_MAX_TOKENS, refreshRun, type SynthesisRefreshDeps } from "../workflows/index.js";
import { inProcessAuditBroker, CANONICAL_BRANCH } from "../workflows/direct-integrator.js";
import { makeStoreValidationVault } from "../validation/store-vault.js";
import { readRunInput } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { backupConfig, ledgerDbPath, resolvePath } from "./backup-config.js";

const PACK_BUDGET = 6000;
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

    // The audit + model boundaries are both in-process (ADR-0003): no broker daemon,
    // no egress daemon, no capability mint. `refresh` performs no canonical move (the
    // run stays review-pending), so the in-process client only appends the
    // non-installing `run.refreshed` event (audit/WORM dropped).
    const repo = openRepo(resolvePath(ctx, cfg.vault.path));
    const broker = inProcessAuditBroker();

    {
      const receipts: ModelCallReceipt[] = [];
      const models = new ModelsClient(createInProcessInvoker({ env: ctx.env }), (r) => { receipts.push(r); });
      const indexingCfg = { chunker_version: cfg.indexing.chunker_version, embedding_model: cfg.indexing.embedding_model, dimensions: cfg.indexing.dimensions };
      const snapshot = await readVault(cfg);
      const noteById = new Map(snapshot.notes.map((n) => [n.id, n]));
      const retrieve = await makeRetrieveSeam({ ctx, store, models, indexingCfg, rrf: cfg.retrieval.rrf, fts: cfg.retrieval.fts, defaultSensitivity: cfg.policies.default_sensitivity, runId: p.runId, now: () => new Date().toISOString() });
      const generatePlan = makeModelPlanGenerator({
        models,
        model: cfg.models.generation_model,
        maxTokens: PLAN_GENERATION_MAX_TOKENS,
      });
      const deps: SynthesisRefreshDeps = {
        retrieve, generatePlan,
        readNote: (id: string) => noteById.get(id) ?? null,
        validationVault: makeStoreValidationVault(store.db),
        supportingEvidenceStates: () => [],
        config: { packBudgetTokens: PACK_BUDGET, requireSourcesForSynthesis: cfg.policies.require_sources_for_synthesis },
        store, broker, backup: backupConfig(ctx), repo,
        worktreesPath: resolvePath(ctx, cfg.git.worktrees_path),
        canonicalRef: CANONICAL_BRANCH,
      };

      const res = await refreshRun(p.runId, kind, input, deps);
      const out = { command: "git refresh", runId: res.runId, newCommit: res.newCommit, superseded: res.superseded, baseCommit: res.baseCommit, state: res.state };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`refreshed ${res.runId}: ${res.superseded.slice(0, 8)} → ${res.newCommit.slice(0, 8)} (${res.state})`);
      return EXIT.OK;
    }
  } finally {
    store.close();
  }
}

registerCommand("git refresh", gitRefresh);

export { gitRefresh, parseArgs };
