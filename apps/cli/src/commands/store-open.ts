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
import { openStore, registerGenerationMigration, registerSyncCursorsMigration, type Store } from "@atlas/sqlite-store";
import { registerJobsMigration } from "@atlas/jobs";
import { CliError, EXIT } from "../errors/envelope.js";
import { ledgerDbPath } from "./paths.js";
import { openWorkflowStore, registerWorkflowMigrations } from "../workflows/index.js";
import type { RunContext } from "../handlers.js";

/**
 * Register EVERY feature-owned migration on a `Store`, BEFORE `Store.migrate()` —
 * the shared migration composition root (plan §2.7, Review-Hint). `@atlas/sqlite-store`
 * owns `0001_core`/`0003`/`0004` and pre-registers them in `openStore`; the two
 * feature migrations it deliberately does NOT know about are registered here:
 *   - `0002_jobs` (owned by `@atlas/jobs`, {@link registerJobsMigration});
 *   - `0006_workflow_idempotency` (owned by the workflows layer, {@link registerWorkflowMigrations}).
 *
 * `db migrate` calls this before `store.migrate()`, so ALL feature migrations are
 * discovered through the one checksum-guarded runner — there is no undiscoverable
 * migration and jobs/read commands never apply DDL ad-hoc. Registering an
 * already-applied migration is a checksum-verified no-op, so calling this on a
 * partially-migrated ledger is safe.
 */
export function registerFeatureMigrations(store: Store): void {
  registerJobsMigration(store);
  registerWorkflowMigrations(store);
  // `0008_index_config_revision` (generation/activation layer). Without this line a
  // real deployment's `db migrate` never applies 0008 and the FIRST live
  // `index rebuild` dies in `GenerationRepo.adoptConfig` ("no such table:
  // index_config_revisions") — the package tests masked it by registering the
  // migration themselves. Found on the 2026-07-16 live drive.
  registerGenerationMigration(store);
  // `0012_sync_cursors` (60-A vault-sync adoption). Registered here so a real
  // `db migrate` applies the per-source sync cursor through the one checksum-guarded
  // runner; the adopt-vault bootstrap seeds the zero-state row afterward.
  registerSyncCursorsMigration(store);
}

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

/** The first required table that is absent from `store`, or `null` if all present. */
function firstMissingTable(store: Store, required: readonly string[]): string | null {
  const has = store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`);
  for (const t of required) {
    if (has.get(t) === undefined) return t;
  }
  return null;
}

/**
 * The projection tables a read-only synthesis PREVIEW (`enrich`/`reconcile`/
 * `maintain`) queries: the `0001_core` note projections AND the `0014_evidence_v2`
 * flat `evidence` projection (read by the maintain unverified-evidence detector).
 * `openMigratedStore`'s bare `0001_core` check is NOT enough — a ledger migrated to
 * core but not `0014` would pass it and then die with an internal `no such table:
 * evidence` when the preview queries the evidence table. Requiring these up front
 * turns that into the typed `db-unavailable` exit 2 (no DDL applied). (The v1
 * `claims`/`claim_evidence` tables were forward-dropped by `0014` — #337.)
 */
export const PREVIEW_PROJECTION_TABLES: readonly string[] = [
  "notes",
  "note_identity_keys",
  "note_links",
  "evidence",
];

/**
 * Open the ledger store, asserting it is ALREADY migrated. Never creates the DB
 * file and never applies DDL — the caller (rebuild / status / a read-only preview)
 * is not the schema owner. Pass `requiredTables` to additionally assert the feature
 * tables the caller queries are present, so a partially-migrated ledger fails with a
 * typed `db-unavailable` (exit 2) instead of an internal no-such-table error. The
 * caller owns closing the returned store.
 */
export function openMigratedStore(ctx: RunContext, requiredTables: readonly string[] = []): Store {
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
  const missing = firstMissingTable(store, requiredTables);
  if (missing !== null) {
    store.close();
    throw dbUnavailable(dbPath, `a required projection table is absent (${missing}) — the ledger is only partially migrated`);
  }
  return store;
}

/**
 * The shared composition root for key-accepting WORKFLOW commands (round-3 finding
 * on idempotency.ts:70-87). A key-accepting command persists its `(command,
 * idempotency_key)` slot in `workflow_idempotency`, which is owned by the feature
 * migration `0006_workflow_idempotency` — NOT part of `openStore`'s default retained
 * set (so a bare store's fresh-DB diff stays exactly the §2.7 core/provenance/claims
 * set, per finding #3). This helper is the ONE production path that opens the ledger,
 * registers the workflows-owned migration(s), and applies them through the normal
 * checksum-guarded runner (`openWorkflowStore` → `registerWorkflowMigrations` +
 * `Store.migrate`). Every key-accepting workflow command (e.g. `reconcile`) opens
 * through THIS root, so the idempotency table is guaranteed present at store-open in
 * production — not merely when a test harness registers it by hand. The caller owns
 * closing the returned store.
 */
export function openWorkflowCommandStore(ctx: RunContext): Store {
  return openWorkflowStore({ path: ledgerDbPath(ctx) });
}

/**
 * Open an already-migrated ledger for the `jobs` commands (plan §2.7 / Review-Hint,
 * round-2 finding). A jobs command is NOT the schema owner — `0002_jobs` is applied
 * by the shared migration composition root (`db migrate` → {@link registerFeatureMigrations}
 * before `store.migrate()`), so jobs commands MUST NOT migrate on their own: a
 * read-only `jobs list` that auto-migrated could create/modify the database, and an
 * ad-hoc per-command migration would defeat the single, discoverable composition
 * root. This delegates to {@link openMigratedStore}, which fails fast with
 * `db-unavailable` (exit 2) when the ledger is absent or unmigrated. The caller owns
 * closing the returned store.
 */
export function openJobsCommandStore(ctx: RunContext): Store {
  return openMigratedStore(ctx);
}
