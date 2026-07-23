/**
 * `workflows/reverify` — the rendition-bump re-verification / staleness protocol
 * (Task 4.7). When an extractor/normalizer upgrade re-points a blob's ACTIVE rendition
 * (`ProvenanceRepo.setActiveRendition`), every current evidence head still pinned to the
 * PRIOR rendition may no longer anchor the same quote. `enqueueReverification`:
 *
 *   1. enumerates the affected current evidence (deterministically);
 *   2. marks it transitionally `stale` in the projection — a `stale` head blocks Tier-2
 *      auto-commit + trusted grounding until it is re-anchored;
 *   3. enqueues ONE re-verification job per OWNING NOTE (idempotency key
 *      `(contentId, newRenditionId, owningNoteId)`), so a bump spanning N notes enqueues
 *      N non-colliding jobs and a retry is a no-op.
 *
 * The job re-anchors each affected head against the new rendition and emits a validated
 * `UpdateEvidenceVerification` ChangePlan per note (Markdown SSOT) with one of three
 * outcomes — see {@link classifyReanchor}. The durable state change always flows through
 * that ChangePlan path; the `stale` projection mark is only the transient in between.
 */
import { enqueue, type JobId, type LedgerTx } from "@atlas/jobs";
import { ClaimsRepo, type ClaimEvidenceRow, type EvidenceVerification } from "@atlas/sqlite-store";

/** A blob whose active rendition was re-pointed from `previous` to `next`. */
export interface RenditionBump {
  /** The blob whose active rendition moved (`raw_content_hash` + `canonical_media_type`). */
  readonly contentId: { readonly rawContentHash: string; readonly canonicalMediaType: string };
  /** The rendition version pair the affected evidence is currently pinned to. */
  readonly previous: { readonly extractorVersion: number; readonly normalizerVersion: number };
  /** The re-pointed active rendition (its 5-segment handle backs the idempotency key). */
  readonly newRenditionId: string;
}

/** The workflow name reverify jobs are enqueued under. */
export const REVERIFY_WORKFLOW = "reverify";

/** The durable payload of a reverify job (allowlisted, hash-verified by the queue). */
export interface ReverifyJobPayload {
  readonly owningNoteId: string;
  readonly contentId: { readonly rawContentHash: string; readonly canonicalMediaType: string };
  readonly newRenditionId: string;
  /** The evidence heads (by surrogate id) this note's job must re-anchor. */
  readonly evidenceIds: readonly string[];
}

/** The deterministic re-anchor idempotency key for a note's reverification. */
export function reverifyKey(bump: RenditionBump, owningNoteId: string): string {
  return `${bump.contentId.rawContentHash}:${bump.contentId.canonicalMediaType}:${bump.newRenditionId}:${owningNoteId}`;
}

/**
 * Enumerate the current evidence heads pinned to the bump's PRIOR rendition, mark the
 * `valid` ones `stale` (the transient that blocks auto-commit), and enqueue one
 * re-verification job per owning note. Returns the enqueued job ids (one per note; a
 * retry against the same bump returns the SAME ids — the queue de-dupes on the key).
 */
export function enqueueReverification(tx: LedgerTx, bump: RenditionBump): JobId[] {
  const repo = new ClaimsRepo(tx);
  const affected = repo
    .evidenceForRendition({ kind: "content", ...bump.contentId })
    .filter(
      (e) =>
        e.current === 1 &&
        e.extractor_version === bump.previous.extractorVersion &&
        e.normalizer_version === bump.previous.normalizerVersion,
    );

  // Group affected heads by their claim's owning note (deterministic order).
  const byNote = new Map<string, ClaimEvidenceRow[]>();
  const owningNoteStmt = tx.prepare(`SELECT owning_note_id FROM claims WHERE claim_id = ?`);
  for (const e of affected) {
    const row = owningNoteStmt.get(e.claim_id) as { owning_note_id: string } | undefined;
    if (!row) continue; // orphan evidence (no claim) — nothing to re-anchor
    const list = byNote.get(row.owning_note_id) ?? [];
    list.push(e);
    byNote.set(row.owning_note_id, list);
  }

  const jobIds: JobId[] = [];
  for (const owningNoteId of [...byNote.keys()].sort()) {
    const heads = byNote.get(owningNoteId)!;
    // Transitional stale marking: a valid head becomes stale pending re-anchor. A head
    // already pending/failed keeps its state (it is not "freshly stale"); a tombstoned
    // head is never enumerated (current === 1 filter above).
    for (const e of heads) {
      if (e.verification === "valid") repo.setEvidenceVerification(e.evidence_id, "stale");
    }
    const payload: ReverifyJobPayload = {
      owningNoteId,
      contentId: bump.contentId,
      newRenditionId: bump.newRenditionId,
      evidenceIds: heads.map((e) => e.evidence_id).sort(),
    };
    jobIds.push(enqueue(tx, { workflow: REVERIFY_WORKFLOW, idempotencyKey: reverifyKey(bump, owningNoteId), payload }));
  }
  return jobIds;
}

/** The three re-anchor match classes the deterministic quote matcher yields. */
export type ReanchorMatch = "exact" | "ambiguous" | "moved" | "not-found";

/** A re-anchor outcome: the new verification verdict. */
export interface ReanchorOutcome {
  readonly verification: EvidenceVerification;
}

/**
 * Map a deterministic quote-match result to its verification outcome (spec §staleness).
 * v2 (#335): the Tier-3 review escalation is retired — an uncertain re-anchor
 * (`ambiguous`/`moved`) can no longer park for human resolution, so it fails
 * closed exactly like a vanished quote:
 *  - `exact` ⇒ re-pinned `valid` (auto-integrated);
 *  - `ambiguous` / `moved` / `not-found` ⇒ `failed` (evidence stays stale, gated
 *    out of trusted grounding; no auto re-pin).
 */
export function classifyReanchor(match: ReanchorMatch): ReanchorOutcome {
  return { verification: match === "exact" ? "valid" : "failed" };
}
