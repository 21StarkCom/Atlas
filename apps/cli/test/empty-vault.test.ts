/**
 * `empty-vault` (#342, Phase-4 task 4-6) — zero-state proof. On a FRESH, EMPTY vault
 * (git-init, `db migrate`, no notes) the read/maintenance surface must return a
 * well-formed, zero-count payload at exit 0 — never a crash, never a spurious error.
 *
 * Drives the REAL `brain` commands through `runCli` over a real (empty) git vault +
 * migrated store, with the deterministic in-process fake embedder (so `index rebuild`
 * / `query` need no daemon and no network):
 *   - `status`      ⇒ well-formed payload, zero counts, exit 0;
 *   - `sync`        ⇒ noop:true (nothing to reconcile), exit 0;
 *   - `query <x>`   ⇒ empty result set, exit 0;
 *   - `db rebuild`  ⇒ empty projection (every table 0 rows), exit 0.
 *
 * (`query` opens the LanceDB table, so the fresh-install turnkey step `index rebuild`
 * — itself asserted zero-state, exit 0 — runs first to create the empty index.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runCli } from "../src/main.js";

let root: string;
let cwd: string;
let vaultDir: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Aryeh Stark",
  GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
  GIT_COMMITTER_NAME: "Aryeh Stark",
  GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
};

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, env, { cwd });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-empty-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  vaultDir = join(cwd, "vault");
  mkdirSync(vaultDir, { recursive: true });
  // A fresh, EMPTY git vault: init + one empty commit so there is a HEAD, no notes.
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: vaultDir, env: GIT_ENV });
  const config = [
    "vault:", `  path: ${vaultDir}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = {
    ...process.env,
    NO_COLOR: "1",
    ATLAS_TEST_MODE: "1",
    ATLAS_FAKE_PROVIDER: "1",
  };
  dbPath = join(cwd, ".atlas", "atlas.db");
  const migrate = await cli(["db", "migrate", "--json"]);
  expect(migrate.code, migrate.out).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("empty-vault zero-state (#342)", () => {
  it("status ⇒ well-formed payload with zero counts, exit 0", async () => {
    const r = await cli(["status", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.command).toBe("status");
    // Every count is zero on a fresh empty vault.
    expect(out.vault.noteCount).toBe(0);
    expect(out.db).toMatchObject({ noteCount: 0, sectionCount: 0, linkCount: 0 });
    expect(out.index.chunkCount).toBe(0);
    expect(out.sync).toMatchObject({ pendingChangedCount: 0, pendingNewCount: 0, pendingDroppedCount: 0, pendingMovedCount: 0 });
    // The payload carries the full probe set (well-formed, not a partial/crash).
    expect(Array.isArray(out.checks)).toBe(true);
    expect(out.checks.length).toBeGreaterThan(0);
  });

  it("sync ⇒ noop:true (nothing to reconcile), exit 0", async () => {
    const r = await cli(["sync", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.command).toBe("sync");
    expect(out.noop).toBe(true);
    expect(out).toMatchObject({ scannedCount: 0, changedCount: 0, newCount: 0, droppedCount: 0, movedCount: 0 });
  });

  it("index rebuild ⇒ empty index (0 notes, 0 chunks), exit 0 — the fresh-install turnkey step", async () => {
    const r = await cli(["index", "rebuild", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ command: "index rebuild", notesIndexed: 0, chunksWritten: 0 });
  });

  it("query <anything> ⇒ empty result set, exit 0", async () => {
    // The LanceDB table must exist for query to open it — build the empty index first
    // (the turnkey step above, asserted zero-state separately).
    const built = await cli(["index", "rebuild", "--json"]);
    expect(built.code, built.out).toBe(0);

    const r = await cli(["query", "anything at all", "--no-answer", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.command).toBe("query");
    expect(out.mode).toBe("retrieval-only");
    expect(out.items).toEqual([]); // empty result set
  });

  it("db rebuild ⇒ empty projection (every table 0 rows), exit 0", async () => {
    const r = await cli(["db", "rebuild", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.command).toBe("db rebuild");
    for (const t of out.rebuilt as { table: string; rows: number }[]) {
      expect(t.rows, `${t.table} should be empty`).toBe(0);
    }
    // The DB file exists (migrate created it); rebuild never conjured a second store.
    expect(existsSync(dbPath)).toBe(true);
  });
});
