/**
 * `git-review.cli` (Task 4.9) — `brain git review <runId>` renders a review-pending run's manifest
 * (branch, base/agent commits, validation) + risk + summary, validated against `git-review.schema.json`;
 * a non-review-pending / unknown run is an error.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../src/main.js";
import { openStore, type Store } from "@atlas/sqlite-store";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  errorsText: (e?: unknown) => string;
};
function validateSchema(name: string, value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8"));
  const v = ajv.compile(schema);
  if (!v(value)) throw new Error(`${name} failed: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value)}`);
}

let root: string, cwd: string, env: NodeJS.ProcessEnv, dbPath: string;
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const ro = process.stdout.write.bind(process.stdout), re = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try { return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out }; }
  finally { process.stdout.write = ro; process.stderr.write = re; }
}

const RUN = "01J9Z8Q00000000000000REVIEW";
const BASE = "b".repeat(40), AGENT = "c".repeat(40);

function seedReviewPending(store: Store): void {
  const now = "2026-07-16T00:00:00.000Z";
  store.ledger.upsertAgentRun({ run_id: RUN, operation: "enrich", status: "review-pending", tier: 3, started_at: now, updated_at: now });
  const gop = store.db.prepare(`INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  gop.run(`${RUN}:base`, RUN, "base", "refs/heads/main", BASE, now);
  gop.run(`${RUN}:agent-committed`, RUN, "agent-committed", `refs/agent/${RUN}`, AGENT, now);
  store.db.prepare(`INSERT INTO change_plans (plan_id, run_id, tier, confidence, summary, plan_hash, created_at) VALUES (?, ?, 3, 0.9, 'enrich alpha', ?, ?)`).run(`${RUN}-plan`, RUN, "sha256:0", now);
  store.db.prepare(`INSERT INTO patches (patch_id, plan_id, note_id, changed_lines, changed_sections, patch_hash, created_at) VALUES (?, ?, 'note-a', 3, 1, 'sha256:0', ?)`).run(`${RUN}-patch`, `${RUN}-plan`, now);
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-grv-"));
  cwd = join(root, "work");
  const vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
  writeFileSync(join(cwd, "brain.config.yaml"), [
    "vault:", `  path: ${vaultDir}`, "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb", "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`, "models: {}", "policies: {}",
    "logs:", "  dir: ./.atlas/logs", "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n"), "utf8");
  env = { ...process.env, NO_COLOR: "1" };
  dbPath = join(cwd, ".atlas", "atlas.db");
  await cli(["db", "migrate", "--json"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain git review", () => {
  it("renders a review-pending run's manifest + risk, validated against the schema", async () => {
    const store = openStore({ path: dbPath });
    try { seedReviewPending(store); } finally { store.close(); }
    const r = await cli(["git", "review", RUN, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-review", out);
    expect(out.state).toBe("review-pending");
    expect(out.risk).toBe("tier-3");
    expect(out.manifest.agentCommit).toBe(AGENT);
    expect(out.manifest.baseCommit).toBe(BASE);
    expect(out.manifest.validation).toBe("passed");
  });

  it("errors on an unknown run (exit 1)", async () => {
    const r = await cli(["git", "review", "01J9Z8Q0000000000000UNKNOWN", "--json"]);
    expect(r.code).toBe(1);
  });
});
