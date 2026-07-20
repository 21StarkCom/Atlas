/**
 * OQ#5 divergence detection — unit tests over `detectDivergence` + the git
 * helpers directly (60-B Task 4.3). The cycle-level HALT assertions (exit 2,
 * cursor/ref unmoved) live in sync-cycle.test.ts once the engine exists —
 * each task's green depends only on completed tasks.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRepo, type Repo } from "@atlas/git";
import { detectDivergence, countBehind } from "../src/sync/diff.js";

const cleanups: string[] = [];
afterAll(async () => {
  for (const d of cleanups) await rm(d, { recursive: true, force: true });
});

interface Fixture {
  readonly dir: string;
  readonly repo: Repo;
  readonly git: (args: string[]) => string;
  /** OIDs of the linear history, oldest first. */
  readonly oids: string[];
}

/** A linear main history with `n` commits (c0..c(n-1)), each touching notes/n<i>.md. */
async function linearFixture(n = 3): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "atlas-sync-divergence-"));
  cleanups.push(dir);
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Atlas Fixture"]);
  git(["config", "user.email", "fixtures@atlas.local"]);
  git(["config", "commit.gpgsign", "false"]);
  const oids: string[] = [];
  for (let i = 0; i < n; i++) {
    await writeFile(join(dir, `n${i}.md`), `---\nid: n${i}\n---\nbody ${i}\n`);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", `c${i}`]);
    oids.push(git(["rev-parse", "HEAD"]));
  }
  return { dir, repo: openRepo(dir), git, oids };
}

describe("detectDivergence (OQ#5 pre-diff guard)", () => {
  it("ancestral cursor ⇒ ok", async () => {
    const f = await linearFixture(3);
    const head = f.oids[2]!;
    expect(await detectDivergence(f.repo, f.oids[0]!, head)).toEqual({ state: "ok" });
    expect(await detectDivergence(f.repo, head, head)).toEqual({ state: "ok" });
  });

  it("null cursor ⇒ ok (zero-state, not divergence)", async () => {
    const f = await linearFixture(1);
    expect(await detectDivergence(f.repo, null, f.oids[0]!)).toEqual({ state: "ok" });
  });

  it("force-push to a rewritten history ⇒ non-ancestral", async () => {
    const f = await linearFixture(2);
    const cursor = f.oids[1]!;
    // Rewrite: hard-reset to c0 and commit a DIFFERENT c1' — cursor no longer an ancestor.
    f.git(["reset", "--hard", f.oids[0]!]);
    await writeFile(join(f.dir, "n1.md"), `---\nid: n1\n---\nrewritten\n`);
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "c1-rewritten"]);
    const newHead = f.git(["rev-parse", "HEAD"]);
    const d = await detectDivergence(f.repo, cursor, newHead);
    expect(d).toEqual({ state: "non-ancestral", cursorOid: cursor, upstreamHead: newHead });
  });

  it("gc'd cursor commit ⇒ cursor-unreachable", async () => {
    const f = await linearFixture(2);
    const cursor = f.oids[1]!;
    // Drop c1 from reachability, expire everything, prune: the OID stops resolving.
    f.git(["reset", "--hard", f.oids[0]!]);
    f.git(["reflog", "expire", "--expire=now", "--all"]);
    f.git(["gc", "--prune=now", "--quiet"]);
    const head = f.git(["rev-parse", "HEAD"]);
    const d = await detectDivergence(f.repo, cursor, head);
    expect(d).toEqual({ state: "cursor-unreachable", cursorOid: cursor, upstreamHead: head });
  });

  it("ours-merge revert (cursor ancestor via the SECOND parent, off the first-parent chain) ⇒ non-ancestral", async () => {
    // #289 review MAJOR repro: C0→C1 absorbed (cursor=C1); upstream reverts C1
    // WITHOUT a force-push via `reset --hard C0 && merge -s ours C1`. C1 is still
    // an ANY-parent ancestor of the merge M (via M's second parent), so a plain
    // merge-base --is-ancestor check says "ok" — but M's FIRST-PARENT diff back to
    // C0 is empty, so the delta walk would absorb nothing and silently advance the
    // cursor, leaving canonical permanently diverged. The first-parent anchor
    // check must classify this as a divergence → REJECT.
    const f = await linearFixture(2); // c0, c1
    const cursor = f.oids[1]!;
    f.git(["reset", "--hard", f.oids[0]!]);
    f.git(["merge", "-s", "ours", "--no-edit", cursor]); // M: first parent C0, second parent C1
    const head = f.git(["rev-parse", "HEAD"]);
    // Sanity: C1 IS an any-parent ancestor of M (so a bare isAncestor check passes).
    expect(await f.repo.isAncestor(cursor, head)).toBe(true);
    const d = await detectDivergence(f.repo, cursor, head);
    expect(d).toEqual({ state: "non-ancestral", cursorOid: cursor, upstreamHead: head });
  });

  it("a normal merge whose cursor IS on the first-parent chain stays ok (no false REJECT)", async () => {
    const f = await linearFixture(2); // c0, c1 (cursor = c1, on main's first-parent line)
    const cursor = f.oids[1]!;
    // Side branch off c1, merged back into main with --no-ff: c1 stays first-parent.
    f.git(["checkout", "-q", "-b", "side", cursor]);
    await writeFile(join(f.dir, "s.md"), "---\nid: s\n---\ns\n");
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "s"]);
    f.git(["checkout", "-q", "main"]);
    f.git(["merge", "-q", "--no-ff", "--no-edit", "side"]);
    const head = f.git(["rev-parse", "main"]);
    const d = await detectDivergence(f.repo, cursor, head);
    expect(d).toEqual({ state: "ok" });
  });
});

describe("countBehind (first-parent behindBy)", () => {
  it("counts the range cursor..head, zero when caught up", async () => {
    const f = await linearFixture(3);
    expect(await countBehind(f.repo, f.oids[0]!, f.oids[2]!)).toBe(2);
    expect(await countBehind(f.repo, f.oids[2]!, f.oids[2]!)).toBe(0);
  });

  it("zero-state counts the full first-parent chain", async () => {
    const f = await linearFixture(3);
    expect(await countBehind(f.repo, null, f.oids[2]!)).toBe(3);
  });

  it("counts merges as ONE first-parent step (matches the dispatch walk)", async () => {
    const f = await linearFixture(2);
    // Side branch off c0 with two commits, merged into main: first-parent sees 1 merge commit.
    f.git(["checkout", "-q", "-b", "side", f.oids[0]!]);
    await writeFile(join(f.dir, "s1.md"), "---\nid: s1\n---\ns1\n");
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "s1"]);
    await writeFile(join(f.dir, "s2.md"), "---\nid: s2\n---\ns2\n");
    f.git(["add", "-A"]);
    f.git(["commit", "-q", "-m", "s2"]);
    f.git(["checkout", "-q", "main"]);
    f.git(["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const head = f.git(["rev-parse", "HEAD"]);
    // c1..head first-parent = just the merge commit.
    expect(await countBehind(f.repo, f.oids[1]!, head)).toBe(1);
  });
});
