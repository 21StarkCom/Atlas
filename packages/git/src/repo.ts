/**
 * `Repo` — the entry point of `@atlas/git`. A typed handle over the vault git
 * repository that exposes exactly the plumbing agents are allowed to perform:
 * read any ref (incl. protected), create/advance `refs/agent/*` branches, and
 * add/remove worktrees. Protected-ref *writes* are structurally impossible here
 * (see `refs.ts`) — those belong to the broker.
 */
import { resolve } from "node:path";
import { runGit, runGitBuffer, GitError } from "./exec.js";
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

/**
 * The normalized change alphabet the sync cycle consumes. Git's raw name-status
 * alphabet is wider; {@link parseNameStatusZ} folds it fail-closed: `R<score>` →
 * `R` (with `fromPath`), `C<score>` → `A` of the destination (the source still
 * exists — a copy is an addition from the consumer's view), `T` (typechange) →
 * `M` (the path's content changed), and any OTHER status (unmerged `U`, `X`,
 * broken `B`, unknown) THROWS rather than silently dropping a change.
 */
export type ChangeStatus = "A" | "M" | "D" | "R";

/** One normalized path change. `fromPath` is present only for `R` (the rename source). */
export interface PathChange {
  readonly status: ChangeStatus;
  readonly path: string;
  readonly fromPath?: string;
}

/** One commit on a first-parent walk plus its (pathspec-filtered) changes. */
export interface CommitChanges {
  readonly oid: string;
  readonly changes: PathChange[];
}

/**
 * Classify a `git cat-file blob <commit>:<path>` failure as "does not resolve".
 * cat-file has no `--quiet`, so unlike `readRef`'s exit-1-empty-stderr signal
 * (refs.ts:59-75) the unresolved case here is exit 128 WITH a fatal message —
 * classification must pin git's actual wordings (probed against git 2.x):
 *   - `path '…' does not exist in '…'`            (path absent from the commit)
 *   - `path '…' exists on disk, but not in '…'`   (worktree-only file — committed-state binding)
 *   - `invalid object name '…'`                   (commit-ish does not resolve)
 * `bad revision` / `Not a valid object name` are retained for wording drift
 * across git versions. Anything else at exit 128 — notably `not a git
 * repository` — is operational and must propagate (null-only-unresolved).
 */
const UNRESOLVED_BLOB_RE =
  /does not exist|invalid object name|bad revision|not a valid object name|exists on disk, but not in/i;

/**
 * Parse NUL-delimited `git … --name-status -z` output into normalized
 * {@link PathChange} records. Structural mirror of the broker's
 * `parseNameStatusZ` (packages/broker/src/git.ts:36-56): `-z` is the ONLY safe
 * form — it never C-quotes non-ASCII/quoted paths and never collapses embedded
 * whitespace. Stream shape: `<status>\0<path>\0` for A/M/D/T, and
 * `<status>\0<oldpath>\0<newpath>\0` for R…/C… (similarity score suffixed on
 * the status token). A truncated trailing record (missing fields) is DROPPED as
 * a fault rather than half-parsed, exactly like the broker parser — with
 * `execFile`'s buffered output the only way to truncate is a maxBuffer abort,
 * which already threw. Status normalization is fail-closed (see
 * {@link ChangeStatus}).
 */
