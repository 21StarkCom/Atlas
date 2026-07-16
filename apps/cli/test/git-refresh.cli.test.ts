/**
 * `git-refresh.cli` (Task 4.11) — the wired `brain git refresh <runId>` command. The run-input
 * reconstruction + fail-closed guards (not-review-pending / not-refreshable / input-unavailable) run
 * BEFORE any daemon connect, so they are exercised deterministically here through the real router.
 * (The happy-path regeneration is proven end-to-end by `synthesis-refresh.e2e` + the `enrich.e2e`
 * seam assembly; this asserts the command reconstructs the input from persisted state + fails closed.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore } from "@atlas/sqlite-store";
import { newRunId } from "@atlas/contracts";
import { persistRunInput, readRunInput } from "../src/workflows/synthesis.js";
import { parseArgs } from "../src/commands/git-refresh.js";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

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

function seedRun(id: string, operation: string, status: string, targetNoteId: string | null): void {
  const s = openStore({ path: dbPath });
  try {
    s.db.prepare(
      `INSERT INTO agent_runs (run_id, operation, status, checkpoint_seq, target_note_id, tier, started_at, updated_at)
       VALUES (?,?,?,1,?,3,'2026-07-16T00:00:00Z','2026-07-16T00:00:00Z')`,
    ).run(id, operation, status, targetNoteId);
  } finally { s.close(); }
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-gr-"));
  cwd = join(root, "work");
  const vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
  dbPath = join(cwd, ".atlas", "atlas.db");
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
  env = { ...process.env, NO_COLOR: "1" };
  await cli(["db", "migrate", "--json"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("git refresh argument parsing (Task 4.11)", () => {
  it("parses <runId> + --idempotency-key; rejects missing runId / unknown flag / extra positional", () => {
    expect(parseArgs(["01JZ"])).toEqual({ runId: "01JZ" });
    expect(parseArgs(["01JZ", "--idempotency-key", "k"])).toEqual({ runId: "01JZ" });
    expect(() => parseArgs([])).toThrow(/expected a <runId>/);
    expect(() => parseArgs(["01JZ", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["01JZ", "02KZ"])).toThrow(/unexpected argument/);
  });
});

describe("run-input persistence round-trip (Task 4.11)", () => {
  it("persistRunInput → readRunInput preserves instruction + optional knobs; absent ⇒ null", () => {
    const s = openStore({ path: dbPath });
    try {
      const id = newRunId();
      expect(readRunInput(s.db, id)).toBeNull();
      persistRunInput(s.db, id, { target: "n", instruction: "enrich the note", retrievalK: 8, typeFilter: "concept" });
      expect(readRunInput(s.db, id)).toEqual({ instruction: "enrich the note", retrievalK: 8, typeFilter: "concept" });
      // A replay (same run) is idempotent (INSERT OR REPLACE).
      persistRunInput(s.db, id, { target: "n", instruction: "enrich the note" });
      expect(readRunInput(s.db, id)).toEqual({ instruction: "enrich the note" });
    } finally { s.close(); }
  });
});

describe("brain git refresh (fail-closed guards)", () => {
  it("a run not at the review gate ⇒ not-review-pending (exit 1)", async () => {
    const id = newRunId();
    seedRun(id, "enrich", "integrated", "note-a");
    const r = await cli(["git", "refresh", id, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("not-review-pending");
  });

  it("a review-pending non-synthesis run ⇒ not-refreshable (exit 1)", async () => {
    const id = newRunId();
    seedRun(id, "ingest", "review-pending", "note-a");
    const r = await cli(["git", "refresh", id, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("not-refreshable");
  });

  it("a review-pending synthesis run with no recorded input ⇒ input-unavailable (exit 1)", async () => {
    const id = newRunId();
    seedRun(id, "enrich", "review-pending", "note-a"); // no run_inputs row persisted
    const r = await cli(["git", "refresh", id, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("input-unavailable");
  });
});
