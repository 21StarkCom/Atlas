/**
 * `sync/seed` — seed the per-source `sync_cursors` row at adoption (60-A task 1.5).
 *
 * Adoption creates ONE zero-state cursor for the adopted vault: no absorbed oid yet,
 * `cycle_seq` 0, an empty `pending_quarantine`, and a real `last_synced_at` stamp.
 * The insert is `INSERT OR IGNORE`, so re-running adoption (or the operator command
 * twice) NEVER clobbers an advanced cursor — a real sync that has moved
 * `last_absorbed_oid`/`cycle_seq` forward is left untouched. This is the idempotent
 * bridge the adopt-vault bootstrap invokes via `seed-cli`.
 */
import type { Store } from "@atlas/sqlite-store";

/** Arguments for {@link seedSyncCursor}. */
export interface SeedSyncCursorArgs {
  /** The source key (the adopted vault), e.g. `main-vault`. */
  readonly sourceId: string;
  /** The upstream ref sync follows on the source, e.g. `refs/atlas/main`. */
  readonly upstreamRef: string;
  /** Injectable clock (RFC-3339) for the `last_synced_at` stamp. */
  readonly now?: () => string;
}

/** Outcome of a seed: `seeded` is false when the row already existed (no-op). */
export interface SeedSyncCursorResult {
  readonly sourceId: string;
  readonly upstreamRef: string;
  /** True iff a NEW zero-state row was inserted; false when an existing row was preserved. */
  readonly seeded: boolean;
}

/**
 * Insert the zero-state `sync_cursors` row for `sourceId` if absent. Idempotent:
 * an existing (possibly advanced) row is preserved via `INSERT OR IGNORE`. Requires
 * an ALREADY-MIGRATED store (the `0012_sync_cursors` table must exist).
 */
export function seedSyncCursor(store: Store, args: SeedSyncCursorArgs): SeedSyncCursorResult {
  const now = (args.now ?? (() => new Date().toISOString()))();
  const info = store.db
    .prepare(
      `INSERT OR IGNORE INTO sync_cursors
         (source_id, upstream_ref, last_absorbed_oid, last_synced_at, cycle_seq, pending_quarantine)
       VALUES (?, ?, NULL, ?, 0, '[]')`,
    )
    .run(args.sourceId, args.upstreamRef, now);
  return { sourceId: args.sourceId, upstreamRef: args.upstreamRef, seeded: info.changes > 0 };
}
