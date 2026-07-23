/**
 * `query` — the surviving BUSINESS-ROW landing (v2 #334 review finding).
 *
 * v1 landed query's correlated rows (retrieval_runs / retrieval_results /
 * model_calls / the agent_runs terminal) through the audited
 * runReadAudit→finalizeLedgerWrite path; v2 lands the SAME rows through a plain
 * `applyLedgerWrite` transaction (the audit event + covering backup are
 * retired). The #334 review flagged that the deleting of the v1 audit suite
 * left these SURVIVING rows unasserted — this suite restores that coverage
 * against the REAL `brain query` (in-process fake provider, daemon-free):
 *
 *   - an answered query records the retrieval run + per-item results + every
 *     model_call receipt + a terminal agent_runs row;
 *   - `--no-answer` STILL records the embed model_call (no generation row);
 *   - `recordFailedTransmissions` lands the failed agent_runs row + the
 *     receipts even though the command surfaced the original error.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore } from "@atlas/sqlite-store";
import { ModelsClient, createInProcessInvoker, type ModelCallReceipt } from "@atlas/models";
import { newRunId } from "@atlas/contracts";
import { runCli } from "../src/main.js";
import { recordFailedTransmissions } from "../src/commands/query.js";
import type { RunContext } from "../src/handlers.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

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
    const code = await runCli(argv, env, { cwd, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function count(table: string, where = "1=1", ...params: unknown[]): number {
  const s = openStore({ path: dbPath });
  try {
    return (s.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
  } finally {
    s.close();
  }
}

const BODY = "The alpha concept explains deterministic query embeddings.";

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-qrows-"));
  cwd = join(root, "work");
  vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir, env: GIT_ENV });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: vaultDir, env: GIT_ENV });
  dbPath = join(cwd, ".atlas", "atlas.db");
  writeFileSync(
    join(vaultDir, "alpha.md"),
    `---\nid: concept-alpha\ntype: concept\nschema_version: 1\ntitle: Alpha\nstatus: active\ncreated: 2026-07-22\nupdated: 2026-07-22\n---\n# Alpha\n\n${BODY}\n`,
    "utf8",
  );
  execFileSync("git", ["add", "-A"], { cwd: vaultDir, env: GIT_ENV });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: vaultDir, env: GIT_ENV });
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
  env = { ...process.env, NO_COLOR: "1", ATLAS_TEST_MODE: "1", ATLAS_FAKE_PROVIDER: "1" };
  const mig = await cli(["db", "migrate", "--json"]);
  expect(mig.code, mig.out).toBe(0);
  const sync = await cli(["sync", "--json"]);
  expect(sync.code, sync.out).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("query business rows land without the retired audit path", () => {
  it("--no-answer records the retrieval run + results + the embed model_call + a terminal agent_runs row", async () => {
    const r = await cli(["query", BODY, "--no-answer", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(count("retrieval_runs")).toBe(1);
    expect(count("retrieval_results")).toBeGreaterThan(0);
    expect(count("model_calls")).toBeGreaterThan(0); // the embed transmission
    expect(count("agent_runs", "operation = 'retrieve'")).toBe(1);
  });

  it("an answered query additionally records the generation model_call, correlated to ONE run", async () => {
    const r = await cli(["query", BODY, "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(count("retrieval_runs")).toBe(1);
    expect(count("model_calls")).toBeGreaterThanOrEqual(2); // embed + generation
    const s = openStore({ path: dbPath });
    try {
      const runIds = (s.db.prepare(`SELECT DISTINCT run_id FROM model_calls`).all() as { run_id: string }[]).map(
        (x) => x.run_id,
      );
      expect(runIds).toHaveLength(1); // every receipt correlated to the one query run
    } finally {
      s.close();
    }
  });

  it("recordFailedTransmissions lands the failed run + its receipts (best-effort accounting survives a model failure)", async () => {
    // Collect a REAL receipt from the in-process fake provider.
    const runId = newRunId(); // ONE id binds the receipts AND the failed run (the production shape)
    const receipts: ModelCallReceipt[] = [];
    const models = new ModelsClient(createInProcessInvoker({ env }), (r) => receipts.push(r));
    await models.embed({ model: "gemini-embedding-001", texts: ["x"], dimensions: 768 }, { runId });
    expect(receipts.length).toBeGreaterThan(0);

    const store = openStore({ path: dbPath });
    try {
      const warns: unknown[] = [];
      await recordFailedTransmissions(
        { log: { warn: (m: string, c: unknown) => warns.push([m, c]) } } as unknown as RunContext,
        store,
        runId,
        receipts,
        "injected retrieve failure",
        () => "2026-07-23T00:00:00.000Z",
      );
      expect(warns, JSON.stringify(warns)).toEqual([]);
      expect(
        (store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string }).status,
      ).toBe("failed");
      expect(count("model_calls", "run_id = ?", runId)).toBe(receipts.length);
    } finally {
      store.close();
    }
  });
});
