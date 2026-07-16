/**
 * `purge.cli.e2e` (Task 4.10) — `brain purge` is DEFAULT-SAFE: a bare invocation is a non-mutating
 * preview (mode `preview`, inventory + digest); `--apply` requires a broker authorization
 * (`--export-challenge` emits the challenge, exit 6; bare `--apply` is action-required, exit 6);
 * the selector must be EXACTLY ONE of --note/--source/--data-category (else usage, exit 5). The
 * authorized erasure itself is covered by `purge-erase.test`.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../../src/main.js";
import { makePhase2Harness, type Phase2Harness } from "./phase2-support.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (o?: unknown) => { compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown }; errorsText: (e?: unknown) => string };
function validateSchema(name: string, value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const v = ajv.compile(JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8")));
  if (!v(value)) throw new Error(`${name}: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value)}`);
}

let h: Phase2Harness, cwd: string, env: NodeJS.ProcessEnv;
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const ro = process.stdout.write.bind(process.stdout), re = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try { return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out }; }
  finally { process.stdout.write = ro; process.stderr.write = re; }
}

beforeEach(async () => {
  h = await makePhase2Harness();
  cwd = h.root;
  writeFileSync(join(h.root, "brain.config.yaml"), [
    "vault:", `  path: ${h.vaultDir}`, "sqlite:", `  path: ${h.dbPath}`, "  ledger_backup:", `    dir: ${join(h.root, ".atlas", "backups")}`, "    key_id: test-key-v1", "    keep: 10",
    "lancedb:", `  dir: ${join(h.root, ".atlas", "lancedb")}`, "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", `  worktrees_path: ${h.worktreesPath}`, `  audit_anchor_path: ${h.anchorPath}`, "models: {}", "policies: {}",
    "logs:", `  dir: ${join(h.root, ".atlas", "logs")}`, "broker:", `  socket_path: ${h.socketPath}`, `  egress_socket_path: ${join(h.root, "e.sock")}`, "",
  ].join("\n"), "utf8");
  env = { ...process.env, NO_COLOR: "1", ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: join(h.root, ".atlas", "custody") };
});
afterEach(async () => { await h.cleanup(); });

describe("brain purge (default-safe)", () => {
  it("a bare invocation is a non-mutating preview with an inventory + digest", async () => {
    const r = await cli(["purge", "--note", "concept-x", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("purge", out);
    expect(out.mode).toBe("preview");
    expect(out.scope).toEqual({ kind: "note", value: "concept-x" });
    expect(out.inventoryDigest).toMatch(/^sha256:/);
    expect(out.inventoryId).toBeTruthy();
  });

  it("--apply --export-challenge emits a challenge (op purge) + exits 6", async () => {
    const r = await cli(["purge", "--note", "concept-x", "--apply", "--export-challenge", "--json"]);
    expect(r.code, r.out).toBe(6);
    expect(JSON.parse(r.out).op).toBe("purge");
  });

  it("--apply without an authorization is action-required (exit 6)", async () => {
    const r = await cli(["purge", "--note", "concept-x", "--apply", "--json"]);
    expect(r.code).toBe(6);
  });

  it("no selector, or more than one, is a usage error (exit 5)", async () => {
    expect((await cli(["purge", "--json"])).code).toBe(5);
    expect((await cli(["purge", "--note", "a", "--data-category", "concept", "--json"])).code).toBe(5);
  });

  it("--dry-run with --apply is a usage error (exit 5)", async () => {
    expect((await cli(["purge", "--note", "a", "--dry-run", "--apply", "--json"])).code).toBe(5);
  });
});
