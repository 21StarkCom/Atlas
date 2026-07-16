/**
 * `db-status.cli` — the wired read-only `brain db status`. Reports the applied migration head +
 * list, per-table row counts, and backup-watermark health; schema-valid; pure (no mutation).
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
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${name} failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

let root: string, cwd: string, env: NodeJS.ProcessEnv;
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

beforeEach(() => {
  root = mkdtempSync(join("/tmp", "atlas-dbst-"));
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
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain db status", () => {
  it("after migrate: reports a non-empty schema head, per-table row counts, and healthy backup — schema-valid", async () => {
    await cli(["db", "migrate", "--json"]);
    const r = await cli(["db", "status", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("db-status", out);
    expect(out.schema.head).toMatch(/^\d{4}_/); // the highest applied migration id
    expect(out.schema.applied).toContain("0001_core"); // the base migration is applied
    expect(out.schema.applied[out.schema.applied.length - 1]).toBe(out.schema.head); // head = max
    const names = out.tables.map((t: { name: string }) => t.name);
    expect(names).toContain("notes");
    expect(names).toContain("agent_runs");
    for (const t of out.tables) expect(t.rowCount).toBeGreaterThanOrEqual(0);
    expect(out.backup).toMatchObject({ healthy: expect.any(Boolean) });
  });

  it("stays available (no ledger write) — a repeat call is identical + schema-valid", async () => {
    await cli(["db", "migrate", "--json"]);
    const a = JSON.parse((await cli(["db", "status", "--json"])).out);
    const b = JSON.parse((await cli(["db", "status", "--json"])).out);
    validateSchema("db-status", b);
    expect(b.tables).toEqual(a.tables); // pure read: no mutation between calls
    expect(b.schema).toEqual(a.schema);
  });
});
