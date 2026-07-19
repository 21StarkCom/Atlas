/**
 * Broker-side privileged git plumbing.
 *
 * Unlike `@atlas/git` (agent side, whose write surface is structurally limited
 * to `refs/agent/*`), the broker is the SOLE mutator of protected refs — so it
 * needs raw `update-ref` (with compare-and-swap old-values), `commit-tree`, and
 * ancestry queries. That capability lives HERE, package-internal, and is never
 * re-exported. Reads reuse `@atlas/git.readRef` where convenient.
 *
 * Every invocation shells `git` via `execFile` (argv array, never a shell
 * string) so ref names and paths are free of shell-injection concerns.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readRef as agentReadRef } from "@atlas/git";

const execFileAsync = promisify(execFile);

/** The all-zeros object id: as a CAS old-value it means "the ref must not exist". */
export const ZERO_OID = "0".repeat(40);

/**
 * Parse NUL-delimited `git … --name-status -z` output into `{ status, path }`
 * entries. The `-z` form is the ONLY safe one for a path-policy gate: it never
 * C-quotes non-ASCII paths (so a Hebrew note name is not mangled into a
 * `"…"`-wrapped string that fails a suffix check) and never collapses embedded
 * whitespace/tabs. The stream is a flat run of NUL-terminated fields:
 *   `<status>\0<path>\0`               for A/M/D/T
 *   `<status>\0<oldpath>\0<newpath>\0` for R.../C... (score suffix on status)
 * A rename/copy contributes BOTH paths under its status letter, so an
 * additions-only policy sees (and rejects) the rename SOURCE, not just its
 * destination. Any trailing partial record (no terminating NUL) is DROPPED as a
 * fault rather than parsed fail-open — the caller's policy check then sees a
 * complete, faithful set or nothing.
 */
function parseNameStatusZ(out: string): { status: string; path: string }[] {
  if (out.length === 0) return [];
  // Split on NUL; a well-formed stream ends with a NUL so the final element is "".
  const fields = out.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  const entries: { status: string; path: string }[] = [];
  let i = 0;
  while (i < fields.length) {
    const raw = fields[i++]!;
    const status = raw.charAt(0);
    const isRenameOrCopy = status === "R" || status === "C";
    const wanted = isRenameOrCopy ? 2 : 1;
    // Require the full record; a truncated tail is not silently accepted.
    if (i + wanted > fields.length) break;
    for (let k = 0; k < wanted; k++) {
      const p = fields[i++]!;
      if (p.length > 0) entries.push({ status, path: p });
    }
  }
  return entries;
}

/** De-duplicate `{status, path}` entries (union across a multi-commit range). */
function dedupeStatuses(entries: { status: string; path: string }[]): { status: string; path: string }[] {
  const seen = new Set<string>();
  const out: { status: string; path: string }[] = [];
  for (const e of entries) {
    const key = `${e.status}\t${e.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** Raised when a broker `git` subprocess exits non-zero. */
export class BrokerGitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} (in ${cwd}) failed with code ${exitCode}: ${stderr.trim()}`);
    this.name = "BrokerGitError";
  }
}

async function runGit(cwd: string, args: readonly string[], input?: string): Promise<string> {
  try {
    const child = execFileAsync("git", args as string[], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // Deterministic authorship for broker-authored audit commits.
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Aryeh Stark",
        GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
        GIT_COMMITTER_NAME: "Aryeh Stark",
        GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
        // Fixed timestamp base so audit-chain SHAs are reproducible in tests.
        GIT_AUTHOR_DATE: "2026-07-12T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-07-12T00:00:00Z",
      },
    });
    if (input !== undefined) child.child.stdin?.end(input);
    const { stdout } = await child;
    return stdout.trim();
  } catch (err) {
    const e = err as { code?: number | null; stderr?: string };
    throw new BrokerGitError(args, cwd, e.code ?? null, e.stderr ?? String(err));
  }
}

/** A typed git handle over the broker's vault repo. */
export class BrokerGit {
  constructor(readonly dir: string) {}

  /** Resolve a ref/sha/commit-ish to its commit SHA, or `null` if unresolved. */
  readRef(name: string): Promise<string | null> {
    return agentReadRef(this.dir, name);
  }

