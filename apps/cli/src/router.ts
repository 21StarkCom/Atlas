/**
 * Command routing (Task 1.8 / #24).
 *
 * Parses argv into global output flags + a command name (matched against the
 * canonical `commands.json` registry — the D-registry SSOT, never re-enumerated
 * here) + the residual argv the command handler consumes. Multi-word command
 * names (`db status`, `source trust promote`) are matched longest-first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OutputFlags } from "./render/plain.js";
import { CliError } from "./errors/envelope.js";

/** A registry row from `docs/specs/cli-contract/commands.json`. */
export interface CommandRow {
  name: string;
  schemaRef: string;
  phase: number;
  idempotency: string;
  privilege: "shared" | "privileged";
  implemented: boolean;
}

/** The parsed command registry. */
export interface Registry {
  version: number;
  commands: CommandRow[];
}

/** Result of parsing argv. */
export interface ParsedArgv {
  /** Global output flags (see {@link OutputFlags}). */
  flags: OutputFlags;
  /** `--config <path>` override, if given. */
  configPath: string | undefined;
  /** `--help`/`-h` requested (possibly for a specific command). */
  help: boolean;
  /** The matched registry command name, or null if none matched. */
  command: string | null;
  /** Residual argv (after the command words are consumed) for the handler. */
  rest: string[];
  /** The leading non-flag tokens (used to report an unknown command). */
  commandTokens: string[];
}

/** Load + parse the canonical command registry, given the repo root. */
export function loadRegistry(repoRoot: string): Registry {
  const path = join(repoRoot, "docs", "specs", "cli-contract", "commands.json");
  return JSON.parse(readFileSync(path, "utf8")) as Registry;
}

/**
 * Parse argv. Global flags may appear anywhere; the command name is the longest
 * registry entry that prefixes the leading non-flag tokens. Everything else is
 * `rest` (forwarded to the handler verbatim, order preserved).
 */
export function parseArgv(argv: string[], registry: Registry): ParsedArgv {
  const flags: OutputFlags = {};
  let configPath: string | undefined;
  let help = false;
  // `remaining` keeps EVERY non-global token in its ORIGINAL order — command
  // words, command-specific flags, and positionals interleaved exactly as given.
  // Only recognized global flags are stripped; nothing is reordered.
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") {
      // Everything after `--` is passthrough, preserved verbatim + in order.
      for (let j = i + 1; j < argv.length; j++) remaining.push(argv[j]!);
      break;
    }
    switch (tok) {
      case "--json":
        flags.json = true;
        continue;
      case "--plain":
        flags.plain = true;
        continue;
      case "--no-color":
        flags.noColor = true;
        continue;
      case "--quiet":
      case "-q":
        flags.quiet = true;
        continue;
      case "--verbose":
      case "-v":
        flags.verbose = true;
        continue;
      case "--help":
      case "-h":
        help = true;
        continue;
      case "--config": {
        const value = argv[++i];
        if (value === undefined) {
          throw CliError.usage(
            "missing value for --config",
            "Pass a path, e.g. `--config /path/to/brain.config.yaml`.",
          );
        }
        configPath = value;
        continue;
      }
    }
    if (tok.startsWith("--config=")) {
      configPath = tok.slice("--config=".length);
      continue;
    }
    // Any other token (command word, command-specific flag, or positional) is a
    // non-global token: keep it in place.
    remaining.push(tok);
  }

  // The command name is the longest registry entry that prefixes the LEADING run
  // of non-flag tokens in `remaining`. Flags never form part of a command name,
  // so matching stops at the first `-`-prefixed token.
  const leadingWords: string[] = [];
  for (const tok of remaining) {
    if (tok.startsWith("-")) break;
    leadingWords.push(tok);
  }
  const { command, consumed } = matchCommand(leadingWords, registry);
  // Drop only the consumed command words from the front; everything else keeps
  // its original order (recognized global flags already removed).
  const rest = remaining.slice(consumed);

  return {
    flags,
    configPath,
    help,
    command,
    rest,
    commandTokens: leadingWords,
  };
}

/**
 * Non-fallible pre-scan of argv for the recognizable global output flags. Used to
 * resolve the requested output mode BEFORE the fallible full parse in
 * {@link parseArgv}, so a usage error (e.g. a missing `--config` value) still
 * honours an already-supplied `--json`/`--quiet`/`--verbose`/`--plain`/`--no-color`
 * and emits the correct envelope. This mirrors the flag names in `parseArgv` (the
 * single source of truth for global-flag spelling) but never throws: unknown
 * tokens, missing values, and command words are simply ignored here.
 */
export function sniffOutputFlags(argv: string[]): OutputFlags {
  const flags: OutputFlags = {};
  for (const tok of argv) {
    if (tok === "--") break; // passthrough boundary: nothing after is a global flag
    switch (tok) {
      case "--json":
        flags.json = true;
        break;
      case "--plain":
        flags.plain = true;
        break;
      case "--no-color":
        flags.noColor = true;
        break;
      case "--quiet":
      case "-q":
        flags.quiet = true;
        break;
      case "--verbose":
      case "-v":
        flags.verbose = true;
        break;
    }
  }
  return flags;
}

/**
 * Match the longest registry command name that is a prefix of `tokens`. Returns
 * the matched name and how many leading tokens it consumed (0 if no match).
 */
function matchCommand(
  tokens: string[],
  registry: Registry,
): { command: string | null; consumed: number } {
  // Sort by descending word count so `source trust show` beats `source`.
  const names = registry.commands
    .map((c) => c.name)
    .sort((a, b) => b.split(" ").length - a.split(" ").length);
  for (const name of names) {
    const words = name.split(" ");
    if (words.length > tokens.length) continue;
    if (words.every((w, i) => tokens[i] === w)) {
      return { command: name, consumed: words.length };
    }
  }
  return { command: null, consumed: 0 };
}

/** Look up a registry row by command name. */
export function findCommand(registry: Registry, name: string): CommandRow | undefined {
  return registry.commands.find((c) => c.name === name);
}
