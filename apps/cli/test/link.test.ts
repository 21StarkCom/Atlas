/**
 * `link` (#331) — the one NEW v2 command, proven against the spec's binding test
 * rows e–n (2026-07-21 v2 spec §test-plan) by driving the REAL `brain link`
 * through the router over a real git vault + migrated projection (the projection
 * is seeded through a real `brain sync` with the deterministic in-process fake
 * embedder — no daemon, no network).
 *
 *   row e — fresh plain add: action:"added", predicate:null, EXACTLY one commit,
 *           noop:false, the SetLink edge present in the projection;
 *   row f — fresh typed add (--predicate cites): action:"related", one commit;
 *   row g — duplicate add: 2nd run action:"noop", commit:null, exit 0, HEAD
 *           unchanged (no git write, no projection write);
 *   row h — plain + cites both present, `--predicate cites --remove` removes ONLY
 *           the cites edge (the plain link survives);
 *   row i — absent-edge remove: noop, HEAD unchanged;
 *   row j — --alias + --remove: exit 5 (usage), no mutation;
 *   row k — unknown source/target: exit 1 grounding failure, never a noop;
 *   row l — alias change: action:"updated", ONE in-place mutation + one commit,
 *           no duplicate edge;
 *   row m — aliasless re-add: noop, the stored alias preserved (never clobbered);
 *   row n — identical-alias re-add: noop, HEAD unchanged.
 *
 * Plus: every `--json` payload validates against link.schema.json; the schema
 * REJECTS the two invalid combos (noop:false+commit:null, noop:true+non-noop
 * action) — the commit-null-IFF-noop invariant is machine-enforced; and the
 * identity-key ⇄ partial-index conformance row — a target seed spelled by id,
 * slug, or declared alias resolves to the SAME `@atlas/contracts` identity, so
 * re-adding under a different spelling is a noop and the projection holds exactly
 * one row per `ux_note_links_plain` / `ux_note_links_pred` selector.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { openStore } from "@atlas/sqlite-store";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  errorsText: (e?: unknown) => string;
};

const linkSchema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", "link.schema.json"), "utf8")) as object;
const ajv = new Ajv({ strict: false, allErrors: true });
const validateLink = ajv.compile(linkSchema);

function assertValid(value: unknown): void {
  if (!validateLink(value)) {
    throw new Error(`link payload failed schema: ${ajv.errorsText(validateLink.errors)}\n${JSON.stringify(value)}`);
  }
}

let root: string;
let cwd: string;
let vaultDir: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Aryeh Stark",
  GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
  GIT_COMMITTER_NAME: "Aryeh Stark",
  GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: vaultDir, encoding: "utf8", env: GIT_ENV }).trim();
}
const head = (): string => git(["rev-parse", "HEAD"]);
const commitCount = (): number => Number.parseInt(git(["rev-list", "--count", "HEAD"]), 10);

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

/** Run `brain link … --json`, parse the payload, schema-validate it. */
async function link(args: string[]): Promise<{ code: number; payload: Record<string, unknown> }> {
  const r = await cli(["link", ...args, "--json"]);
  const payload = JSON.parse(r.out) as Record<string, unknown>;
  if (r.code === 0) assertValid(payload);
  return { code: r.code, payload };
}

function noteText(id: string, aliases: readonly string[] = []): string {
  const aliasBlock = aliases.length === 0 ? "" : `aliases:\n${aliases.map((a) => `  - ${a}`).join("\n")}\n`;
  return `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\nstatus: active\n${aliasBlock}created: 2026-07-22\nupdated: 2026-07-22\n---\n# ${id}\n\nBody of ${id}.\n`;
}
function writeNote(rel: string, id: string, aliases: readonly string[] = []): void {
  writeFileSync(join(vaultDir, rel), noteText(id, aliases), "utf8");
}

