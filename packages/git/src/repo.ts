/**
 * `Repo` — the entry point of `@atlas/git`. A typed handle over the vault git
 * repository that exposes exactly the plumbing agents are allowed to perform:
 * read any ref (incl. protected), create/advance `refs/agent/*` branches, and
 * add/remove worktrees. Protected-ref *writes* are structurally impossible here
 * (see `refs.ts`) — those belong to the broker.
 */
import { resolve } from "node:path";
import { runGit, GitError } from "./exec.js";
import { agentRef, assertAgentRef, attachHeadToAgentRef, readRef, updateAgentRef } from "./refs.js";
import { makeWorktree, type Worktree } from "./worktree.js";

/**
 * A registered git worktree as reported by `git worktree list --porcelain`: its
 * absolute working-directory path, the commit its HEAD points at, and the ref its
 * HEAD is attached to (`branch`), or `null` when the worktree is detached.
 */
export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
}

export interface Repo {
  /** Absolute path to the repository working directory. */
  readonly dir: string;
  /**
   * Resolve `name` (ref/sha/commit-ish) to its commit SHA, or `null` if it does
   * not resolve. May target protected refs — reading them is permitted.
   */
  readRef(name: string): Promise<string | null>;
  /**
   * Create the agent branch `refs/agent/<runId>` pointing at `base` (any
   * commit-ish). Returns the fully-qualified ref name. Throws if `runId` is not
   * a ULID or `base` does not resolve.
   */
  createAgentBranch(runId: string, base: string): Promise<string>;
  /**
   * Add a worktree at `dir` checked out on `ref`, with HEAD attached to the ref
   * so subsequent commits advance it. `ref` must be an agent ref.
   */
  addWorktree(ref: string, dir: string): Promise<Worktree>;
  /** Remove the worktree at `dir` (also pruning its administrative metadata). */
  removeWorktree(dir: string): Promise<void>;
  /**
   * List the repository's registered worktrees (`git worktree list --porcelain`),
   * each with its absolute path and the ref its HEAD is attached to. Read-only.
   * `git cleanup` uses this to VERIFY a recorded worktree is actually bound to the
   * run's own `refs/agent/<runId>` before removing it, so a stale/corrupt ledger
   * `ref_name` can never force-remove an unrelated (e.g. open-run) worktree.
   */
  listWorktrees(): Promise<WorktreeEntry[]>;
  /**
   * Resolve the TREE object a commit-ish points at (`<commitish>^{tree}`), or
   * `null` if it does not resolve. Read-only; used by recovery to prove a recorded
   * commit's tree matches the tree hash captured at `worktree-applied`.
   */
  commitTree(commitish: string): Promise<string | null>;
  /**
   * `true` iff `ancestor` is an ancestor of `descendant` (or the same commit) —
   * `git merge-base --is-ancestor`. Read-only. Used by recovery to prove a recorded
   * commit is CONTAINED in a ref whose tip may have advanced beyond it: ref-tip
   * EQUALITY wrongly rejects a valid commit once a later commit is layered on top,
   * so containment must be tested by ancestry, not equality (round-2 finding W4).
   * Returns `false` if either commit-ish does not resolve.
   */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

class RepoImpl implements Repo {
  constructor(readonly dir: string) {}

  readRef(name: string): Promise<string | null> {
    return readRef(this.dir, name);
  }

  async commitTree(commitish: string): Promise<string | null> {
    try {
      return await runGit(this.dir, ["rev-parse", "--verify", "--quiet", `${commitish}^{tree}`]);
    } catch (err) {
      // Mirror readRef: only "does not resolve" (exit 1, empty stderr) becomes
      // `null`; every operational failure propagates rather than masquerading.
      if (err instanceof GitError && err.exitCode === 1 && err.stderr.trim() === "") return null;
      throw err;
    }
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    // Resolve both first so an unresolvable commit-ish is a clean `false` (per the
    // contract) rather than a `fatal: Not a valid commit name` (exit 128).
    if ((await readRef(this.dir, ancestor)) === null) return false;
    if ((await readRef(this.dir, descendant)) === null) return false;
    try {
      await runGit(this.dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true; // exit 0 ⇒ ancestor (or identical)
    } catch (err) {
      // exit 1 ⇒ NOT an ancestor (the documented negative). Anything else is an
      // operational failure and propagates rather than masquerading as `false`.
      if (err instanceof GitError && err.exitCode === 1) return false;
      throw err;
    }
  }

  async createAgentBranch(runId: string, base: string): Promise<string> {
    const ref = agentRef(runId);
    const baseSha = await readRef(this.dir, base);
    if (baseSha === null) {
      throw new Error(`base "${base}" does not resolve to a commit`);
    }
    await updateAgentRef(this.dir, ref, baseSha);
    return ref;
  }

  async addWorktree(ref: string, dir: string): Promise<Worktree> {
    // Reject non-agent refs up front so a protected ref can never even create a
    // (detached) worktree — otherwise the later HEAD-attach guard would throw
    // only after `git worktree add` had already left an orphaned worktree on disk.
    assertAgentRef(ref);
    const worktreeDir = resolve(dir);
    // Detached checkout at the ref's commit, then re-attach HEAD to the agent
    // ref (guarded) so commits land on `refs/agent/<runId>` rather than a
    // detached HEAD. `--detach` avoids git auto-creating a `refs/heads/` branch.
    await runGit(this.dir, ["worktree", "add", "--detach", worktreeDir, ref]);
    try {
      await attachHeadToAgentRef(worktreeDir, ref);
    } catch (err) {
      // The worktree is registered + on disk but its HEAD is still detached.
      // Roll it back so a failed add leaves no half-attached worktree behind
      // for the reconciler to trip over. Best-effort: if cleanup itself fails
      // we still surface the original attachment error (the primary failure).
      try {
        await this.removeWorktree(worktreeDir);
      } catch {
        // swallow — original error is the one worth reporting
      }
      throw err;
    }
    return makeWorktree(worktreeDir, ref);
  }

  async removeWorktree(dir: string): Promise<void> {
    await runGit(this.dir, ["worktree", "remove", "--force", resolve(dir)]);
  }

  async listWorktrees(): Promise<WorktreeEntry[]> {
    // `--porcelain` emits one attribute per line, records separated by a blank
    // line: `worktree <abspath>`, then `HEAD <sha>`, then either `branch <ref>`
    // (HEAD attached to that ref) or `detached`.
    const out = await runGit(this.dir, ["worktree", "list", "--porcelain"]);
    const entries: WorktreeEntry[] = [];
    let cur: { path: string; head: string | null; branch: string | null } | null = null;
    const flush = (): void => {
      if (cur !== null) entries.push({ path: resolve(cur.path), head: cur.head, branch: cur.branch });
      cur = null;
    };
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        flush();
        cur = { path: line.slice("worktree ".length), head: null, branch: null };
      } else if (cur !== null && line.startsWith("HEAD ")) {
        cur.head = line.slice("HEAD ".length);
      } else if (cur !== null && line.startsWith("branch ")) {
        cur.branch = line.slice("branch ".length);
      }
    }
    flush();
    return entries;
  }
}

/** Open a repository handle rooted at `dir`. Does not touch the filesystem. */
export function openRepo(dir: string): Repo {
  return new RepoImpl(resolve(dir));
}
