/**
 * Command-handler registry (Task 1.8 seam, extracted for Task 1.7).
 *
 * Holds the `RunContext` a handler receives, the `CommandHandler` type, the global
 * `HANDLERS` map, and `registerCommand`. This lives in its OWN leaf module — NOT in
 * `main.ts` — so command modules (`commands/db-backup.ts`, …) can call
 * `registerCommand(...)` at import time WITHOUT forming a runtime import cycle with
 * `main.ts`. (`main.ts` side-effect-imports `commands/index.js` at its top; if the
 * registry lived in `main.ts`, that import would run `registerCommand` before
 * `main.ts`'s own `const HANDLERS` initialized — a temporal-dead-zone crash.)
 */
import type { LoadedConfig } from "./config/load.js";
import type { RenderOpts } from "./render/safe.js";
import type { ProgressReporter } from "./render/progress.js";
import type { OutputMode } from "./render/plain.js";
import type { LockManager } from "./locks/manager.js";
import type { Logger } from "./diag/logger.js";

/** Everything a command handler receives. */
export interface RunContext {
  /** ULID correlating every log line + audit event of this invocation. */
  readonly runId: string;
  /** The matched registry command name. */
  readonly command: string;
  /** Residual argv for the command (global flags already consumed). */
  readonly argv: string[];
  /** Loaded, validated config. */
  readonly config: LoadedConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Resolved output mode/degradation. */
  readonly output: OutputMode;
  /** The ONLY human-output path (bound to this run's mode/quiet). */
  render(text: string, opts?: Partial<RenderOpts>): string;
  /** Append-only progress reporter for long-running work. */
  readonly progress: ProgressReporter;
  /** Run-correlated diagnostics logger. */
  readonly log: Logger;
  /** Named-scope lock acquisition (global-order enforced). */
  readonly withLock: LockManager["withLock"];
}

/** A command handler returns its process-exit code (0 on success). */
export type CommandHandler = (ctx: RunContext) => Promise<number> | number;

/** The process-wide handler registry, populated at import time by command modules. */
export const HANDLERS = new Map<string, CommandHandler>();

/** Register the handler for a registry command. Command modules call this at import time. */
export function registerCommand(name: string, handler: CommandHandler): void {
  HANDLERS.set(name, handler);
}
