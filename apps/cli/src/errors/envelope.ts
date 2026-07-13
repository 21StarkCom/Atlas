/**
 * The JSON error-envelope emitter (Task 1.8 / #24).
 *
 * `CliError` is the single failure type every command throws; `toEnvelope` renders
 * it into the discriminated object defined by
 * `docs/specs/cli-contract/error-envelope.schema.json`; `emitError` is the JSON
 * emitter (the ONLY module besides the renderer permitted to write to stdout).
 *
 * Every `CliError` carries an `exitCode` from the plan §2.5 process-exit set:
 *   0 ok · 1 validation · 2 config/vault/lock · 3 secret-scan · 4 internal ·
 *   5 user/usage · 6 action-required.
 */

/** The plan §2.5 process-exit categories. `0` never carries an error. */
export const EXIT = {
  OK: 0,
  VALIDATION: 1,
  CONFIG: 2,
  SECRET_SCAN: 3,
  INTERNAL: 4,
  USAGE: 5,
  ACTION_REQUIRED: 6,
} as const;

/** A non-`OK` process-exit code. */
export type ExitCode = 1 | 2 | 3 | 4 | 5 | 6;

/** Source location for a failure that maps to a concrete file (schema `$defs.location`). */
export interface ErrorLocation {
  file: string;
  line?: number;
  span?: [number, number];
}

/** Code-specific typed remediation data (schema `$defs.details`; open object). */
export interface ErrorDetails {
  field?: string;
  path?: string;
  location?: ErrorLocation;
  [key: string]: unknown;
}

/** A single nested failure inside `errors[]` (schema `$defs.nestedError`). */
export interface NestedError {
  code: string;
  message: string;
  hint?: string;
  details?: ErrorDetails;
  retryable?: boolean;
  retryAfterMs?: number;
  runId?: string;
  jobId?: string;
}

/** The serialized error envelope — matches `error-envelope.schema.json`. */
export interface ErrorEnvelope {
  code: string;
  message: string;
  hint: string;
  retryable: boolean;
  details?: ErrorDetails;
  errors?: NestedError[];
  retryAfterMs?: number;
  runId?: string;
  jobId?: string;
}

/** Fields accepted when constructing a {@link CliError}. */
export interface CliErrorInit {
  /** Stable, command-specific discriminator (e.g. `usage`, `locked:vault-maintenance`). */
  code: string;
  /** Human-readable, terminal-safe summary. */
  message: string;
  /** Process-exit category (plan §2.5). */
  exitCode: ExitCode;
  /** Actionable next step; empty when no remediation applies. */
  hint?: string;
  /** May the caller retry the identical invocation? Defaults to false. */
  retryable?: boolean;
  details?: ErrorDetails;
  errors?: NestedError[];
  retryAfterMs?: number;
  runId?: string;
  jobId?: string;
  /** Underlying cause, retained for diagnostics (never serialized into the envelope). */
  cause?: unknown;
}

/**
 * The single CLI failure type. Thrown by command handlers and the foundation;
 * caught by `runCli`, which serializes it (`--json`) or renders its message
 * (human mode) and returns `exitCode`.
 */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint: string;
  readonly retryable: boolean;
  readonly details: ErrorDetails | undefined;
  readonly errors: NestedError[] | undefined;
  readonly retryAfterMs: number | undefined;
  readonly runId: string | undefined;
  readonly jobId: string | undefined;

  constructor(init: CliErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "CliError";
    this.code = init.code;
    this.exitCode = init.exitCode;
    this.hint = init.hint ?? "";
    this.retryable = init.retryable ?? false;
    this.details = init.details;
    this.errors = init.errors;
    this.retryAfterMs = init.retryAfterMs;
    this.runId = init.runId;
    this.jobId = init.jobId;
  }

  /** Convenience: a `usage` error (exit 5). */
  static usage(message: string, hint = ""): CliError {
    return new CliError({ code: "usage", message, hint, exitCode: EXIT.USAGE });
  }

  /** Convenience: an `internal` error (exit 4). */
  static internal(message: string, cause?: unknown): CliError {
    return new CliError({
      code: "internal",
      message,
      exitCode: EXIT.INTERNAL,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** True when `e` is (or quacks like) a {@link CliError}. */
export function isCliError(e: unknown): e is CliError {
  return e instanceof CliError;
}

/** Build the serializable envelope from a {@link CliError}, omitting absent optional fields. */
export function toEnvelope(e: CliError): ErrorEnvelope {
  const env: ErrorEnvelope = {
    code: e.code,
    message: e.message,
    hint: e.hint,
    retryable: e.retryable,
  };
  if (e.details !== undefined) env.details = e.details;
  if (e.errors !== undefined) env.errors = e.errors;
  if (e.retryAfterMs !== undefined) env.retryAfterMs = e.retryAfterMs;
  if (e.runId !== undefined) env.runId = e.runId;
  if (e.jobId !== undefined) env.jobId = e.jobId;
  return env;
}

/**
 * Write the JSON error envelope for `e` to `stream` as a single NDJSON line.
 * This is the JSON emitter — one of only two modules allowed to write to stdout
 * (the other is the renderer). Returns the exit code (does not exit the process),
 * so `runCli` stays a pure `Promise<number>`.
 */
export function writeErrorEnvelope(
  e: CliError,
  stream: NodeJS.WritableStream = process.stdout,
): ExitCode {
  stream.write(`${JSON.stringify(toEnvelope(e))}\n`);
  return e.exitCode;
}

/**
 * Emit a structured JSON success payload as a single NDJSON line. This is the
 * JSON-success counterpart to {@link writeErrorEnvelope}; keeping it here means
 * command handlers never write to stdout themselves (the "single output channel"
 * invariant — enforced by `no-render-bypass.test.ts`, which allowlists this file
 * as the JSON emitter). Callers gate on `--json` mode before calling.
 */
export function emitJson(
  obj: unknown,
  stream: NodeJS.WritableStream = process.stdout,
): void {
  stream.write(`${JSON.stringify(obj)}\n`);
}

/**
 * Emit `e`'s envelope to stdout and terminate the process with its exit code.
 * The `never` return reflects that this is a terminal operation; `runCli` uses
 * {@link writeErrorEnvelope} instead so it can return a code for tests.
 */
export function emitError(e: CliError): never {
  writeErrorEnvelope(e, process.stdout);
  process.exit(e.exitCode);
}
