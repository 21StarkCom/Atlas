/**
 * A git worktree bound to an agent ref, with the one write operation agents
 * perform: {@link Worktree.commit} — stage the working tree and record an agent
 * commit carrying the run-manifest trailer, advancing `refs/agent/<runId>`.
 */
import type { RunManifest } from "@atlas/contracts";
import { runGit } from "./exec.js";
import { buildCommitMessage, parseManifestTrailer } from "./commit.js";

/**
 * Deterministic identity stamped on agent commits. Under the v2 in-process cutover
 * (ADR-0003) the agent commit is FF-installed DIRECTLY onto the canonical ref (the
 * retired broker no longer re-authors an audit commit over it), so it must carry the
 * required deterministic authorship `Aryeh Stark <aryeh@21stark.com>` — the same
 * identity the (now-retired) broker stamped on canonical writes. Both author AND
 * committer are pinned so the installed commit's identity is fully deterministic. The
 * identity is set per-invocation via `-c` so the commit never depends on — or mutates
 * — ambient git config.
 */
const AGENT_AUTHOR_NAME = "Aryeh Stark";
const AGENT_AUTHOR_EMAIL = "aryeh@21stark.com";

export interface Worktree {
  /** Absolute path to the worktree directory. */
  readonly dir: string;
  /** The agent ref (`refs/agent/<runId>`) this worktree's HEAD is attached to. */
  readonly ref: string;
  /**
   * Stage all changes and commit them with `msg` plus the manifest trailer.
   * Returns the new commit SHA. The commit advances `ref`.
   */
  commit(msg: string, manifest: RunManifest): Promise<string>;
  /** Read back and validate the manifest trailer from a commit (default HEAD). */
  readManifest(rev?: string): Promise<RunManifest>;
}

class WorktreeImpl implements Worktree {
  constructor(
    readonly dir: string,
    readonly ref: string,
  ) {}

  async commit(msg: string, manifest: RunManifest): Promise<string> {
    await runGit(this.dir, ["add", "-A"]);
    const message = buildCommitMessage(msg, manifest);
    await runGit(
      this.dir,
      [
        "-c",
        `user.name=${AGENT_AUTHOR_NAME}`,
        "-c",
        `user.email=${AGENT_AUTHOR_EMAIL}`,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-F",
        "-",
      ],
      // Pin all four identity vars in the environment too: `-c user.name/email`
      // is overridden by ambient GIT_AUTHOR_*/GIT_COMMITTER_*, so a poisoned
      // environment could otherwise change the committed authorship. Explicit
      // env wins and keeps the directly-installed canonical commit deterministic.
      {
        input: message,
        env: {
          GIT_AUTHOR_NAME: AGENT_AUTHOR_NAME,
          GIT_AUTHOR_EMAIL: AGENT_AUTHOR_EMAIL,
          GIT_COMMITTER_NAME: AGENT_AUTHOR_NAME,
          GIT_COMMITTER_EMAIL: AGENT_AUTHOR_EMAIL,
        },
      },
    );
    return runGit(this.dir, ["rev-parse", "HEAD"]);
  }

  async readManifest(rev = "HEAD"): Promise<RunManifest> {
    const message = await runGit(this.dir, ["show", "-s", "--format=%B", rev]);
    return parseManifestTrailer(message);
  }
}

/** Construct a worktree handle. Internal — created by `Repo.addWorktree`. */
export function makeWorktree(dir: string, ref: string): Worktree {
  return new WorktreeImpl(dir, ref);
}
