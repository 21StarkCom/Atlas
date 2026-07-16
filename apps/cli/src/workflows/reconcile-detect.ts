/**
 * `workflows/reconcile-detect` — the vault-reconciliation proposal detector (Task 4.11).
 * `reconcile` scans the projection for cross-note inconsistencies and turns each into a
 * reconciliation proposal the synthesis pipeline (Task 4.5) drives through preview/apply:
 *
 *   - `merge-duplicate` — distinct notes sharing an identical title (a duplicate signal). Merging
 *     collapses content ⇒ DESTRUCTIVE ⇒ always Tier-3.
 *   - `resolve-conflicting-claim` — a claim explicitly marked `disputed`. Resolving edits asserted
 *     content ⇒ Tier-3.
 *   - `fix-broken-link` — a `note_links` row whose target note no longer exists (defensive: strict
 *     ingest rejects dangling links, so this is normally empty). Repointing/removing a link is
 *     non-destructive ⇒ Tier-2.
 *
 * Deterministic, read-only, and stably sorted. This is the detector; turning a proposal into a
 * validated ChangePlan + running it is the command.
 */
import type { SqliteDatabase } from "@atlas/sqlite-store";

/** A detected reconciliation proposal + the tier its remediation must land at. */
export interface ReconciliationProposal {
  readonly kind: "merge-duplicate" | "resolve-conflicting-claim" | "fix-broken-link";
  /** The notes (≥1) the proposal concerns — the merge set / owning note / link endpoints. */
  readonly targets: readonly string[];
  /** The minimum tier the remediation must land at (destructive ⇒ tier-3). */
  readonly minTier: "tier-2" | "tier-3";
}

/** Detect reconciliation proposals in the current projection (deterministic, read-only, sorted). */
export function detectReconciliationProposals(db: SqliteDatabase): ReconciliationProposal[] {
  const proposals: ReconciliationProposal[] = [];

  // merge-duplicate: distinct notes that share an identical title.
  const dupes = db
    .prepare(
      `SELECT title, GROUP_CONCAT(note_id) AS ids, COUNT(*) AS n
         FROM notes GROUP BY title HAVING n > 1 ORDER BY title`,
    )
    .all() as { title: string; ids: string; n: number }[];
  for (const d of dupes) {
    proposals.push({ kind: "merge-duplicate", targets: d.ids.split(",").sort(), minTier: "tier-3" });
  }

  // resolve-conflicting-claim: a claim explicitly marked disputed.
  const disputed = db
    .prepare(`SELECT claim_id, owning_note_id FROM claims WHERE status = 'disputed' ORDER BY claim_id`)
    .all() as { claim_id: string; owning_note_id: string }[];
  for (const c of disputed) {
    proposals.push({ kind: "resolve-conflicting-claim", targets: [c.owning_note_id], minTier: "tier-3" });
  }

  // fix-broken-link: a link whose target note is absent (defensive; strict ingest rejects these).
  const broken = db
    .prepare(
      `SELECT source_note_id, target_note_id FROM note_links l
        WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.note_id = l.target_note_id)
        ORDER BY source_note_id, target_note_id`,
    )
    .all() as { source_note_id: string; target_note_id: string }[];
  for (const b of broken) {
    proposals.push({ kind: "fix-broken-link", targets: [b.source_note_id, b.target_note_id], minTier: "tier-2" });
  }

  return proposals.sort((a, b) => (a.kind === b.kind ? a.targets.join(",").localeCompare(b.targets.join(",")) : a.kind.localeCompare(b.kind)));
}
