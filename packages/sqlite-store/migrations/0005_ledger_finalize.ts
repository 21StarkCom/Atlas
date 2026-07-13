/**
 * `0005_ledger_finalize` — the FORWARD migration owned by Task 1.7 (ledger
 * finalization + encrypted backup/restore).
 *
 * `0001_core` is already checksummed and applied on existing databases, so it is
 * IMMUTABLE (a changed body is a hard migration-checksum failure, `migrate.ts`).
 * The §2.8 cross-store protocol needs two columns `0001` never carried —
 * `audit_intents.event_json` (the canonical unsigned event, so the reconciler can
 * re-drive step 2) and `audit_intents.write_json` (the run's serializable step-3
 * business writes, so the reconciler replays the COMPLETE step-3 op) — plus the
 * durable backup-retry state (`backup_watermark.retry_count` / `next_retry_at`)
 * the fail-closed retry machine resumes after a restart. This migration adds them
 * with `ALTER TABLE ADD COLUMN` (round-3 finding 5).
 *
 * ## Legacy-pending-intent handling
 * `ADD COLUMN … NOT NULL DEFAULT …` backfills every existing row, so a LEGACY
 * `pending` intent written under `0001` (which had no `event_json`/`write_json`)
 * gets `event_json = ''` and `write_json = '[]'`. `reconcileInterruptedRuns`
 * treats an empty `event_json` as "no re-drivable event persisted" and finalizes
 * such a legacy intent by marking it `done` WITHOUT a broker re-drive (there is no
 * byte-stable event to replay and, being from a prior binary, its step-2/step-3
 * either already landed or is unrecoverable) — never fabricating an event. Fresh
 * intents always carry a non-empty `event_json`, so this path only ever fires for
 * pre-migration rows.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The forward-migration DDL (idempotent-safe ALTERs; §2.8 + durable retry state). */
export const LEDGER_FINALIZE_DDL = `ALTER TABLE audit_intents ADD COLUMN event_json TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_intents ADD COLUMN write_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE backup_watermark ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backup_watermark ADD COLUMN next_retry_at TEXT;`;

/** The `0005_ledger_finalize` migration. */
export const migration0005LedgerFinalize: Migration = {
  id: "0005_ledger_finalize",
  checksum: migrationChecksum(LEDGER_FINALIZE_DDL),
  up(db) {
    db.exec(LEDGER_FINALIZE_DDL);
  },
};
