/**
 * `sync/pending` — the SOLE owner of the pending-quarantine reconcile policy
 * (60-B Task 4.6; spec §behavior "Pending-quarantine lifecycle").
 *
 * The durable set is keyed by path (at most one entry per path) and reconciled
 * every finalized cycle:
 *
 * - **Clear** — a path that this cycle scanned clean / was archived / was
 *   renamed away leaves the set (a durable pending record for it would be stale).
 * - **Upsert** — a path that scanned dirty this cycle gains/replaces its entry.
 *   `firstSeenOid` is PRESERVED from the surviving prior entry (it records where
 *   the dirt FIRST appeared, not the latest sighting). A path that was cleared
 *   earlier in the same cycle and re-dirtied by a later commit gets the NEW
 *   OID — the old dirt was corrected mid-range; this is a fresh occurrence.
 * - **Untouched** — a pending path not in this cycle's diff keeps its entry.
 *
 * `finalizeCursor` (sync/cursor.ts) writes the returned set verbatim; it never
 * re-applies any part of this policy, so live finalize and crash-recovery
 * replay cannot diverge.
 */
import type { PendingEntry } from "./cursor.js";

export interface ReconcilePendingArgs {
  /** Paths whose terminal disposition this cycle clears the entry (clean absorb / archive / rename-away). */
  readonly clearedPaths: readonly string[];
  /** Paths quarantined this cycle, with the entry to upsert (firstSeenOid = the sighting commit). */
  readonly upsertedDirty: readonly PendingEntry[];
}

/** The reconcile result: the new set plus which existing entries were actually removed. */
export interface ReconciledPending {
  readonly entries: readonly PendingEntry[];
  /** The prior entries removed by `clearedPaths` (for the envelope's `clearedPending[]`). */
  readonly cleared: readonly PendingEntry[];
}

/** Apply the lifecycle policy. Pure; deterministic output order (sorted by path). */
export function reconcilePending(
  existing: readonly PendingEntry[],
  args: ReconcilePendingArgs,
): ReconciledPending {
  const byPath = new Map<string, PendingEntry>();
  for (const e of existing) {
    if (byPath.has(e.path)) throw new Error(`reconcilePending: duplicate existing entry for ${e.path}`);
    byPath.set(e.path, e);
  }

  const cleared: PendingEntry[] = [];
  for (const p of new Set(args.clearedPaths)) {
    const prior = byPath.get(p);
    if (prior !== undefined) {
      cleared.push(prior);
      byPath.delete(p);
    }
  }

  for (const dirty of args.upsertedDirty) {
    const survivor = byPath.get(dirty.path);
    byPath.set(dirty.path, {
      path: dirty.path,
      quarantineId: dirty.quarantineId,
      // Preserve the first sighting ONLY from an entry that survived the clears —
      // a clear-then-re-dirty in one range is a fresh occurrence at the new OID.
      firstSeenOid: survivor !== undefined ? survivor.firstSeenOid : dirty.firstSeenOid,
    });
  }

  const entries = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const clearedSorted = cleared.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, cleared: clearedSorted };
}
