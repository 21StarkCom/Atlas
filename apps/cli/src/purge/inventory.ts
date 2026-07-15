/**
 * `purge/inventory` — the default-safe erasure-inventory core (Task 4.10). A bare `purge`
 * is a NON-mutating preview: it resolves the selector to the immutable set of rows that
 * would be erased across every storage class, in the normative purge ORDER (dependents +
 * projection children first; the ledger/audit classes last, tombstoned rather than dropped —
 * retention-matrix.md), and stamps a deterministic `digest` over that set. The broker
 * challenge on `--apply` is bound to this inventory's identity, so an applied erasure matches
 * exactly the previewed set.
 *
 * This module is the pure resolver. The privileged `--apply` execution (broker
 * challenge/authorization, ordinary opaque-id-map deletion + signed tombstone vs. the
 * history-rewrite exception, per-class resumable checkpoints, post-purge verification) is the
 * broker-authorized command surface built with the git-surface authorization machinery.
 */
import type { ContentId } from "@atlas/contracts";
import { canonicalSerialize } from "@atlas/contracts";
import { createHash } from "node:crypto";
import type { SqliteDatabase } from "@atlas/sqlite-store";

/** Exactly one selector kind scopes a purge (a bare/multi selector is a usage error upstream). */
export type PurgeSelector =
  | { readonly kind: "note"; readonly value: string }
  | { readonly kind: "source"; readonly value: ContentId }
  | { readonly kind: "data-category"; readonly value: string };

/** One storage class's affected rows in the inventory (identified by their natural keys). */
export interface ErasureClassEntry {
  /** The storage class (retention-matrix.md row label, e.g. `claim_evidence`, `content_blobs`). */
  readonly storageClass: string;
  /** The affected row identifiers (sorted, deterministic). */
  readonly ids: readonly string[];
  /** `tombstone` = soft (ledger/audit, retained + tombstoned); `hard` = erased. */
  readonly disposition: "hard" | "tombstone";
}

/** The immutable resolved erasure inventory (the preview payload; digest binds the apply). */
export interface ErasureInventory {
  readonly selector: PurgeSelector;
  /** The affected classes in normative purge order (dependents/children first, ledger last). */
  readonly classes: readonly ErasureClassEntry[];
  /** `sha256:<hex>` over the canonical inventory — the identity the apply challenge binds to. */
  readonly digest: string;
}

function ids(rows: Record<string, unknown>[], ...cols: string[]): string[] {
  return rows.map((r) => cols.map((c) => String(r[c])).join(":")).sort();
}

/**
 * Resolve `selector` to its erasure inventory (non-mutating). The class list is emitted in
 * purge order: dependent evidence → provenance children (renditions/captures/note_sources) →
 * content roots (blobs) / projection roots (notes + links + identity keys) → the ledger/audit
 * classes LAST (tombstone-only). Empty classes are omitted; the digest covers the ordered set.
 */
export function computeErasureInventory(db: SqliteDatabase, selector: PurgeSelector): ErasureInventory {
  const classes: ErasureClassEntry[] = [];
  const push = (storageClass: string, rowIds: string[], disposition: "hard" | "tombstone"): void => {
    if (rowIds.length > 0) classes.push({ storageClass, ids: rowIds, disposition });
  };

  if (selector.kind === "source") {
    const c = selector.value;
    const args = [c.rawContentHash, c.canonicalMediaType];
    // Dependents FIRST: current evidence citing any rendition of this blob.
    push("claim_evidence", ids(db.prepare(`SELECT evidence_id FROM claim_evidence WHERE raw_content_hash=? AND canonical_media_type=?`).all(...args) as Record<string, unknown>[], "evidence_id"), "hard");
    push("note_sources", ids(db.prepare(`SELECT note_id, extractor_version, normalizer_version FROM note_sources WHERE raw_content_hash=? AND canonical_media_type=?`).all(...args) as Record<string, unknown>[], "note_id", "extractor_version", "normalizer_version"), "hard");
    push("source_renditions", ids(db.prepare(`SELECT extractor_version, normalizer_version FROM source_renditions WHERE raw_content_hash=? AND canonical_media_type=?`).all(...args) as Record<string, unknown>[], "extractor_version", "normalizer_version"), "hard");
    push("source_captures", ids(db.prepare(`SELECT capture_id FROM source_captures WHERE raw_content_hash=? AND canonical_media_type=?`).all(...args) as Record<string, unknown>[], "capture_id"), "hard");
    push("content_blobs", ids(db.prepare(`SELECT raw_content_hash, canonical_media_type FROM content_blobs WHERE raw_content_hash=? AND canonical_media_type=?`).all(...args) as Record<string, unknown>[], "raw_content_hash", "canonical_media_type"), "hard");
  } else if (selector.kind === "note") {
    const n = selector.value;
    // Claims owned by the note + their evidence (dependents first).
    const claimIds = ids(db.prepare(`SELECT claim_id FROM claims WHERE owning_note_id=?`).all(n) as Record<string, unknown>[], "claim_id");
    push("claim_evidence", ids(db.prepare(`SELECT e.evidence_id FROM claim_evidence e JOIN claims c ON c.claim_id=e.claim_id WHERE c.owning_note_id=?`).all(n) as Record<string, unknown>[], "evidence_id"), "hard");
    push("claims", claimIds, "hard");
    push("note_links", ids(db.prepare(`SELECT source_note_id, target_note_id, predicate FROM note_links WHERE source_note_id=? OR target_note_id=?`).all(n, n) as Record<string, unknown>[], "source_note_id", "target_note_id", "predicate"), "hard");
    push("note_identity_keys", ids(db.prepare(`SELECT normalized_key FROM note_identity_keys WHERE note_id=?`).all(n) as Record<string, unknown>[], "normalized_key"), "hard");
    push("note_sources", ids(db.prepare(`SELECT note_id, raw_content_hash, canonical_media_type FROM note_sources WHERE note_id=?`).all(n) as Record<string, unknown>[], "note_id", "raw_content_hash", "canonical_media_type"), "hard");
    push("notes", ids(db.prepare(`SELECT note_id FROM notes WHERE note_id=?`).all(n) as Record<string, unknown>[], "note_id"), "hard");
  } else {
    // data-category → the notes of that type (a coarse projection selector).
    const type = selector.value;
    push("notes", ids(db.prepare(`SELECT note_id FROM notes WHERE type=?`).all(type) as Record<string, unknown>[], "note_id"), "hard");
  }

  // The audit/ledger classes are ALWAYS last and tombstone-only (never dropped): a purge
  // records the erasure as a signed tombstone, it does not delete audit history.
  const affected = classes.reduce((sum, c) => sum + c.ids.length, 0);
  if (affected > 0) push("audit_events", ["<signed-tombstone>"], "tombstone");

  const digest = `sha256:${createHash("sha256").update(canonicalSerialize({ selector, classes })).digest("hex")}`;
  return { selector, classes, digest };
}
