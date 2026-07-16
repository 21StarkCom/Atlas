/**
 * `git-rollback.cli.e2e` (Task 4.9) — the `brain git rollback` authorization gate over the real
 * broker daemon: a finalized run with `--export-challenge` emits a challenge (op `git rollback`)
 * + exits 6; bare is action-required (exit 6); a non-rollbackable / unknown run is rejected
 * (exit 1). The authorized revert+install itself is covered by `rollback-lifecycle.e2e`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main.js";
import { makePhase2Harness, type Phase2Harness } from "./phase2-support.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const RUN = "01J9Z8Q0000000000000000FR0";

let h: Phase2Harness, cwd: string, env: NodeJS.ProcessEnv;
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const ro = process.stdout.write.bind(process.stdout), re = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try { return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out }; }
  finally { process.stdout.write = ro; process.stderr.write = re; }
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
  // Seed a finalized synthesis run (rollback-able, no dependents ⇒ self-contained).
  const store = h.openStore();
  try {
    const now = "2026-07-14T00:00:00.000Z";
    store.ledger.upsertAgentRun({ run_id: RUN, operation: "enrich", status: "finalized", tier: 3, started_at: now, updated_at: now });
    store.db.prepare(`INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at) VALUES (?, ?, 'integrated', 'refs/heads/main', ?, ?)`).run(`${RUN}:integrated`, RUN, "c".repeat(40), now);
  } finally { store.close(); }
});
afterEach(async () => { await h.cleanup(); });

describe("brain git rollback (authorization gate)", () => {
  it("--export-challenge on a finalized run emits a challenge (op git rollback) + exits 6", async () => {
    const r = await cli(["git", "rollback", RUN, "--export-challenge", "--json"]);
    expect(r.code, r.out).toBe(6);
    expect(JSON.parse(r.out).op).toBe("git rollback");
  });

  it("without an authorization it is action-required (exit 6)", async () => {
    const r = await cli(["git", "rollback", RUN, "--json"]);
    expect(r.code).toBe(6);
  });

  it("a non-rollbackable / unknown run is rejected (exit 1)", async () => {
    const r = await cli(["git", "rollback", "01J9Z8Q0000000000000UNKNOWN", "--json"]);
    expect(r.code).toBe(1);
  });
});
