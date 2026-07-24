/**
 * mutation-order.restoration.test.ts (#325) — the binding mutation order's
 * failure/restoration guarantees, proven directly against {@link runMutation} over
 * a REAL git vault + a REAL migrated store.
 *
 *   HEAD guard          — a feature-branch / detached HEAD ⇒ exit 2 BEFORE any
 *                         mutation (no commit, no derived-store write).
 *   preimage restore    — an apply→commit failpoint restores the touched-path
 *                         working-tree preimage (a created file is removed; an
 *                         edited file reverts) and lands NO commit.
 *   index-write failure — a failed index refresh aborts AFTER the commit but
 *                         BEFORE the projection advance, so `content_hash` is left
 *                         stale and a subsequent clean run (the next `brain sync`)
 *                         re-derives and heals it.
 *   git-only revert     — a git revert leaves the projection stale; re-deriving
 *                         from the reverted tree (what `brain sync` does) restores it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, ProjectionRepo, foldNotesForPaths, type Store } from "@atlas/sqlite-store";
import { openRepo, type Repo } from "@atlas/git";
import { runMutation, type Grounded } from "../src/workflows/mutation-order.js";
import { CliError } from "../src/errors/envelope.js";
import type { RunContext } from "../src/handlers.js";

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Aryeh Stark",
  GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
  GIT_COMMITTER_NAME: "Aryeh Stark",
  GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
});

const h = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

interface Fix {
  dir: string;
  repo: Repo;
  store: Store;
  env: NodeJS.ProcessEnv;
  ctx: RunContext;
  git(args: string[]): string;
  head(): string;
}

let fix: Fix;

beforeEach(() => {
  const dir = mkdtempSync(join("/tmp", "atlas-restore-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "seed\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  const store = openStore({ path: ":memory:" });
  store.migrate();
  const env: NodeJS.ProcessEnv = {};
  const ctx = { env, withLock: (_s: unknown, fn: () => unknown) => fn() } as unknown as RunContext;
  fix = { dir, repo: openRepo(dir), store, env, ctx, git, head: () => git(["rev-parse", "HEAD"]) };
});

afterEach(() => {
  try {
    fix.store.close();
  } catch {
    /* ignore */
  }
  rmSync(fix.dir, { recursive: true, force: true });
});

/** Drive a mutation that writes `apply()` to `touchedPaths`, with optional refresh spies. */
function mutate(opts: {
  touchedPaths: string[];
  apply: () => void;
  refreshIndex?: () => Promise<void>;
  refreshProjection?: () => Promise<void>;
}): Promise<string> {
  return runMutation<string>({
    ctx: fix.ctx,
    repo: fix.repo,
    vaultPath: fix.dir,
    ground(preApply): Grounded {
      preApply();
      return { touchedPaths: opts.touchedPaths, commitMessage: "m", affectedNoteIds: [], apply: opts.apply };
    },
    ...(opts.refreshIndex ? { refreshIndex: (): Promise<void> => opts.refreshIndex!() } : {}),
    ...(opts.refreshProjection ? { refreshProjection: (): Promise<void> => opts.refreshProjection!() } : {}),
    buildResult: (sha) => sha,
  });
}

