/**
 * `source.registry.cli` (v2 task 4-3 / #339) — the wired `source add|list|show`
 * slice over the v2 operational `source` registry. Proves the #339 acceptance: a
 * second `source add` of the SAME locator is a NOOP SUCCESS returning the first id
 * (never a duplicate, never an error); `source list`/`show` read the registry; the
 * `--json` payloads validate against their committed schemas. Purely operational —
 * no git commit, no vault mutation (that is `ingest`, task 4-3b).
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

let root: string, cwd: string, env: NodeJS.ProcessEnv, vaultDir: string;
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
  root = mkdtempSync(join("/tmp", "atlas-sreg-"));
  cwd = join(root, "work");
  vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
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
  const mig = await cli(["db", "migrate", "--json"]);
  expect(mig.code, mig.out).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain source add|list|show (v2 registry)", () => {
  it("source add: inserts a file/url row, schema-valid; a repeat of the SAME locator is a noop returning the first id", async () => {
    const r1 = await cli(["source", "add", "sources/a.txt", "--title", "Source A", "--json"]);
    expect(r1.code, r1.out).toBe(0);
    const out1 = JSON.parse(r1.out);
    validateSchema("source-add", out1);
    expect(out1).toMatchObject({ command: "source add", kind: "file", locator: "sources/a.txt", added: true });

    // Same locator again — NOOP SUCCESS returning the first id (never a duplicate/error).
    const r2 = await cli(["source", "add", "sources/a.txt", "--json"]);
    expect(r2.code, r2.out).toBe(0);
    const out2 = JSON.parse(r2.out);
    expect(out2.added).toBe(false);
    expect(out2.id).toBe(out1.id);

    // A URL locator derives kind:url.
    const rUrl = await cli(["source", "add", "https://example.com/doc", "--json"]);
    expect(rUrl.code, rUrl.out).toBe(0);
    expect(JSON.parse(rUrl.out).kind).toBe("url");
  });

  it("source list reads the registry (schema-valid, both rows present)", async () => {
    await cli(["source", "add", "sources/a.txt", "--json"]);
    await cli(["source", "add", "https://example.com/doc", "--json"]);
    const r = await cli(["source", "list", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("source-list", out);
    const locators = out.sources.map((s: { locator: string }) => s.locator);
    expect(locators).toContain("sources/a.txt");
    expect(locators).toContain("https://example.com/doc");
    expect(out.pagination.total).toBe(2);
  });

  it("source show reads a registry row by id AND by locator; unknown ⇒ source-not-found (1)", async () => {
    const added = JSON.parse((await cli(["source", "add", "sources/a.txt", "--title", "A", "--json"])).out);
    const byId = await cli(["source", "show", added.id, "--json"]);
    expect(byId.code, byId.out).toBe(0);
    validateSchema("source-show", JSON.parse(byId.out));
    expect(JSON.parse(byId.out).source).toMatchObject({ id: added.id, kind: "file", locator: "sources/a.txt", title: "A" });

    const byLoc = await cli(["source", "show", "sources/a.txt", "--json"]);
    expect(byLoc.code, byLoc.out).toBe(0);
    expect(JSON.parse(byLoc.out).source.id).toBe(added.id);

    const missing = await cli(["source", "show", "no-such-source", "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).code).toBe("source-not-found");
  });
});
