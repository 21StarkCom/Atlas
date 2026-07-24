/**
 * `ingest.cli` (v2 task 4-3b / #340) — the rebased `brain ingest <id>` over the flat
 * `source` registry + the surviving `@atlas/sources` normalizers + the common
 * mutation order. Proves: preview persists nothing; `--apply` commits a deterministic
 * note DIRECTLY onto refs/heads/main and stamps `source.lastIngestedAt` LAST; a
 * re-ingest of identical input is an idempotent NOOP (no duplicate note, no second
 * commit) that still re-stamps; unknown id ⇒ validation (1); `--dry-run --apply` ⇒
 * usage (5); a url source ⇒ usage (5). The `--json` payloads validate against the
 * committed schema.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

let root: string, cwd: string, env: NodeJS.ProcessEnv, vaultDir: string, srcFile: string;
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
function headSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir, encoding: "utf8" }).trim();
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-ingest-"));
  cwd = join(root, "work");
  vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
  execFileSync("git", ["config", "user.email", "t@atlas.test"], { cwd: vaultDir });
  execFileSync("git", ["config", "user.name", "Atlas Test"], { cwd: vaultDir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: vaultDir });
  // Born `main` — the mutation order commits onto refs/heads/main (a partial commit
  // needs HEAD). A real graduated vault always carries commits; seed one here.
  writeFileSync(join(vaultDir, "README.md"), "seed\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: vaultDir });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: vaultDir });
  // A real markdown source file at an ABSOLUTE path — the registry locator ingest reads.
  srcFile = join(root, "inbox.md");
  writeFileSync(srcFile, "# Inbox\n\nA registered source captured by ingest.\n", "utf8");
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

/** Register `srcFile` and return its source id. */
async function addSource(): Promise<string> {
  const r = await cli(["source", "add", srcFile, "--json"]);
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.out).id as string;
}

describe("brain ingest <id> (v2 rebase)", () => {
  it("preview (default) resolves + normalizes and persists nothing", async () => {
    const id = await addSource();
    const before = headSha();
    const r = await cli(["ingest", id, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("ingest", out);
    expect(out).toMatchObject({ command: "ingest", id, mode: "preview", applied: false });
    expect(out.preview.sourceId).toBe(id);
    expect(out.preview.canonicalMediaType).toBe("text/markdown");
    expect(out.capture).toBeUndefined();
    // Nothing committed: HEAD unmoved and no note file written.
    expect(headSha()).toBe(before);
    expect(existsSync(join(vaultDir, "sources", `${out.preview.noteId}.md`))).toBe(false);
  });

  it("--apply commits the produced note onto refs/heads/main + stamps lastIngestedAt", async () => {
    const id = await addSource();
    const r = await cli(["ingest", id, "--apply", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("ingest", out);
    expect(out).toMatchObject({ command: "ingest", id, mode: "apply", applied: true });
    expect(out.capture.committed).toBe(true);
    expect(out.capture.canonicalSha).toBe(headSha());
    // The note file landed under sources/ and is on refs/heads/main.
    expect(existsSync(join(vaultDir, out.capture.path))).toBe(true);
    const tracked = execFileSync("git", ["ls-files", out.capture.path], { cwd: vaultDir, encoding: "utf8" }).trim();
    expect(tracked).toBe(out.capture.path);
    // lastIngestedAt is stamped on the registry row.
    const show = JSON.parse((await cli(["source", "show", id, "--json"])).out);
    expect(show.source.lastIngestedAt).toBe(out.capture.lastIngestedAt);
    // The note is projected + retrievable by id.
    const note = await cli(["note", "show", out.capture.noteId, "--json"]);
    expect(note.code, note.out).toBe(0);
  });

  it("re-ingest of identical input is an idempotent NOOP — no duplicate note, no second commit", async () => {
    const id = await addSource();
    const first = JSON.parse((await cli(["ingest", id, "--apply", "--json"])).out);
    expect(first.capture.committed).toBe(true);
    const afterFirst = headSha();

    const second = await cli(["ingest", id, "--apply", "--json"]);
    expect(second.code, second.out).toBe(0);
    const out2 = JSON.parse(second.out);
    validateSchema("ingest", out2);
    expect(out2.capture.committed).toBe(false); // NOOP — nothing committed
    expect(out2.capture.noteId).toBe(first.capture.noteId); // same deterministic id
    expect(headSha()).toBe(afterFirst); // no second commit
    // Still re-stamped (idempotent): a fresh lastIngestedAt.
    expect(typeof out2.capture.lastIngestedAt).toBe("string");
    // Exactly one ingested note tracked (no duplicate).
    const files = execFileSync("git", ["ls-files", "sources/"], { cwd: vaultDir, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    expect(files).toEqual([first.capture.path]);
  });

  it("unknown source id ⇒ validation error (exit 1)", async () => {
    const r = await cli(["ingest", "src-does-not-exist", "--apply", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("validation-error");
  });

  it("--dry-run with --apply ⇒ usage error (exit 5)", async () => {
    const id = await addSource();
    const r = await cli(["ingest", id, "--dry-run", "--apply", "--json"]);
    expect(r.code).toBe(5);
  });

  it("a url source ⇒ usage error (exit 5, no in-process fetch in v2)", async () => {
    const added = JSON.parse((await cli(["source", "add", "https://example.com/doc", "--json"])).out);
    expect(added.kind).toBe("url");
    const r = await cli(["ingest", added.id, "--apply", "--json"]);
    expect(r.code).toBe(5);
  });

  it("a source whose text contains a [[wiki-link]] is FENCED — `db rebuild` does not wedge (the dangling-link DR hazard)", async () => {
    // Without fencing, the raw `[[Nonexistent Page]]` would be extracted as a dangling
    // wiki-link and the strict whole-vault `rebuildProjections` would throw
    // DanglingLinkError, rolling back the ENTIRE rebuild (while incremental sync stays
    // green). Fencing the source body makes the [[...]] opaque body text.
    const danglingSrc = join(root, "dangling.md");
    writeFileSync(danglingSrc, "# Doc\n\nSee [[Nonexistent Page]] for the rest.\n", "utf8");
    const added = JSON.parse((await cli(["source", "add", danglingSrc, "--json"])).out);
    const ing = await cli(["ingest", added.id, "--apply", "--json"]);
    expect(ing.code, ing.out).toBe(0);
    const noteId = JSON.parse(ing.out).capture.noteId;
    // The verbatim [[...]] survives in the committed body, inside a code fence.
    const body = readFileSync(join(vaultDir, "sources", `${noteId}.md`), "utf8");
    expect(body).toContain("[[Nonexistent Page]]");
    expect(body).toMatch(/```/);
    // Drop the non-note seed README (missing-frontmatter) so the whole-vault rebuild
    // sees only valid notes — isolating the dangling-link behaviour we are testing.
    execFileSync("git", ["rm", "-q", "README.md"], { cwd: vaultDir });
    execFileSync("git", ["commit", "-q", "-m", "drop readme"], { cwd: vaultDir });
    // The authoritative whole-vault rebuild must SUCCEED — the fenced [[...]] is NOT a
    // dangling link, so rebuildProjections does not throw + roll back the whole vault.
    const rb = await cli(["db", "rebuild", "--json"]);
    expect(rb.code, rb.out).toBe(0);
  });
});