  /** True iff both commits resolve and `ancestor` is an ancestor of `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await runGit(this.dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (err) {
      if (err instanceof BrokerGitError && err.exitCode === 1) return false;
      throw err;
    }
  }

  /** The paths changed by `commit` relative to its first parent (root commit ⇒ all paths). */
  async changedPaths(commit: string): Promise<string[]> {
    const out = await runGit(this.dir, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "--root",
      commit,
    ]);
    return out.length === 0 ? [] : out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /**
   * The UNION of per-path change statuses across EVERY commit reachable from
   * `commit` when canonical is unborn (no base). Uses `git log … -m` so EVERY
   * commit in the new history is inspected — including each parent of a merge
   * commit — closing the hole where an unborn-canonical capture was scope-checked
   * on the tip alone (a multi-commit chain, or a merge tip that `diff-tree`
   * reports as empty, would otherwise install an unchecked tree).
   */
  async changedPathStatusesFromRoot(commit: string): Promise<{ status: string; path: string }[]> {
    const out = await runGit(this.dir, ["log", "--name-status", "-z", "--format=", "-m", commit]);
    return dedupeStatuses(parseNameStatusZ(out));
  }

  /**
   * The UNION of per-path change statuses across EVERY commit in `base..commit`
   * (each vs its first parent, `-m` for merges) — the name-status analogue of
   * {@link changedPathsInRange}, so a modify/delete introduced by an earlier
   * commit of a multi-commit range is caught even if the tip only adds.
   */
  async changedPathStatusesInRange(base: string, commit: string): Promise<{ status: string; path: string }[]> {
    const out = await runGit(this.dir, ["log", "--name-status", "-z", "--format=", "-m", `${base}..${commit}`]);
    return dedupeStatuses(parseNameStatusZ(out));
  }

  /**
   * The UNION of paths touched by EVERY commit in the range `base..commit` (each
   * commit vs its first parent), so a forbidden path introduced in an earlier
   * commit of a multi-commit capture is caught even if the tip touches only
   * allowed paths (fixes the multi-commit scope-bypass finding). `base` must be an
   * ancestor of `commit`; use {@link changedPaths} when there is no base.
   */
  async changedPathsInRange(base: string, commit: string): Promise<string[]> {
    const out = await runGit(this.dir, [
      "log",
      "--name-only",
      "--format=",
      "-m", // list paths for merge commits too (against each parent)
      `${base}..${commit}`,
    ]);
    if (out.length === 0) return [];
    const paths = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
    return [...paths];
  }

  /** The number of commits reachable from `ref` (0 if the ref does not exist). */
  async countCommits(ref: string): Promise<number> {
    const sha = await this.readRef(ref);
    if (sha === null) return 0;
    const out = await runGit(this.dir, ["rev-list", "--count", ref]);
    return Number.parseInt(out, 10);
  }

  /** Commit SHAs reachable from `ref`, newest first (empty if the ref is absent). */
  async revList(ref: string): Promise<string[]> {
    const sha = await this.readRef(ref);
    if (sha === null) return [];
    const out = await runGit(this.dir, ["rev-list", ref]);
    return out.length === 0 ? [] : out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  /** The full commit message body of `commit`. */
  async commitMessage(commit: string): Promise<string> {
    return runGit(this.dir, ["log", "-1", "--format=%B", commit]);
  }

  /** The SHA of the empty tree object in this repo. */
  async emptyTree(): Promise<string> {
    return runGit(this.dir, ["mktree"], "");
  }

  /** Create a commit object with `tree`, optional `parent`, and `message`; return its SHA. */
  async commitTree(tree: string, parent: string | null, message: string): Promise<string> {
    const args = ["commit-tree", tree];
    if (parent !== null) args.push("-p", parent);
    // Message via stdin so arbitrary JSON bodies never hit argv length/quoting limits.
    return runGit(this.dir, [...args], message);
  }

  /**
   * Compare-and-swap a ref from `oldValue` to `newValue`. `oldValue` = {@link ZERO_OID}
   * asserts the ref must not already exist. Throws {@link BrokerGitError} (exit 128)
   * if the current value differs — the caller maps that to a typed CAS refusal.
   */
  async updateRefCas(ref: string, newValue: string, oldValue: string): Promise<void> {
    await runGit(this.dir, ["update-ref", ref, newValue, oldValue]);
  }
}
