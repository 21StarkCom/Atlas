/**
 * `workflows/maintain` — the vault-maintenance issue detector (Task 4.11). `maintain` scans
 * the projection for hygiene issues — orphan notes (no inbound or outbound link) and evidence
 * that is not `resolved` (pending/failed/needs-review, needing re-verification) — and turns each
 * into a maintenance proposal the synthesis pipeline (Task 4.5) drives through preview/apply.
 *
 * v2 (#335, ADR-0003): the Tier-3 review gate is retired — every remediation
 * (destructive included) applies directly, exactly like `enrich`. Git is the undo
 * (`git revert` + `brain sync`). This module is the deterministic read-only
 * detector; turning an issue into a validated ChangePlan + running it is the command.
 *
 * v2 evidence (#337): the unverified-evidence scan reads the flat vault-derived
 * `evidence` projection (`EvidenceRepo`), not the retired `claims`/`claim_evidence`
 * model — `noteId` rides each row, so no claims join is needed.
 */
import { EvidenceRepo, type SqliteDatabase } from "@atlas/sqlite-store";

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
 *  - `unverified-evidence` — a note owning an evidence row whose status is not `resolved`
 *    (pending/failed/needs-review); flagging it for re-verification is non-destructive.
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

  // Every evidence row not `resolved` (needs-attention) rides its owning `noteId` directly —
  // no claims join. Collapse to a per-note + per-status remediation proposal (deterministic).
  const unresolved = new EvidenceRepo(db).needingAttention({ limit: 1_000_000_000, offset: 0 });
  const seen = new Set<string>();
  for (const e of unresolved) {
    if (e.noteId === null) continue; // soft reference may be null; nothing to remediate against
    const status = e.status ?? "unresolved";
    const key = `${e.noteId}:${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      kind: "unverified-evidence",
      noteId: e.noteId,
      detail: `note "${e.noteId}" has ${status} evidence needing re-verification`,
      destructive: false,
    });
  }

  return issues.sort((a, b) => (a.noteId === b.noteId ? a.kind.localeCompare(b.kind) : a.noteId.localeCompare(b.noteId)));
}
