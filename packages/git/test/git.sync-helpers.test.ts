/**
 * `git.sync-helpers.test` — the three read-only sync-cycle helpers on `Repo`
 * (Phase 4, #60): `readBlobAt` (byte-exact committed blob), `commitsInRange`
 * (first-parent walk + normalized name-status), `changedPaths` (net tree diff).
 *
 * Contract points locked here:
 *  - `null` means ONLY "does not resolve" (readBlobAt); operational failures
 *    (non-repo dir) propagate as GitError — the package convention.
 *  - Byte-exactness: trailing newline + non-utf8 bytes survive (runGit's
 *    trim+utf8 path would destroy both — hence runGitBuffer).
 *  - First-parent semantics: a merge's second-parent work appears as the MERGE
 *    commit's change set; side-branch commits never appear in the walk.
 *  - Fail-closed status normalization: R→R(+fromPath), T→M; every commit in a
 *    range is returned even when pathspec-filtered to `changes: []`.
 *  - `-z` NUL parsing: paths with spaces/quotes arrive unmangled (no C-quoting).
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError } from "../src/exec.js";
import * as publicApi from "../src/index.js";
import { openRepo } from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atlas-git-sync-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Atlas Fixture"]);
  git(["config", "user.email", "fixtures@atlas.local"]);
  git(["config", "commit.gpgsign", "false"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Write `rel` (creating parent dirs), stage everything, commit; return the new HEAD oid. */
async function commit(rel: string, content: string | Buffer, msg: string): Promise<string> {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}

const NOTES_GLOB = [":(glob)notes/**/*.md"];

describe("readBlobAt — byte-exact committed blob reads", () => {
  it("returns the exact bytes, trailing newline included", async () => {
    const oid = await commit("notes/a.md", "alpha body\n", "add a");
    const blob = await openRepo(dir).readBlobAt(oid, "notes/a.md");
    // toString would hide a trimmed trailing newline; compare raw bytes.
    expect(blob).not.toBeNull();
    expect(blob!.equals(Buffer.from("alpha body\n", "utf8"))).toBe(true);
  });

  it("returns non-utf8 bytes intact (0xFF survives round-trip)", async () => {
    const raw = Buffer.from([0x62, 0x69, 0x6e, 0x00, 0xff, 0xfe, 0x0a]);
    const oid = await commit("bin.dat", raw, "add binary");
    const blob = await openRepo(dir).readBlobAt(oid, "bin.dat");
    // A utf8 decode would have replaced 0xFF/0xFE with U+FFFD; byte equality
    // proves the buffer-mode exec path is truly lossless.
    expect(blob!.equals(raw)).toBe(true);
  });

  it("returns null for a path absent from the commit", async () => {
    const oid = await commit("notes/a.md", "x\n", "add a");
    expect(await openRepo(dir).readBlobAt(oid, "notes/nope.md")).toBeNull();
  });

  it("binds to committed state: a worktree-only file is null", async () => {
    const oid = await commit("notes/a.md", "x\n", "add a");
    await writeFile(join(dir, "wt-only.md"), "never committed\n");
    // git's wording here is "exists on disk, but not in '<oid>'" — still an
    // unresolved *committed* path, so it must classify to null, not throw.
    expect(await openRepo(dir).readBlobAt(oid, "wt-only.md")).toBeNull();
  });

  it("returns null for an unresolvable commit oid", async () => {
    await commit("notes/a.md", "x\n", "add a");
    expect(await openRepo(dir).readBlobAt("deadbeef".repeat(5), "notes/a.md")).toBeNull();
  });

  it("propagates GitError for a non-repo dir (never masquerades as absence)", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "atlas-git-sync-norepo-"));
    try {
      await expect(openRepo(notARepo).readBlobAt("HEAD", "x.md")).rejects.toBeInstanceOf(GitError);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

describe("commitsInRange — first-parent walk", () => {
  it("walks oldest→newest from the root when from is null, root additions included", async () => {
    const c1 = await commit("notes/a.md", "v1\n", "c1");
    const c2 = await commit("notes/a.md", "v2\n", "c2");
    await unlink(join(dir, "notes/a.md"));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "c3"]);
    const c3 = git(["rev-parse", "HEAD"]);

    const result = await openRepo(dir).commitsInRange(null, "main", []);
    expect(result.map((c) => c.oid)).toEqual([c1, c2, c3]);
    expect(result[0]!.changes).toEqual([{ status: "A", path: "notes/a.md" }]);
    expect(result[1]!.changes).toEqual([{ status: "M", path: "notes/a.md" }]);
    expect(result[2]!.changes).toEqual([{ status: "D", path: "notes/a.md" }]);
  });

  it("detects a rename as R with fromPath", async () => {
    await commit("notes/old.md", "same content, exact rename\n", "add old");
    git(["mv", "notes/old.md", "notes/new.md"]);
    git(["commit", "-q", "-m", "rename"]);
    const head = git(["rev-parse", "HEAD"]);

    const result = await openRepo(dir).commitsInRange(null, "main", []);
    const renameCommit = result.find((c) => c.oid === head);
    expect(renameCommit!.changes).toEqual([
      { status: "R", path: "notes/new.md", fromPath: "notes/old.md" },
    ]);
  });

  it("normalizes a typechange (file → symlink) to M", async () => {
    await commit("notes/link.md", "regular file\n", "add file");
    await unlink(join(dir, "notes/link.md"));
    await symlink("target-elsewhere.md", join(dir, "notes/link.md"));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "typechange"]);
    const head = git(["rev-parse", "HEAD"]);

    const result = await openRepo(dir).commitsInRange(null, "main", []);
    const tc = result.find((c) => c.oid === head);
    expect(tc!.changes).toEqual([{ status: "M", path: "notes/link.md" }]);
  });

  it("diffs a merge commit against its FIRST parent only, and never walks side-branch commits", async () => {
    const base = await commit("notes/base.md", "base\n", "base");
    // Side branch: one commit adding feat.md.
    git(["checkout", "-q", "-b", "feat"]);
    const f1 = await commit("notes/feat.md", "feature work\n", "F1");
    // Advance main independently, then merge the side branch (a real 2-parent merge).
    git(["checkout", "-q", "main"]);
    const m2 = await commit("notes/main2.md", "mainline\n", "M2");
    git(["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]);
    const mc = git(["rev-parse", "HEAD"]);

    const result = await openRepo(dir).commitsInRange(null, "main", []);
    // First-parent walk: base → M2 → merge. F1 itself is invisible…
    expect(result.map((c) => c.oid)).toEqual([base, m2, mc]);
    expect(result.map((c) => c.oid)).not.toContain(f1);
    // …but its content surfaces as the MERGE commit's first-parent diff.
    const merge = result.find((c) => c.oid === mc);
    expect(merge!.changes).toEqual([{ status: "A", path: "notes/feat.md" }]);
  });

  it("filters by :(glob) pathspec; a non-matching commit still appears with empty changes", async () => {
    const c1 = await commit("notes/a.md", "note\n", "c1");
    const c2 = await commit("docs/x.md", "doc\n", "c2 docs only");

    const result = await openRepo(dir).commitsInRange(null, "main", NOTES_GLOB);
    // Every commit boundary is returned — the sync cursor advances per commit —
    // but c2's changes are filtered to nothing.
    expect(result.map((c) => c.oid)).toEqual([c1, c2]);
    expect(result[0]!.changes).toEqual([{ status: "A", path: "notes/a.md" }]);
    expect(result[1]!.changes).toEqual([]);
    expect(result.flatMap((c) => c.changes.map((ch) => ch.path))).not.toContain("docs/x.md");
  });

  it("from..to subrange excludes `from` and everything before it", async () => {
    const c1 = await commit("notes/a.md", "v1\n", "c1");
    const c2 = await commit("notes/a.md", "v2\n", "c2");
    const c3 = await commit("notes/b.md", "b\n", "c3");

    const result = await openRepo(dir).commitsInRange(c1, c3, []);
    expect(result.map((c) => c.oid)).toEqual([c2, c3]);
  });

  it("returns [] for an empty range (from === to)", async () => {
    const c1 = await commit("notes/a.md", "v1\n", "c1");
    expect(await openRepo(dir).commitsInRange(c1, c1, [])).toEqual([]);
  });
});

