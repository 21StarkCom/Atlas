/**
 * `read-commands.cli.test` — per-command contract fixtures for the Task 2.9 read/
 * maintenance surface not covered by `pagination.contract.test`: `source show`,
 * `source trust show` (default untrusted), `note show`/`note related`, and
 * `git cleanup` (terminal-only pruning, dry-run, idempotency). Every `--json`
 * success validates against the committed schema; error paths assert exit codes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../src/main.js";
import { openStore, type Store } from "@atlas/sqlite-store";
import { openRepo } from "@atlas/git";
import { normalizeIdentityKey } from "@atlas/contracts";

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

const hash = (n: number): string => n.toString(16).padStart(64, "0");
const iso = "2026-07-13T10:00:00.000Z";
const ulid = (n: number): string => `01J9Z8Q${"0".repeat(17)}${String(n).padStart(2, "0")}`;

let root: string;
let cwd: string;
let vaultDir: string;
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
  root = mkdtempSync(join("/tmp", "atlas-rc-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  vaultDir = join(cwd, "vault");
  mkdirSync(vaultDir, { recursive: true });
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
  dbPath = join(cwd, ".atlas", "atlas.db");
  await cli(["db", "migrate", "--json"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedBlob(store: Store): { contentId: string; renditionId: string } {
  const raw = hash(1);
  const media = "text/markdown";
  store.provenance.upsertBlob({ raw_content_hash: raw, canonical_media_type: media, size_bytes: 1024, vault_path: "blob/1", first_seen_at: iso });
  store.provenance.recordCapture({ raw_content_hash: raw, canonical_media_type: media, origin: "/inbox/a.md", first_seen_at: iso, last_seen_at: iso });
  store.provenance.recordRendition({ raw_content_hash: raw, canonical_media_type: media, extractor_version: 1, normalizer_version: 1, normalized_content_hash: `sha256:${hash(2)}`, size_bytes: 990, locator_scheme: "char", created_at: iso });
  store.provenance.setActiveRendition({ raw_content_hash: raw, canonical_media_type: media, extractor_version: 1, normalizer_version: 1 });
  return { contentId: `sha256:${raw}:${media}`, renditionId: `sha256:${raw}:${media}:1:1` };
}

describe("source show", () => {
  it("source show validates + reports captures/renditions with the active pointer", async () => {
    const store = openStore({ path: dbPath });
    let ids: { contentId: string; renditionId: string };
    try { ids = seedBlob(store); } finally { store.close(); }
    const r = await cli(["source", "show", ids.contentId, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("source-show", out);
    expect(out.source.activeRenditionId).toBe(ids.renditionId);
    expect(out.source.renditions[0].active).toBe(true);
    expect(out.source.captures.length).toBe(1);
  });

  it("missing arg ⇒ usage (5); malformed handle ⇒ invalid-source-handle (1); unknown ⇒ source-not-found (1)", async () => {
    expect((await cli(["source", "show", "--json"])).code).toBe(5);
    const bad = await cli(["source", "show", "not-a-handle", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).code).toBe("invalid-source-handle");
    const missing = await cli(["source", "show", `sha256:${hash(9)}:text/markdown`, "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).code).toBe("source-not-found");
  });
});

describe("note show / note related", () => {
  function writeNote(name: string, body: string): void {
    writeFileSync(join(vaultDir, `${name}.md`), body, "utf8");
  }

  it("note show validates + emits sections in document order + link resolution", async () => {
    writeNote("atlas", ["---", "id: concept-atlas", "title: Atlas", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "aliases: [Atlas Engine]", "---", "# Overview", "See [[vault]].", "## Goals", "# Details"].join("\n"));
    writeNote("vault", ["---", "id: concept-vault", "title: Vault", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "body"].join("\n"));
    const r = await cli(["note", "show", "concept-atlas", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("note-show", out);
    expect(out.note.sections).toEqual(["Overview", "Overview/Goals", "Details"]);
    expect(out.note.aliases).toEqual(["Atlas Engine"]);
    const link = out.note.links.find((l: { target: string }) => l.target === "vault");
    expect(link.resolved).toBe(true);
  });

  it("note show: not-found ⇒ 1; ambiguous (duplicate id) ⇒ 1", async () => {
    writeNote("a", ["---", "id: dup", "title: A", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "x"].join("\n"));
    writeNote("b", ["---", "id: dup", "title: B", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "y"].join("\n"));
    expect((await cli(["note", "show", "nope", "--json"])).code).toBe(1);
    const amb = await cli(["note", "show", "dup", "--json"]);
    expect(amb.code).toBe(1);
    expect(JSON.parse(amb.out).code).toBe("ambiguous-note");
  });

  it("note related validates against schema", async () => {
    const store = openStore({ path: dbPath });
    try {
      const mk = (id: string) => store.projections.insertNote({ note_id: id, slug: id, title: id, type: "concept", schema_version: 1, status: "active", file_path: `${id}.md`, content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      ["concept-atlas", "concept-vault"].forEach(mk);
      store.projections.insertLink({ source_note_id: "concept-atlas", target_note_id: "concept-vault", predicate: "references", ordinal: 0 });
    } finally { store.close(); }
    const r = await cli(["note", "related", "concept-atlas", "--json"]);
    expect(r.code, r.out).toBe(0);
    validateSchema("note-related", JSON.parse(r.out));
    expect(JSON.parse(r.out).related[0].noteId).toBe("concept-vault");
  });
});

describe("git cleanup", () => {
  /** Seed a git repo at the vault path with one commit; return its sha. */
  function seedRepo(): string {
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: vaultDir,
        env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
      }).toString().trim();
    git(["init", "-q", "-b", "main"]);
    writeFileSync(join(vaultDir, "seed.md"), "seed", "utf8");
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
    return git(["rev-parse", "HEAD"]);
  }

  /** Record a `worktree-applied` git_operations row (ref_name = the worktree dir). */
  function recordWorktree(runId: string, wtDir: string): void {
    const store = openStore({ path: dbPath });
    try {
      store.db
        .prepare(
          `INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at)
           VALUES (?, ?, 'worktree-applied', ?, NULL, ?)`,
        )
        .run(`gop-${runId}`, runId, wtDir, iso);
    } finally {
      store.close();
    }
  }

  /** Upsert an agent_runs row (terminal rows carry a failed_checkpoint only for failed/cancelled). */
  function seedRun(runId: string, status: string, failedCheckpoint: string | null = null): void {
    const store = openStore({ path: dbPath });
    try {
      store.ledger.upsertAgentRun({
        run_id: runId, operation: "ingest", status, failed_checkpoint: failedCheckpoint,
        tier: 3, target_note_id: null, started_at: iso, updated_at: iso,
        finished_at: status === "review-pending" ? null : iso,
      });
    } finally {
      store.close();
    }
  }

  it("empty repo ⇒ zero pruned (idempotent), schema-valid", async () => {
    seedRepo();
    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-cleanup", out);
    expect(out).toMatchObject({ prunedBranches: 0, prunedWorktrees: 0, details: [] });
  });

  it("prunes a TERMINAL run's agent branch but never an OPEN run's", async () => {
    const base = seedRepo();
    const git = (args: string[]): void => { execFileSync("git", args, { cwd: vaultDir }); };
    git(["update-ref", `refs/agent/${ulid(1)}`, base]); // terminal run's branch
    git(["update-ref", `refs/agent/${ulid(2)}`, base]); // open run's branch
    const store = openStore({ path: dbPath });
    try {
      store.ledger.upsertAgentRun({ run_id: ulid(1), operation: "ingest", status: "rejected", failed_checkpoint: null, tier: 3, target_note_id: null, started_at: iso, updated_at: iso, finished_at: iso });
      store.ledger.upsertAgentRun({ run_id: ulid(2), operation: "ingest", status: "review-pending", tier: 3, target_note_id: null, started_at: iso, updated_at: iso });
    } finally { store.close(); }

    // Dry-run reports the terminal branch would be pruned WITHOUT mutating.
    const dry = await cli(["git", "cleanup", "--dry-run", "--json"]);
    expect(dry.code, dry.out).toBe(0);
    expect(JSON.parse(dry.out).prunedBranches).toBe(1);
    expect(existsSync(join(vaultDir, ".git", "refs", "agent", ulid(1)))).toBe(true); // not actually deleted

    // Real run prunes exactly the terminal branch.
    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-cleanup", out);
    expect(out.prunedBranches).toBe(1);
    expect(out.details[0]).toMatchObject({ runId: ulid(1), action: "branch-pruned" });

    const check = (n: number): boolean => {
      try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/agent/${ulid(n)}`], { cwd: vaultDir }); return true; } catch { return false; }
    };
    expect(check(1)).toBe(false); // terminal branch gone
    expect(check(2)).toBe(true); // OPEN run's branch untouched

    // Idempotent: a second run prunes nothing.
    const again = await cli(["git", "cleanup", "--json"]);
    expect(JSON.parse(again.out).prunedBranches).toBe(0);
  });

  it("prunes a TERMINAL run's real recorded worktree (branch+worktree-pruned)", async () => {
    const base = seedRepo();
    const repo = openRepo(vaultDir);
    const ref = await repo.createAgentBranch(ulid(1), base);
    const wtDir = join(root, "wt-terminal");
    await repo.addWorktree(ref, wtDir);
    seedRun(ulid(1), "rejected");
    recordWorktree(ulid(1), wtDir);
    expect(existsSync(wtDir)).toBe(true);

    // Dry-run does not touch the worktree on disk.
    const dry = await cli(["git", "cleanup", "--dry-run", "--json"]);
    expect(dry.code, dry.out).toBe(0);
    expect(JSON.parse(dry.out).prunedWorktrees).toBe(1);
    expect(existsSync(wtDir)).toBe(true);

    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-cleanup", out);
    expect(out.prunedWorktrees).toBe(1);
    expect(out.prunedBranches).toBe(1);
    expect(out.details[0]).toMatchObject({ runId: ulid(1), action: "branch+worktree-pruned" });
    expect(existsSync(wtDir)).toBe(false); // real worktree removed
  });

  it("SAFETY: a terminal row whose recorded path is ANOTHER (open) run's worktree never removes it", async () => {
    const base = seedRepo();
    const repo = openRepo(vaultDir);
    // ulid(2) is an OPEN run with its own real worktree.
    const openRef = await repo.createAgentBranch(ulid(2), base);
    const openWt = join(root, "wt-open");
    await repo.addWorktree(openRef, openWt);
    // ulid(1) is TERMINAL but its (stale/corrupt) row points at ulid(2)'s worktree.
    seedRun(ulid(1), "rejected");
    seedRun(ulid(2), "review-pending");
    recordWorktree(ulid(1), openWt);

    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-cleanup", out);
    // The worktree is bound to refs/agent/<ulid(2)>, not the terminal run's ref, so it is NOT removed.
    expect(out.prunedWorktrees).toBe(0);
    expect(existsSync(openWt)).toBe(true); // open run's worktree preserved
  });

  it("MISSING LEDGER PATH: discovers + removes a terminal run's worktree by its ref binding with NO worktree-applied row — never orphaned (finding #3)", async () => {
    const base = seedRepo();
    const repo = openRepo(vaultDir);
    const ref = await repo.createAgentBranch(ulid(1), base);
    const wtDir = join(root, "wt-missing-ledger");
    await repo.addWorktree(ref, wtDir);
    seedRun(ulid(1), "rejected");
    // DELIBERATELY no recordWorktree(...) — the ledger `worktree-applied` row is
    // missing. Pre-fix, discovery keyed on that row, so the worktree (still bound to
    // refs/agent/<runId>) was left behind while the branch was deleted — an orphan.
    expect(existsSync(wtDir)).toBe(true);

    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-cleanup", out);
    expect(out.prunedWorktrees).toBe(1);
    expect(out.prunedBranches).toBe(1);
    expect(out.details[0]).toMatchObject({ runId: ulid(1), action: "branch+worktree-pruned" });
    expect(existsSync(wtDir)).toBe(false); // worktree removed BEFORE the ref — not orphaned
    // No leftover/broken worktree remains bound to the (now-deleted) ref.
    const wts = await openRepo(vaultDir).listWorktrees();
    expect(wts.some((w) => w.branch === `refs/agent/${ulid(1)}`)).toBe(false);
  });

  it("STALE LEDGER PATH: removes the worktree actually bound to the ref even when the recorded path points elsewhere (finding #3)", async () => {
    const base = seedRepo();
    const repo = openRepo(vaultDir);
    const ref = await repo.createAgentBranch(ulid(1), base);
    const wtDir = join(root, "wt-real");
    await repo.addWorktree(ref, wtDir);
    seedRun(ulid(1), "rejected");
    // The ledger row points at a STALE, nonexistent path — not the real worktree.
    // Pre-fix, existsSync on that path was false, so the branch was deleted while the
    // real ref-bound worktree survived (orphan). Discovery by ref binding fixes it.
    recordWorktree(ulid(1), join(root, "does-not-exist"));
    expect(existsSync(wtDir)).toBe(true);

    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-cleanup", out);
    expect(out.prunedWorktrees).toBe(1);
    expect(out.prunedBranches).toBe(1);
    expect(out.details[0]).toMatchObject({ runId: ulid(1), action: "branch+worktree-pruned" });
    expect(existsSync(wtDir)).toBe(false); // the ref-bound worktree is removed despite the wrong ledger path
  });

  it("MULTIPLE BINDINGS: removes EVERY worktree bound to the terminal ref, then the ref (finding W4)", async () => {
    const base = seedRepo();
    const repo = openRepo(vaultDir);
    const ref = await repo.createAgentBranch(ulid(1), base);
    // @atlas/git adds worktrees by a DETACHED checkout + HEAD re-attach, so git does
    // not enforce its "a branch is checked out in one worktree" rule — TWO worktrees
    // can bind the same refs/agent/<runId>. A `find` would have left the second behind.
    const wtA = join(root, "wt-dup-a");
    const wtB = join(root, "wt-dup-b");
    await repo.addWorktree(ref, wtA);
    await repo.addWorktree(ref, wtB);
    seedRun(ulid(1), "rejected");
    // Precondition: both worktrees really are bound to the same ref.
    expect((await repo.listWorktrees()).filter((w) => w.branch === `refs/agent/${ulid(1)}`).length).toBe(2);

    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-cleanup", out);
    expect(out.prunedWorktrees).toBe(2); // BOTH removed, not just one
    expect(out.prunedBranches).toBe(1);
    expect(out.details[0]).toMatchObject({ runId: ulid(1), action: "branch+worktree-pruned" });
    expect(existsSync(wtA)).toBe(false);
    expect(existsSync(wtB)).toBe(false);
    // No worktree remains bound to the (now-deleted) ref.
    const after = await openRepo(vaultDir).listWorktrees();
    expect(after.some((w) => w.branch === `refs/agent/${ulid(1)}`)).toBe(false);
  });

  it("REMOVAL FAILURE: a worktree that cannot be removed PRESERVES the ref (exit 4, both binding + ref intact) (finding W3)", async () => {
    const base = seedRepo();
    const repo = openRepo(vaultDir);
    const ref = await repo.createAgentBranch(ulid(1), base);
    const wtDir = join(root, "wt-locked");
    await repo.addWorktree(ref, wtDir);
    // Lock the worktree: `git worktree remove --force` (single -f) REFUSES a locked
    // working tree, so removal fails AND git STILL lists it bound to the ref. The ref
    // must be preserved (never delete a ref a live worktree is checked out on) and the
    // failure surfaced — filesystem/`--force` "success" is NOT proof of deregistration.
    execFileSync("git", ["worktree", "lock", wtDir], { cwd: vaultDir });
    seedRun(ulid(1), "rejected");

    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code).toBe(4); // internal — an operational failure left a resource present
    expect(JSON.parse(r.out).code).toBe("internal");
    // The worktree binding survived...
    const after = await openRepo(vaultDir).listWorktrees();
    expect(after.some((w) => w.branch === `refs/agent/${ulid(1)}`)).toBe(true);
    expect(existsSync(wtDir)).toBe(true);
    // ...and the ref was NOT deleted out from under it.
    const refLive = (): boolean => {
      try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/agent/${ulid(1)}`], { cwd: vaultDir }); return true; } catch { return false; }
    };
    expect(refLive()).toBe(true);
  });

  it("PRESERVATION: checkpoint runs (integrated, reindexed) are never pruned", async () => {
    const base = seedRepo();
    const git = (args: string[]): void => { execFileSync("git", args, { cwd: vaultDir }); };
    git(["update-ref", `refs/agent/${ulid(3)}`, base]); // integrated (checkpoint, not terminal)
    git(["update-ref", `refs/agent/${ulid(4)}`, base]); // reindexed (checkpoint, not terminal)
    git(["update-ref", `refs/agent/${ulid(5)}`, base]); // finalized (terminal)
    seedRun(ulid(3), "integrated");
    seedRun(ulid(4), "reindexed");
    seedRun(ulid(5), "finalized");

    const r = await cli(["git", "cleanup", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.prunedBranches).toBe(1); // only the finalized run
    expect(out.details.map((d: { runId: string }) => d.runId)).toEqual([ulid(5)]);

    const check = (n: number): boolean => {
      try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/agent/${ulid(n)}`], { cwd: vaultDir }); return true; } catch { return false; }
    };
    expect(check(3)).toBe(true); // integrated checkpoint preserved
    expect(check(4)).toBe(true); // reindexed checkpoint preserved
    expect(check(5)).toBe(false); // finalized terminal pruned
  });
});

describe("note lookup precedence (tiered: exact id → exact slug → unique alias)", () => {
  function writeNote(name: string, body: string): void {
    writeFileSync(join(vaultDir, `${name}.md`), body, "utf8");
  }
  function fm(id: string, opts: { aliases?: string } = {}): string[] {
    return ["---", `id: ${id}`, `title: ${id}`, "type: concept", "status: active", "schema_version: 1",
      "created: 2026-07-13", "updated: 2026-07-13", ...(opts.aliases ? [`aliases: ${opts.aliases}`] : []), "---", "body"];
  }

  it("note show: an exact id that is ALSO another note's slug resolves to the id (not ambiguous)", async () => {
    // File `collide.md` gives note B the filename slug "collide"; note A's id is "collide".
    writeNote("a", fm("collide").join("\n"));
    writeNote("collide", fm("concept-b").join("\n"));
    const r = await cli(["note", "show", "collide", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).note.id).toBe("collide"); // exact-id tier wins over slug tier
  });

  it("note show: an exact id that is ALSO another note's alias resolves to the id", async () => {
    writeNote("a", fm("aliascollide").join("\n"));
    writeNote("c", fm("concept-c", { aliases: "[aliascollide]" }).join("\n"));
    const r = await cli(["note", "show", "aliascollide", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).note.id).toBe("aliascollide");
  });

  it("note related: an exact id that is ALSO another note's slug resolves to the id", async () => {
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "collideid", slug: "other", title: "A", type: "concept", schema_version: 1, status: "active", file_path: "a.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertNote({ note_id: "concept-b", slug: "collideid", title: "B", type: "concept", schema_version: 1, status: "active", file_path: "b.md", content_hash: `sha256:${hash(2)}`, created: iso, updated: iso });
    } finally { store.close(); }
    const r = await cli(["note", "related", "collideid", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).noteId).toBe("collideid"); // exact-id tier wins, never ambiguous
  });

  it("note history: an exact id that is ALSO another note's slug resolves to the id", async () => {
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "histcollide", slug: "other-h", title: "A", type: "concept", schema_version: 1, status: "active", file_path: "a.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertNote({ note_id: "concept-b", slug: "histcollide", title: "B", type: "concept", schema_version: 1, status: "active", file_path: "b.md", content_hash: `sha256:${hash(2)}`, created: iso, updated: iso });
    } finally { store.close(); }
    const r = await cli(["note", "history", "histcollide", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).noteId).toBe("histcollide");
  });
});

describe("alias resolution is identical across note show / related / history (finding #1)", () => {
  it("a declared alias that normalizes to the note's own slug resolves the SAME across all three", async () => {
    // The note's declared alias "Atlas Engine" and its filename slug "atlas-engine"
    // BOTH fold to the identity key "atlas engine" — a slug-equivalent alias. `note
    // show` reads this vault directly, so it resolves the alias via the vault's alias
    // tier.
    writeFileSync(
      join(vaultDir, "atlas-engine.md"),
      ["---", "id: concept-atlas", "title: Atlas Engine", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "aliases: [Atlas Engine]", "---", "body"].join("\n"),
      "utf8",
    );
    // The projection AS `db rebuild` writes it: a slug-equivalent alias COLLAPSES into
    // the single required kind='slug' identity row (the `one-slug-per-note` verify
    // invariant permits exactly one slug key per note and `normalized_key` is the PK),
    // so there is NO kind='alias' row for "Atlas Engine". `note related`/`note history`
    // resolve the seed against THIS projection — pre-fix they filtered kind='alias' and
    // returned note-not-found while `note show` resolved it, diverging the three.
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas-engine", title: "Atlas Engine", type: "concept", schema_version: 1, status: "active", file_path: "atlas-engine.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("atlas-engine"), note_id: "concept-atlas", kind: "slug", normalizer_version: 1 });
    } finally { store.close(); }

    // Sequential — the `cli` helper swaps the shared process.stdout.write, so
    // overlapping invocations would clobber each other's captured output.
    const alias = "Atlas Engine";
    const show = await cli(["note", "show", alias, "--json"]);
    const related = await cli(["note", "related", alias, "--json"]);
    const history = await cli(["note", "history", alias, "--json"]);
    expect(show.code, `show: ${show.out}`).toBe(0);
    expect(related.code, `related: ${related.out}`).toBe(0);
    expect(history.code, `history: ${history.out}`).toBe(0);
    // All three resolve the SAME alias to the SAME note id.
    expect(JSON.parse(show.out).note.id).toBe("concept-atlas");
    expect(JSON.parse(related.out).noteId).toBe("concept-atlas");
    expect(JSON.parse(history.out).noteId).toBe("concept-atlas");
  });

  it("NO-ALIAS PARITY: a bare slug (no declared alias) is NOT accepted as an alias by any of the three", async () => {
    // A note with filename slug "atlas-engine" and NO declared aliases. Its projection
    // is a single kind='slug' identity row keyed on normalizeIdentityKey("atlas-engine")
    // — BYTE-IDENTICAL to the slug-equivalent-alias case above, since that alias
    // collapses into the same row. `note show` resolves the seed "Atlas Engine" against
    // the vault, whose alias tier consults only DECLARED aliases (none here), so it
    // returns note-not-found. Round-1's "match ANY kind" would have let `note related`/
    // `note history` accept the bare slug row as an alias — diverging from `note show`.
    // Resolution must consult declared-alias evidence, so all three return not-found.
    writeFileSync(
      join(vaultDir, "atlas-engine.md"),
      ["---", "id: concept-atlas", "title: Atlas Engine", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "body"].join("\n"),
      "utf8",
    );
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas-engine", title: "Atlas Engine", type: "concept", schema_version: 1, status: "active", file_path: "atlas-engine.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("atlas-engine"), note_id: "concept-atlas", kind: "slug", normalizer_version: 1 });
    } finally { store.close(); }

    // Sanity: the EXACT slug still resolves via the slug tier on all three (only the
    // normalized-but-inexact "Atlas Engine" spelling — an alias-only spelling — must miss).
    expect((await cli(["note", "show", "atlas-engine", "--json"])).code).toBe(0);
    expect((await cli(["note", "related", "atlas-engine", "--json"])).code).toBe(0);
    expect((await cli(["note", "history", "atlas-engine", "--json"])).code).toBe(0);

    const alias = "Atlas Engine";
    const show = await cli(["note", "show", alias, "--json"]);
    const related = await cli(["note", "related", alias, "--json"]);
    const history = await cli(["note", "history", alias, "--json"]);
    // Identical across all three: note-not-found (exit 1).
    expect(show.code, `show: ${show.out}`).toBe(1);
    expect(related.code, `related: ${related.out}`).toBe(1);
    expect(history.code, `history: ${history.out}`).toBe(1);
    expect(JSON.parse(show.out).code).toBe("note-not-found");
    expect(JSON.parse(related.out).code).toBe("note-not-found");
    expect(JSON.parse(history.out).code).toBe("note-not-found");
  });

  it("STALE PROJECTION ALIAS: a persisted kind='alias' row for an alias since REMOVED from the vault resolves NOWHERE (round-3)", async () => {
    // The vault note declares NO "legacy" alias (it was removed), but the projection
    // still carries a stale kind='alias' row from before the removal. `note show` reads
    // the vault and returns not-found. Pre-fix, `note related`/`note history` UNIONed the
    // stale row into tier 3 and still resolved it — diverging from `note show`. Current
    // vault declarations are authoritative, so all three must return not-found.
    writeFileSync(
      join(vaultDir, "atlas-note.md"),
      ["---", "id: concept-atlas", "title: Atlas", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "body"].join("\n"),
      "utf8",
    );
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas-note", title: "Atlas", type: "concept", schema_version: 1, status: "active", file_path: "atlas-note.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("atlas-note"), note_id: "concept-atlas", kind: "slug", normalizer_version: 1 });
      // STALE: a kind='alias' row lingering from before "legacy" was removed in the vault.
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("legacy"), note_id: "concept-atlas", kind: "alias", normalizer_version: 1 });
    } finally { store.close(); }

    const alias = "legacy";
    const show = await cli(["note", "show", alias, "--json"]);
    const related = await cli(["note", "related", alias, "--json"]);
    const history = await cli(["note", "history", alias, "--json"]);
    // Identical across all three: the removed alias resolves nowhere (exit 1).
    expect(show.code, `show: ${show.out}`).toBe(1);
    expect(related.code, `related: ${related.out}`).toBe(1);
    expect(history.code, `history: ${history.out}`).toBe(1);
    expect(JSON.parse(show.out).code).toBe("note-not-found");
    expect(JSON.parse(related.out).code).toBe("note-not-found");
    expect(JSON.parse(history.out).code).toBe("note-not-found");
  });

  it("REMAPPED PROJECTION ALIAS: an alias moved to another note resolves to the CURRENT vault owner, never ambiguous (round-3)", async () => {
    // The vault now declares alias "shared" on note B; note A no longer declares it.
    // The projection still carries a STALE kind='alias' row pointing "shared" at note A.
    // `note show` reads the vault and resolves "shared" to B. Pre-fix, `note related`/
    // `note history` UNIONed the stale A row with the vault's B row → two distinct owners
    // → ambiguous-note, diverging from `note show`. Current vault declarations are
    // authoritative, so all three resolve to B (the current owner) with no ambiguity.
    writeFileSync(
      join(vaultDir, "a-note.md"),
      ["---", "id: concept-a", "title: A", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "body"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(vaultDir, "b-note.md"),
      ["---", "id: concept-b", "title: B", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "aliases: [shared]", "---", "body"].join("\n"),
      "utf8",
    );
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-a", slug: "a-note", title: "A", type: "concept", schema_version: 1, status: "active", file_path: "a-note.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertNote({ note_id: "concept-b", slug: "b-note", title: "B", type: "concept", schema_version: 1, status: "active", file_path: "b-note.md", content_hash: `sha256:${hash(2)}`, created: iso, updated: iso });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("a-note"), note_id: "concept-a", kind: "slug", normalizer_version: 1 });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("b-note"), note_id: "concept-b", kind: "slug", normalizer_version: 1 });
      // STALE/REMAPPED: `normalized_key` is the PK, so the projection holds exactly ONE
      // "shared" row — here still pointing at the OLD owner A, not yet re-projected to B.
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("shared"), note_id: "concept-a", kind: "alias", normalizer_version: 1 });
    } finally { store.close(); }

    const alias = "shared";
    const show = await cli(["note", "show", alias, "--json"]);
    const related = await cli(["note", "related", alias, "--json"]);
    const history = await cli(["note", "history", alias, "--json"]);
    expect(show.code, `show: ${show.out}`).toBe(0);
    expect(related.code, `related: ${related.out}`).toBe(0);
    expect(history.code, `history: ${history.out}`).toBe(0);
    // All three resolve to the CURRENT vault owner (B), never the stale A, never ambiguous.
    expect(JSON.parse(show.out).note.id).toBe("concept-b");
    expect(JSON.parse(related.out).noteId).toBe("concept-b");
    expect(JSON.parse(history.out).noteId).toBe("concept-b");
  });
});

