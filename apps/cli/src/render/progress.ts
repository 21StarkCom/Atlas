/**
 * Append-only progress announcements (Task 1.8 / #24).
 *
 * When output is degraded (`--plain`, `NO_COLOR`, `--no-color`, `TERM=dumb`, or a
 * non-TTY stdout — see {@link isDegraded}), a long-running command MUST NOT redraw
 * a spinner or rewrite a line with CR (the renderer strips CR anyway). Instead it
 * emits discrete, append-only lines:
 *
 *     started: <label>
 *     progress: <done>/<total> <label?>
 *     done: <label>
 *
 * Consecutive identical lines are suppressed (`non-duplicated`), so a caller that
 * reports the same fraction twice does not spam the log.
 *
 * Every line goes through {@link render}, so progress output is terminal-safe and
 * flows through the single human-output channel.
 */
import { render, type RenderOpts } from "./safe.js";

/** A progress reporter over a single command run. */
export interface ProgressReporter {
  /** Announce the start of work. Emitted at most once. */
  started(label: string): void;
  /** Announce incremental progress `done/total`. Duplicate lines are suppressed. */
  progress(done: number, total: number, label?: string): void;
  /** Announce completion. Emitted at most once. */
  done(label?: string): void;
}

/** Options for {@link createProgress}. */
export interface ProgressOptions {
  /** Output mode; `"json"` suppresses all human progress. */
  mode: "human" | "json";
  /** Suppress progress (`--quiet`). */
  quiet: boolean;
  /** Destination stream. Defaults to `process.stderr` (progress is not primary output). */
  stream?: NodeJS.WritableStream;
}

/**
 * Detect degraded (non-decorated) output. Progress is ALWAYS append-only here —
 * Atlas never emits redraw/spinner control sequences — so this is informational:
 * it confirms plain mode is the only mode. Callers may use it to shorten labels.
 */
export function isDegraded(env: NodeJS.ProcessEnv, stream: NodeJS.WritableStream): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return true;
  if (env.TERM === "dumb") return true;
  const isTTY = (stream as NodeJS.WriteStream).isTTY === true;
  return !isTTY;
}

/**
 * Create an append-only {@link ProgressReporter}. `started`/`done` fire once each;
 * `progress` suppresses a line identical to the previously emitted one.
 */
export function createProgress(opts: ProgressOptions): ProgressReporter {
  const renderOpts: Partial<RenderOpts> = {
    mode: opts.mode,
    quiet: opts.quiet,
    stream: opts.stream ?? process.stderr,
    newline: true,
  };
  let startedEmitted = false;
  let doneEmitted = false;
  let lastLine: string | null = null;

  function emit(line: string): void {
    if (line === lastLine) return; // non-duplicated: skip an identical consecutive line
    lastLine = line;
    render(line, renderOpts);
  }

  return {
    started(label: string): void {
      if (startedEmitted) return;
      startedEmitted = true;
      emit(`started: ${label}`);
    },
    progress(done: number, total: number, label?: string): void {
      emit(`progress: ${done}/${total}${label ? ` ${label}` : ""}`);
    },
    done(label?: string): void {
      if (doneEmitted) return;
      doneEmitted = true;
      emit(`done${label ? `: ${label}` : ""}`);
    },
  };
}
