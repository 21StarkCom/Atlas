/**
 * `sync/cursor` — read/finalize the `sync_cursors` row (60-B Task 4.2).
 *
 * The row is the SSOT for "how far upstream Atlas has processed" (spec §ssot).
 * `readCursor` parses + validates the durable `pending_quarantine` JSON set
 * fail-closed (a malformed element is an error, never a silently-tolerated
 * value). `finalizeCursor` is deliberately dumb: it persists a caller-supplied,
 * ALREADY-reconciled pending set verbatim in the same statement as the cursor
 * advance — the clear/upsert/`firstSeenOid`-preservation policy lives ONLY in
 * `reconcilePending` (sync/pending.ts), so the ordinary finalize path and a
 * crash-recovery replay can never apply divergent rules.
 *
 * `finalizeCursor` takes the raw db handle (not the Store) because it must run
 * INSIDE the caller's finalize transaction (§2.8 step 3) — never on its own
 * connection, never in its own transaction.
 */
import type { Store } from "@atlas/sqlite-store";

/** One durable pending-quarantine entry (set keyed by `path`). */
export interface PendingEntry {
  readonly path: string;
  readonly quarantineId: string;
  /** 40-hex upstream commit OID where the dirty bytes FIRST appeared. */
  readonly firstSeenOid: string;
}

/** The parsed `sync_cursors` row. */
export interface SyncCursor {
  readonly sourceId: string;
  readonly upstreamRef: string;
  readonly lastAbsorbedOid: string | null;
  readonly lastSyncedAt: string;
  readonly cycleSeq: number;
  readonly pendingQuarantine: readonly PendingEntry[];
}

const OID_RE = /^[0-9a-f]{40}$/;

/** Raised when the durable `pending_quarantine` column fails validation. */
export class MalformedPendingError extends Error {
  constructor(sourceId: string, detail: string) {
    super(`sync_cursors.pending_quarantine for "${sourceId}" is malformed: ${detail}`);
    this.name = "MalformedPendingError";
  }
}

/** Validate one raw pending element fail-closed. */
function validateEntry(sourceId: string, raw: unknown, i: number): PendingEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new MalformedPendingError(sourceId, `element ${i} is not an object`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.path !== "string" || e.path.length === 0) {
    throw new MalformedPendingError(sourceId, `element ${i} has no path`);
  }
  if (typeof e.quarantineId !== "string" || e.quarantineId.length === 0) {
    throw new MalformedPendingError(sourceId, `element ${i} (${e.path}) has no quarantineId`);
  }
  if (typeof e.firstSeenOid !== "string" || !OID_RE.test(e.firstSeenOid)) {
    throw new MalformedPendingError(sourceId, `element ${i} (${e.path}) firstSeenOid is not a 40-hex OID`);
  }
  return { path: e.path, quarantineId: e.quarantineId, firstSeenOid: e.firstSeenOid };
}

/**
 * Serialize a pending set deterministically (sorted by path) so the durable
 * column is byte-stable across replays — a crash-recovery re-write of the same
 * reconciled set is byte-identical to the original write.
 */
export function serializePending(entries: readonly PendingEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify(
    sorted.map((e) => ({ path: e.path, quarantineId: e.quarantineId, firstSeenOid: e.firstSeenOid })),
  );
}

/**
 * Read + validate the cursor row. Returns `null` when the source has no row
 * (an un-adopted vault — the command layer maps that to `vault-error`, exit 2).
 */
export function readCursor(store: Store, sourceId: string): SyncCursor | null {
  const row = store.db
    .prepare(
      `SELECT source_id, upstream_ref, last_absorbed_oid, last_synced_at, cycle_seq, pending_quarantine
         FROM sync_cursors WHERE source_id = ?`,
    )
    .get(sourceId) as
    | {
        source_id: string;
        upstream_ref: string;
        last_absorbed_oid: string | null;
        last_synced_at: string;
        cycle_seq: number;
        pending_quarantine: string;
      }
    | undefined;
  if (row === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.pending_quarantine);
  } catch {
    throw new MalformedPendingError(sourceId, "column is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new MalformedPendingError(sourceId, "column is not a JSON array");
  const pending = parsed.map((e, i) => validateEntry(sourceId, e, i));
  const seen = new Set<string>();
  for (const e of pending) {
    if (seen.has(e.path)) throw new MalformedPendingError(sourceId, `duplicate entry for path ${e.path}`);
    seen.add(e.path);
  }
  if (row.last_absorbed_oid !== null && !OID_RE.test(row.last_absorbed_oid)) {
    throw new MalformedPendingError(sourceId, `last_absorbed_oid "${row.last_absorbed_oid}" is not a 40-hex OID`);
  }
  return {
    sourceId: row.source_id,
    upstreamRef: row.upstream_ref,
    lastAbsorbedOid: row.last_absorbed_oid,
    lastSyncedAt: row.last_synced_at,
    cycleSeq: row.cycle_seq,
    pendingQuarantine: pending,
  };
}

/** The `finalizeCursor` write — everything the finalize transaction persists. */
export interface FinalizeCursorArgs {
  readonly sourceId: string;
  /** The commit boundary the cursor advances to (head, or the --max-paths boundary). */
  readonly newOid: string;
  /** RFC3339 UTC finalize time. */
  readonly now: string;
  /** The ALREADY-reconciled pending set (from `reconcilePending`) — written verbatim. */
  readonly pendingQuarantine: readonly PendingEntry[];
}

/** The db-handle shape `finalizeCursor` needs (better-sqlite3 subset). */
export interface CursorDb {
  prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint } };
}

/**
 * Advance the cursor in ONE statement: `last_absorbed_oid`, `last_synced_at`,
 * `cycle_seq += 1`, and the caller-reconciled pending set — atomically with
 * whatever transaction the caller has open (§2.8 step 3). Throws if the row is
 * missing (the adoption seed is a precondition of every cycle).
 */
export function finalizeCursor(db: CursorDb, args: FinalizeCursorArgs): void {
  if (!OID_RE.test(args.newOid)) {
    throw new Error(`finalizeCursor: newOid "${args.newOid}" is not a 40-hex OID`);
  }
  const info = db
    .prepare(
      `UPDATE sync_cursors
          SET last_absorbed_oid = ?, last_synced_at = ?, cycle_seq = cycle_seq + 1, pending_quarantine = ?
        WHERE source_id = ?`,
    )
    .run(args.newOid, args.now, serializePending(args.pendingQuarantine), args.sourceId);
  if (Number(info.changes) !== 1) {
    throw new Error(`finalizeCursor: no sync_cursors row for source "${args.sourceId}" (vault not adopted)`);
  }
}
