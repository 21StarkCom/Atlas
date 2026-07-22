/**
 * `commitPaths` — the pathspec-scoped stage-then-commit primitive.
 *
 * This is where the **direct commit is born** under the v2 in-process cutover
 * (ADR-0003): Phase 2's integrator only fast-forward-advanced a pre-existing
 * agent commit, but v2 mutations commit their touched paths straight onto the
 * working repo. `commitPaths` stages exactly the literal paths a mutation
 * touched (`git add`, covering creates / edits / deletions), then commits ONLY
 * those paths (`git commit -- <paths>`), so any unrelated pre-staged index
 * entries for other files survive untouched. Staging-first is mandatory:
 * `git commit -- <path>` rejects an untracked file, so a freshly created note
 * would never commit without a prior `git add`.
 *
 * If the commit fails, the touched paths' index entries are restored to their
 * pre-`add` state (and only those — unrelated staged entries are never
 * disturbed), so a failed commit leaves the index exactly as `commitPaths`
 * found it for the paths it touched.
 *
 * v2 has no privilege boundary, so this is a narrow, capability-specific API on
 * `@atlas/git` — NOT a raw-argv escape hatch. The old "`runGit` stays
 * unexported so a consumer can't `update-ref` a protected ref" invariant is
 * moot here: this primitive only ever runs `add` / `commit` / `update-index` /
 * `ls-files`, none of which are ref-writing subcommands (the source audit in
 * `git.no-protected-write.test.ts` confirms).
 */
import { posix } from "node:path";
import type { Repo } from "./repo.js";
import { runGit } from "./exec.js";

/**
 * Canonicalize the caller's repo-relative paths ONCE, up front, so every
 * operation (snapshot / add / commit / restore) keys off the identical spelling
 * git itself normalizes to. Without this, `./doc.md` snapshots under the key
 * `doc.md` (git normalizes) while restoration looks it up as `./doc.md` and
 * misses — silently dropping the tracked index entry. `posix.normalize`
 * collapses `.`/`..`/`//`/trailing-slash segments the same way git's pathspec
 * normalization does for a literal path; the result is what git commits and
 * what `ls-files` reports. Absolute paths and any spelling that escapes the repo
 * root are rejected rather than normalized into an unrelated location.
 *
 * Combined with `--literal-pathspecs` on every path-consuming git call, this
 * also neutralizes pathspec magic: a name containing `*`, `[ab]`, or a
 * `:(exclude)` prefix is treated as that literal filename, never a glob or
 * magic signature that could stage/commit unrelated files.
 */
function canonicalizePaths(paths: readonly string[]): string[] {
  return paths.map((p) => {
    if (p === "") throw new Error("commitPaths: empty path is not allowed");
    const norm = posix.normalize(p);
    if (posix.isAbsolute(norm) || norm === ".." || norm.startsWith("../")) {
      throw new Error(`commitPaths: path escapes the repository root: ${p}`);
    }
    return norm;
  });
}

/**
 * `--literal-pathspecs` disables ALL Git pathspec magic (globbing and the
 * `:(magic)` prefix syntax) for the invocation, so a pathspec is matched as a
 * verbatim filename. Prepended to every path-consuming git call in this module.
 */
const LITERAL = "--literal-pathspecs";

/**
 * Deterministic identity stamped on the direct commit. Mirrors `worktree.ts`'s
 * `AGENT_AUTHOR_*` (the canonical pattern): under v2 the commit is installed
 * directly onto the canonical ref, so it must carry the required deterministic
 * authorship `Aryeh Stark <aryeh@21stark.com>` (author AND committer). The
 * identity is pinned per-invocation via `-c` AND in the environment, because
 * `-c user.name/email` is overridden by ambient `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
 * — a poisoned environment could otherwise rewrite the committed authorship.
 */
const AGENT_AUTHOR_NAME = "Aryeh Stark";
const AGENT_AUTHOR_EMAIL = "aryeh@21stark.com";

/** One index entry as reported by `git ls-files -s -z`: mode, object id, merge stage. */
interface IndexEntry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: string;
}

/**
 * Snapshot the index state of exactly `paths` (before any staging), keyed by
 * the repo-relative path git reports. `-z` is used so paths with embedded
 * whitespace / non-ASCII survive verbatim (no C-quoting). A path with no index
 * entry (untracked, or a not-yet-staged deletion) is simply absent from the
 * map — its restore is "remove the entry we added".
 */
async function snapshotIndex(
  dir: string,
  paths: readonly string[],
): Promise<Map<string, IndexEntry>> {
  const out = await runGit(dir, [LITERAL, "ls-files", "-s", "-z", "--", ...paths]);
  const map = new Map<string, IndexEntry>();
  if (out === "") return map;
  for (const rec of out.split("\0")) {
    if (rec === "") continue; // trailing empty field after the final NUL
    // Record shape: "<mode> <oid> <stage>\t<path>".
    const tab = rec.indexOf("\t");
    if (tab === -1) continue; // defensive: malformed record, skip rather than mis-key
    const [mode, oid, stage] = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    if (mode === undefined || oid === undefined || stage === undefined) continue;
    map.set(path, { mode, oid, stage });
  }
  return map;
}

