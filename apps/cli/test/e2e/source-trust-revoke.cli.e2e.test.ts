/**
 * `source-trust-revoke.cli.e2e` (Task 4.8/4.9) — the `brain source trust revoke` authorization
 * gate over the REAL broker daemon: a captured source with `--export-challenge` emits a broker
 * AuthorizationChallenge (op `source trust revoke`) + exits 6; without an authorization it is
 * action-required (exit 6); an unknown source is rejected (exit 1). The authorized→revoked path's
 * projection update is covered by `trust-command.test`; the authorization construction by
 * `broker-authorization.test`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/main.js";
import { makePhase2Harness, type Phase2Harness } from "./phase2-support.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const HASH = "a".repeat(64);
const SOURCE_ID = `sha256:${HASH}:text/plain`;

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
  // Seed a captured blob so the source resolves.
  const store = h.openStore();
  try {
    store.db.prepare(`INSERT INTO content_blobs (raw_content_hash, canonical_media_type, size_bytes, vault_path, first_seen_at) VALUES (?, 'text/plain', 10, 'sources/a', '2026-07-14')`).run(HASH);
  } finally { store.close(); }
});
afterEach(async () => { await h.cleanup(); });

describe("brain source trust revoke (authorization gate)", () => {
  it("--export-challenge emits a challenge (op source trust revoke) + exits 6", async () => {
    const r = await cli(["source", "trust", "revoke", SOURCE_ID, "--export-challenge", "--json"]);
    expect(r.code, r.out).toBe(6);
    const challenge = JSON.parse(r.out);
    expect(challenge.op).toBe("source trust revoke");
    expect(challenge.nonce).toBeTruthy();
  });

  it("without an authorization it is action-required (exit 6)", async () => {
    const r = await cli(["source", "trust", "revoke", SOURCE_ID, "--json"]);
    expect(r.code).toBe(6);
  });

  it("an unknown source is rejected (exit 1)", async () => {
    const r = await cli(["source", "trust", "revoke", `sha256:${"c".repeat(64)}:text/plain`, "--export-challenge", "--json"]);
    expect(r.code).toBe(1);
  });
});
