/**
 * `validate.cli` (Task 4.11) — `brain validate` audits the vault read-only: a clean vault is `ok`
 * (exit 0); a dangling wiki-link reference is a `dangling-reference` finding (exit 1). Output
 * validates against `validate.schema.json`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../src/main.js";

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

let root: string, cwd: string, env: NodeJS.ProcessEnv, vaultDir: string;
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const ro = process.stdout.write.bind(process.stdout), re = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try { return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out }; }
  finally { process.stdout.write = ro; process.stderr.write = re; }
}

function note(id: string, body = ""): string {
  return `---\nid: ${id}\ntype: concept\ntitle: ${id}\nstatus: active\nschema_version: 1\ncreated: 2026-07-16\nupdated: 2026-07-16\n---\n# ${id}\n${body}\n`;
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-val-"));
  cwd = join(root, "work");
  vaultDir = join(cwd, "vault");
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
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain validate", () => {
  it("a clean vault validates ok (exit 0)", async () => {
    writeFileSync(join(vaultDir, "a.md"), note("concept-a", "Links [[concept-b]]."));
    writeFileSync(join(vaultDir, "b.md"), note("concept-b"));
    const r = await cli(["validate", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("validate", out);
    expect(out.ok).toBe(true);
    expect(out.gates.tier2Eligible).toBe(true);
  });

  it("a dangling wiki-link is a dangling-reference finding (exit 1)", async () => {
    writeFileSync(join(vaultDir, "a.md"), note("concept-a", "Links [[does-not-exist]]."));
    const r = await cli(["validate", "--json"]);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.out);
    validateSchema("validate", out);
    expect(out.ok).toBe(false);
    expect(out.findings.some((f: { code: string }) => f.code === "dangling-reference")).toBe(true);
  });
});
