/**
 * `evidence-retry.cli` (Task 4.7 / #59) — `brain evidence retry`. Covers the jobs-repo reset
 * primitive (terminal ⇒ requeued fresh; active ⇒ no-op) and the wired command: reconstruct the
 * reverify bump from a seeded failed evidence head, enqueue a reverify job (requeued), a repeat while
 * queued is a no-op (already-active), a missing evidence exits 1, and one evidence.retry_enqueued
 * ledger event is recorded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { openStore, rebuildProjections } from "@atlas/sqlite-store";
import { openJobsStore, resetForRetry, enqueue } from "@atlas/jobs";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
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
    "  - claim_id: claim-a", '    text: "c."', "    evidence:", `      - rendition: "${CONTENT_A}:1:1"`, "        verification: failed", "---", "", "# note-a", ""].join("\n");
  return note(raw, { id: "note-a", path: "note-a.md" });
}

describe("resetForRetry primitive (jobs)", () => {
  it("a terminal job resets to a fresh pending attempt; an active job is a no-op", () => {
    const s = openJobsStore({ path: ":memory:" });
    try {
      const id = enqueue(s.db, { workflow: "reverify", idempotencyKey: "k1", payload: { x: 1 } });
      // Simulate a terminal failure, then retry.
      s.db.prepare(`UPDATE jobs SET state = 'failed', attempts = 3, next_run_at = NULL WHERE job_id = ?`).run(id);
      expect(resetForRetry(s.db, id, "2026-07-16T00:00:00Z")).toBe("requeued");
      const row = s.db.prepare(`SELECT state, attempts, next_run_at FROM jobs WHERE job_id = ?`).get(id) as { state: string; attempts: number; next_run_at: string | null };
      expect(row).toMatchObject({ state: "pending", attempts: 0, next_run_at: "2026-07-16T00:00:00Z" });
      // A repeat while pending is a no-op.
      expect(resetForRetry(s.db, id, "2026-07-16T00:00:01Z")).toBe("already-active");
    } finally { s.close(); }
  });
});

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

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-ert-"));
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

describe("brain evidence retry", () => {
  it("enqueues a reverify job for a failed evidence head (requeued), and records one ledger event", async () => {
    const r = await cli(["evidence", "retry", evidenceId, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ command: "evidence retry", evidenceId, requeued: true });
    expect(out.jobId).toBeTruthy();

    const s = openJobsStore({ path: dbPath });
    try {
      const job = s.db.prepare(`SELECT state, workflow FROM jobs WHERE job_id = ?`).get(out.jobId) as { state: string; workflow: string };
      expect(job).toMatchObject({ state: "pending", workflow: "reverify" });
      const events = (s.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'evidence.retry_enqueued'`).get() as { n: number }).n;
      expect(events).toBe(1);
    } finally { s.close(); }
  });

  it("a repeat retry while the job is queued is a no-op (requeued=false, same jobId)", async () => {
    const first = JSON.parse((await cli(["evidence", "retry", evidenceId, "--json"])).out);
    const second = JSON.parse((await cli(["evidence", "retry", evidenceId, "--json"])).out);
    expect(second.jobId).toBe(first.jobId);
    expect(second.requeued).toBe(false);
  });

  it("a missing evidence id ⇒ not-found (exit 1)", async () => {
    const r = await cli(["evidence", "retry", "nope-not-an-id", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("not-found");
  });
});
