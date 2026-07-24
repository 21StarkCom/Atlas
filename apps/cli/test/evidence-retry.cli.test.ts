/**
 * `evidence-retry.cli` (v2 task 4-4) — `brain evidence retry`. Synchronous retry:
 * re-runs the deterministic reverification AND increments `attempts` in the note's
 * `evidence:` frontmatter entry (committed + re-folded). No jobs queue, no ledger
 * event. A gone target ⇒ target-missing (attempts unchanged, no mutation).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore, EvidenceRepo } from "@atlas/sqlite-store";
import { parseArgs } from "../src/commands/evidence-retry.js";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const NOTE_A = [
  "---", "id: note-a", "type: concept", "schema_version: 1", "title: note-a",
  "created: 2026-07-11", "updated: 2026-07-11",
  "evidence:", "  - id: ev-note-a", '    claim: "Meridian launched."', "    status: pending",
  "---", "", "# note-a", "", "body", "",
].join("\n");

let root: string, cwd: string, env: NodeJS.ProcessEnv, dbPath: string, vaultDir: string;
function git(args: string[]): void { execFileSync("git", args, { cwd: vaultDir }); }
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

describe("evidence retry arg parsing", () => {
  it("requires <evidenceId>; rejects unknown flags + extra args", () => {
    expect(parseArgs(["ev-1"])).toEqual({ evidenceId: "ev-1" });
    expect(() => parseArgs([])).toThrow(/evidenceId/);
    expect(() => parseArgs(["ev-1", "--nope"])).toThrow(/unknown/);
  });
});

describe("brain evidence retry (v2 synchronous, no jobs/ledger)", () => {
  beforeEach(async () => {
    root = mkdtempSync(join("/tmp", "atlas-ert-"));
    cwd = join(root, "work");
    vaultDir = join(cwd, "vault");
    mkdirSync(join(cwd, ".atlas"), { recursive: true });
    mkdirSync(vaultDir, { recursive: true });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
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
    writeFileSync(join(vaultDir, "note-a.md"), NOTE_A, "utf8");
    git(["add", "-A"]); git(["commit", "-q", "-m", "seed"]);
    await cli(["db", "migrate", "--json"]);
    const s = openStore({ path: dbPath });
    try {
      const repo = new EvidenceRepo(s.db);
      repo.replaceForNote("note-a", "hash-a", [{ id: "ev-note-a", claim: "Meridian launched.", status: "pending", attempts: 0, createdAt: "2026-07-11" }]);
      repo.replaceForNote("ghost", "hash-g", [{ id: "ev-ghost", claim: "orphan", status: "pending", attempts: 0, createdAt: "2026-07-11" }]);
    } finally { s.close(); }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("increments attempts in the note (verified by re-folding), resolved + committed", async () => {
    const r1 = await cli(["evidence", "retry", "ev-note-a", "--json"]);
    expect(r1.code, r1.out).toBe(0);
    const out1 = JSON.parse(r1.out);
    expect(out1).toMatchObject({ command: "evidence retry", outcome: "resolved", evidenceId: "ev-note-a", status: "resolved", attempts: 1 });
    expect(out1.commit).toMatch(/^[0-9a-f]{40}$/);
    const s1 = openStore({ path: dbPath });
    try { expect(new EvidenceRepo(s1.db).byId("ev-note-a")?.attempts).toBe(1); } finally { s1.close(); }

    // A second retry bumps to 2 (attempts lives in the note, re-folded each time).
    const r2 = await cli(["evidence", "retry", "ev-note-a", "--json"]);
    expect(r2.code, r2.out).toBe(0);
    expect(JSON.parse(r2.out).attempts).toBe(2);
    const s2 = openStore({ path: dbPath });
    try { expect(new EvidenceRepo(s2.db).byId("ev-note-a")?.attempts).toBe(2); } finally { s2.close(); }
  });

  it("a gone target ⇒ target-missing, attempts unchanged, no mutation, exit 0", async () => {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir }).toString().trim();
    const r = await cli(["evidence", "retry", "ev-ghost", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ command: "evidence retry", outcome: "target-missing", status: "needs-review", attempts: 0 });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir }).toString().trim()).toBe(before);
  });

  it("a missing evidence id ⇒ not-found (exit 1)", async () => {
    const r = await cli(["evidence", "retry", "nope", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("not-found");
  });
});
