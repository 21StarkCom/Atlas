/**
 * The `brain` entrypoint (Task 1.8 / #24).
 *
 * `runCli(argv, env)` is the single process entry: it parses argv against the
 * canonical command registry, resolves the output mode (`--json|--quiet|--verbose|
 * --plain` + `NO_COLOR`/`TERM`/TTY degradation), loads config, wires the lock
 * manager + diagnostics logger, dispatches to the registered command handler, and
 * maps the outcome to a plan §2.5 process-exit code. Every human byte flows through
 * the renderer; every failure serializes through the JSON error envelope.
 *
 * Command *handlers* are owned by later tasks (1.9, Phase 2+). They register via
 * {@link registerCommand}; this module is pure plumbing and ships no handlers.
 */
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newRunId } from "@atlas/contracts";
import { loadConfig, type LoadedConfig } from "./config/load.js";
import { ConfigError } from "./config/schema.js";
import {
  CliError,
  EXIT,
  isCliError,
  writeErrorEnvelope,
  type ExitCode,
} from "./errors/envelope.js";
import { render, type RenderOpts } from "./render/safe.js";
import { createProgress } from "./render/progress.js";
import { resolveOutputMode, type OutputMode } from "./render/plain.js";
import { configureLocks, withLock } from "./locks/manager.js";
import { configureDiag, diag, type Logger } from "./diag/logger.js";
import { loadRegistry, parseArgv, findCommand, sniffOutputFlags, type Registry } from "./router.js";
import { HANDLERS, registerCommand, type CommandHandler, type RunContext } from "./handlers.js";
// Side-effect import: register the implemented command handlers (Task 1.7+). Must
// come AFTER the handler-registry import so `HANDLERS` is initialized before a
// command module's import-time `registerCommand(...)` runs.
import "./commands/index.js";

// Re-export the registry seam so existing importers (`../main.js`) keep working.
export { registerCommand, type CommandHandler, type RunContext };

/** Options for {@link runCli} (test/DI seams; production uses defaults). */
export interface RunCliOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Handler overrides merged over the global registry (tests inject fakes here). */
  handlers?: Record<string, CommandHandler>;
  /** stdout override (renderer/JSON emitter). Defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** stderr override (human error output + progress). Defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
  /** Repo/install root holding `docs/specs/cli-contract/`. Defaults to auto-detected. */
  root?: string;
}

