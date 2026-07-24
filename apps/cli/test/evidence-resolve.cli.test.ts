/**
 * `evidence-resolve.cli` (v2 task 4-4) — `brain evidence resolve`. Deterministic
 * reverification of a flat vault-derived evidence row: a present note+entry ⇒
 * `resolved` (status written to the note frontmatter + committed + re-folded); a
 * gone target ⇒ `target-missing` (no mutation). No renditions, no broker, no ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore, EvidenceRepo } from "@atlas/sqlite-store";
import { parseArgs } from "../src/commands/evidence-resolve.js";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** A valid vault note carrying one flat `evidence:` frontmatter entry. */
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

describe("evidence resolve arg parsing", () => {
  it("requires <evidenceId>; rejects unknown flags + extra args", () => {
    expect(parseArgs(["ev-1"])).toEqual({ evidenceId: "ev-1" });
    expect(() => parseArgs([])).toThrow(/evidenceId/);
    expect(() => parseArgs(["ev-1", "--nope"])).toThrow(/unknown/);
    expect(() => parseArgs(["ev-1", "ev-2"])).toThrow(/unexpected/);
  });
});

describe("brain evidence resolve (v2 deterministic, no broker)", () => {
  beforeEach(async () => {
    root = mkdtempSync(join("/tmp", "atlas-ers-"));
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
    // Commit the note so the working tree is clean + HEAD=main (the mutation-order gates).
    writeFileSync(join(vaultDir, "note-a.md"), NOTE_A, "utf8");
    git(["add", "-A"]); git(["commit", "-q", "-m", "seed"]);
    await cli(["db", "migrate", "--json"]);
    // Seed the flat evidence rows directly (a present note-a entry + an orphan ghost row).
    const s = openStore({ path: dbPath });
    try {
      const repo = new EvidenceRepo(s.db);
      repo.replaceForNote("note-a", "hash-a", [{ id: "ev-note-a", claim: "Meridian launched.", status: "pending", createdAt: "2026-07-11" }]);
      repo.replaceForNote("ghost", "hash-g", [{ id: "ev-ghost", claim: "orphan", status: "pending", createdAt: "2026-07-11" }]);
    } finally { s.close(); }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a missing evidence id ⇒ not-found (exit 1)", async () => {
    const r = await cli(["evidence", "resolve", "nope-not-an-id", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("not-found");
  });

  it("a present note+entry ⇒ resolved: status written to Markdown, committed, re-folded", async () => {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir }).toString().trim();
    const r = await cli(["evidence", "resolve", "ev-note-a", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ command: "evidence resolve", outcome: "resolved", evidenceId: "ev-note-a", noteId: "note-a", status: "resolved" });
    expect(out.commit).toMatch(/^[0-9a-f]{40}$/);
    // Exactly one new commit, and the re-folded row reads resolved (Markdown SSOT).
    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir }).toString().trim();
    expect(after).not.toBe(before);
    const s = openStore({ path: dbPath });
    try {
      expect(new EvidenceRepo(s.db).byId("ev-note-a")?.status).toBe("resolved");
    } finally { s.close(); }
  });

  it("an evidence row whose note is gone ⇒ target-missing (needs-review, no mutation, exit 0)", async () => {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir }).toString().trim();
    const r = await cli(["evidence", "resolve", "ev-ghost", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ command: "evidence resolve", outcome: "target-missing", evidenceId: "ev-ghost", status: "needs-review" });
    expect(out.commit).toBeUndefined();
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir }).toString().trim()).toBe(before);
  });
});
