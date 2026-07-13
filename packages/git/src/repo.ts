/**
 * `Repo` — the entry point of `@atlas/git`. A typed handle over the vault git
 * repository that exposes exactly the plumbing agents are allowed to perform:
 * read any ref (incl. protected), create/advance `refs/agent/*` branches, and
 * add/remove worktrees. Protected-ref *writes* are structurally impossible here
 * (see `refs.ts`) — those belong to the broker.
 */
import { resolve } from "node:path";
import { runGit } from "./exec.js";
import { agentRef, assertAgentRef, attachHeadToAgentRef, readRef, updateAgentRef } from "./refs.js";
import { makeWorktree, type Worktree } from "./worktree.js";

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
}

class RepoImpl implements Repo {
  constructor(readonly dir: string) {}

  readRef(name: string): Promise<string | null> {
    return readRef(this.dir, name);
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
}

/** Open a repository handle rooted at `dir`. Does not touch the filesystem. */
export function openRepo(dir: string): Repo {
  return new RepoImpl(resolve(dir));
}
