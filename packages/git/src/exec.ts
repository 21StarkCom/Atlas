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
  /**
   * Environment variables merged over `process.env` for this one invocation.
   * Used to pin `GIT_AUTHOR_*`/`GIT_COMMITTER_*` so a poisoned ambient
   * environment cannot override the deterministic commit identity.
   */
  readonly env?: Readonly<Record<string, string>>;
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
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
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

/**
 * Run `git <args>` returning stdout as RAW BYTES — no trim, no utf8 decode.
 *
 * Exists because {@link runGit} is byte-lossy in two ways that a blob read
 * cannot tolerate: `trim()` eats a blob's leading/trailing whitespace (a
 * trailing newline IS content), and forcing `utf8` mangles non-utf8 bytes
 * (0x80–0xFF sequences become U+FFFD before the caller ever sees them). Blob
 * reads for the sync cycle must be byte-exact against the committed object, so
 * they funnel through here instead. Same discipline as {@link runGit}: this is
 * the ONE raw-argv escape hatch and it stays package-internal — never
 * re-exported from the barrel (the public-surface regression test locks both).
 */
export async function runGitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args as string[], {
      cwd,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    // stderr arrives as a Buffer in buffer mode; GitError carries it as utf8
    // text (error messages are ASCII in practice, and the classification in
    // repo.ts matches on the decoded text).
    const e = err as { code?: number | null; stderr?: string | Buffer };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr instanceof Buffer
          ? e.stderr.toString("utf8")
          : String(err);
    throw new GitError(args, cwd, e.code ?? null, stderr);
  }
}
