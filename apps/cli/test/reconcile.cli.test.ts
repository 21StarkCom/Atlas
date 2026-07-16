/**
 * `reconcile.cli` (Task 4.11) — the wired `brain reconcile` command + its deterministic detector.
 * PREVIEW (default) dispatches through the real router, detects cross-note inconsistencies, and
 * reports schema-valid proposals + the run's effective risk with NO daemon and NO sink. (The apply →
 * tiered-synthesis loop reuses the assembly proven end-to-end by `enrich.e2e`.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { openStore } from "@atlas/sqlite-store";
import { detectReconciliationProposals } from "../src/workflows/reconcile-detect.js";
import { parseArgs, instructionFor, effectiveRisk } from "../src/commands/reconcile.js";
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

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

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

function insertNote(dbFile: string, id: string, title: string): void {
  const s = openStore({ path: dbFile });
  try {
    s.db.prepare(
      `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
       VALUES (?,?,?,?,1,'active',?, 'h','2026-07-16T00:00:00Z','2026-07-16T00:00:00Z')`,
    ).run(id, id, title, "concept", `${id}.md`);
  } finally { s.close(); }
}
function insertDisputedClaim(dbFile: string, claimId: string, owningNoteId: string): void {
  const s = openStore({ path: dbFile });
  try {
    s.db.prepare(`INSERT INTO claims (claim_id, owning_note_id, text, status, created_at) VALUES (?,?,?, 'disputed', '2026-07-16T00:00:00Z')`).run(claimId, owningNoteId, "c.");
  } finally { s.close(); }
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-rec-"));
  cwd = join(root, "work");
  const vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
  dbPath = join(cwd, ".atlas", "atlas.db");
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
  await cli(["db", "migrate", "--json"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reconcile argument + mapping helpers (Task 4.11)", () => {
  it("parses flags + rejects conflicts + junk", () => {
    expect(parseArgs([])).toEqual({ apply: false, dryRun: false });
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(() => parseArgs(["--apply", "--dry-run"])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["x"])).toThrow(/unexpected argument/);
  });
  it("effectiveRisk takes the highest tier; empty ⇒ tier-0", () => {
    expect(effectiveRisk([])).toBe("tier-0");
    expect(effectiveRisk(["tier-2", "tier-3"])).toBe("tier-3");
  });
  it("instructionFor derives a prompt per kind", () => {
    expect(instructionFor({ kind: "merge-duplicate", targets: ["a", "b"], minTier: "tier-3" })).toMatch(/merge the duplicate/);
    expect(instructionFor({ kind: "resolve-conflicting-claim", targets: ["a"], minTier: "tier-3" })).toMatch(/disputed claim/);
    expect(instructionFor({ kind: "fix-broken-link", targets: ["a", "b"], minTier: "tier-2" })).toMatch(/broken link/);
  });
});

describe("detectReconciliationProposals (Task 4.11)", () => {
  it("finds duplicate titles + disputed claims (deterministic, sorted)", () => {
    insertNote(dbPath, "dup-a", "Shared Title");
    insertNote(dbPath, "dup-b", "Shared Title");
    insertNote(dbPath, "owner", "Unique");
    insertDisputedClaim(dbPath, "claim-x", "owner");
    const s = openStore({ path: dbPath });
    try {
      const proposals = detectReconciliationProposals(s.db);
      expect(proposals).toEqual([
        { kind: "merge-duplicate", targets: ["dup-a", "dup-b"], minTier: "tier-3" },
        { kind: "resolve-conflicting-claim", targets: ["owner"], minTier: "tier-3" },
      ]);
    } finally { s.close(); }
  });
});

describe("brain reconcile (preview)", () => {
  it("an empty ledger ⇒ zero proposals, tier-0, schema-valid", async () => {
    const r = await cli(["reconcile", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("reconcile", out);
    expect(out).toMatchObject({ command: "reconcile", mode: "preview", risk: "tier-0", proposals: [] });
  });

  it("a seeded duplicate + disputed claim ⇒ schema-valid Tier-3 proposals; no sink", async () => {
    insertNote(dbPath, "dup-a", "Shared Title");
    insertNote(dbPath, "dup-b", "Shared Title");
    insertNote(dbPath, "owner", "Unique");
    insertDisputedClaim(dbPath, "claim-x", "owner");

    const r = await cli(["reconcile", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("reconcile", out);
    expect(out.risk).toBe("tier-3");
    expect(out.proposals).toEqual([
      { kind: "merge-duplicate", targets: ["dup-a", "dup-b"], risk: "tier-3" },
      { kind: "resolve-conflicting-claim", targets: ["owner"], risk: "tier-3" },
    ]);
  });
});
