/**
 * dirty-vault.test.ts (#325) — the dirty-vault grounding doctrine.
 *
 * Reads + sync treat working-tree dirt as normal; a MUTATING command tolerates
 * UNRELATED dirt but fails grounding (exit 1) if any note it edits/names is dirty
 * — dirty being (an uncommitted git diff vs HEAD) OR (on-disk hash != projection
 * `content_hash`). Proven directly against {@link runMutation} over a REAL git
 * vault + a REAL migrated projection store (no daemon, no sandbox, no binary).
 *
 *   row a  — UNRELATED dirt (both kinds) present, the edited note CLEAN ⇒ the
 *            mutation succeeds and BOTH dirt kinds survive untouched.
 *   row b  — the target note has an uncommitted working-tree edit ⇒ exit 1.
 *   row b2 — the target note's on-disk hash != its projection content_hash ⇒ exit 1.
 *   row b3 — one of several named (source) notes is dirty ⇒ exit 1.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, ProjectionRepo, type Store } from "@atlas/sqlite-store";
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

function h(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

interface Fix {
  dir: string;
  repo: Repo;
  store: Store;
  git(args: string[]): string;
  ctx: RunContext;
  writeNote(rel: string, body: string): void;
  projectNote(rel: string, id: string, contentHash: string): void;
}

let fix: Fix;

beforeEach(() => {
  const dir = mkdtempSync(join("/tmp", "atlas-dirty-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "seed\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  const store = openStore({ path: ":memory:" });
  store.migrate();
  const proj = new ProjectionRepo(store.db);

  const ctx = { env: {}, withLock: (_s: unknown, fn: () => unknown) => fn() } as unknown as RunContext;

  fix = {
    dir,
    repo: openRepo(dir),
    store,
    git,
    ctx,
    writeNote(rel, body): void {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body, "utf8");
    },
    projectNote(rel, id, contentHash): void {
      proj.insertNote({
        note_id: id,
        slug: id,
        title: id,
        type: "note",
        schema_version: 1,
        status: "active",
        file_path: rel,
        content_hash: contentHash,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      });
    },
  };
});

afterEach(() => {
  try {
    fix.store.close();
  } catch {
    /* ignore */
  }
  rmSync(fix.dir, { recursive: true, force: true });
});

/** A trivial mutation that adds `touched.md`; `dirtyCheckPaths` is the notes it "edits/names". */
function mutation(dirtyCheckPaths: string[]): Promise<string> {
  return runMutation<string>({
    ctx: fix.ctx,
    repo: fix.repo,
    vaultPath: fix.dir,
    store: fix.store,
    ground(preApply): Grounded {
      preApply();
      return {
        touchedPaths: ["touched.md"],
        commitMessage: "mutation",
        affectedNoteIds: [],
        dirtyCheckPaths,
        apply(): void {
          writeFileSync(join(fix.dir, "touched.md"), "mutated\n", "utf8");
        },
      };
    },
    buildResult: (sha) => sha,
  });
}

async function expectDirty(paths: string[]): Promise<CliError> {
  try {
    await mutation(paths);
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe("dirty-vault");
    expect((e as CliError).exitCode).toBe(1);
    return e as CliError;
  }
  throw new Error("expected a dirty-vault refusal, but the mutation succeeded");
}

describe("dirty-vault grounding doctrine (#325)", () => {
  it("row a — unrelated dirt (both kinds) succeeds; the target note stays clean and dirt survives", async () => {
    // A CLEAN target note the mutation names: committed, projection hash matches.
    const clean = "notes/clean.md";
    fix.writeNote(clean, "clean body\n");
    fix.git(["add", "-A"]);
    fix.git(["commit", "-q", "-m", "add clean"]);
    fix.projectNote(clean, "clean", h("clean body\n"));

    // UNRELATED dirt kind 1: an uncommitted working-tree edit to a DIFFERENT note.
    const other = "notes/other.md";
    fix.writeNote(other, "committed\n");
    fix.git(["add", "-A"]);
    fix.git(["commit", "-q", "-m", "add other"]);
    writeFileSync(join(fix.dir, other), "edited on disk\n", "utf8");
    // UNRELATED dirt kind 2: a projection row whose content_hash drifts from disk.
    fix.projectNote(other, "other", "sha256:" + "0".repeat(64));

    const sha = await mutation([clean]);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // The commit landed AND the unrelated dirt is intact.
    expect(fix.git(["status", "--porcelain", "--", other])).not.toBe("");
  });

  it("row b — a dirty target (uncommitted working-tree edit) refuses exit 1", async () => {
    const t = "notes/target.md";
    fix.writeNote(t, "committed body\n");
    fix.git(["add", "-A"]);
    fix.git(["commit", "-q", "-m", "add target"]);
    fix.projectNote(t, "target", h("committed body\n"));
    writeFileSync(join(fix.dir, t), "uncommitted edit\n", "utf8"); // dirty!

    const err = await expectDirty([t]);
    expect(err.details).toMatchObject({ kind: "working-tree" });
  });

  it("row b2 — on-disk hash != projection content_hash refuses exit 1 (projection drift)", async () => {
    const t = "notes/drift.md";
    fix.writeNote(t, "the real body\n");
    fix.git(["add", "-A"]);
    fix.git(["commit", "-q", "-m", "add drift"]);
    // Working tree is CLEAN (committed), but the projection hash is stale.
    fix.projectNote(t, "drift", "sha256:" + "f".repeat(64));

    const err = await expectDirty([t]);
    expect(err.details).toMatchObject({ kind: "projection-drift" });
  });

  it("row b3 — one dirty note among several named (source) notes refuses exit 1", async () => {
    const a = "notes/a.md";
    const b = "notes/b.md";
    for (const [rel, body, id] of [[a, "a body\n", "a"], [b, "b body\n", "b"]] as const) {
      fix.writeNote(rel, body);
      fix.git(["add", "-A"]);
      fix.git(["commit", "-q", "-m", `add ${id}`]);
      fix.projectNote(rel, id, h(body));
    }
    // b is dirtied via a STAGED (index) change — still an uncommitted diff vs HEAD.
    writeFileSync(join(fix.dir, b), "b changed\n", "utf8");
    fix.git(["add", b]);

    await expectDirty([a, b]);
  });
});
