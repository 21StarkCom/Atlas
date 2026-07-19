/**
 * `0012_sync_cursors` — the per-source vault-sync cursor (60-A adoption, task 1.3).
 *
 * Live-vault sync absorbs upstream commits from an adopted vault into Atlas's
 * canonical ref. Each source (the adopted vault, keyed by `source_id`) needs a
 * durable cursor recording how far it has been absorbed so a resumed sync is
 * idempotent and monotonic:
 *   - `upstream_ref`        — the ref sync follows on the source (e.g. `refs/atlas/main`);
 *   - `last_absorbed_oid`   — the last upstream commit folded in (NULL at zero-state,
 *                             before the first sync cycle);
 *   - `last_synced_at`      — when the cursor was last advanced (RFC-3339);
 *   - `cycle_seq`           — the monotonic sync-cycle counter (starts at 0);
 *   - `pending_quarantine`  — a JSON array of oids held back by a dirty scan verdict
 *                             (defaults to the empty array `'[]'`).
 *
 * This is AUTHORITATIVE, NON-DERIVED state (like `jobs`): it is NOT rebuildable from
 * canonical Markdown, so `db rebuild` never touches it and it is recovered only from
 * the encrypted ledger backup. It is a FEATURE migration (registered at store-open,
 * NOT in `openStore`'s default retained set), so the `db.migrate-ownership` fresh-DB
 * diff stays exactly the §2.7 core set. Numbering interleaves across packages — it is
 * NOT renumbered to close gaps (the runner is gap-tolerant).
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The DDL owned by `0012_sync_cursors` (the checksum source). */
export const SYNC_CURSORS_DDL = `CREATE TABLE sync_cursors (
  source_id          TEXT    NOT NULL PRIMARY KEY,
  upstream_ref       TEXT    NOT NULL,
  last_absorbed_oid  TEXT,
  last_synced_at     TEXT    NOT NULL,
  cycle_seq          INTEGER NOT NULL DEFAULT 0,
  pending_quarantine TEXT    NOT NULL DEFAULT '[]'
) STRICT;`;

/** The `0012_sync_cursors` migration (registered by the CLI at store-open). */
export const migration0012SyncCursors: Migration = {
  id: "0012_sync_cursors",
  checksum: migrationChecksum(SYNC_CURSORS_DDL),
  up(db) {
    db.exec(SYNC_CURSORS_DDL);
  },
};
