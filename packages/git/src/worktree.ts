/**
 * A git worktree bound to an agent ref, with the one write operation agents
 * perform: {@link Worktree.commit} — stage the working tree and record an agent
 * commit carrying the run-manifest trailer, advancing `refs/agent/<runId>`.
 */
import type { RunManifest } from "@atlas/contracts";
import { runGit } from "./exec.js";
import { buildCommitMessage, parseManifestTrailer } from "./commit.js";

/**
 * Runtime identity stamped on agent commits. Agent commits are made by the
 * automated runtime, not a human, so they carry a dedicated agent identity
 * (distinct from the repo-authoring convention used for source commits). The
 * identity is set per-invocation via `-c` so the commit never depends on — or
 * mutates — ambient git config.
 */
const AGENT_AUTHOR_NAME = "Atlas Agent";
const AGENT_AUTHOR_EMAIL = "agent@atlas.local";

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
      { input: message },
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
