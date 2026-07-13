/**
 * Thin `node:child_process` wrapper around the system `git` binary.
 *
 * Per the task contract this package shells `git` directly rather than pulling
 * in an external git library. Every git invocation in `@atlas/git` funnels
 * through {@link runGit} so argument handling, cwd binding, and error surfacing
 * are uniform. `execFile` (not `exec`) is used so arguments are passed as an
 * argv array — never interpolated into a shell string — which keeps ref names
 * and paths free of shell-injection concerns.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Raised when a `git` subprocess exits non-zero. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} (in ${cwd}) failed with code ${exitCode}: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Options for a single git invocation. */
export interface RunGitOptions {
  /** Data to pipe to the subprocess stdin (used for `commit -F -`). */
  readonly input?: string;
}

/**
 * Run `git <args>` with working directory `cwd`, returning trimmed stdout.
 * Throws {@link GitError} on a non-zero exit.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<string> {
  try {
    const child = execFileAsync("git", args as string[], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (options.input !== undefined) {
      child.child.stdin?.end(options.input);
    }
    const { stdout } = await child;
    return stdout.trim();
  } catch (err) {
    const e = err as { code?: number | null; stderr?: string };
    throw new GitError(args, cwd, e.code ?? null, e.stderr ?? String(err));
  }
}
