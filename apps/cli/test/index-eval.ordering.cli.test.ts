/**
 * `index-eval.ordering.cli` — #157: `brain index eval` validates the eval-set files
 * BEFORE connecting the egress broker. A local eval-set error must surface as
 * `eval-set-invalid` (exit 1), NOT be masked by `broker-unreachable` (exit 2) when
 * authoring a set with no daemon running. Driven through the real CLI with the egress
 * socket pointed at a nonexistent path, so reaching the broker connect at all fails
 * `broker-unreachable` — the assertions below prove validation runs first.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

let root: string, cwd: string, env: NodeJS.ProcessEnv;

async function cli(argv: string[], envOverride?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    return { code: await runCli(argv, envOverride ?? env, { cwd, root: REPO_ROOT }), out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function writeSet(queries: unknown, labels: unknown): { q: string; l: string } {
  const q = join(root, "queries.json");
  const l = join(root, "labels.json");
  writeFileSync(q, typeof queries === "string" ? queries : JSON.stringify(queries));
  writeFileSync(l, typeof labels === "string" ? labels : JSON.stringify(labels));
  return { q, l };
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-eval-order-"));
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
    // Both sockets point at nonexistent paths — any command that reaches the broker
    // connect fails broker-unreachable (exit 2).
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1" };
  // A migrated ledger so the store opens (index eval needs it before validation).
  expect((await cli(["db", "migrate"])).code).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain index eval — eval-set validation precedes the egress broker (#157)", () => {
  it("malformed eval-set JSON fails eval-set-invalid (exit 1), not broker-unreachable, with the egress daemon down", async () => {
    const { q, l } = writeSet("{nope", { version: 1, labels: { q1: ["team-cloud"] } });
    const { code, out } = await cli(["index", "eval", "--queries", q, "--labels", l, "--json"]);
    expect(code).toBe(1);
    expect(out).toContain("eval-set-invalid");
    expect(out).not.toContain("broker-unreachable");
  });

  it("a label id absent from the notes projection fails eval-set-invalid before the broker", async () => {
    // Valid shape, but the vault is empty so no note id resolves — the cross-check
    // (which needs only the store) rejects it up front, no broker required.
    const { q, l } = writeSet(
      { version: 1, queries: [{ id: "q1", text: "who runs the cloud team" }] },
      { version: 1, labels: { q1: ["team-cloud"] } },
    );
    const { code, out } = await cli(["index", "eval", "--queries", q, "--labels", l, "--json"]);
    expect(code).toBe(1);
    expect(out).toContain("eval-set-invalid");
    expect(out).toContain("team-cloud");
    expect(out).not.toContain("broker-unreachable");
  });

  it("a well-formed, resolvable eval set proceeds PAST validation and RUNS the eval (proves validation is not over-eager)", async () => {
    // Insert a note into the projection so its label resolves; validation then passes
    // and the command advances past validation into the retrieval eval. Post the Phase-2
    // in-process cutover there is no egress daemon, so we activate the gated deterministic
    // in-process fake provider (ATLAS_TEST_MODE + ATLAS_FAKE_PROVIDER) — the eval RUNS
    // against an empty index and reports below-threshold (exit 1), never eval-set-invalid.
    execFileSync("node", ["-e", `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(join(cwd, ".atlas", "atlas.db"))});
      db.prepare("INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, active_generation, created, updated, quarantined) VALUES ('team-cloud','team-cloud','Cloud','team',1,'active','10_Work/Teams/cloud.md','h1',0,'2026-07-12T00:00:00.000Z','2026-07-12T00:00:00.000Z',0)").run();
      db.close();
    `], { cwd: REPO_ROOT });
    const { q, l } = writeSet(
      { version: 1, queries: [{ id: "q1", text: "who runs the cloud team" }] },
      { version: 1, labels: { q1: ["team-cloud"] } },
    );
    const fakeEnv = { ...env, ATLAS_TEST_MODE: "1", ATLAS_FAKE_PROVIDER: "1" };
    const { code, out } = await cli(["index", "eval", "--queries", q, "--labels", l, "--json"], fakeEnv);
    // The eval RAN (validation was not over-eager): it emits the eval-result payload and
    // exits 1 as below-threshold over an empty index — NOT eval-set-invalid, NOT broker-unreachable.
    expect(code).toBe(1);
    expect(out).toContain(`"command":"index eval"`);
    expect(out).toContain(`"pass":false`);
    expect(out).not.toContain("eval-set-invalid");
    expect(out).not.toContain("broker-unreachable");
  });
});