describe("note history: `commit` is the canonical SHA (git_operations), NOT audit git_head", () => {
  it("run.integrated event emits the integrated commit_sha; git_head is never surfaced; non-integration events omit commit", async () => {
    const canonical = hash(0xca); // git_operations integrated commit_sha (the canonical SHA)
    const auditHead = hash(0xad); // audit_events.git_head (refs/audit/runs chain head) — DELIBERATELY different
    expect(canonical).not.toBe(auditHead);
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas", title: "Atlas", type: "concept", schema_version: 1, status: "active", file_path: "atlas.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.ledger.upsertAgentRun({ run_id: ulid(9), operation: "ingest", status: "integrated", tier: 1, target_note_id: "concept-atlas", started_at: iso, updated_at: iso, finished_at: iso });
      // A pre-integration event (no canonical commit yet) and the integration event —
      // both carry a git_head, but only the integration has a canonical commit.
      store.ledger.insertAuditEvent({ seq: 1, run_id: ulid(9), event_type: "run.planned", payload_hash: hash(2), git_head: auditHead, created_at: iso });
      store.ledger.insertAuditEvent({ seq: 2, run_id: ulid(9), event_type: "run.integrated", payload_hash: hash(3), git_head: auditHead, created_at: iso });
      store.db
        .prepare(`INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at) VALUES (?, ?, 'integrated', ?, ?, ?)`)
        .run(`gop-int-${ulid(9)}`, ulid(9), "refs/heads/main", canonical, iso);
    } finally { store.close(); }

    const r = await cli(["note", "history", "concept-atlas", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("note-history", out);
    const integrated = out.events.find((e: { kind: string }) => e.kind === "run.integrated");
    const planned = out.events.find((e: { kind: string }) => e.kind === "run.planned");
    expect(integrated.commit).toBe(canonical); // canonical SHA from git_operations
    expect(integrated.commit).not.toBe(auditHead); // the audit-chain head is NOT surfaced
    expect(planned.commit).toBeUndefined(); // no canonical commit ⇒ omitted
  });

  it("a run that never integrated omits commit entirely (inapplicable)", async () => {
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-open", slug: "open", title: "Open", type: "concept", schema_version: 1, status: "active", file_path: "open.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.ledger.upsertAgentRun({ run_id: ulid(8), operation: "ingest", status: "review-pending", tier: 2, target_note_id: "concept-open", started_at: iso, updated_at: iso });
      store.ledger.insertAuditEvent({ seq: 5, run_id: ulid(8), event_type: "run.planned", payload_hash: hash(2), git_head: hash(0xbe), created_at: iso });
    } finally { store.close(); }
    const r = await cli(["note", "history", "concept-open", "--json"]);
    expect(r.code, r.out).toBe(0);
    validateSchema("note-history", JSON.parse(r.out));
    expect(JSON.parse(r.out).events.every((e: { commit?: string }) => e.commit === undefined)).toBe(true);
  });
});