/** All projected edges for a source, ordered — the physical `note_links` view. */
function edges(sourceId: string): { target_note_id: string; predicate: string | null; alias: string | null }[] {
  const s = openStore({ path: dbPath });
  try {
    return s.db
      .prepare(
        `SELECT target_note_id, predicate, alias FROM note_links WHERE source_note_id = ? ORDER BY target_note_id, predicate`,
      )
      .all(sourceId) as { target_note_id: string; predicate: string | null; alias: string | null }[];
  } finally {
    s.close();
  }
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-link-"));
  cwd = join(root, "work");
  vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
  git(["config", "commit.gpgsign", "false"]);
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
  env = { ...process.env, NO_COLOR: "1", ATLAS_TEST_MODE: "1", ATLAS_FAKE_PROVIDER: "1" };

  // Two committed, projected notes: concept-a (slug a) + concept-b (slug b, one
  // declared alias for the identity-conformance row).
  writeNote("a.md", "concept-a");
  writeNote("b.md", "concept-b", ["Bee Note"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed notes"]);
  const mig = await cli(["db", "migrate", "--json"]);
  expect(mig.code, mig.out).toBe(0);
  const sync = await cli(["sync", "--json"]);
  expect(sync.code, sync.out).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain link — binding rows e–n", () => {
  it("row e — fresh plain add: added, predicate:null, exactly one commit, edge projected", async () => {
    const before = commitCount();
    const { code, payload } = await link(["concept-a", "concept-b"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({
      command: "link",
      action: "added",
      source: "concept-a",
      target: "concept-b",
      predicate: null,
      alias: null,
      noop: false,
    });
    expect(payload.commit).toBe(head()); // the ONE commit is HEAD
    expect(commitCount()).toBe(before + 1); // exactly one
    expect(edges("concept-a")).toEqual([{ target_note_id: "concept-b", predicate: null, alias: null }]);
    // The surgery landed in the canonical links section of the source body.
    expect(readFileSync(join(vaultDir, "a.md"), "utf8")).toContain("## Links");
    expect(readFileSync(join(vaultDir, "a.md"), "utf8")).toContain("[[concept-b]]");
  });

  it("row f — fresh typed add: related, predicate set, one commit, relationship projected", async () => {
    const before = commitCount();
    const { code, payload } = await link(["concept-a", "concept-b", "--predicate", "cites"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ action: "related", predicate: "cites", noop: false });
    expect(payload.commit).toBe(head());
    expect(commitCount()).toBe(before + 1);
    expect(edges("concept-a")).toEqual([{ target_note_id: "concept-b", predicate: "cites", alias: null }]);
    // Model A: the typed edge lives in the source's frontmatter `related:` list.
    const text = readFileSync(join(vaultDir, "a.md"), "utf8");
    expect(text).toContain("related:");
    expect(text).toContain("predicate: cites");
  });

  it("row g — duplicate plain add: 2nd run is a noop with HEAD unchanged", async () => {
    await link(["concept-a", "concept-b"]);
    const headAfterFirst = head();
    const edgesAfterFirst = edges("concept-a");
    const { code, payload } = await link(["concept-a", "concept-b"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ action: "noop", commit: null, noop: true });
    expect(head()).toBe(headAfterFirst); // no new commit
    expect(edges("concept-a")).toEqual(edgesAfterFirst); // no projection write
  });

  it("row h — predicate-scoped remove: only the cites edge goes, the plain link survives", async () => {
    await link(["concept-a", "concept-b"]);
    await link(["concept-a", "concept-b", "--predicate", "cites"]);
    expect(edges("concept-a")).toHaveLength(2);
    const before = commitCount();
    const { code, payload } = await link(["concept-a", "concept-b", "--predicate", "cites", "--remove"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ action: "removed", predicate: "cites", noop: false });
    expect(commitCount()).toBe(before + 1);
    expect(edges("concept-a")).toEqual([{ target_note_id: "concept-b", predicate: null, alias: null }]);
  });

  it("row i — absent-edge remove: noop, HEAD unchanged, no commit", async () => {
    const h0 = head();
    const { code, payload } = await link(["concept-a", "concept-b", "--remove"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ action: "noop", commit: null, noop: true });
    expect(head()).toBe(h0);
  });

  it("row j — --alias + --remove: exit 5 before grounding, no mutation anywhere", async () => {
    const h0 = head();
    const r = await cli(["link", "concept-a", "concept-b", "--alias", "foo", "--remove", "--json"]);
    expect(r.code).toBe(5);
    expect(head()).toBe(h0);
    expect(edges("concept-a")).toEqual([]);
  });

  it("row k — unknown source/target: exit 1 grounding failure, never a noop", async () => {
    for (const argv of [["concept-a", "no-such-note"], ["no-such-note", "concept-b"]]) {
      const h0 = head();
      const r = await cli(["link", ...argv, "--json"]);
      expect(r.code, r.out).toBe(1);
      const err = JSON.parse(r.out) as { code?: string };
      expect(err.code).toBe("note-not-found");
      expect(head()).toBe(h0);
    }
  });

  it("row l — alias change: updated, one in-place mutation + one commit, no duplicate edge", async () => {
    await link(["concept-a", "concept-b", "--alias", "foo"]);
    const before = commitCount();
    const { code, payload } = await link(["concept-a", "concept-b", "--alias", "bar"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ action: "updated", alias: "bar", noop: false });
    expect(commitCount()).toBe(before + 1);
    expect(edges("concept-a")).toEqual([{ target_note_id: "concept-b", predicate: null, alias: "bar" }]); // ONE edge, realiased
    const body = readFileSync(join(vaultDir, "a.md"), "utf8");
    expect(body).toContain("[[concept-b|bar]]");
    expect(body).not.toContain("[[concept-b|foo]]");
  });

  it("row m — aliasless re-add: noop, the stored alias is preserved (never clobbered)", async () => {
    await link(["concept-a", "concept-b", "--alias", "foo"]);
    const { code, payload } = await link(["concept-a", "concept-b"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ action: "noop", commit: null, noop: true });
    expect(edges("concept-a")).toEqual([{ target_note_id: "concept-b", predicate: null, alias: "foo" }]);
  });

  it("row n — identical-alias re-add: noop, HEAD unchanged (alias equality is part of the duplicate test)", async () => {
    await link(["concept-a", "concept-b", "--alias", "foo"]);
    const h0 = head();
    const { code, payload } = await link(["concept-a", "concept-b", "--alias", "foo"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ action: "noop", commit: null, noop: true });
    expect(head()).toBe(h0);
  });

  it("rows l/m/n typed form — alias update / preserve / identical on a `related:` edge", async () => {
    await link(["concept-a", "concept-b", "--predicate", "cites", "--alias", "foo"]);
    // aliasless typed re-add preserves the stored alias
    const m = await link(["concept-a", "concept-b", "--predicate", "cites"]);
    expect(m.payload).toMatchObject({ action: "noop", noop: true });
    expect(edges("concept-a")).toEqual([{ target_note_id: "concept-b", predicate: "cites", alias: "foo" }]);
    // identical alias ⇒ noop
    const n = await link(["concept-a", "concept-b", "--predicate", "cites", "--alias", "foo"]);
    expect(n.payload).toMatchObject({ action: "noop", noop: true });
    // changed alias ⇒ updated, in place
    const l = await link(["concept-a", "concept-b", "--predicate", "cites", "--alias", "bar"]);
    expect(l.payload).toMatchObject({ action: "updated", noop: false });
    expect(edges("concept-a")).toEqual([{ target_note_id: "concept-b", predicate: "cites", alias: "bar" }]);
  });
});

describe("brain link — grounding gates", () => {
  it("a dirty TARGET (uncommitted git edit) fails grounding exit 1 before any mutation (spec row b)", async () => {
    appendFileSync(join(vaultDir, "b.md"), "\nuncommitted edit\n");
    const h0 = head();
    const r = await cli(["link", "concept-a", "concept-b", "--json"]);
    expect(r.code, r.out).toBe(1);
    const err = JSON.parse(r.out) as { code?: string };
    expect(err.code).toBe("dirty-vault");
    expect(head()).toBe(h0);
    expect(edges("concept-a")).toEqual([]);
  });

  it("a dirty SOURCE fails grounding exit 1 even when the outcome would be a noop (noop is only for clean notes)", async () => {
    await link(["concept-a", "concept-b"]);
    appendFileSync(join(vaultDir, "a.md"), "\nuncommitted edit\n");
    const r = await cli(["link", "concept-a", "concept-b", "--json"]); // would otherwise be the row-g noop
    expect(r.code, r.out).toBe(1);
    const err = JSON.parse(r.out) as { code?: string };
    expect(err.code).toBe("dirty-vault");
  });
});

describe("link.schema.json — the machine-enforced commit-null-IFF-noop invariant", () => {
  const base = { command: "link", source: "a", target: "b", predicate: null, alias: null };

  it("rejects noop:false with commit:null", () => {
    expect(validateLink({ ...base, action: "added", commit: null, noop: false })).toBe(false);
  });

  it("rejects noop:true with a non-noop action", () => {
    expect(
      validateLink({ ...base, action: "added", commit: null, noop: true }),
    ).toBe(false);
  });

  it("rejects noop:true carrying a commit sha", () => {
    expect(
      validateLink({ ...base, action: "noop", commit: "5f3a581aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", noop: true }),
    ).toBe(false);
  });

  it("accepts the two valid shapes", () => {
    expect(validateLink({ ...base, action: "noop", commit: null, noop: true })).toBe(true);
    expect(
      validateLink({ ...base, action: "added", commit: "5f3a581aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", noop: false }),
    ).toBe(true);
  });
});

describe("identity-key ⇄ partial-index conformance (#331 acceptance)", () => {
  it("the two v2 partial UNIQUE indexes exist with the NULL-partitioned selectors", () => {
    const s = openStore({ path: dbPath });
    try {
      const rows = s.db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('ux_note_links_plain', 'ux_note_links_pred') ORDER BY name`)
        .all() as { name: string; sql: string }[];
      expect(rows.map((r) => r.name)).toEqual(["ux_note_links_plain", "ux_note_links_pred"]);
      expect(rows[0]!.sql).toMatch(/UNIQUE INDEX ux_note_links_plain .*WHERE predicate IS NULL/s);
      expect(rows[1]!.sql).toMatch(/UNIQUE INDEX ux_note_links_pred .*WHERE predicate IS NOT NULL/s);
    } finally {
      s.close();
    }
  });

  it("id / slug / declared-alias spellings resolve to ONE identity: re-adds are noops, one row per selector", async () => {
    // Add via the target's DECLARED ALIAS spelling.
    const first = await link(["concept-a", "Bee Note"]);
    expect(first.payload).toMatchObject({ action: "added", target: "concept-b" }); // resolved id in the payload
    // Re-add via the filename-slug spelling ⇒ the SAME @atlas/contracts identity ⇒ noop.
    const bySlug = await link(["concept-a", "b"]);
    expect(bySlug.payload).toMatchObject({ action: "noop", target: "concept-b" });
    // Re-add via the exact id ⇒ still the same identity ⇒ noop.
    const byId = await link(["concept-a", "concept-b"]);
    expect(byId.payload).toMatchObject({ action: "noop" });
    // Exactly ONE plain row survives — the ux_note_links_plain selector.
    expect(edges("concept-a")).toEqual([{ target_note_id: "concept-b", predicate: null, alias: null }]);

    // Same 1:1 mapping on the predicate selector (ux_note_links_pred).
    await link(["concept-a", "Bee Note", "--predicate", "cites"]);
    const predAgain = await link(["concept-a", "b", "--predicate", "cites"]);
    expect(predAgain.payload).toMatchObject({ action: "noop" });
    expect(edges("concept-a")).toEqual([
      { target_note_id: "concept-b", predicate: null, alias: null },
      { target_note_id: "concept-b", predicate: "cites", alias: null },
    ]);
  });
});