/** Walk up from `start` until `docs/specs/cli-contract/commands.json` is found. */
function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "docs", "specs", "cli-contract", "commands.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // reached filesystem root; give up gracefully
    dir = parent;
  }
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Parse, route, and execute a single `brain` invocation. Never throws: every
 * failure is serialized (JSON) or rendered (human) and mapped to an exit code.
 */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: RunCliOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const root = options.root ?? findRoot(MODULE_DIR);

  let registry: Registry;
  try {
    registry = loadRegistry(root);
  } catch (e) {
    return fail(
      CliError.internal(`cannot load command registry from ${root}`, e),
      { mode: "human", plain: true, quiet: false, verbose: false },
      stdout,
      stderr,
    );
  }

  // Resolve the output mode from a NON-FALLIBLE pre-scan of the global flags
  // BEFORE the fallible full parse, so a usage error (e.g. a missing `--config`
  // value) still honours an already-supplied `--json` and emits the JSON error
  // envelope instead of human text. The pre-scan can't throw; the full parse can.
  const preOutput = resolveOutputMode(sniffOutputFlags(argv), env, stdout);
  let parsed;
  try {
    parsed = parseArgv(argv, registry);
  } catch (e) {
    const err = isCliError(e) ? e : CliError.internal("cannot parse arguments", e);
    return fail(err, preOutput, stdout, stderr);
  }
  const output = resolveOutputMode(parsed.flags, env, stdout);

  const renderTo = (text: string, opts: Partial<RenderOpts> = {}): string =>
    render(text, { mode: output.mode, quiet: output.quiet, stream: stdout, ...opts });

  // Help / no command → usage summary (exit 0), through the renderer.
  if (parsed.help || parsed.commandTokens.length === 0) {
    if (output.mode !== "json") renderTo(usage(registry));
    return EXIT.OK;
  }

  // Unknown command → usage error (exit 5).
  if (parsed.command === null) {
    return fail(
      CliError.usage(
        `unknown command: \`${parsed.commandTokens.join(" ")}\``,
        "Run `brain --help` for the command list.",
      ),
      output,
      stdout,
      stderr,
    );
  }

  const row = findCommand(registry, parsed.command)!;

  // Load config (exit 2 on any config/vault failure).
  let config: LoadedConfig;
  try {
    config = loadConfig(cwd, env, parsed.configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      const details = e.location.key
        ? { field: e.location.key, location: { file: e.location.file } }
        : { location: { file: e.location.file } };
      return fail(
        new CliError({
          code: "config-invalid",
          message: e.message,
          hint: "Fix the offending key in brain.config.yaml.",
          exitCode: EXIT.CONFIG,
          details,
        }),
        output,
        stdout,
        stderr,
      );
    }
    // Any other startup/configuration failure (filesystem, YAML parse, or an
    // internal config-loader fault) must NOT escape runCli unmapped — route it
    // through fail() as a config error (exit 2) with safe output.
    return fail(
      new CliError({
        code: "config-unreadable",
        message: `failed to load configuration: ${e instanceof Error ? e.message : String(e)}`,
        hint: "Check that brain.config.yaml exists and is readable valid YAML.",
        exitCode: EXIT.CONFIG,
        cause: e,
      }),
      output,
      stdout,
      stderr,
    );
  }

  // Wire the process-wide lock manager + diagnostics logger from config.
  configureLocks({ dir: resolve(cwd, dirname(config.config.sqlite.path), "locks") });
  configureDiag({
    dir: resolve(cwd, config.config.logs.dir),
    maxBytes: config.config.logs.max_bytes,
    maxFiles: config.config.logs.max_files,
    minLevel: output.verbose ? "debug" : "info",
  });

  const runId = newRunId();
  const log = diag(runId).child({ cmd: parsed.command, phase: row.phase });
  const progress = createProgress({ mode: output.mode, quiet: output.quiet, stream: stderr });

  const handler = options.handlers?.[parsed.command] ?? HANDLERS.get(parsed.command);
  if (!handler) {
    return fail(
      new CliError({
        code: "not-implemented",
        message: `command \`${parsed.command}\` is not implemented in this build.`,
        hint: "This command is delivered by a later phase (see the implementation plan).",
        exitCode: EXIT.USAGE,
      }),
      output,
      stdout,
      stderr,
      log,
    );
  }

  const ctx: RunContext = {
    runId,
    command: parsed.command,
    argv: parsed.rest,
    config,
    env,
    cwd,
    output,
    render: renderTo,
    progress,
    log,
    withLock,
  };

  try {
    log.info("command.start");
    const code = await handler(ctx);
    log.info("command.end", { exitCode: code });
    return code;
  } catch (e) {
    const err = isCliError(e)
      ? e
      : CliError.internal(`unhandled error in \`${parsed.command}\``, e);
    return fail(err, output, stdout, stderr, log);
  }
}

/** Emit a failure per output mode and return its exit code. */
function fail(
  err: CliError,
  output: OutputMode,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  log?: Logger,
): ExitCode {
  log?.error("command.error", {
    code: err.code,
    exitCode: err.exitCode,
    retryable: err.retryable,
  });
  if (output.mode === "json") {
    // JSON emitter path (allowed stdout writer).
    return writeErrorEnvelope(err, stdout);
  }
  // Human mode: render the message (+ hint) to stderr through the safe renderer.
  const text = err.hint ? `error: ${err.message}\nhint: ${err.hint}` : `error: ${err.message}`;
  render(text, { mode: "human", quiet: false, stream: stderr });
  return err.exitCode;
}

/** The `--help` / no-args usage summary (grouped by phase, from the registry). */
function usage(registry: Registry): string {
  const lines = ["brain — Atlas CLI", "", "Usage: brain [--json|--plain|--quiet|--verbose] <command> [args]", "", "Commands:"];
  for (const c of [...registry.commands].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  ${c.name}`);
  }
  return lines.join("\n");
}

/**
 * The `brain` process launcher: run a single invocation and terminate with the
 * mapped exit code. The installed `brain` bin (see package.json `bin`) resolves to
 * the compiled `bin.js`, which calls this. Kept separate from module-URL sniffing
 * so it works when invoked through a symlinked bin (where `process.argv[1]` is the
 * symlink path, not this file).
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<never> {
  let code: number;
  try {
    code = await runCli(argv, env);
  } catch (e) {
    // Last-resort guard: an error escaped runCli's own handling.
    writeErrorEnvelope(CliError.internal("fatal", e), process.stdout);
    code = EXIT.INTERNAL;
  }
  return process.exit(code);
}