describe("git status hasWorktree verifies the git worktree/ref binding (not a bare path check)", () => {
  function seedRepo(): string {
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: vaultDir,
        env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
      }).toString().trim();
    git(["init", "-q", "-b", "main"]);
    writeFileSync(join(vaultDir, "seed.md"), "seed", "utf8");
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
    return git(["rev-parse", "HEAD"]);
  }
  function seedOpenRun(runId: string): void {
    const store = openStore({ path: dbPath });
    try {
      store.ledger.upsertAgentRun({ run_id: runId, operation: "ingest", status: "worktree-applied", tier: 3, target_note_id: null, started_at: iso, updated_at: iso });
    } finally { store.close(); }
  }
  function recordWorktree(runId: string, wtDir: string): void {
    const store = openStore({ path: dbPath });
    try {
      store.db
        .prepare(`INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at) VALUES (?, ?, 'worktree-applied', ?, NULL, ?)`)
        .run(`gop-${runId}`, runId, wtDir, iso);
    } finally { store.close(); }
  }
  const hasWt = (out: string, runId: string): boolean =>
    JSON.parse(out).runs.find((r: { runId: string }) => r.runId === runId).hasWorktree;

  it("a real worktree bound to refs/agent/<runId> ⇒ hasWorktree true", async () => {
    const base = seedRepo();
    const repo = openRepo(vaultDir);
    const ref = await repo.createAgentBranch(ulid(1), base);
    const wtDir = join(root, "wt-real");
    await repo.addWorktree(ref, wtDir);
    seedOpenRun(ulid(1));
    recordWorktree(ulid(1), wtDir);
    const r = await cli(["git", "status", "--json"]);
    expect(r.code, r.out).toBe(0);
    validateSchema("git-status", JSON.parse(r.out));
    expect(hasWt(r.out, ulid(1))).toBe(true);
  });

  it("STALE PATH: an ordinary (non-worktree) directory recorded as the run's worktree ⇒ hasWorktree false", async () => {
    seedRepo();
    const ordinary = join(root, "ordinary-dir");
    mkdirSync(ordinary, { recursive: true }); // exists on disk but is NOT a registered git worktree
    seedOpenRun(ulid(1));
    recordWorktree(ulid(1), ordinary);
    const r = await cli(["git", "status", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(hasWt(r.out, ulid(1))).toBe(false); // bare existsSync would have wrongly said true
  });

  it("REASSIGNED PATH: another run's worktree recorded against this run ⇒ hasWorktree false", async () => {
    const base = seedRepo();
    const repo = openRepo(vaultDir);
    // ulid(2)'s real worktree, bound to refs/agent/<ulid(2)>.
    const otherRef = await repo.createAgentBranch(ulid(2), base);
    const otherWt = join(root, "wt-other");
    await repo.addWorktree(otherRef, otherWt);
    seedOpenRun(ulid(2));
    recordWorktree(ulid(2), otherWt); // ulid(2)'s own (correct) binding
    // ulid(1)'s recorded path ALSO points at ulid(2)'s worktree (reassigned/stale).
    seedOpenRun(ulid(1));
    recordWorktree(ulid(1), otherWt);
    const r = await cli(["git", "status", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(hasWt(r.out, ulid(1))).toBe(false); // bound to ulid(2)'s ref, not ulid(1)'s
    expect(hasWt(r.out, ulid(2))).toBe(true); // its own binding is intact
  });

  it("NON-GIT DIRECTORY: an uninitialized vault degrades to hasWorktree false + exit 0 (the ONLY swallowed case)", async () => {
    // vaultDir exists (beforeEach) but is NOT a git repo — no `git init` here. This is
    // the SOLE git failure `git status` degrades: `git worktree list` reports "not a
    // git repository", which simply means no agent worktrees. The run list still comes
    // back (from the DB), so the command succeeds rather than erroring.
    const ordinary = join(root, "some-dir");
    mkdirSync(ordinary, { recursive: true });
    seedOpenRun(ulid(1));
    recordWorktree(ulid(1), ordinary);
    const r = await cli(["git", "status", "--json"]);
    expect(r.code, r.out).toBe(0); // degrades to "no worktrees", not an error
    const out = JSON.parse(r.out);
    validateSchema("git-status", out);
    expect(out.runs.length).toBe(1); // the run is still listed — degraded, not dropped
    expect(hasWt(r.out, ulid(1))).toBe(false);
  });

  it("OPERATIONAL FAILURE: a git error that is NOT 'not a repository' propagates as internal (exit 4), never a false empty worktree list (finding #2)", async () => {
    // A garbage `.git` FILE is not the benign non-repo case — `git worktree list`
    // fails with `fatal: invalid gitfile format`, a genuine operational error
    // (permission failure / corruption / exec failure all behave the same). Pre-fix,
    // `listWorktreesSafe` swallowed EVERY GitError into `[]` + exit 0, falsely
    // reporting hasWorktree=false. It must instead surface per the git-status
    // contract's `internal` error class.
    writeFileSync(join(vaultDir, ".git"), "garbage not a gitfile", "utf8");
    seedOpenRun(ulid(1));
    const r = await cli(["git", "status", "--json"]);
    expect(r.code).toBe(4); // internal — the contract's operational-failure exit code
    expect(JSON.parse(r.out).code).toBe("internal");
  });

  it("MISSING GITDIR: a valid .git file pointing at a nonexistent gitdir propagates as internal (exit 4), not swallowed as a non-repo (finding W2)", async () => {
    // A well-formed `.git` FILE (a git indirection) whose gitdir TARGET is missing is
    // CORRUPT repository metadata, NOT an uninitialized vault. `git worktree list`
    // fails `fatal: not a git repository: (null)` — which contains the substring "not
    // a git repository" but LACKS the "(or any of the parent directories)" marker of
    // the genuine ordinary-directory case. Matching the bare substring (pre-fix) would
    // have swallowed this as "no worktrees" + exit 0; it must instead propagate per the
    // contract's `internal` error class.
    writeFileSync(join(vaultDir, ".git"), `gitdir: ${join(root, "no-such-gitdir", ".git")}\n`, "utf8");
    seedOpenRun(ulid(1));
    const r = await cli(["git", "status", "--json"]);
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out).code).toBe("internal");
  });

  it("EMPTY/CORRUPT .git DIRECTORY: propagates as internal (exit 4), not swallowed as a non-repo (finding #2 round-3)", async () => {
    // An EMPTY `.git` DIRECTORY makes `git worktree list` emit the SAME message as an
    // uninitialized vault — `fatal: not a git repository (or any of the parent
    // directories): .git`, WITH the "(or any of the parent directories)" marker. Pre-fix,
    // the classifier keyed on that message alone and swallowed this corrupt/inaccessible
    // repository metadata as "no worktrees" + exit 0. It must instead require a
    // VERIFIED-ABSENT vault-root `.git`: the entry is present here, so the error
    // propagates per the contract's `internal` error class.
    mkdirSync(join(vaultDir, ".git"), { recursive: true }); // present but empty ⇒ corrupt metadata
    seedOpenRun(ulid(1));
    const r = await cli(["git", "status", "--json"]);
    expect(r.code).toBe(4);
    expect(JSON.parse(r.out).code).toBe("internal");
  });
});

