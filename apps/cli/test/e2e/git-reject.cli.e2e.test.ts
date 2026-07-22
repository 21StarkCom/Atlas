/**
 * `git-reject.cli.e2e` — `brain git reject <runId>` terminates a review-pending run
 * (`rejected`, `run.rejected`) and retains the agent commit for the audit trail; canonical is
 * never touched. Validated against `git-reject.schema.json`.
 *
 * NOTE: no production path produces a `review-pending` run any more (the Tier-3 synthesis
 * review loop is retired, ADR-0003) — the gate precondition is synthesized directly in the
 * ledger so the SURVIVING `git reject` command's behavior + exit codes stay covered.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import _Ajv2020 from "ajv/dist/2020.js";
import { newRunId } from "@atlas/contracts";
import { runCli } from "../../src/main.js";
import { gitOpId, gitOpUpsert } from "../../src/workflows/checkpoints.js";
import { makePhase2Harness, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const NOW = "2026-07-14T00:00:00.000Z";
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (o?: unknown) => { compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown }; errorsText: (e?: unknown) => string };
function validateSchema(name: string, value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const v = ajv.compile(JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8")));
  if (!v(value)) throw new Error(`${name}: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value)}`);
}

let h: Phase2Harness, cwd: string, env: NodeJS.ProcessEnv;
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const ro = process.stdout.write.bind(process.stdout), re = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try { return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out }; }
  finally { process.stdout.write = ro; process.stderr.write = re; }
}

/** Synthesize a durable review-pending run (agent_runs + git_operations + change_plans + a real agent commit). */
function seedReviewPending(): { runId: string; commitSha: string } {
  const runId = newRunId();
  const base = h.git(["rev-parse", CANONICAL_REF]);
  const agentRef = `refs/agent/${runId}`;
  const commitSha = h.gitIn(h.vaultDir, ["commit-tree", `${base}^{tree}`, "-p", base, "-m", `agent ${runId}`], Buffer.from(""));
  h.git(["update-ref", agentRef, commitSha]);
  const store = h.openStore();
  try {
    store.ledger.upsertAgentRun({ run_id: runId, operation: "enrich", status: "review-pending", tier: 3, started_at: NOW, updated_at: NOW });
    store.db.prepare(`INSERT INTO change_plans (plan_id, run_id, tier, confidence, summary, plan_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`${runId}-plan`, runId, 3, 0.5, "enrich alpha", "sha256:plan", NOW);
    for (const stmt of [
      gitOpUpsert({ gitOpId: gitOpId(runId, "agent-committed"), runId, opType: "agent-committed", refName: agentRef, commitSha, now: NOW }),
      gitOpUpsert({ gitOpId: gitOpId(runId, "base"), runId, opType: "base", refName: CANONICAL_REF, commitSha: base, now: NOW }),
    ]) store.db.prepare(stmt.sql).run(stmt.params);
  } finally { store.close(); }
  return { runId, commitSha };
}

beforeEach(async () => {
  h = await makePhase2Harness();
  cwd = h.root;
  writeFileSync(join(h.root, "brain.config.yaml"), [
    "vault:", `  path: ${h.vaultDir}`, "sqlite:", `  path: ${h.dbPath}`, "  ledger_backup:", `    dir: ${join(h.root, ".atlas", "backups")}`, "    key_id: test-key-v1", "    keep: 10",
    "lancedb:", `  dir: ${join(h.root, ".atlas", "lancedb")}`, "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", `  worktrees_path: ${h.worktreesPath}`, `  audit_anchor_path: ${h.anchorPath}`, "models: {}", "policies: {}",
    "logs:", `  dir: ${join(h.root, ".atlas", "logs")}`, "broker:", `  socket_path: ${h.socketPath}`, `  egress_socket_path: ${join(h.root, "e.sock")}`, "",
  ].join("\n"), "utf8");
  env = { ...process.env, NO_COLOR: "1", ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: join(h.root, ".atlas", "custody") };
});
afterEach(async () => { await h.cleanup(); });

describe("brain git reject", () => {
  it("rejects a review-pending run, retaining the agent commit; canonical untouched", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const { runId, commitSha } = seedReviewPending();
    const r = await cli(["git", "reject", runId, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-reject", out);
    expect(out.state).toBe("rejected");
    expect(out.retainedCommit).toBe(commitSha);
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before); // canonical untouched
    const store = h.openStore();
    try {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("rejected");
    } finally { store.close(); }
  });

  it("errors on a non-review-pending run (exit 1)", async () => {
    const r = await cli(["git", "reject", "01J9Z8Q000000000000UNKNOWN0", "--json"]);
    expect(r.code).toBe(1);
  });
});
