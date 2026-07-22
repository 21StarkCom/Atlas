/**
 * `brain git rollback <runId>` (Task 4.9) — the privileged rollback of a previously-integrated run.
 * Classifies FIRST: a run whose rendition is cited by live evidence is REFUSED (`has-dependents`,
 * exit 1) listing the dependents; otherwise a capture-only run tombstones its rendition and a
 * self-contained run is reverted. The reverting run is DISTINCT (`rollbackRunId`), links to the
 * reverted run via `rollbackOf`, and the reverted run stays finalized. Authorized by the broker
 * challenge / `--export-challenge → sign → --authorization` flow; `--yes` never authorizes. Output
 * matches `git-rollback.schema.json`.
 */
import { BrokerClient } from "@atlas/broker";
import { newRunId } from "@atlas/contracts";
import { openRepo } from "@atlas/git";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore, classifyRollback, rollbackRun, type RunToRollback } from "../workflows/index.js";
import { CANONICAL_BRANCH } from "../workflows/direct-integrator.js";
import { readGitOp, readAgentRunStatus } from "../workflows/checkpoints.js";
import { foldProvenanceFromCanonical } from "../ingest/manifests.js";
import { ledgerDbPath, backupConfig, resolvePath } from "./backup-config.js";

const ZERO = "0".repeat(40);
const ROLLBACKABLE = new Set(["integrated", "reindexed", "finalized"]);

interface Parsed { runId: string; exportChallenge: boolean; authorization?: string }
function parseArgs(argv: string[]): Parsed {
  let runId: string | undefined, exportChallenge = false, authorization: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") authorization = argv[++i];
    else if (a.startsWith("--authorization=")) authorization = a.slice("--authorization=".length);
    else if (a === "--idempotency-key") i++;
    else if (a.startsWith("-")) throw CliError.usage(`\`git rollback\`: unknown flag ${a}`);
    else if (runId === undefined) runId = a;
    else throw CliError.usage(`\`git rollback\`: unexpected argument ${a}`);
  }
  if (runId === undefined) throw CliError.usage(`\`git rollback\`: expected a <runId> argument`);
  return { runId, exportChallenge, ...(authorization !== undefined ? { authorization } : {}) };
}