describe("mutation order — restoration guarantees (#325)", () => {
  it("HEAD guard: a feature branch refuses exit 2 before any mutation", async () => {
    fix.git(["switch", "-q", "-c", "feature"]);
    const before = fix.head();
    let threw: CliError | null = null;
    try {
      await mutate({ touchedPaths: ["n.md"], apply: () => writeFileSync(join(fix.dir, "n.md"), "x\n") });
    } catch (e) {
      threw = e as CliError;
    }
    expect(threw).toBeInstanceOf(CliError);
    expect(threw!.code).toBe("head-not-canonical");
    expect(threw!.exitCode).toBe(2);
    expect(fix.head()).toBe(before); // no commit
    expect(existsSync(join(fix.dir, "n.md"))).toBe(false); // no write survives
  });

  it("HEAD guard: a detached HEAD refuses exit 2", async () => {
    fix.git(["checkout", "-q", "--detach"]);
    await expect(mutate({ touchedPaths: ["n.md"], apply: () => writeFileSync(join(fix.dir, "n.md"), "x\n") })).rejects.toMatchObject({
      code: "head-not-canonical",
      exitCode: 2,
    });
  });

  it("apply→commit failpoint restores the preimage: a created file is removed, no commit lands", async () => {
    fix.env.ATLAS_TEST_MUTATION_APPLY_FAIL = "1";
    const before = fix.head();
    await expect(mutate({ touchedPaths: ["new.md"], apply: () => writeFileSync(join(fix.dir, "new.md"), "created\n") })).rejects.toMatchObject({
      code: "apply-failed",
    });
    expect(existsSync(join(fix.dir, "new.md"))).toBe(false); // preimage: absent → absent
    expect(fix.head()).toBe(before); // no commit
  });

  it("apply→commit failpoint restores an EDITED file to its committed bytes", async () => {
    writeFileSync(join(fix.dir, "edit.md"), "original\n", "utf8");
    fix.git(["add", "-A"]);
    fix.git(["commit", "-q", "-m", "add edit"]);
    fix.env.ATLAS_TEST_MUTATION_APPLY_FAIL = "1";
    await expect(mutate({ touchedPaths: ["edit.md"], apply: () => writeFileSync(join(fix.dir, "edit.md"), "clobbered\n") })).rejects.toMatchObject({
      code: "apply-failed",
    });
    expect(readFileSync(join(fix.dir, "edit.md"), "utf8")).toBe("original\n"); // restored
    expect(fix.git(["status", "--porcelain", "--", "edit.md"])).toBe(""); // clean
  });

  it("index-write failure: commit lands, projection stays stale, a later clean run heals it", async () => {
    const proj = new ProjectionRepo(fix.store.db);
    const projectNote = (contentHash: string): void =>
      proj.insertNote({
        note_id: "note-x",
        slug: "note-x",
        title: "x",
        type: "note",
        schema_version: 1,
        status: "active",
        file_path: "notes/x.md",
        content_hash: contentHash,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      });

    // Arm the index-write failpoint. The commit lands; refreshProjection is NEVER
    // reached, so the projection row is absent (stale) after the failure.
    fix.env.ATLAS_TEST_INDEX_WRITE_FAIL = "1";
    let projectionRan = 0;
    const before = fix.head();
    await expect(
      mutate({
        touchedPaths: ["notes/x.md"],
        apply: () => {
          mkdirSync(join(fix.dir, "notes"), { recursive: true });
          writeFileSync(join(fix.dir, "notes/x.md"), "body v1\n", "utf8");
        },
        refreshProjection: async () => {
          projectionRan++;
          projectNote(h("body v1\n"));
        },
      }),
    ).rejects.toMatchObject({ code: "index-write-failed" });
    expect(fix.head()).not.toBe(before); // the commit DID land
    expect(projectionRan).toBe(0); // projection NOT advanced ⇒ content_hash stale
    expect(fix.store.db.prepare(`SELECT 1 FROM notes WHERE note_id = 'note-x'`).get()).toBeUndefined();

    // The next clean run (the heal) advances the projection — no failpoint this time.
    delete fix.env.ATLAS_TEST_INDEX_WRITE_FAIL;
    await mutate({
      touchedPaths: ["notes/x2.md"],
      apply: () => writeFileSync(join(fix.dir, "notes/x2.md"), "second\n", "utf8"),
      refreshProjection: async () => {
        projectionRan++;
        projectNote(h("body v1\n"));
      },
    });
    expect(projectionRan).toBe(1); // healed
    expect(fix.store.db.prepare(`SELECT content_hash FROM notes WHERE note_id = 'note-x'`).get()).toMatchObject({
      content_hash: h("body v1\n"),
    });
  });

  it("git-only revert leaves the projection stale; re-deriving from the reverted tree restores it", async () => {
    const proj = new ProjectionRepo(fix.store.db);
    // Commit a note through the mutation order + project it.
    await mutate({
      touchedPaths: ["notes/g.md"],
      apply: () => {
        mkdirSync(join(fix.dir, "notes"), { recursive: true });
        writeFileSync(join(fix.dir, "notes/g.md"), "gone soon\n", "utf8");
      },
      refreshProjection: async () =>
        proj.insertNote({
          note_id: "g",
          slug: "g",
          title: "g",
          type: "note",
          schema_version: 1,
          status: "active",
          file_path: "notes/g.md",
          content_hash: h("gone soon\n"),
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        }),
    });
    expect(fix.store.db.prepare(`SELECT status FROM notes WHERE note_id = 'g'`).get()).toMatchObject({ status: "active" });

    // A GIT-ONLY revert removes the note from the tree — the projection is now stale.
    fix.git(["revert", "--no-edit", "HEAD"]);
    expect(existsSync(join(fix.dir, "notes/g.md"))).toBe(false);
    expect(fix.store.db.prepare(`SELECT status FROM notes WHERE note_id = 'g'`).get()).toMatchObject({ status: "active" });

    // Re-derive from the reverted HEAD (what `brain sync` does): the note resolves
    // to null at HEAD ⇒ archived, so the projection matches the tree again.
    foldNotesForPaths(fix.store, ["g"], () => null);
    expect(fix.store.db.prepare(`SELECT status FROM notes WHERE note_id = 'g'`).get()).toMatchObject({ status: "archived" });
  });
});
