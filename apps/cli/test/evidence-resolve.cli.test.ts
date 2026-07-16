/**
 * `evidence-resolve.cli` (Task 4.7 / #59) — `brain evidence resolve`. Covers the fail-closed
 * re-anchor paths that need no broker: a missing evidence ⇒ not-found (exit 1), and a blob whose
 * active rendition is GONE ⇒ the re-anchor is `failed` (never fabricates a `valid`), outcome=failed
 * exit 1. The `valid`⇒integrate (exit 0) and `moved`⇒review-pending (exit 6) paths flow through the
 * broker-backed applySynthesis integrate/review proven by broker-integrator.e2e + enrich.e2e; the
 * match classification itself is unit-covered by classifyReanchor.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore, rebuildProjections } from "@atlas/sqlite-store";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { parseArgs } from "../src/commands/evidence-resolve.js";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;

function note(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return { id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active", created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over };
}
function sourceNote(): ParsedNote {
  const raw = ["---", "id: s-a", "type: source", "schema_version: 1", "title: s-a", "created: 2026-07-11", "updated: 2026-07-11",
    `contentId: "${CONTENT_A}"`, "origin: notes/a.txt", "provenance:", "  vault_path: sources/a.txt", "  size_bytes: 12", "  renditions:",
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`, "---", "", "# s-a", ""].join("\n");
  return note(raw, { type: "source", id: "s-a", path: "sources/s-a.md" });
}
function claimNote(): ParsedNote {
  const raw = ["---", "id: note-a", "type: concept", "schema_version: 1", "title: note-a", "created: 2026-07-11", "updated: 2026-07-11", "claims:",
    "  - claim_id: claim-a", '    text: "c."', "    evidence:", `      - rendition: "${CONTENT_A}:1:1"`, "        verification: pending", "---", "", "# note-a", ""].join("\n");
  return note(raw, { id: "note-a", path: "note-a.md" });
}

let root: string, cwd: string, env: NodeJS.ProcessEnv, dbPath: string, evidenceId: string;
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
  it("requires <runId|evidenceId>; rejects unknown flags + extra args", () => {
    expect(parseArgs(["ev-1"])).toEqual({ ref: "ev-1" });
    expect(() => parseArgs([])).toThrow(/runId\|evidenceId/);
    expect(() => parseArgs(["ev-1", "--nope"])).toThrow(/unknown/);
    expect(() => parseArgs(["ev-1", "ev-2"])).toThrow(/unexpected/);
  });
});

describe("brain evidence resolve (fail-closed, no broker)", () => {
  beforeEach(async () => {
    root = mkdtempSync(join("/tmp", "atlas-ers-"));
    cwd = join(root, "work");
    mkdirSync(join(cwd, ".atlas"), { recursive: true });
    mkdirSync(join(cwd, "vault"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: join(cwd, "vault") });
    dbPath = join(cwd, ".atlas", "atlas.db");
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
    await cli(["db", "migrate", "--json"]);
    const s = openStore({ path: dbPath });
    try {
      rebuildProjections(s.db, { notes: [sourceNote(), claimNote()], errors: [] } as VaultSnapshot);
      evidenceId = (s.db.prepare(`SELECT evidence_id AS id FROM claim_evidence WHERE claim_id = 'claim-a' AND current = 1`).get() as { id: string }).id;
    } finally { s.close(); }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a missing evidence id ⇒ not-found (exit 1)", async () => {
    const r = await cli(["evidence", "resolve", "nope-not-an-id", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("not-found");
  });

  it("a blob whose active rendition is GONE ⇒ failed re-anchor (never fabricates valid), exit 1", async () => {
    // Drop the blob's active-rendition pointer so the re-anchor match is `not-found`.
    const s = openStore({ path: dbPath });
    try {
      s.db.prepare(`UPDATE content_blobs SET active_extractor_version = NULL, active_normalizer_version = NULL WHERE raw_content_hash = ?`).run(HEX_A);
    } finally { s.close(); }

    const r = await cli(["evidence", "resolve", evidenceId, "--json"]);
    expect(r.code, r.out).toBe(1);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ command: "evidence resolve", outcome: "failed", verification: "failed", evidenceId });
  });
});