describe("changedPaths — net tree-vs-tree diff", () => {
  it("nets A/M/D/R across intermediate commits", async () => {
    await commit("notes/keep.md", "v1\n", "base 1");
    await commit("notes/gone.md", "delete me\n", "base 2");
    const from = await commit("notes/moving.md", "stable content for rename\n", "base 3");
    // Churn across several commits…
    await commit("notes/keep.md", "v2\n", "modify keep");
    await unlink(join(dir, "notes/gone.md"));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "delete gone"]);
    git(["mv", "notes/moving.md", "notes/moved.md"]);
    git(["commit", "-q", "-m", "rename moving"]);
    const to = await commit("notes/fresh.md", "brand new\n", "add fresh");

    const result = await openRepo(dir).changedPaths(from, to, []);
    expect(result).toEqual(
      expect.arrayContaining([
        { status: "M", path: "notes/keep.md" },
        { status: "D", path: "notes/gone.md" },
        { status: "R", path: "notes/moved.md", fromPath: "notes/moving.md" },
        { status: "A", path: "notes/fresh.md" },
      ]),
    );
    expect(result).toHaveLength(4);
  });

  it("modify-then-revert nets to no entry", async () => {
    const from = await commit("notes/a.md", "original\n", "base");
    await commit("notes/a.md", "tampered\n", "modify");
    const to = await commit("notes/a.md", "original\n", "revert");
    expect(await openRepo(dir).changedPaths(from, to, [])).toEqual([]);
  });

  it("applies the :(glob) pathspec filter", async () => {
    const from = await commit("notes/a.md", "v1\n", "base");
    await commit("docs/x.md", "doc\n", "docs change");
    const to = await commit("notes/a.md", "v2\n", "notes change");

    const result = await openRepo(dir).changedPaths(from, to, NOTES_GLOB);
    expect(result).toEqual([{ status: "M", path: "notes/a.md" }]);
  });
});

