/**
 * `evidence-review.cli` (v2 task 4-4 + #337-F1) — the wired read-only `brain evidence
 * review`. Seeds v2 vault-derived evidence via real on-disk notes + `sync` (so
 * `sourceNoteHash` matches the committed content), then asserts the command lists the
 * EFFECTIVE needing-attention set (pending/failed/needs-review), computed against the
 * CURRENT working tree — so an edited-but-unsynced note re-surfaces as stale/needs-review
 * (F1: `sourceNoteHash` is read, not just stamped) and a gone target is `target: missing`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { openStore, EvidenceRepo } from "@atlas/sqlite-store";
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

/** A valid v2 note carrying one flat `evidence:` frontmatter entry in the given status. */
function evidenceNote(id: string, status: string): string {
  return [
    "---", `id: ${id}`, "type: concept", "schema_version: 1", `title: ${id}`,
    "created: 2026-07-11", "updated: 2026-07-11",
    "evidence:", `  - id: ev-${id}`, '    claim: "c."', `    status: ${status}`,
    "---", "", `# ${id}`, "", "Body prose for embedding.", "",
  ].join("\n");
}

let root: string, cwd: string, env: NodeJS.ProcessEnv, dbPath: string, vaultDir: string;
function git(args: string[]): void { execFileSync("git", args, { cwd: vaultDir }); }
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
  vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
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
  env = { ...process.env, NO_COLOR: "1", ATLAS_TEST_MODE: "1", ATLAS_FAKE_PROVIDER: "1", ATLAS_GEMINI_API_KEY: "test-key" };
  for (const [id, status] of [["note-p", "pending"], ["note-f", "failed"], ["note-r", "resolved"], ["note-nr", "needs-review"]] as const) {
    writeFileSync(join(vaultDir, `${id}.md`), evidenceNote(id, status), "utf8");
  }
  git(["add", "-A"]); git(["commit", "-q", "-m", "seed"]);
  const mig = await cli(["db", "migrate", "--json"]);
  expect(mig.code, mig.out).toBe(0);
  const sync = await cli(["sync", "--json"]);
  expect(sync.code, sync.out).toBe(0); // folds evidence rows with sourceNoteHash = committed content
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain evidence review", () => {
  it("lists only the effectively non-resolved rows (pending/failed/needs-review), target present, schema-valid", async () => {
    const r = await cli(["evidence", "review", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("evidence-review", out);
    const states = new Map(out.items.map((i: { noteId: string; state: string }) => [i.noteId, i.state]));
    expect(states.get("note-p")).toBe("pending");
    expect(states.get("note-f")).toBe("failed");
    expect(states.get("note-nr")).toBe("needs-review");
    expect(states.has("note-r")).toBe(false); // resolved + unchanged ⇒ not listed
    expect(out.items.every((i: { target: string }) => i.target === "present")).toBe(true);
    expect(out.pagination.total).toBe(3);
  });

  it("F1: an on-disk edit without sync re-surfaces a RESOLVED row as stale/needs-review with a detail", async () => {
    // note-r is resolved (excluded above). Edit it on disk WITHOUT sync ⇒ its content
    // hash no longer matches the folded sourceNoteHash ⇒ effective needs-review.
    appendFileSync(join(vaultDir, "note-r.md"), "\nedited on disk, not synced\n");
    const r = await cli(["evidence", "review", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("evidence-review", out);
    const item = out.items.find((i: { noteId: string }) => i.noteId === "note-r");
    expect(item, "the now-stale resolved row must re-surface").toBeDefined();
    expect(item.state).toBe("needs-review");
    expect(item.target).toBe("present");
    expect(item.detail).toMatch(/stale|edited/i);
    expect(out.pagination.total).toBe(4); // the 3 non-resolved + the newly-stale note-r
  });

  it("a gone target (note absent from the vault) ⇒ target:missing, never a crash", async () => {
    // Seed an orphan row directly (no note file) — review must surface it, not throw.
    const s = openStore({ path: dbPath });
    try {
      new EvidenceRepo(s.db).replaceForNote("ghost", "hash-g", [{ id: "ev-ghost", claim: "orphan", status: "pending", createdAt: "2026-07-11" }]);
    } finally { s.close(); }
    const r = await cli(["evidence", "review", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("evidence-review", out);
    const item = out.items.find((i: { evidenceId: string }) => i.evidenceId === "ev-ghost");
    expect(item).toMatchObject({ noteId: "ghost", target: "missing", state: "needs-review" });
  });

  it("scopes to a single note", async () => {
    const r = await cli(["evidence", "review", "note-p", "--json"]);
    expect(r.code, r.out).toBe(0);
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
