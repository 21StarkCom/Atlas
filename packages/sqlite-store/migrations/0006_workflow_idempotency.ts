/**
 * `0006_workflow_idempotency` — the caller-idempotency table for key-accepting
 * workflow commands (Task 2.5).
 *
 * ## Migration ownership (plan §2.7 + the retained-vs-feature PR split)
 * This is a FEATURE migration, authored and registered exactly like `0002_jobs`
 * (PR-B): it lives here in `packages/sqlite-store/migrations/` as a first-class,
 * checksum-guarded {@link Migration}, but it is NOT part of `openStore`'s default
 * retained set (`0001`/`0003`/`0004`/`0005`). The workflows layer registers it via
 * `Store.registerMigration` before `Store.migrate()` at store-open, so:
 *
 *   - the table is DECLARED and singly-owned, recorded in `db_schema_migrations`,
 *     and checksum-verified on every open (a changed body is a hard failure) — the
 *     "exactly one migration creates each table" invariant (§2.7) is honoured; and
 *   - the `db.migrate-ownership` fresh-DB diff (which opens a BARE store) stays
 *     exactly the §2.7 core/provenance/claims set — §2.7 lists no idempotency
 *     table, so it must NOT appear in the default set.
 *
 * It is applied at store-open through the NORMAL `runMigrations` runner — never
 * lazily created (`CREATE TABLE IF NOT EXISTS`) during a command, which would be an
 * undeclared, unowned table (the round finding #3 objection this migration closes).
 * The gap-tolerant runner (Task 1.4) applies `0006` after the retained set even
 * though `0002_jobs` may be absent — do NOT assume contiguous numbering.
 *
 * ## PR split (per the plan's "Retained-vs-feature PR split for migrations")
 * THIS migration file is the RETAINED-migration half of Task #31: a schema-owning
 * migration lands in its own PR (so the migration inventory grows by exactly one
 * declared, checksum-frozen file), while the feature code that USES the table
 * (`apps/cli/src/workflows/idempotency.ts`) is the feature half — the two are
 * reviewed/merged as the split the plan mandates.
 *
 * The DDL is deliberately minimal: the natural key `(command, idempotency_key)`,
 * the normalized `request_hash`, the terminal `result_json`, the `state`, and the
 * owning `run_id`.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The DDL owned by `0006_workflow_idempotency` (the checksum source). */
export const WORKFLOW_IDEMPOTENCY_DDL = `CREATE TABLE workflow_idempotency (
  command         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('in-progress', 'done')),
  result_json     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (command, idempotency_key)
) STRICT;`;

/** The `0006_workflow_idempotency` migration (registered by the workflows layer). */
export const migration0006WorkflowIdempotency: Migration = {
  id: "0006_workflow_idempotency",
  checksum: migrationChecksum(WORKFLOW_IDEMPOTENCY_DDL),
  up(db) {
    db.exec(WORKFLOW_IDEMPOTENCY_DDL);
  },
};
