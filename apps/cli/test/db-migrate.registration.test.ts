/**
 * `db-migrate.registration` — the composition root registers EVERY feature-owned
 * migration (plan §2.7). Regression for the 2026-07-16 live-drive finding: the CLI
 * never called `registerGenerationMigration`, so a real deployment's `db migrate`
 * skipped `0008_index_config_revision` and the FIRST live `index rebuild` crashed
 * in `GenerationRepo.adoptConfig` ("no such table: index_config_revisions") — the
 * package tests masked it by registering the migration themselves.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore } from "@atlas/sqlite-store";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

let root: string, cwd: string, env: NodeJS.ProcessEnv;
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

beforeEach(() => {
  root = mkdtempSync(join("/tmp", "atlas-dbmr-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(join(cwd, "vault"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: join(cwd, "vault") });
  const config = [
    "vault:", `  path: ${join(cwd, "vault")}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("db migrate — feature-migration composition root", () => {
  it("a FRESH `db migrate` applies 0008_index_config_revision (generation layer)", async () => {
    const r = await cli(["db", "migrate", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out) as { applied: { id: string }[] };
    expect(out.applied.map((a) => a.id)).toContain("0008_index_config_revision");
  });

  it("the migrated store supports GenerationRepo.adoptConfig (what live `index rebuild` needs)", async () => {
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: join(cwd, ".atlas", "atlas.db") });
    try {
      // The exact call that crashed on the live drive with "no such table".
      const rev = store.generation.adoptConfig("chunker=1;model=gemini-embedding-001;dims=768");
      expect(rev).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });
});
