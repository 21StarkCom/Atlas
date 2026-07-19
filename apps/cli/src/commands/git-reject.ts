/**
 * `brain git reject <runId>` (Task 4.9) — reject a Tier-3 run at the review gate: terminate it
 * (`rejected`, `run.rejected`) and clean its worktree; the agent commit is RETAINED for the audit
 * trail (never fast-forwarded onto canonical). Shared privilege (no broker challenge — rejection
 * removes nothing durable). Output matches `git-reject.schema.json`.
 */
import { BrokerClient } from "@atlas/broker";
import { openRepo } from "@atlas/git";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore, rejectRun, type ApproveDeps } from "../workflows/index.js";
import { readGitOp, readAgentRunStatus } from "../workflows/checkpoints.js";
import { ledgerDbPath, backupConfig, resolvePath } from "./backup-config.js";

function parseArgs(argv: string[]): string {
  const positional = argv.filter((a) => !a.startsWith("-"));
  const flags = argv.filter((a) => a.startsWith("-"));
  if (flags.length > 0) throw CliError.usage(`\`git reject\`: unknown flag ${flags[0]}`);
  if (positional.length !== 1) throw CliError.usage(`\`git reject\`: expected exactly one <runId> argument`);
  return positional[0]!;
}

async function gitReject(ctx: RunContext): Promise<number> {
  const runId = parseArgs(ctx.argv);
  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const state = readAgentRunStatus(store.db, runId);
    const committed = readGitOp(store.db, runId, "agent-committed");
    if (state !== "review-pending" || !committed?.commitSha) {
      throw new CliError({ code: "not-review-pending", message: `run ${runId} is not a review-pending run (state ${state ?? "<unknown>"})`, hint: "Only a Tier-3 run at the review gate can be rejected.", exitCode: EXIT.VALIDATION });
    }
    let client: BrokerClient;
    try {
      client = await BrokerClient.connect(ctx.config.config.broker.socket_path);
    } catch (e) {
      throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable at ${ctx.config.config.broker.socket_path}`, hint: "Start the broker daemon before rejecting.", exitCode: EXIT.CONFIG, cause: e });
    }
    try {
      const deps: ApproveDeps = { store, broker: client, backup: backupConfig(ctx), repo, integrate: async () => { throw new Error("reject does not integrate"); }, foldProjections: async () => {}, canonicalRef: ctx.config.config.git.canonical_ref };
      await rejectRun(runId, "rejected at review", deps);
      const out = { command: "git reject", runId, state: "rejected" as const, worktreeRemoved: true, retainedCommit: committed.commitSha };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`rejected ${runId} (retained ${committed.commitSha.slice(0, 8)})`);
      return EXIT.OK;
    } finally {
      client.close();
    }
  } finally {
    store.close();
  }
}

registerCommand("git reject", gitReject);

export { gitReject };
