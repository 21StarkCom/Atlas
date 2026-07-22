/**
 * `@atlas/git` — typed git plumbing over the vault repo for the agent side.
 *
 * Agents may: read any ref (incl. protected), write objects, create/advance
 * `refs/agent/*` branches, and add/remove worktrees. Protected-ref *writes*
 * (`refs/heads/*`, `refs/tags/*`, canonical) are broker-only and structurally
 * impossible here — see `refs.ts` for the guarded write surface.
 */

export {
  openRepo,
  type Repo,
  type WorktreeEntry,
  type ChangeStatus,
  type PathChange,
  type RawStatusChange,
  type CommitChanges,
} from "./repo.js";
export { type Worktree } from "./worktree.js";
export {
  AGENT_REF_PREFIX,
  AGENT_REF_RE,
  agentRef,
  isAgentRef,
  assertAgentRef,
  readRef,
  updateAgentRef,
  deleteAgentRef,
  attachHeadToAgentRef,
  assertCanonicalRef,
  advanceCanonicalRef,
  CanonicalRefError,
} from "./refs.js";
export {
  RUN_MANIFEST_TRAILER,
  encodeManifestTrailer,
  buildCommitMessage,
  parseManifestTrailer,
} from "./commit.js";
// NOTE: `runGit` / `runGitBuffer` are deliberately NOT re-exported. Exposing
// raw `git` argv execution would let a consumer call `update-ref`/`symbolic-ref`
// on any ref (incl. `refs/heads/*`) and bypass every agent-ref guard in
// `refs.ts`. Only the capability-specific guarded operations above are public;
// both executors stay package-internal. The public-surface regression tests
// lock this down.
export { GitError } from "./exec.js";
