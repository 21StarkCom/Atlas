/**
 * `evidence-review.cli` (Task 4.7 / #59) — the wired read-only `brain evidence review`. Seeds
 * evidence in mixed verification states via the real projections and asserts the command lists only
 * the non-`valid` heads (stale/pending/failed), scoped + paginated, schema-valid, no mutation.
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
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;
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
  return { id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active", created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over };
}
function sourceNote(): ParsedNote {
  const raw = ["---", "id: s-a", "type: source", "schema_version: 1", "title: s-a", "created: 2026-07-11", "updated: 2026-07-11",
    `contentId: "${CONTENT_A}"`, "origin: notes/a.txt", "provenance:", "  vault_path: sources/a.txt", "  size_bytes: 12", "  renditions:",
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`, "---", "", "# s-a", ""].join("\n");
  return note(raw, { type: "source", id: "s-a", path: "sources/s-a.md" });
}
function claimNote(id: string, claimId: string, verification: string): ParsedNote {
  const raw = ["---", `id: ${id}`, "type: concept", "schema_version: 1", `title: ${id}`, "created: 2026-07-11", "updated: 2026-07-11", "claims:",
    `  - claim_id: ${claimId}`, '    text: "c."', "    evidence:", `      - rendition: "${CONTENT_A}:1:1"`, `        verification: ${verification}`, "---", "", `# ${id}`, ""].join("\n");
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
    rebuildProjections(s.db, { notes: [sourceNote(), claimNote("note-p", "claim-p", "pending"), claimNote("note-v", "claim-v", "valid"), claimNote("note-f", "claim-f", "failed")], errors: [] } as VaultSnapshot);
  } finally { s.close(); }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain evidence review", () => {
  it("lists only non-valid heads (stale/pending/failed), schema-valid, with a correct total", async () => {
    const r = await cli(["evidence", "review", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("evidence-review", out);
    const states = new Map(out.items.map((i: { noteId: string; state: string }) => [i.noteId, i.state]));
    expect(states.get("note-p")).toBe("pending");
    expect(states.get("note-f")).toBe("failed");
    expect(states.has("note-v")).toBe(false); // valid is NOT listed
    expect(out.pagination.total).toBe(2);
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
    expect(out.pagination).toMatchObject({ limit: 1, offset: 0, total: 2, hasMore: true });
    const bad = await cli(["evidence", "review", "--limit", "0", "--json"]);
    expect(bad.code).toBe(5);
  });
});
