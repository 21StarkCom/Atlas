/**
 * `@atlas/cli` public surface.
 *
 * The CLI foundation (Task 1.8 / #24): the `brain` entrypoint, the terminal-safe
 * renderer (the single human-output path), the JSON error envelope, the lock
 * manager, and diagnostics logging.
 */

// Entrypoint + command registration + the run context handed to handlers.
export {
  runCli,
  main,
  registerCommand,
  type RunContext,
  type CommandHandler,
  type RunCliOptions,
} from "./main.js";

// Terminal-safe renderer — the ONLY human-output path.
export { render, sanitize, type RenderOpts } from "./render/safe.js";
export {
  createProgress,
  isDegraded,
  type ProgressReporter,
  type ProgressOptions,
} from "./render/progress.js";
export { resolveOutputMode, type OutputMode, type OutputFlags } from "./render/plain.js";

// JSON error envelope.
export {
  CliError,
  EXIT,
  emitError,
  writeErrorEnvelope,
  toEnvelope,
  isCliError,
  type ErrorEnvelope,
  type ExitCode,
  type CliErrorInit,
  type ErrorDetails,
  type ErrorLocation,
  type NestedError,
} from "./errors/envelope.js";

// Lock manager.
export {
  withLock,
  configureLocks,
  createLockManager,
  lockManager,
  lockRank,
  subsumes,
  scopesConflict,
  LOCK_SCOPES,
  type LockScope,
  type LockManager,
  type LockManagerOptions,
  type LockOwner,
} from "./locks/manager.js";

// Diagnostics logging.
export {
  diag,
  configureDiag,
  createLoggerFactory,
  redact,
  sanitizeMessage,
  type Logger,
  type LogLevel,
  type LogContext,
  type LoggerFactory,
  type LoggerFactoryOptions,
} from "./diag/logger.js";

// Command routing.
export {
  loadRegistry,
  parseArgv,
  findCommand,
  type Registry,
  type CommandRow,
  type ParsedArgv,
} from "./router.js";
