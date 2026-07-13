/**
 * Diagnostics logging (Task 1.8 / #24).
 *
 * Structured JSONL to `logs.dir`, one object per line:
 *   `{ ts, level, runId?, jobId?, msg, ...ctx }`
 *
 * Correlates every line to a run (and, via `child({ jobId })`, a job). Enforces a
 * REDACTION BOUNDARY (plan §2.5, review hint): raw prompts/quotes/secrets never
 * reach the log. Callers pass only allowlisted metadata, and as defense-in-depth
 * the logger scrubs any context key whose name matches a sensitive pattern before
 * serialization. Rotation + retention honor `logs.max_bytes` / `logs.max_files`.
 */
import { mkdirSync, appendFileSync, statSync, renameSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Structured context — must contain allowlisted metadata only (never raw payloads). */
export type LogContext = Record<string, unknown>;

/** The per-run logger handed to command code. */
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** Derive a logger with additional bound context (e.g. `{ jobId }`). */
  child(ctx: LogContext): Logger;
}

/** Options for {@link createLoggerFactory}. Injectable for deterministic tests. */
export interface LoggerFactoryOptions {
  /** Directory for `atlas.log` (+ rotated `atlas.log.N`). Created if absent. */
  dir: string;
  /** Rotate the active file once it would exceed this many bytes. */
  maxBytes: number;
  /** Keep at most this many files total (active + rotated). */
  maxFiles: number;
  /** Current time source. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /** Base name of the active log file. Defaults to `atlas.log`. */
  fileName?: string;
  /**
   * Minimum level to emit. Defaults to `debug` (emit everything); `runCli` raises
   * it to `info` unless `--verbose`.
   */
  minLevel?: LogLevel;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Context keys whose values are redacted. Matches raw prompt/quote/secret carriers
 * — the boundary the plan forbids crossing. Substring match, case-insensitive.
 */
const SENSITIVE_KEY = /prompt|quote|secret|password|passphrase|token|api[_-]?key|credential|authorization|\bauth\b|private[_-]?key|cookie|session|raw|payload|content|body|text|plaintext/i;

const REDACTED = "[redacted]";
const REDACTED_MSG = "[redacted-message]";

/**
 * A STABLE EVENT IDENTIFIER: a dotted/kebab lowercase token such as
 * `command.start`, `lock.acquired`, `backup-unhealthy`. Message strings are
 * restricted to this shape so the free-form `msg` field can never smuggle raw
 * prompts, quoted content, exception text, or secrets across the redaction
 * boundary (plan §2.5). Anything else is replaced with `[redacted-message]`.
 */
const EVENT_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const MAX_EVENT_ID_LEN = 64;

/** Keep `msg` only if it is a stable event identifier; otherwise redact it. */
export function sanitizeMessage(msg: unknown): string {
  return typeof msg === "string" && msg.length <= MAX_EVENT_ID_LEN && EVENT_ID.test(msg)
    ? msg
    : REDACTED_MSG;
}

/** Recursively replace values under sensitive keys with `[redacted]`. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

/** The factory produced by {@link createLoggerFactory}: `diag(runId): Logger`. */
export interface LoggerFactory {
  diag(runId: string | null): Logger;
}

function rotateIfNeeded(
  dir: string,
  fileName: string,
  maxBytes: number,
  maxFiles: number,
  nextLen: number,
): void {
  const active = join(dir, fileName);
  let size = 0;
  try {
    size = statSync(active).size;
  } catch {
    size = 0;
  }
  if (size === 0 || size + nextLen <= maxBytes) return;

  // Shift atlas.log.(N-1) → atlas.log.N, dropping anything beyond maxFiles, then
  // atlas.log → atlas.log.1. `maxFiles` counts the active file, so the highest
  // rotated index kept is maxFiles - 1.
  const highest = Math.max(0, maxFiles - 1);
  // Drop the oldest that would exceed retention.
  const overflow = join(dir, `${fileName}.${highest}`);
  if (existsSync(overflow)) rmSync(overflow, { force: true });
  for (let i = highest - 1; i >= 1; i--) {
    const from = join(dir, `${fileName}.${i}`);
    if (existsSync(from)) renameSync(from, join(dir, `${fileName}.${i + 1}`));
  }
  if (highest >= 1) renameSync(active, join(dir, `${fileName}.1`));
  else rmSync(active, { force: true }); // maxFiles <= 1: no history kept
}

/**
 * Build a {@link LoggerFactory} writing JSONL under `dir` with rotation/retention.
 * Writes are synchronous appends — deterministic and crash-consistent line-by-line.
 */
export function createLoggerFactory(options: LoggerFactoryOptions): LoggerFactory {
  const {
    dir,
    maxBytes,
    maxFiles,
    now = () => new Date().toISOString(),
    fileName = "atlas.log",
    minLevel = "debug",
  } = options;
  const minRank = LEVEL_RANK[minLevel];
  const active = join(dir, fileName);

  function write(level: LogLevel, runId: string | null, bound: LogContext, msg: string, ctx?: LogContext): void {
    if (LEVEL_RANK[level] < minRank) return;
    // Reserved fields (ts/level/runId/jobId/msg) are trusted and MUST win over any
    // caller-supplied key. Strip them from the user-controlled bound/ctx spreads and
    // assert the trusted values LAST, so `log.info("evt", { msg, runId, ts })` cannot
    // spoof the sanitized message or the correlation fields. jobId comes only from a
    // `child({ jobId })` binding (bound), never from ad-hoc ctx.
    const stripReserved = (c: LogContext): LogContext => {
      const { ts: _t, level: _l, runId: _r, jobId: _j, msg: _m, ...rest } = redact(c) as Record<
        string,
        unknown
      >;
      return rest as LogContext;
    };
    const boundJobId = (redact(bound) as Record<string, unknown>).jobId;
    const record: Record<string, unknown> = {
      ...stripReserved(bound),
      ...(ctx ? stripReserved(ctx) : {}),
      ts: now(),
      level,
      ...(runId !== null ? { runId } : {}),
      ...(typeof boundJobId === "string" ? { jobId: boundJobId } : {}),
      // `msg` is restricted to a stable event identifier — never free-form text —
      // so an accidental `log.info(rawPrompt)` or exception-message string cannot
      // cross the never-log-prompts/quotes/secrets boundary.
      msg: sanitizeMessage(msg),
    };
    const line = `${JSON.stringify(record)}\n`;
    mkdirSync(dir, { recursive: true });
    rotateIfNeeded(dir, fileName, maxBytes, maxFiles, Buffer.byteLength(line));
    appendFileSync(active, line);
  }

  function make(runId: string | null, bound: LogContext): Logger {
    return {
      debug: (msg, ctx) => write("debug", runId, bound, msg, ctx),
      info: (msg, ctx) => write("info", runId, bound, msg, ctx),
      warn: (msg, ctx) => write("warn", runId, bound, msg, ctx),
      error: (msg, ctx) => write("error", runId, bound, msg, ctx),
      child: (ctx) => make(runId, { ...bound, ...(redact(ctx) as LogContext) }),
    };
  }

  return { diag: (runId) => make(runId, {}) };
}

// ---------------------------------------------------------------------------
// Default process-wide factory (the produced `diag(runId)` in the plan interface).
// ---------------------------------------------------------------------------

let defaultFactory: LoggerFactory | null = null;

/** Configure the process-wide logger factory (called once by `runCli` from config). */
export function configureDiag(options: LoggerFactoryOptions): LoggerFactory {
  defaultFactory = createLoggerFactory(options);
  return defaultFactory;
}

/**
 * The plan-interface `diag(runId): Logger`, bound to the default factory. Before
 * `configureDiag` is called, returns a no-op logger (so early failures can log
 * safely without a configured sink).
 */
export function diag(runId: string | null): Logger {
  if (!defaultFactory) return noopLogger();
  return defaultFactory.diag(runId);
}

function noopLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
