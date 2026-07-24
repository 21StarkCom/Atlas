/**
 * `commands/paths` — the pure config-path helpers shared across command handlers:
 * resolve a config-relative path against the invocation cwd, and the absolute path
 * to the ledger SQLite DB.
 *
 * v2 (#338): these were relocated out of the retired `backup-config` module (the AEAD
 * backup-key custody + `backupConfig`/`backupConfigForKeyId` died with the §2.8 audit
 * ledger + AEAD backup subsystem). Only the path helpers survive.
 */
import { isAbsolute, resolve } from "node:path";
import type { RunContext } from "../main.js";

/** Absolute path for a config-relative path (resolved against the invocation cwd). */
export function resolvePath(ctx: RunContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

/** Absolute path to the ledger SQLite DB. */
export function ledgerDbPath(ctx: RunContext): string {
  return resolvePath(ctx, ctx.config.config.sqlite.path);
}
