/**
 * `brain git approve <runId>` (Task 4.9) — the privileged Tier-3 approval. FF-integrates the EXACT
 * reviewed commit onto canonical under a broker-authorized `run.integrated` install, then reindexes
 * + finalizes. Authorized ONLY by an OS-presence assertion bound to the broker challenge, or the
 * non-interactive `--export-challenge → sign → --authorization` flow (§7); `--yes` never authorizes.
 * Without an authorization it exits 6 (action-required) and, with `--export-challenge`, emits the
 * broker AuthorizationChallenge instead. A moved base is the stable `refresh-required` (exit 6) —
 * approve never rebases. Output matches `git-approve.schema.json`.
 */
import { BrokerClient } from "@atlas/broker";
import { openRepo } from "@atlas/git";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { ledgerDbPath, backupConfig, resolvePath } from "./backup-config.js";
import { readGitOp, readAgentRunStatus } from "../workflows/checkpoints.js";
import { approveRun, makeBrokerIntegrator, type ApproveDeps } from "../workflows/index.js";
import { foldProvenanceFromCanonical } from "../ingest/manifests.js";
import { readFileSync } from "node:fs";

interface Parsed { runId: string; exportChallenge: boolean; authorization?: string; idempotencyKey?: string }

function parseArgs(argv: string[]): Parsed {
  let runId: string | undefined, exportChallenge = false, authorization: string | undefined, idempotencyKey: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") authorization = argv[++i];
    else if (a.startsWith("--authorization=")) authorization = a.slice("--authorization=".length);
    else if (a === "--idempotency-key") idempotencyKey = argv[++i];
    else if (a.startsWith("--idempotency-key=")) idempotencyKey = a.slice("--idempotency-key=".length);
    else if (a.startsWith("-")) throw CliError.usage(`\`git approve\`: unknown flag ${a}`);
    else if (runId === undefined) runId = a;
    else throw CliError.usage(`\`git approve\`: unexpected argument ${a}`);
  }
  if (runId === undefined) throw CliError.usage(`\`git approve\`: expected a <runId> argument`);
  return { runId, exportChallenge, ...(authorization !== undefined ? { authorization } : {}), ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) };
}

async function gitApprove(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const canonicalRef = ctx.config.config.git.canonical_ref;
  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  const connectBroker = async (): Promise<BrokerClient> => {
    try {
      return await BrokerClient.connect(ctx.config.config.broker.socket_path);
    } catch (e) {
      throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable at ${ctx.config.config.broker.socket_path}`, hint: "Start the broker daemon before approving.", exitCode: EXIT.CONFIG, cause: e });
    }
  };
  try {
    // State check FIRST — an unknown / non-review-pending run is rejected without the broker.
    const state = readAgentRunStatus(store.db, p.runId);
    const committed = readGitOp(store.db, p.runId, "agent-committed");
    const base = readGitOp(store.db, p.runId, "base");
    if (state !== "review-pending" || !committed?.commitSha || !base?.commitSha) {
      throw new CliError({ code: "not-review-pending", message: `run ${p.runId} is not an approvable review-pending run (state ${state ?? "<unknown>"})`, hint: "Only a Tier-3 run at the review gate can be approved.", exitCode: EXIT.VALIDATION });
    }
    const planHash = (store.db.prepare(`SELECT plan_hash FROM change_plans WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`).get(p.runId) as { plan_hash: string } | undefined)?.plan_hash ?? "sha256:0";
    const op = { op: "git approve", runId: p.runId, targetCommit: committed.commitSha, canonicalBaseCommit: base.commitSha, intendedEffect: { kind: "integrate" as const, tier: 3 as const, changePlanDigest: planHash } };

    // No authorization yet → mint the challenge (broker) or report action-required (no broker).
    if (p.authorization === undefined) {
      if (!p.exportChallenge) {
        throw new CliError({ code: "action-required", message: `run ${p.runId} requires a broker authorization to approve`, hint: "Re-run with --export-challenge, sign the challenge with an enrolled approver key, then pass --authorization <path>.", exitCode: EXIT.ACTION_REQUIRED });
      }
      const client = await connectBroker();
      try {
        const challenge = await client.mintChallenge(op);
        emitJson(challenge as unknown);
        return EXIT.ACTION_REQUIRED;
      } finally {
        client.close();
      }
    }

    // Authorization supplied → integrate under the broker-signed run.integrated advance.
    const authorization = JSON.parse(readFileSync(p.authorization, "utf8")) as never;
    const client = await connectBroker();
    try {
      const deps: ApproveDeps = {
        store, broker: client, backup: backupConfig(ctx), repo,
        integrate: makeBrokerIntegrator(client, { authorization, op: op.op, intendedEffect: op.intendedEffect }),
        foldProjections: async () => { await foldProvenanceFromCanonical(store, repo, canonicalRef); },
        canonicalRef,
      };
      const out = await approveRun(p.runId, deps);
      if (out.mode === "refresh-required") {
        throw new CliError({ code: "refresh-required", message: `run ${p.runId}: canonical advanced since the commit was signed`, hint: "Run `brain git refresh` and re-approve.", exitCode: EXIT.ACTION_REQUIRED });
      }
      const canonicalHead = (await repo.readRef(canonicalRef)) ?? out.canonicalSha ?? committed.commitSha;
      const result = { command: "git approve", runId: p.runId, integratedCommit: out.canonicalSha ?? committed.commitSha, canonicalHead, reindexed: true };
      if (ctx.output.mode === "json") emitJson(result);
      else ctx.render(`approved ${p.runId}: integrated ${result.integratedCommit.slice(0, 8)}`);
      return EXIT.OK;
    } finally {
      client.close();
    }
  } finally {
    store.close();
  }
}

registerCommand("git approve", gitApprove);

export { gitApprove };