describe("git status validation reflects the LATEST result per check (finding W5)", () => {
  function seedValidations(runId: string, rows: { check: string; outcome: string; at: string }[]): void {
    const store = openStore({ path: dbPath });
    try {
      store.ledger.upsertAgentRun({ run_id: runId, operation: "ingest", status: "review-pending", tier: 3, target_note_id: null, started_at: iso, updated_at: iso });
      rows.forEach((row, i) =>
        store.db
          .prepare(`INSERT INTO validation_results (validation_id, run_id, check_name, outcome, detail, created_at) VALUES (?, ?, ?, ?, NULL, ?)`)
          .run(`v-${runId}-${i}`, runId, row.check, row.outcome, row.at),
      );
    } finally { store.close(); }
  }
  const validationOf = (out: string, runId: string): string =>
    JSON.parse(out).runs.find((r: { runId: string }) => r.runId === runId).validation;

  it("fail-then-pass ⇒ passed (a later successful revalidation supersedes the failure)", async () => {
    seedValidations(ulid(1), [
      { check: "lint", outcome: "fail", at: "2026-07-13T10:00:00.000Z" },
      { check: "lint", outcome: "pass", at: "2026-07-13T10:05:00.000Z" },
    ]);
    const r = await cli(["git", "status", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(validationOf(r.out, ulid(1))).toBe("passed");
  });

  it("pass-then-fail ⇒ failed (a later failure supersedes the earlier pass)", async () => {
    seedValidations(ulid(2), [
      { check: "lint", outcome: "pass", at: "2026-07-13T10:00:00.000Z" },
      { check: "lint", outcome: "fail", at: "2026-07-13T10:05:00.000Z" },
    ]);
    const r = await cli(["git", "status", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(validationOf(r.out, ulid(2))).toBe("failed");
  });
});

describe("note related/history surface a vault-read failure as a CONTRACT-DECLARED error (finding #2)", () => {
  it("a broken vault path yields `internal` (exit 4), never the undeclared `vault-error`", async () => {
    // The declared-alias resolution tier reads the current vault (loadVaultSnapshot). Its
    // read failure must map to a class the immutable note-related/note-history contracts
    // declare — internal/note-not-found/usage — NOT `vault-error` (which they don't list;
    // that code belongs to db-rebuild/doctor/git-*). Make the vault path unreadable: a file
    // where a directory is expected makes readVault throw ENOTDIR.
    rmSync(vaultDir, { recursive: true, force: true });
    writeFileSync(vaultDir, "not a directory", "utf8");

    for (const cmd of ["related", "history"]) {
      const r = await cli(["note", cmd, "anything", "--json"]);
      expect(r.code, `${cmd}: ${r.out}`).toBe(4);
      const code = JSON.parse(r.out).code;
      expect(code, `${cmd} code`).toBe("internal");
      expect(code).not.toBe("vault-error"); // undeclared for these commands
    }
  });
});

describe("git status treats a DANGLING .git symlink as present, not a benign non-repo (finding #3)", () => {
  it("a dangling `.git` symlink surfaces `internal` (exit 4), never a false exit-0 empty list", async () => {
    // existsSync follows symlinks and returns false for a dangling `.git` symlink, which
    // would let corrupt metadata fall into the "no repository" path (exit 0). The git
    // invocation still fails (not-a-repository), but a `.git` ENTRY exists — so the command
    // must propagate `internal`, not report hasWorktree=false. lstat sees the entry itself.
    symlinkSync(join(root, "does-not-exist"), join(vaultDir, ".git"));
    const r = await cli(["git", "status", "--json"]);
    expect(r.code, r.out).toBe(4);
    expect(JSON.parse(r.out).code).toBe("internal");
  });
});