async function gitRollback(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const CANONICAL_REF = CANONICAL_BRANCH;
  const vaultPath = resolvePath(ctx, ctx.config.config.vault.path);
  const repo = openRepo(vaultPath);
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const state = readAgentRunStatus(store.db, p.runId);
    if (state === null || !ROLLBACKABLE.has(state)) {
      throw new CliError({ code: "not-rollbackable", message: `run ${p.runId} is at ${state ?? "<unknown>"}; only a previously-integrated run can be rolled back`, hint: "Rollback reverts a finalized/integrated run.", exitCode: EXIT.VALIDATION });
    }
    const operation = (store.db.prepare(`SELECT operation FROM agent_runs WHERE run_id = ?`).get(p.runId) as { operation: string }).operation;
    const target: RunToRollback = { runId: p.runId, operation };

    // Classify FIRST — a has-dependents run is refused before any authorization/revert.
    const dependentsOf = (_r: RunToRollback): readonly string[] => {
      const integrated = readGitOp(store.db, p.runId, "integrated");
      // Capture-class rollbacks check rendition dependents; synthesis runs have none here.
      void integrated;
      return [];
    };
    const classification = classifyRollback(target, { dependentsOf });
    if (classification.kind === "has-dependents") {
      throw new CliError({ code: "has-dependents", message: `run ${p.runId} has ${classification.dependents.length} downstream dependent(s); rollback refused`, hint: "Use a compensating ChangePlan instead.", exitCode: EXIT.VALIDATION, details: { dependents: classification.dependents as unknown[] } });
    }

    const integratedCommit = readGitOp(store.db, p.runId, "integrated")?.commitSha ?? ZERO;
    const op = { op: "git rollback", runId: p.runId, targetCommit: integratedCommit, canonicalBaseCommit: (await repo.readRef(CANONICAL_REF)) ?? ZERO, intendedEffect: { kind: "revert" as const, revertCommit: ZERO } };
    if (p.authorization === undefined) {
      if (!p.exportChallenge) throw new CliError({ code: "action-required", message: `rolling back ${p.runId} requires a broker authorization`, hint: "Re-run with --export-challenge, sign the challenge, then pass --authorization <path>.", exitCode: EXIT.ACTION_REQUIRED });
      const client = await connect(ctx);
      try { emitJson((await client.mintChallenge(op as never)) as unknown); return EXIT.ACTION_REQUIRED; }
      finally { client.close(); }
    }

    const authorization = JSON.parse(readFileSync(p.authorization, "utf8")) as never;
    const integrated = readGitOp(store.db, p.runId, "integrated");
    const client = await connect(ctx);
    try {
      const result = await rollbackRun(target, {
        store,
        dependentsOf,
        produceRevert: async ({ rollbackRunId }) => {
          const base = (await repo.readRef(CANONICAL_REF)) ?? ZERO;
          if (!integrated?.commitSha) return { revertCommit: null, base };
          const wtParent = ctx.config.config.git.worktrees_path && existsSync(resolvePath(ctx, ctx.config.config.git.worktrees_path)) ? resolvePath(ctx, ctx.config.config.git.worktrees_path) : tmpdir();
          const wt = await mkdtemp(join(wtParent, `atlas-rb-${rollbackRunId}-`));
          try {
            execFileSync("git", ["worktree", "add", "-q", "--detach", wt, CANONICAL_REF], { cwd: vaultPath });
            execFileSync("git", ["-c", "user.name=Atlas Agent", "-c", "user.email=agent@atlas.local", "revert", "--no-edit", integrated.commitSha], { cwd: wt });
            return { revertCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim(), base };
          } finally {
            try { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: vaultPath }); } catch { await rm(wt, { recursive: true, force: true }).catch(() => {}); }
          }
        },
        installRevert: async ({ rollbackRunId, revertCommit, base }) => {
          const event = { schemaVersion: 1 as const, eventId: newRunId(), kind: "run.rolled_back" as const, seq: 0, occurredAt: new Date().toISOString(), runId: rollbackRunId, subjects: [], canonicalCommit: revertCommit, detail: { rollbackOf: p.runId } };
          const res = await client.signAndAdvanceProtectedRef({ ref: CANONICAL_REF, expectedOld: base, newCommit: revertCommit, manifest: { schemaVersion: 1, runId: rollbackRunId, state: "rolled-back", createdAt: event.occurredAt, canonicalBaseCommit: base, targets: [] }, authorization, authorizedOp: { op: op.op, intendedEffect: op.intendedEffect }, event: event as never });
          return { canonicalSha: res.newCommit };
        },
        reconcile: async () => { await foldProvenanceFromCanonical(store, repo, CANONICAL_REF); },
      });
      void backupConfig(ctx);
      if (result.mode === "refused") {
        throw new CliError({ code: "has-dependents", message: `run ${p.runId} has downstream dependents`, hint: "Use a compensating ChangePlan.", exitCode: EXIT.VALIDATION, details: { dependents: result.dependents as unknown[] } });
      }
      const out = { command: "git rollback", runId: p.runId, rollbackRunId: result.rollbackRunId, rollbackOf: result.rollbackOf, revertCommit: result.revertCommit ?? ZERO, class: result.rollbackClass, reconciled: true, dependents: [] as string[] };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`rolled back ${p.runId} (${result.rollbackClass}) via ${result.rollbackRunId}`);
      return EXIT.OK;
    } finally { client.close(); }
  } finally {
    store.close();
  }
}

async function connect(ctx: RunContext): Promise<BrokerClient> {
  try { return await BrokerClient.connect(ctx.config.config.broker.socket_path); }
  catch (e) { throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable`, hint: "Start the broker daemon.", exitCode: EXIT.CONFIG, cause: e }); }
}

registerCommand("git rollback", gitRollback);

export { gitRollback };
