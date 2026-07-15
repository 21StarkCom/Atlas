/**
 * Ref naming + the **security boundary** of this package.
 *
 * Agents (the consumers of `@atlas/git`) hold object-write + `refs/agent/*` +
 * protected-ref *read*. The broker is the sole mutator of protected refs
 * (`refs/heads/*`, `refs/tags/*`, and the canonical branch). Therefore every
 * ref-*writing* code path in this package MUST route through {@link updateAgentRef}
 * / {@link attachHeadToAgentRef}, both of which reject any ref outside the
 * `refs/agent/` namespace. Reading (see {@link readRef}) may target any ref,
 * protected or not — that is the permitted read-only view.
 *
 * `git.no-protected-write.test` grep-guards this: the only git ref-write
 * subcommands allowed anywhere in `src` are the two guarded calls below.
 */
import { ULID_RE } from "@atlas/contracts";
import { GitError, runGit } from "./exec.js";

/** The one namespace agents may write. */
export const AGENT_REF_PREFIX = "refs/agent/";

/**
 * A fully-qualified agent branch ref: `refs/agent/<ULID runId>`. The `runId`
 * segment is pinned to a ULID so a caller cannot smuggle path segments (e.g.
 * `../heads/main`) into the ref name.
 */
export const AGENT_REF_RE = new RegExp(`^refs/agent/${ULID_RE.source.replace(/^\^|\$$/g, "")}$`);

/** True iff `ref` is a well-formed `refs/agent/<ulid>` ref. */
export function isAgentRef(ref: string): boolean {
  return AGENT_REF_RE.test(ref);
}

/**
 * Throw unless `ref` is a writable agent ref. This is the guard the whole
 * no-protected-write invariant rests on — do not weaken it.
 */
export function assertAgentRef(ref: string): void {
  if (!isAgentRef(ref)) {
    throw new Error(
      `refusing to write non-agent ref "${ref}": this package may only write ${AGENT_REF_PREFIX}<runId> ` +
        `(protected-ref writes are broker-only)`,
    );
  }
}

/** Build the agent ref for a run id, validating the id is a ULID. */
export function agentRef(runId: string): string {
  if (!ULID_RE.test(runId)) {
    throw new Error(`invalid runId "${runId}": expected a ULID`);
  }
  return `${AGENT_REF_PREFIX}${runId}`;
}

/**
 * Resolve `name` (a ref, sha, or any commit-ish) to its commit SHA, or `null`
 * if it does not resolve. Read-only: `name` may be a protected ref — reading
 * protected refs is explicitly permitted for agents.
 */
export async function readRef(dir: string, name: string): Promise<string | null> {
  try {
    // `^{commit}` peels tags/annotated objects to the underlying commit.
    return await runGit(dir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  } catch (err) {
    // Distinguish "ref does not resolve" from operational failures. With
    // `--verify --quiet`, git exits 1 with empty stderr solely because the name
    // is unknown — that is the only case we translate to `null`. Every other
    // failure (exit 128: not a git repo / bad cwd / corrupt object, a missing
    // git binary surfaced as a non-`GitError`, permission errors, etc.) is
    // operational and MUST propagate rather than masquerade as an unknown ref.
    if (err instanceof GitError && err.exitCode === 1 && err.stderr.trim() === "") {
      return null;
    }
    throw err;
  }
}

/**
 * Point an agent ref at `targetSha` via `git update-ref`. GUARDED: throws for
 * any ref outside `refs/agent/`. This is the *only* `update-ref` call site in
 * the package.
 */
export async function updateAgentRef(dir: string, ref: string, targetSha: string): Promise<void> {
  assertAgentRef(ref);
  await runGit(dir, ["update-ref", ref, targetSha]);
}

/**
 * Delete an agent ref via `git update-ref -d`. GUARDED: throws for any ref
 * outside `refs/agent/`, so `git cleanup` (Task 2.9) can prune a terminal run's
 * abandoned branch without ever being able to delete a protected ref. A ref that
 * does not exist is a no-op success (`update-ref -d` is convergent), which keeps
 * cleanup intrinsically idempotent. This is a guarded write call site — it MUST
 * stay co-located with {@link assertAgentRef} for the no-protected-write audit.
 */
export async function deleteAgentRef(dir: string, ref: string): Promise<void> {
  assertAgentRef(ref);
  await runGit(dir, ["update-ref", "-d", ref]);
}

/**
 * Attach a worktree's `HEAD` to an agent ref via `git symbolic-ref`, so commits
 * made in that worktree advance `refs/agent/<runId>` (a ref checked out into a
 * worktree is otherwise detached, since it lives outside `refs/heads/`).
 * GUARDED on the target ref: HEAD may only be attached to an agent ref, so this
 * can never make a worktree commit onto a protected branch. This is the only
 * `symbolic-ref` call site in the package.
 */
export async function attachHeadToAgentRef(dir: string, ref: string): Promise<void> {
  assertAgentRef(ref);
  await runGit(dir, ["symbolic-ref", "HEAD", ref]);
}
