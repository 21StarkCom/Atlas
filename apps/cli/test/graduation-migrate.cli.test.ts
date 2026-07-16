/**
 * `graduation-migrate.cli` (Task 5.3 / #59) — the wired `graduation migrate` command. Covers the
 * non-privileged PREVIEW (deterministic plan, zero mutation, schema-valid) and the privileged
 * apply/rollback ORDERING + AUTH gates (fail-closed without a clean scan; action-required without an
 * authorization). The byte-exact apply/rollback engine is covered by migrate-apply; the parseArgs +
 * plan by their own suites.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../src/main.js";
import { writeScanState, scanStatePath } from "../src/graduation/state.js";
import { parseArgs } from "../src/commands/graduation-migrate.js";

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

function makeCleanCopy(): string {
  const copy = join(root, "grad-copy");
  mkdirSync(join(copy, "Concepts"), { recursive: true });
  mkdirSync(join(copy, "People"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: copy });
  execFileSync("git", ["-C", copy, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", copy, "config", "user.name", "t"]);
  execFileSync("git", ["-C", copy, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(copy, "Concepts", "Atlas.md"), "# Atlas\n\nA standalone concept.\n");
  writeFileSync(join(copy, "People", "Koral.md"), "# Koral\n\nA standalone person.\n");
  execFileSync("git", ["-C", copy, "add", "-A"]);
  execFileSync("git", ["-C", copy, "commit", "-q", "-m", "seed"]);
  return copy;
}
function seedCleanGate(): string {
  const copy = makeCleanCopy();
  const copyHead = execFileSync("git", ["-C", copy, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeScanState(scanStatePath(join(cwd, ".atlas", "atlas.db")), { copy, copyHead, gate: "clean", scannedAt: "2026-07-16T00:00:00Z", findingCount: 0 });
  return copy;
}

beforeEach(() => {
  root = mkdtempSync(join("/tmp", "atlas-gm-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  const config = [
    "vault:", `  path: ${join(root, "vault")}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  mkdirSync(join(root, "vault"), { recursive: true });
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("graduation migrate arg parsing (#59)", () => {
  it("parses apply/rollback/challenge/authorization; --apply + --rollback are mutually exclusive", () => {
    expect(parseArgs([])).toEqual({ apply: false, rollback: false, exportChallenge: false });
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--rollback"]).rollback).toBe(true);
    expect(parseArgs(["--authorization", "/a"]).authorization).toBe("/a");
    expect(() => parseArgs(["--apply", "--rollback"])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown/);
  });
});

describe("brain graduation migrate (preview + gates)", () => {
  it("preview: deterministic plan over the scanned copy, zero mutation, schema-valid", async () => {
    const copy = seedCleanGate();
    const treeBefore = execFileSync("git", ["-C", copy, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();

    const r = await cli(["graduation", "migrate", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("graduation-migrate", out);
    expect(out.mode).toBe("preview");
    expect(Object.keys(out.idMap).sort()).toEqual(["Concepts/Atlas.md", "People/Koral.md"]);
    expect(out.idMap["Concepts/Atlas.md"]).toBe("concept-atlas");
    expect(out.idMap["People/Koral.md"]).toBe("person-koral");
    expect(out.notes).toHaveLength(2);
    expect(out.quarantined).toEqual([]);
    // Zero mutation: the copy tree is byte-identical.
    expect(execFileSync("git", ["-C", copy, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim()).toBe(treeBefore);
  });

  it("--apply without an authorization ⇒ authorization-required (exit 6)", async () => {
    seedCleanGate();
    const r = await cli(["graduation", "migrate", "--apply", "--json"]);
    expect(r.code).toBe(6);
    expect(JSON.parse(r.out).code).toBe("authorization-required");
  });

  it("--rollback without an authorization ⇒ authorization-required (exit 6)", async () => {
    seedCleanGate();
    const r = await cli(["graduation", "migrate", "--rollback", "--json"]);
    expect(r.code).toBe(6);
    expect(JSON.parse(r.out).code).toBe("authorization-required");
  });

  it("no clean scan gate ⇒ scan-gate-open (exit 2), even for preview", async () => {
    const r = await cli(["graduation", "migrate", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).code).toBe("scan-gate-open");
  });
});
