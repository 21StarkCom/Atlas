/**
 * `git.commit-paths.test` — focused unit tests for the `commitPaths` primitive:
 * a pathspec-scoped stage-then-commit that (1) commits exactly the touched
 * paths while leaving unrelated pre-staged entries intact, and (2) restores the
 * touched index entries — and only those — when the commit fails.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitPaths, openRepo } from "../src/index.js";

/** Stand up a minimal one-commit git repo in a temp dir; return its path. */
async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atlas-git-commit-paths-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Atlas Fixture"]);
  git(["config", "user.email", "fixtures@atlas.local"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "# fixture\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture: initial"]);
  return dir;
}

let repoDir: string;

beforeEach(async () => {
  repoDir = await makeFixtureRepo();
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();

/** Files whose index entry differs from HEAD (`git diff --cached --name-only`). */
function stagedPaths(): string[] {
  const out = git(["diff", "--cached", "--name-only"]);
  return out === "" ? [] : out.split("\n");
}

/** Files present on disk but unknown to git (`git ls-files --others --exclude-standard`). */
function untrackedPaths(): string[] {
  const out = git(["ls-files", "--others", "--exclude-standard"]);
  return out === "" ? [] : out.split("\n");
}

describe("commitPaths", () => {
  it("commits exactly the touched path and leaves an unrelated pre-staged file intact", async () => {
    const repo = openRepo(repoDir);

    // Pre-stage an UNRELATED file that commitPaths must not touch.
    await writeFile(join(repoDir, "unrelated.md"), "unrelated staged content\n");
    git(["add", "--", "unrelated.md"]);
    expect(stagedPaths()).toEqual(["unrelated.md"]);

    // A CreateNote-style untracked file is the only path we ask to commit.
    await mkdir(join(repoDir, "notes"), { recursive: true });
    await writeFile(join(repoDir, "notes/alpha.md"), "# alpha\n");
    const before = git(["rev-parse", "HEAD"]);

    const sha = await commitPaths(repo, ["notes/alpha.md"], "add alpha note");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe(before);

    // The commit advanced HEAD and contains EXACTLY the touched path.
    expect(git(["rev-parse", "HEAD"])).toBe(sha);
    const committed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    expect(committed.split("\n")).toEqual(["notes/alpha.md"]);

    // The unrelated pre-staged file is STILL staged and STILL intact (not committed).
    expect(stagedPaths()).toEqual(["unrelated.md"]);
    expect(git(["show", ":unrelated.md"])).toBe("unrelated staged content");

    // Deterministic authorship (author AND committer), matching worktree commits.
    const identity = (fmt: string) => git(["show", "-s", `--format=${fmt}`, sha]);
    expect(identity("%an <%ae>")).toBe("Aryeh Stark <aryeh@21stark.com>");
    expect(identity("%cn <%ce>")).toBe("Aryeh Stark <aryeh@21stark.com>");
    expect(git(["show", "-s", "--format=%s", sha])).toBe("add alpha note");
  });

  it("stages and commits an edit and a deletion together", async () => {
    const repo = openRepo(repoDir);

    // Seed two tracked files in a base commit.
    await writeFile(join(repoDir, "keep.md"), "v1\n");
    await writeFile(join(repoDir, "gone.md"), "doomed\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);

    // Edit one, delete the other — both unstaged working-tree changes.
    await writeFile(join(repoDir, "keep.md"), "v2\n");
    await rm(join(repoDir, "gone.md"));

    const sha = await commitPaths(repo, ["keep.md", "gone.md"], "edit + delete");
    const names = git(["diff-tree", "--no-commit-id", "--name-status", "-r", sha]).split("\n").sort();
    expect(names).toEqual(["D\tgone.md", "M\tkeep.md"].sort());
    expect(git(["show", `${sha}:keep.md`])).toBe("v2");
    // The deletion landed: the path no longer resolves in the new tree.
    expect(() => git(["cat-file", "-e", `${sha}:gone.md`])).toThrow();
  });

  it("restores the touched index on commit failure and never disturbs unrelated staged entries", async () => {
    const repo = openRepo(repoDir);

    // Pre-stage an unrelated file.
    await writeFile(join(repoDir, "unrelated.md"), "keep me staged\n");
    git(["add", "--", "unrelated.md"]);

    // A pre-commit hook that always fails forces the commit to error AFTER our
    // `git add` has already staged the touched path.
    const hookDir = join(repoDir, ".git", "hooks");
    const hook = join(hookDir, "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await mkdir(join(repoDir, "notes"), { recursive: true });
    await writeFile(join(repoDir, "notes/alpha.md"), "# alpha\n");
    const headBefore = git(["rev-parse", "HEAD"]);

    await expect(commitPaths(repo, ["notes/alpha.md"], "will fail")).rejects.toThrow();

    // HEAD did not move — no commit landed.
    expect(git(["rev-parse", "HEAD"])).toBe(headBefore);

    // The touched path is restored to its pre-stage state: back to untracked,
    // not lingering in the index.
    expect(stagedPaths()).toEqual(["unrelated.md"]);
    expect(untrackedPaths()).toContain("notes/alpha.md");

    // The unrelated pre-staged entry was never disturbed.
    expect(git(["show", ":unrelated.md"])).toBe("keep me staged");
  });

  it("restores the exact pre-call index blob (v2, not HEAD's v1) on commit failure", async () => {
    const repo = openRepo(repoDir);

    // A tracked file committed at v1 (this is HEAD's blob).
    await writeFile(join(repoDir, "doc.md"), "v1\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "doc v1"]);

    // Another actor stages v2 into the index — this is the PRE-CALL index state
    // commitPaths must preserve. It differs from BOTH HEAD (v1) and the working
    // tree (v3 below), so a rollback that merely resets to HEAD would fail here.
    await writeFile(join(repoDir, "doc.md"), "v2\n");
    git(["add", "--", "doc.md"]);
    expect(git(["show", ":doc.md"])).toBe("v2");

    // Fail the commit via a pre-commit hook.
    const hook = join(repoDir, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    // Working-tree edit to v3 that commitPaths will `git add` (staging v3) then
    // fail to commit. Use the `./doc.md` spelling so the snapshot/restore key
    // canonicalization is exercised end-to-end.
    await writeFile(join(repoDir, "doc.md"), "v3\n");

    await expect(commitPaths(repo, ["./doc.md"], "v3")).rejects.toThrow();

    // The index entry is restored to the EXACT pre-call blob (v2), not reset to
    // HEAD's v1 and not left at the v3 that `git add` staged.
    expect(git(["show", ":doc.md"])).toBe("v2");
  });

  it("restores every descendant of a directory pathspec on commit failure", async () => {
    const repo = openRepo(repoDir);

    // Seed a directory with ONE pre-existing tracked file committed at v1.
    await mkdir(join(repoDir, "notes"), { recursive: true });
    await writeFile(join(repoDir, "notes/existing.md"), "existing v1\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed notes/existing.md"]);

    // Pre-stage an unrelated file that must survive untouched.
    await writeFile(join(repoDir, "unrelated.md"), "keep me staged\n");
    git(["add", "--", "unrelated.md"]);

    // Working-tree changes under the directory: EDIT the pre-existing descendant
    // and CREATE a brand-new descendant. A `notes/` pathspec stages BOTH.
    await writeFile(join(repoDir, "notes/existing.md"), "existing v2\n");
    await writeFile(join(repoDir, "notes/fresh.md"), "# fresh\n");

    // Force the commit to fail after `git add notes/` has staged both descendants.
    const hook = join(repoDir, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    const headBefore = git(["rev-parse", "HEAD"]);
    await expect(commitPaths(repo, ["notes/"], "will fail")).rejects.toThrow();

    // No commit landed.
    expect(git(["rev-parse", "HEAD"])).toBe(headBefore);

    // The pre-existing descendant is restored to its pre-stage (HEAD) blob — the
    // staged v2 edit is gone, not lingering in the index.
    expect(stagedPaths()).toEqual(["unrelated.md"]);
    expect(git(["show", ":notes/existing.md"])).toBe("existing v1");

    // The newly-added descendant is force-removed back to untracked (the bug:
    // a `notes/` lookup would have missed it and left it staged).
    expect(untrackedPaths()).toContain("notes/fresh.md");

    // The unrelated pre-staged entry was never disturbed.
    expect(git(["show", ":unrelated.md"])).toBe("keep me staged");
  });

  it("treats a metacharacter filename literally (no pathspec magic)", async () => {
    const repo = openRepo(repoDir);

    // A file whose NAME contains git pathspec metacharacters. Without
    // --literal-pathspecs, `*` would glob and `:(exclude)`-like prefixes would
    // parse as magic; here it must be staged/committed as this exact literal.
    const literalName = "weird[ab]*.md";
    await writeFile(join(repoDir, literalName), "literal star bracket\n");

    // A decoy the glob `weird[ab]*.md` (or `a*.md`) would otherwise sweep in.
    await writeFile(join(repoDir, "wearied.md"), "decoy that a glob might catch\n");

    const sha = await commitPaths(repo, [literalName], "add literal-named note");

    // EXACTLY the literal-named file is committed; the decoy is untouched.
    const committed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    expect(committed.split("\n")).toEqual([literalName]);
    expect(untrackedPaths()).toContain("wearied.md");
  });

  it("throws on an empty path list", async () => {
    const repo = openRepo(repoDir);
    await expect(commitPaths(repo, [], "nothing")).rejects.toThrow(/at least one path/);
  });

  it("refuses an unmerged path and leaves the conflict entries byte-identical", async () => {
    // Round-3 finding: running through a conflict would collapse its
    // stage-1/2/3 entries to a single stage-0 entry on rollback, destroying
    // the conflict state. The primitive must refuse up front instead.
    const repo = openRepo(repoDir);

    // Both-added conflict: `conflict.md` created differently on two branches.
    git(["checkout", "-q", "-b", "side"]);
    await writeFile(join(repoDir, "conflict.md"), "side version\n");
    git(["add", "--", "conflict.md"]);
    git(["commit", "-q", "-m", "side: add conflict.md"]);
    git(["checkout", "-q", "main"]);
    await writeFile(join(repoDir, "conflict.md"), "main version\n");
    git(["add", "--", "conflict.md"]);
    git(["commit", "-q", "-m", "main: add conflict.md"]);
    try {
      git(["merge", "side"]); // exits nonzero on the conflict — expected
    } catch {
      /* conflict is the point */
    }
    const conflictEntries = git(["ls-files", "-u"]);
    expect(conflictEntries).not.toBe(""); // sanity: the merge really conflicted

    await expect(commitPaths(repo, ["conflict.md"], "must refuse")).rejects.toThrow(/unmerged/);

    // The conflict's staged entries (all stages) survive byte-identical.
    expect(git(["ls-files", "-u"])).toBe(conflictEntries);
  });
});
