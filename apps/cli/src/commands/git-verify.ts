/**
 * `brain git verify` (Task 4.9) — read-only manifest↔index convergence check over every
 * non-terminal run. For each run whose ledger records an agent commit, it asserts the recorded
 * commit resolves and `refs/agent/<runId>` points at it; a divergence is REPORTED (not mutated).
 * Output matches `git-verify.schema.json`: `{command, convergent, checked, repaired, divergences}`.
 * Read-only + shared: no ref/worktree/ledger mutation. `repaired` is 0 here — this build reports
 * divergences for the operator; convergent repair re-folds from canonical (a separate step).
 */
import { openRepo } from "@atlas/git";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { resolvePath } from "./backup-config.js";
import { verifyRun, type VerifyDivergence } from "../workflows/index.js";

function parseArgs(argv: string[]): void {
  if (argv.length > 0) throw CliError.usage(`\`git verify\`: unexpected argument ${argv[0]}`);
}

async function gitVerify(ctx: RunContext): Promise<number> {
  parseArgs(ctx.argv);
  const vaultPath = resolvePath(ctx, ctx.config.config.vault.path);
  const repo = openRepo(vaultPath);
  const store = openMigratedStore(ctx);
  try {
    // Every non-terminal run whose git evidence must converge with the observable refs.
    const runIds = (
      store.db
        .prepare(
          `SELECT run_id FROM agent_runs
            WHERE status NOT IN ('rejected','rolled-back','failed','cancelled')
            ORDER BY run_id`,
        )
        .all() as { run_id: string }[]
    ).map((r) => r.run_id);

    let checked = 0;
    const divergences: VerifyDivergence[] = [];
    for (const runId of runIds) {
      const report = await verifyRun(store.db, repo, runId);
      checked += report.checked;
      divergences.push(...report.divergences);
    }

    // Map the internal divergence kinds to the schema's convergence-class enum. This build
    // REPORTS divergences (read-only); `repaired` is the (currently empty) set the convergent
    // repair pass would fix by re-folding from canonical.
    const out = {
      command: "git verify",
      convergent: divergences.length === 0,
      checked,
      repaired: [] as { runId: string; kind: string; detail?: string }[],
      divergences: divergences.map((d) => ({ runId: d.runId, kind: "manifest-index-drift", detail: d.detail })),
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`git verify: ${out.convergent ? "convergent" : `${divergences.length} divergence(s)`} across ${checked} run(s)`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("git verify", gitVerify);

export { gitVerify };
