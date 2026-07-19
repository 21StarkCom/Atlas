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

  /**
   * Convenience: a `secret-scan` refusal (exit 3). Maps a scan guard's
   * {@link SecretDetectedError} to the CLI boundary — the offending bytes are
   * already quarantined (AEAD, ciphertext-only) by the time this is raised.
   */
  static secretScan(message: string, hint = "", cause?: unknown): CliError {
    return new CliError({
      code: "secret-scan",
      message,
      hint,
      exitCode: EXIT.SECRET_SCAN,
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
 * Escape C0 AND C1 control characters (incl. U+009B CSI) in a string as JSON
 * `\uXXXX` sequences. `JSON.stringify` alone escapes C0 but passes C1 RAW — a
 * terminal-injection surface on any consumer that prints stream free-text
 * (`watch.error.message`, `job.lastError`). Applied to the SERIALIZED line by
 * {@link emitLineAwaitable}, where it can only land inside string literals.
 */
export function escapeControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

/** Thrown by {@link emitLineAwaitable} when the consumer closed the pipe (EPIPE-class) — the stream maps it to a clean exit 0 (§10.1), never SIGPIPE/141. */
export class StdoutClosedError extends Error {
  constructor(cause: unknown) {
    super("stdout closed by the consumer (EPIPE)");
    this.cause = cause;
  }
}

/** Error codes that mean "the reader went away" — detach is success, not failure. */
const PIPE_CLOSED_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

/**
 * The BLOCKING NDJSON line writer for long-lived streams (`watch`): serialize,
 * escape C0+C1 in the serialized form (stringify already escaped C0 inside
 * strings; the C1 pass here covers what it passes raw), `\n`-terminate, and
 * AWAIT completion — resolving on the write callback and, when `write()` returns
 * `false`, only after `'drain'` — so a slow consumer backpressures the producer
 * and nothing is ever dropped or reordered. An EPIPE-class failure rejects with
 * {@link StdoutClosedError} (the caller exits 0). The one-shot {@link emitJson}
 * (which ignores backpressure) stays intact for one-shot commands.
 */
export function emitLineAwaitable(obj: unknown, stream: NodeJS.WriteStream = process.stdout): Promise<void> {
  const line = `${escapeControls(JSON.stringify(obj))}\n`;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // A write failure ALSO fires the stream's 'error' event; left unhandled that
    // event crashes the process (uncaughtException, exit 1) before the callback
    // path can map EPIPE to the clean exit-0 signal — so handle BOTH, settle once.
    const onStreamError = (e: unknown): void => fail(e);
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      stream.removeListener("error", onStreamError);
      fn();
    };
    const fail = (e: unknown): void => {
      const code = (e as NodeJS.ErrnoException)?.code ?? "";
      settle(() => reject(PIPE_CLOSED_CODES.has(code) ? new StdoutClosedError(e) : (e as Error)));
    };
    stream.once("error", onStreamError);
    let needsDrain = false;
    try {
      needsDrain = !stream.write(line, (err) => {
        if (err) {
          fail(err);
          return;
        }
        if (!needsDrain) settle(resolve);
      });
    } catch (e) {
      fail(e);
      return;
    }
    if (needsDrain) {
      stream.once("drain", () => settle(resolve));
    }
  });
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
