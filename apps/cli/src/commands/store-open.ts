/**
 * `openMigratedStore` — open the ledger store for a command that must NOT own the
 * schema (round-2 finding F5).
 *
 * `db rebuild` (projection-only) and `status` (read-only summary) are both
 * forbidden from creating the database or applying DDL: rebuild must never touch
 * `db_schema_migrations`, and `status` is a read surface that must not conjure a
 * store or run a migration. `openStore(...).migrate()` would do exactly that (it
 * CREATES the file and applies `0001_core`). This helper instead REQUIRES an
 * already-migrated ledger: it fails fast with a `db-unavailable` `CliError`
 * (exit 2) when the DB file is absent or `0001_core` has not been applied, and
 * otherwise returns the open store WITHOUT migrating.
 */
import { existsSync } from "node:fs";
import { openStore, type Store } from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";
import { ledgerDbPath } from "./backup-config.js";
import type { RunContext } from "../handlers.js";

/** The core migration whose presence proves the ledger has been migrated. */
const CORE_MIGRATION_ID = "0001_core";

function dbUnavailable(dbPath: string, detail: string): CliError {
  return new CliError({
    code: "db-unavailable",
    message: `the ledger store at ${dbPath} is unavailable: ${detail}`,
    hint: "Run `brain db migrate` first (this command requires an already-migrated ledger and does not create one), or check sqlite.path in brain.config.yaml.",
    exitCode: EXIT.CONFIG,
  });
}

/** True iff `db_schema_migrations` exists AND records `0001_core` as applied. */
function isMigrated(store: Store): boolean {
  const hasTable = store.db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'db_schema_migrations'`)
    .get() !== undefined;
  if (!hasTable) return false;
  return store.db.prepare(`SELECT 1 FROM db_schema_migrations WHERE id = ?`).get(CORE_MIGRATION_ID) !== undefined;
}

/**
 * Open the ledger store, asserting it is ALREADY migrated. Never creates the DB
 * file and never applies DDL — the caller (rebuild / status) is not the schema
 * owner. The caller owns closing the returned store.
 */
export function openMigratedStore(ctx: RunContext): Store {
  const dbPath = ledgerDbPath(ctx);
  if (!existsSync(dbPath)) throw dbUnavailable(dbPath, "no ledger database exists yet");

  let store: Store;
  try {
    store = openStore({ path: dbPath });
  } catch (e) {
    throw dbUnavailable(dbPath, e instanceof Error ? e.message : String(e));
  }

  if (!isMigrated(store)) {
    store.close();
    throw dbUnavailable(dbPath, "the ledger has not been migrated (0001_core absent)");
  }
  return store;
}
