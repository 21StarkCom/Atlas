/**
 * `maintain.cli` (Task 4.11) — the wired `brain maintain` command. PREVIEW (default) dispatches
 * through the real router, runs the deterministic detector, and reports schema-valid findings +
 * the run's effective risk with NO daemon and NO sink. (The detector's own cases are covered by
 * `maintain.test`; the apply → tiered-synthesis loop reuses the assembly proven by `enrich.e2e`.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import type { ParsedNote, VaultSnapshot, WikiLink } from "@atlas/contracts";
import { openStore, rebuildProjections } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { parseArgs, instructionFor, effectiveRisk } from "../src/commands/maintain.js";
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

function makeNote(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return { id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active", created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over };
}
function plainNote(id: string, links: string[] = []): ParsedNote {
  const raw = `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\nstatus: active\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n# ${id}\n`;
  return makeNote(raw, { id, links: links.map((t) => ({ target: t, raw: `[[${t}]]` }) as WikiLink) });
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

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-maint-"));
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

describe("maintain argument + mapping helpers (Task 4.11)", () => {
  it("parses --apply / --dry-run / --idempotency-key and rejects conflicts + junk", () => {
    expect(parseArgs([])).toEqual({ apply: false, dryRun: false });
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--idempotency-key", "k"])).toEqual({ apply: false, dryRun: false });
    expect(() => parseArgs(["--apply", "--dry-run"])).toThrow(/mutually exclusive/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["positional"])).toThrow(/unexpected argument/);
  });
  it("effectiveRisk takes the highest tier; empty ⇒ tier-0", () => {
    expect(effectiveRisk([])).toBe("tier-0");
    expect(effectiveRisk(["tier-2", "tier-3", "tier-2"])).toBe("tier-3");
    expect(effectiveRisk(["tier-2"])).toBe("tier-2");
  });
  it("instructionFor derives a destructive vs re-verification prompt by kind", () => {
    expect(instructionFor({ kind: "orphan-note", noteId: "n", detail: "d", minTier: "tier-3" })).toMatch(/orphan/);
    expect(instructionFor({ kind: "unverified-evidence", noteId: "n", detail: "d", minTier: "tier-2" })).toMatch(/re-verification/);
  });
});

describe("brain maintain (preview)", () => {
  it("an empty ledger ⇒ zero findings, tier-0, schema-valid", async () => {
    const r = await cli(["maintain", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("maintain", out);
    expect(out).toMatchObject({ command: "maintain", mode: "preview", risk: "tier-0", findings: [] });
  });

  it("a seeded orphan ⇒ a destructive Tier-3 orphan finding; risk tier-3; schema-valid; no sink", async () => {
    // hub ↔ leaf are linked (not orphans); `lonely` has no links.
    const s = openStore({ path: dbPath });
    try {
      rebuildProjections(s.db, { notes: [plainNote("hub", ["leaf"]), plainNote("leaf", ["hub"]), plainNote("lonely")], errors: [] } as VaultSnapshot);
    } finally {
      s.close();
    }
    const head = (): string | null => { try { return execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: join(cwd, "vault"), stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };
    const canonicalBefore = head();

    const r = await cli(["maintain", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("maintain", out);
    expect(out.risk).toBe("tier-3");
    expect(out.findings).toEqual([{ kind: "orphan", target: "lonely", destructive: true, risk: "tier-3" }]);

    // Preview touched no sink (git HEAD unchanged / still unborn).
    expect(head()).toBe(canonicalBefore);
  });
});
