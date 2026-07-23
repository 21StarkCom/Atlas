/**
 * `evidence-review.cli` (v2 task 4-4) — the wired read-only `brain evidence review`. Seeds v2
 * vault-derived evidence in mixed statuses via note frontmatter + the real fold, and asserts the
 * command lists only the non-`resolved` rows (pending/failed/needs-review), scoped + paginated,
 * schema-valid, no mutation, with a best-effort `target` resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { openStore, rebuildProjections } from "@atlas/sqlite-store";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
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

function note(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return { id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active", created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal", links: [], relationships: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over };
}
/** A v2 note carrying one flat `evidence:` frontmatter entry in the given status. */
function evidenceNote(id: string, status: string): ParsedNote {
  const raw = ["---", `id: ${id}`, "type: concept", "schema_version: 1", `title: ${id}`, "created: 2026-07-11", "updated: 2026-07-11",
    "evidence:", `  - id: ev-${id}`, '    claim: "c."', `    status: ${status}`, "---", "", `# ${id}`, ""].join("\n");
  return note(raw, { id, path: `${id}.md` });
}

let root: string, cwd: string, env: NodeJS.ProcessEnv, dbPath: string;
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
  root = mkdtempSync(join("/tmp", "atlas-er-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: (mkdirSync(join(cwd, "vault"), { recursive: true }), join(cwd, "vault")) });
  dbPath = join(cwd, ".atlas", "atlas.db");
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
  await cli(["db", "migrate", "--json"]);
  const s = openStore({ path: dbPath });
  try {
    rebuildProjections(s.db, {
      notes: [evidenceNote("note-p", "pending"), evidenceNote("note-r", "resolved"), evidenceNote("note-f", "failed"), evidenceNote("note-nr", "needs-review")],
      errors: [],
    } as VaultSnapshot);
  } finally { s.close(); }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain evidence review", () => {
  it("lists only non-resolved rows (pending/failed/needs-review), schema-valid, target present, correct total", async () => {
    const r = await cli(["evidence", "review", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("evidence-review", out);
    const states = new Map(out.items.map((i: { noteId: string; state: string }) => [i.noteId, i.state]));
    expect(states.get("note-p")).toBe("pending");
    expect(states.get("note-f")).toBe("failed");
    expect(states.get("note-nr")).toBe("needs-review");
    expect(states.has("note-r")).toBe(false); // resolved is NOT listed
    expect(out.items.every((i: { target: string }) => i.target === "present")).toBe(true);
    expect(out.pagination.total).toBe(3);
    expect(out.pagination.hasMore).toBe(false);
  });

  it("scopes to a single note", async () => {
    const r = await cli(["evidence", "review", "note-p", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].noteId).toBe("note-p");
    expect(out.pagination.total).toBe(1);
  });

  it("paginates (limit 1 ⇒ hasMore), and rejects a bad --limit (exit 5)", async () => {
    const r = await cli(["evidence", "review", "--limit", "1", "--json"]);
    const out = JSON.parse(r.out);
    expect(out.items).toHaveLength(1);
    expect(out.pagination).toMatchObject({ limit: 1, offset: 0, total: 3, hasMore: true });
    const bad = await cli(["evidence", "review", "--limit", "0", "--json"]);
    expect(bad.code).toBe(5);
  });
});
