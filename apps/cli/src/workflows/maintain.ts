/**
 * `workflows/maintain` — the vault-maintenance issue detector (Task 4.11). `maintain` scans
 * the projection for hygiene issues — orphan notes (no inbound or outbound link) and evidence
 * that is not `valid` (stale/pending/failed, needing re-verification) — and turns each into a
 * maintenance proposal the synthesis pipeline (Task 4.5) drives through preview/apply.
 *
 * v2 (#335, ADR-0003): the Tier-3 review gate is retired — every remediation
 * (destructive included) applies directly, exactly like `enrich`. Git is the undo
 * (`git revert` + `brain sync`). This module is the deterministic read-only
 * detector; turning an issue into a validated ChangePlan + running it is the command.
 */
import { ClaimsRepo, type SqliteDatabase } from "@atlas/sqlite-store";

/** A detected maintenance issue. */
export interface MaintenanceIssue {
  readonly kind: "orphan-note" | "unverified-evidence";
  /** The note the issue concerns (owning note for evidence). */
  readonly noteId: string;
  /** A short, allowlisted description (never raw content). */
  readonly detail: string;
  /** `true` ⇒ the remediation removes content (archive/merge an orphan). */
  readonly destructive: boolean;
}

/**
 * Detect maintenance issues in the current projection (deterministic, read-only, sorted):
 *  - `orphan-note` — a note with NO inbound and NO outbound link (remediation is destructive).
 *  - `unverified-evidence` — a current evidence head whose verification is not `valid`
 *    (stale/pending/failed); flagging it for re-verification is non-destructive.
 */
export function detectMaintenanceIssues(db: SqliteDatabase): MaintenanceIssue[] {
  const issues: MaintenanceIssue[] = [];

  const orphans = db
    .prepare(
      `SELECT note_id FROM notes n
        WHERE NOT EXISTS (SELECT 1 FROM note_links l WHERE l.source_note_id = n.note_id OR l.target_note_id = n.note_id)
        ORDER BY note_id`,
    )
    .all() as { note_id: string }[];
  for (const o of orphans) {
    issues.push({ kind: "orphan-note", noteId: o.note_id, detail: `note "${o.note_id}" has no links (orphan)`, destructive: true });
  }

  const unverified = new ClaimsRepo(db)
    .allEvidence()
    .filter((e) => e.current === 1 && e.verification !== "valid");
  // Group to the owning note for a per-note remediation proposal (deterministic order).
  const owningStmt = db.prepare(`SELECT owning_note_id FROM claims WHERE claim_id = ?`);
  const seen = new Set<string>();
  for (const e of unverified) {
    const row = owningStmt.get(e.claim_id) as { owning_note_id: string } | undefined;
    if (!row) continue;
    const key = `${row.owning_note_id}:${e.claim_id}:${e.verification}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      kind: "unverified-evidence",
      noteId: row.owning_note_id,
      detail: `claim "${e.claim_id}" has ${e.verification} evidence needing re-verification`,
      destructive: false,
    });
  }

  return issues.sort((a, b) => (a.noteId === b.noteId ? a.kind.localeCompare(b.kind) : a.noteId.localeCompare(b.noteId)));
}