/**
 * Restore the index to `preStage` — the state captured before staging — for
 * every entry that `git add` may have touched. Keys are the ACTUAL repo-relative
 * paths git reports, never the caller's pathspecs, so a directory pathspec such
 * as `notes/` (which stages descendants `notes/a.md`, `notes/b.md`) restores
 * each of those descendants rather than a nonexistent `notes/` entry.
 *
 * The work set is the union of the pre-stage snapshot's keys and `postStage`'s
 * keys (the entries matching the same pathspecs AFTER `git add`):
 *  - a path present in `preStage` is rewritten to its prior mode+oid — this also
 *    resurrects an entry `git add` staged as a deletion;
 *  - a path absent from `preStage` but present in `postStage` was newly staged
 *    (untracked/unstaged before), so the entry we added is force-removed,
 *    returning it to untracked.
 *
 * Unrelated index entries are never in either map, so they are left exactly as
 * they were. Assumes normal (stage 0) entries — the primitive is not designed
 * to run mid-merge, and `--cacheinfo` writes stage 0.
 */
async function restoreIndex(
  dir: string,
  preStage: Map<string, IndexEntry>,
  postStage: Map<string, IndexEntry>,
): Promise<void> {
  // ONE `update-index -z --index-info` invocation restores everything: a
  // pre-stage entry is rewritten to its prior mode+oid (also resurrecting an
  // entry `git add` staged as a deletion), and a path newly staged by `git add`
  // (absent pre-stage, present post-stage) is removed via the documented
  // mode-000000 form, returning it to untracked. A single stdin-fed subprocess
  // replaces the previous per-path loop, so a mid-loop subprocess failure can
  // no longer strand a half-restored index (round-3 finding: rollback was not
  // fail-safe). `-z` NUL-terminates records so any path spelling survives.
  const records: string[] = [];
  for (const [path, entry] of preStage) {
    records.push(`${entry.mode} ${entry.oid} ${entry.stage}\t${path}`);
  }
  for (const path of postStage.keys()) {
    if (preStage.has(path)) continue; // rewritten to its pre-stage entry above
    records.push(`000000 ${"0".repeat(40)} 0\t${path}`);
  }
  if (records.length === 0) return;
  await runGit(dir, ["update-index", "-z", "--index-info"], {
    input: records.join("\0") + "\0",
  });
}

/**
 * Stage the literal `paths` a mutation touched, then commit ONLY those paths
 * with `message`, returning the new commit SHA. Unrelated pre-staged entries
 * for other files are left intact; if the commit fails, the touched paths'
 * index entries are restored to their pre-stage state (and only those). `paths`
 * are treated as repo-relative literals (creates / edits / deletions all
 * covered by `git add`).
 */
export async function commitPaths(
  repo: Repo,
  paths: readonly string[],
  message: string,
): Promise<string> {
  if (paths.length === 0) {
    throw new Error("commitPaths requires at least one path");
  }
  const dir = repo.dir;

  // Canonicalize ONCE so snapshot keys, staging, commit, and restore all use
  // the identical git-normalized spelling (fixes the `./doc.md` snapshot/restore
  // key mismatch), and validate that no path escapes the repo root.
  const canonPaths = canonicalizePaths(paths);

  // Capture the pre-stage index state of the touched paths so a failed commit
  // can be rolled back to exactly it (leaving unrelated entries alone).
  const snapshot = await snapshotIndex(dir, canonPaths);

  // REFUSE unmerged paths before any index mutation. The snapshot map keeps one
  // entry per path (a conflicted path's final record carries a nonzero stage),
  // and the restore path writes a single entry per path — running through a
  // conflict would collapse its stage-1/2/3 entries and destroy the conflict
  // state on rollback (round-3 finding). The primitive is documented as not
  // designed to run mid-merge; enforce that fail-closed here.
  for (const [path, entry] of snapshot) {
    if (entry.stage !== "0") {
      throw new Error(
        `commitPaths refuses unmerged path "${path}" (index stage ${entry.stage}): ` +
          `resolve the merge conflict before committing`,
      );
    }
  }

  // Stage the touched paths. `git add -- <paths>` covers creates, edits, AND
  // deletions of tracked files (git 2.0+ treats a pathspec `add` as `add -A`
  // for those paths). This is mandatory: `git commit -- <untracked>` rejects an
  // unstaged new file, so a fresh note would never commit otherwise.
  await runGit(dir, [LITERAL, "add", "--", ...canonPaths]);

  try {
    // Commit ONLY the touched paths (a partial commit): git builds the commit
    // from HEAD plus these pathspecs, so any unrelated staged entries stay in
    // the index untouched. Identity pinned via `-c` + env (see AGENT_AUTHOR_*).
    // `-F -` feeds the message over stdin so it is never argv-interpolated.
    await runGit(
      dir,
      [
        LITERAL,
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
        "--",
        ...canonPaths,
      ],
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
  } catch (err) {
    // The commit did not land, but `git add` already mutated the index for the
    // touched paths (including any descendants of a directory pathspec). Snapshot
    // the entries matching the SAME pathspecs post-stage, then restore exactly
    // the union of pre- and post-stage matches so a failed commit is a no-op on
    // the index; unrelated pre-staged entries are never referenced. The
    // post-stage snapshot runs INSIDE the rollback try (round-3 finding: it sat
    // outside, so its own failure skipped restoration silently). If rollback
    // itself fails, BOTH failures surface via AggregateError — a swallowed
    // rollback error previously hid that touched paths were left staged.
    try {
      const postStage = await snapshotIndex(dir, canonPaths);
      await restoreIndex(dir, snapshot, postStage);
    } catch (rollbackErr) {
      throw new AggregateError(
        [err, rollbackErr],
        "commitPaths: commit failed AND the index rollback failed — " +
          "touched paths may retain staged entries (first error: commit; second: rollback)",
      );
    }
    throw err;
  }

  return runGit(dir, ["rev-parse", "HEAD"]);
}
