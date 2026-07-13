/**
 * Output-mode + degradation resolution (Task 1.8 / #24).
 *
 * Collapses the global output flags and environment into the render decisions the
 * renderer + progress reporter consume:
 *
 *   - `mode`     — `"json"` when `--json`, else `"human"`.
 *   - `plain`    — degraded/undecorated output: `--plain` OR `--no-color` OR
 *                  `NO_COLOR` set OR `TERM=dumb` OR stdout is not a TTY.
 *   - `quiet`    — `--quiet` (suppress ordinary human output).
 *   - `verbose`  — `--verbose` (raise diagnostics to debug level).
 *
 * The renderer strips every colour/redraw escape regardless, so `plain` never
 * changes *safety* — it only signals that decorated output would be pointless,
 * which the progress reporter uses to stay strictly append-only.
 */

/** Resolved presentation for a single `runCli` invocation. */
export interface OutputMode {
  mode: "human" | "json";
  plain: boolean;
  quiet: boolean;
  verbose: boolean;
}

/** The global output flags parsed off argv. */
export interface OutputFlags {
  json?: boolean;
  plain?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

/** Resolve the effective {@link OutputMode} from flags, env, and the stdout stream. */
export function resolveOutputMode(
  flags: OutputFlags,
  env: NodeJS.ProcessEnv,
  stdout: NodeJS.WritableStream = process.stdout,
): OutputMode {
  const noColorEnv = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const dumbTerm = env.TERM === "dumb";
  const notTty = (stdout as NodeJS.WriteStream).isTTY !== true;
  const plain =
    flags.plain === true || flags.noColor === true || noColorEnv || dumbTerm || notTty;
  return {
    mode: flags.json === true ? "json" : "human",
    plain,
    quiet: flags.quiet === true,
    verbose: flags.verbose === true,
  };
}
