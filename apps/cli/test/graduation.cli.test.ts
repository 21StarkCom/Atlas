/**
 * `graduation.cli` (Task 5.1/5.2, #57/#58) — the wired `graduation scan` + `graduation audit`
 * commands through the real router. Covers the scan's clean-vault happy path (clone → scan working
 * tree + history → persist a CLEAN gate, source never mutated) and the audit's fail-closed ordering
 * gate (refuses without / behind a clean scan). The scan's quarantine branch + the audit's
 * run.readonly happy path run over live custody/broker and are covered by the cores + the readonly
 * audit suites; these assert the command surface + fail-closed contract.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../src/main.js";
import { writeScanState, scanStatePath } from "../src/graduation/state.js";

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

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
let sourceVault: string;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, env, { cwd, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

beforeEach(() => {
  root = mkdtempSync(join("/tmp", "atlas-gradcli-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  // A clean legacy source vault (git repo with two innocuous notes).
  sourceVault = join(root, "legacy-vault");
  mkdirSync(sourceVault, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sourceVault });
  git(sourceVault, ["config", "user.email", "t@t"]);
  git(sourceVault, ["config", "user.name", "t"]);
  git(sourceVault, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(sourceVault, "a.md"), "---\nid: a\ntype: concept\nschema_version: 1\ntitle: A\ncreated: 2026-07-16\nupdated: 2026-07-16\n---\n# A\n");
  writeFileSync(join(sourceVault, "b.md"), "---\nid: b\ntype: concept\nschema_version: 1\ntitle: B\ncreated: 2026-07-16\nupdated: 2026-07-16\n---\n# B\n");
  git(sourceVault, ["add", "-A"]);
  git(sourceVault, ["commit", "-q", "-m", "seed"]);

  const config = [
    "vault:", `  path: ${sourceVault}`,
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

describe("brain graduation scan (clean vault)", () => {
  it("clones + scans working tree AND history, persists a CLEAN gate, and never mutates the source", async () => {
    const copy = join(root, "grad-copy");
    const sourceTreeBefore = git(sourceVault, ["rev-parse", "HEAD^{tree}"]).trim();

    const r = await cli(["graduation", "scan", "--source", sourceVault, "--copy", copy, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("graduation-scan", out);
    expect(out.gate).toBe("clean");
    expect(out.findings).toEqual([]);
    expect(out.scanned.includeHistory).toBe(true);
    expect(out.scanned.workingTreeFiles).toBeGreaterThanOrEqual(2);
    expect(out.scanned.historyCommits).toBeGreaterThanOrEqual(1);
    expect(out.copyHead).toMatch(/^[0-9a-f]{40}$/);

    // The scan-state gate was persisted (clean).
    const state = JSON.parse(readFileSync(scanStatePath(join(cwd, ".atlas", "atlas.db")), "utf8"));
    expect(state.gate).toBe("clean");
    expect(state.copy).toBe(copy);

    // PROHIBITED effect: the live source is byte-identical (never written to).
    expect(git(sourceVault, ["rev-parse", "HEAD^{tree}"]).trim()).toBe(sourceTreeBefore);
  });
});

describe("brain graduation audit (fail-closed ordering gate)", () => {
  it("refuses when no scan has run ⇒ scan-gate-open (exit 2)", async () => {
    const r = await cli(["graduation", "audit", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).code).toBe("scan-gate-open");
  });

  it("refuses behind a BLOCKED scan gate ⇒ scan-gate-open (exit 2)", async () => {
    writeScanState(scanStatePath(join(cwd, ".atlas", "atlas.db")), { copy: join(root, "grad-copy"), copyHead: "a".repeat(40), gate: "blocked", scannedAt: "2026-07-16T00:00:00Z", findingCount: 3 });
    const r = await cli(["graduation", "audit", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).code).toBe("scan-gate-open");
  });
});