describe("NUL-safe path parsing", () => {
  // Without -z, git C-quotes this into `"notes/we ird \"quoted\" name.md"` and
  // any line-oriented parse mangles it; the -z parser must hand it back verbatim.
  const WEIRD = 'notes/we ird "quoted" name.md';

  it("a filename with spaces and a quote character survives the walk verbatim", async () => {
    const oid = await commit(WEIRD, "odd but legal\n", "weird name");
    const result = await openRepo(dir).commitsInRange(null, "main", []);
    expect(result.find((c) => c.oid === oid)!.changes).toEqual([{ status: "A", path: WEIRD }]);
    // And the parsed path round-trips into a byte-exact blob read.
    const blob = await openRepo(dir).readBlobAt(oid, WEIRD);
    expect(blob!.toString("utf8")).toBe("odd but legal\n");
  });

  it("…and survives the net diff too", async () => {
    const from = await commit("notes/a.md", "x\n", "base");
    const to = await commit(WEIRD, "odd\n", "weird add");
    expect(await openRepo(dir).changedPaths(from, to, [])).toEqual([
      { status: "A", path: WEIRD },
    ]);
  });
});

describe("changedStatusesInRange — RAW-status, ALL-REACHABLE range inspection (mirrors the broker)", () => {
  it("keeps RAW status letters (T is NOT folded to M)", async () => {
    await commit("notes/a.md", "regular file\n", "base");
    const base = git(["rev-parse", "HEAD"]);
    // Replace the regular file with a symlink at the same path ⇒ git reports `T`.
    await unlink(join(dir, "notes/a.md"));
    await symlink("b.md", join(dir, "notes/a.md"));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "typechange"]);
    const to = git(["rev-parse", "HEAD"]);
    const changes = await openRepo(dir).changedStatusesInRange(base, to);
    // The normalized `commitsInRange` would report `M`; the raw inspection keeps `T`.
    expect(changes).toEqual([{ status: "T", path: "notes/a.md" }]);
  });

  it("sees a change made AND REVERTED on a MERGED SIDE BRANCH that a first-parent walk misses", async () => {
    const base = await commit("notes/main.md", "main\n", "base");
    // Side branch off base ADDS then DELETES a path — net-nothing, so the merge's net
    // tree (and its first-parent diff) never shows it, but every commit of the branch
    // DID touch it. This is the exact first-parent blind spot the raw all-reachable
    // walk closes.
    git(["checkout", "-q", "-b", "side"]);
    await commit("sources/smuggled.md", "smuggled\n", "side add");
    await unlink(join(dir, "sources/smuggled.md"));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "side revert"]);
    const sideOid = git(["rev-parse", "HEAD"]);
    // Back on main, a mainline commit, then a no-ff merge of the side branch.
    git(["checkout", "-q", "main"]);
    await commit("notes/more.md", "more\n", "mainline more");
    git(["merge", "--no-ff", "-q", "-m", "merge side", sideOid]);
    const merge = git(["rev-parse", "HEAD"]);

    // First-parent walk: the reverted side path never appears.
    const firstParent = (await openRepo(dir).commitsInRange(base, merge, [])).flatMap((c) => c.changes.map((ch) => ch.path));
    expect(firstParent).not.toContain("sources/smuggled.md");
    // All-reachable raw inspection: the side-branch add/delete surfaces.
    const allReachable = (await openRepo(dir).changedStatusesInRange(base, merge)).map((e) => e.path);
    expect(allReachable).toContain("sources/smuggled.md");
  });

  it("reports BOTH sides of a rename under the raw R letter (not a normalized fromPath)", async () => {
    const base = await commit("notes/old.md", "content that is long enough to detect a rename cleanly\n", "base");
    await unlink(join(dir, "notes/old.md"));
    await writeFile(join(dir, "notes/new.md"), "content that is long enough to detect a rename cleanly\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "rename"]);
    const to = git(["rev-parse", "HEAD"]);
    const changes = await openRepo(dir).changedStatusesInRange(base, to);
    expect(changes).toContainEqual({ status: "R", path: "notes/old.md" });
    expect(changes).toContainEqual({ status: "R", path: "notes/new.md" });
  });

  it("from=null inspects the whole reachable history (unborn-canonical parity)", async () => {
    await commit("notes/a.md", "a\n", "first");
    await commit("notes/b.md", "b\n", "second");
    const paths = (await openRepo(dir).changedStatusesInRange(null, "main")).map((e) => e.path).sort();
    expect(paths).toEqual(["notes/a.md", "notes/b.md"]);
  });
});

describe("public surface", () => {
  it("does not leak runGitBuffer (nor runGit) from the barrel", () => {
    // Companion to git.no-protected-write.test's runGit lock: the buffer-mode
    // executor is the same raw-argv escape hatch and must stay internal.
    expect(Object.keys(publicApi)).not.toContain("runGitBuffer");
    expect(Object.keys(publicApi)).not.toContain("runGit");
  });
});
