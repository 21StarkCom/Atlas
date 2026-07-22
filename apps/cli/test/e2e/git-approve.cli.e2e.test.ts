/**
 * `git-approve.cli.e2e` — the `brain git approve` command's authorization gate over the REAL
 * broker daemon. Post-demolition (ADR-0003) the retired action-required exit 6 is now
 * config/authorization exit 2 (`EXIT.CONFIG`): a review-pending run with `--export-challenge`
 * emits an AuthorizationChallenge and exits 2; without an authorization it exits 2; a
 * non-review-pending run is rejected (exit 1). The authorized → integrated path itself is
 * proven elsewhere; this exercises the command's gate wiring + exit mapping.
 *
 * NOTE: no production path produces a `review-pending` run any more (the Tier-3 synthesis
 * review loop is retired) — the gate precondition is synthesized directly in the ledger so
 * the SURVIVING `git approve` command's authorization + exit-code behavior stays covered.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRunId } from "@atlas/contracts";
import { runCli } from "../../src/main.js";
import { gitOpId, gitOpUpsert } from "../../src/workflows/checkpoints.js";
import { makePhase2Harness, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const NOW = "2026-07-14T00:00:00.000Z";

let h: Phase2Harness;
let cwd: string, env: NodeJS.ProcessEnv;
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const ro = process.stdout.write.bind(process.stdout), re = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try { return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out }; }
  finally { process.stdout.write = ro; process.stderr.write = re; }
}

/**
 * Synthesize a durable `review-pending` run directly in the ledger (agent_runs +
 * git_operations agent-committed/base + change_plans), backed by a real agent commit —
 * enough for `git approve`'s read-only precondition + challenge minting.
 */
function seedReviewPending(): string {
  const runId = newRunId();
  const base = h.git(["rev-parse", CANONICAL_REF]);
  // A real agent commit (the "reviewed" commit) on a detached agent branch.
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
  return runId;
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

describe("brain git approve (authorization gate)", () => {
  it("--export-challenge on a review-pending run emits a challenge + exits 2 (config/authorization)", async () => {
    const runId = seedReviewPending();
    const r = await cli(["git", "approve", runId, "--export-challenge", "--json"]);
    expect(r.code, r.out).toBe(2);
    const challenge = JSON.parse(r.out);
    expect(challenge.op).toBe("git approve");
    expect(challenge.nonce).toBeTruthy();
    expect(challenge.signingPayload).toBeTruthy();
  });

  it("without an authorization it is action-required (exit 2), never integrating", async () => {
    const runId = seedReviewPending();
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const r = await cli(["git", "approve", runId, "--json"]);
    expect(r.code, r.out).toBe(2);
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before); // never integrated
  });

  it("a non-review-pending run is rejected (exit 1)", async () => {
    const r = await cli(["git", "approve", "01J9Z8Q000000000000UNKNOWN0", "--json"]);
    expect(r.code, r.out).toBe(1);
  });
});