function parseNameStatusZ(out: string): PathChange[] {
  if (out.length === 0) return [];
  // Split on NUL; a well-formed stream ends with a NUL so the final element is "".
  const fields = out.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  const changes: PathChange[] = [];
  let i = 0;
  while (i < fields.length) {
    const token = fields[i++]!;
    const letter = token.charAt(0);
    // Require the full record; a truncated tail is never silently half-parsed.
    if (i + (letter === "R" || letter === "C" ? 2 : 1) > fields.length) break;
    switch (letter) {
      case "R": {
        const fromPath = fields[i++]!;
        changes.push({ status: "R", path: fields[i++]!, fromPath });
        break;
      }
      case "C": {
        i++; // copy SOURCE: unchanged at `to`, so it is not part of the change set
        changes.push({ status: "A", path: fields[i++]! });
        break;
      }
      case "A":
      case "M":
      case "D":
        changes.push({ status: letter, path: fields[i++]! });
        break;
      case "T":
        // Typechange (blob↔symlink/mode class): the path's committed content
        // changed, which is exactly what `M` means to the consumer.
        changes.push({ status: "M", path: fields[i++]! });
        break;
      default:
        // Fail closed: an unmerged/unknown status silently dropped would make
        // the sync cycle skip a real change. Refuse the whole parse instead.
        throw new Error(
          `unsupported git name-status token "${token}": ` +
            `only A/M/D/T/R<score>/C<score> are parseable; refusing fail-closed`,
        );
    }
  }
  return changes;
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
  /**
   * BYTE-EXACT read of the blob at `<commitOid>:<path>` (`git cat-file blob`).
   * Read-only; binds to COMMITTED state — a file present only in the working
   * tree does not resolve. Returns raw bytes (trailing newline and non-utf8
   * bytes preserved; decode is the caller's decision), or `null` ONLY when the
   * commit-ish or the path within it does not resolve — the package's
   * null-only-unresolved convention. Operational failures (not a repo, corrupt
   * object store) propagate as `GitError`. The sync cycle's incremental fold
   * reads note bodies at the adopted ref through this instead of shelling git
   * itself.
   */
  readBlobAt(commitOid: string, path: string): Promise<Buffer | null>;
  /**
   * The FIRST-PARENT commit walk for the sync cycle: every commit in
   * `from..to` (or all of `to`'s first-parent history when `from` is `null`),
   * oldest→newest, each with its pathspec-filtered changes. Semantics that are
   * load-bearing for sync correctness:
   *
   *  - First-parent view: a MERGE commit is diffed against its FIRST parent, so
   *    everything a merge brings in (second-parent work) surfaces as that merge
   *    commit's own change set — side-branch commits themselves never appear.
   *  - A parentless root commit is diffed with `--root`, so initial additions
   *    are not dropped.
   *  - EVERY commit in the range is returned, even with `changes: []` — the
   *    sync cursor advances per commit boundary, so a commit filtered to
   *    nothing must still be walkable.
   *  - `pathspec` elements pass verbatim after `--` (callers hand `:(glob)…`
   *    magic, see apps/cli note-matcher `noteGlobPathspec`).
   *  - Status alphabet is normalized fail-closed (see {@link ChangeStatus}).
   */
  commitsInRange(
    from: string | null,
    to: string,
    pathspec: readonly string[],
  ): Promise<CommitChanges[]>;
  /**
   * NET tree-vs-tree name-status between two commit-ish/tree-ish (`git diff
   * --find-renames --name-status <from> <to>`): what actually differs between
   * the two trees, with per-commit churn collapsed (modify-then-revert yields
   * nothing). Same pathspec passthrough + fail-closed status normalization as
   * {@link Repo.commitsInRange}. Used by `sync reset`'s tree diff.
   */
  changedPaths(from: string, to: string, pathspec: readonly string[]): Promise<PathChange[]>;
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

  async readBlobAt(commitOid: string, path: string): Promise<Buffer | null> {
    try {
      // Buffer-mode exec: runGit trims stdout and forces utf8, either of which
      // breaks byte-exactness (a trailing newline is blob content; 0xFF must
      // survive). See exec.ts runGitBuffer.
      return await runGitBuffer(this.dir, ["cat-file", "blob", `${commitOid}:${path}`]);
    } catch (err) {
      // Mirror readRef's discipline: `null` means ONLY "does not resolve".
      // cat-file's unresolved signal is exit 128 + a pinned fatal wording (see
      // UNRESOLVED_BLOB_RE); every other failure — exit 128 "not a git
      // repository" included — propagates rather than masquerading as absence.
      if (err instanceof GitError && err.exitCode === 128 && UNRESOLVED_BLOB_RE.test(err.stderr)) {
        return null;
      }
      throw err;
    }
  }

  async commitsInRange(
    from: string | null,
    to: string,
    pathspec: readonly string[],
  ): Promise<CommitChanges[]> {
    // Oldest→newest along the first-parent line only: side-branch commits are
    // invisible; their content surfaces as the merge commit's own diff below.
    const walk = await runGit(this.dir, [
      "rev-list",
      "--first-parent",
      "--reverse",
      from === null ? to : `${from}..${to}`,
    ]);
    const oids = walk === "" ? [] : walk.split("\n");
    const out: CommitChanges[] = [];
    for (const oid of oids) {
      // Parentless detection reuses readRef's exit-1-empty-stderr contract:
      // `<oid>^` resolving to null ⇔ no first parent. Deterministic, and any
      // operational failure propagates instead of silently picking a diff mode.
      const parentless = (await readRef(this.dir, `${oid}^`)) === null;
      // `<oid>^ <oid>` is an explicit two-tree diff — for a merge commit that
      // IS the required first-parent view. `--root` covers the parentless root
      // so initial additions are not dropped. Pathspec passes verbatim.
      const args = parentless
        ? ["diff-tree", "-z", "--find-renames", "--root", "--no-commit-id", "--name-status", "-r", oid]
        : ["diff-tree", "-z", "--find-renames", "--no-commit-id", "--name-status", "-r", `${oid}^`, oid];
      const raw = await runGit(this.dir, [...args, "--", ...pathspec]);
      // Commits whose filtered change set is empty are STILL returned: the sync
      // cursor advances per commit boundary and must be able to walk them.
      out.push({ oid, changes: parseNameStatusZ(raw) });
    }
    return out;
  }

  async changedPaths(from: string, to: string, pathspec: readonly string[]): Promise<PathChange[]> {
    // Net two-tree diff: per-commit churn collapses (modify-then-revert ⇒ no
    // entry). Same -z + rename detection + fail-closed normalization as the
    // per-commit walk, so both surfaces speak one change alphabet.
    const raw = await runGit(this.dir, [
      "diff",
      "-z",
      "--find-renames",
      "--name-status",
      from,
      to,
      "--",
      ...pathspec,
    ]);
    return parseNameStatusZ(raw);
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
