/**
 * `purge/erase` — the applied-erasure execution (Task 4.10). Given a resolved erasure inventory
 * (Task 4.10 preview) and a broker authorization bound to its digest, erase every matched row
 * across storage classes in normative purge order, then VERIFY no matching copy survives.
 *
 * This models the ORDINARY erasure class (security-broker-contract.md §12.1): the opaque-id ↔
 * natural-id mapping is deleted + a signed tombstone audit event is appended — NO canonical-ref
 * rewrite. The broker authorization is an injected seam: an unauthorized/agent caller or a
 * digest mismatch is REFUSED there, BEFORE any row is deleted (fail-closed). The projection
 * deletes run in ONE transaction in purge order (children first; content_blobs' DEFERRABLE
 * RESTRICT FK is satisfied because the blob is deleted alongside its renditions), so a partial
 * erasure can never commit — a retry re-derives + re-verifies idempotently.
 */
import type { SqliteDatabase } from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";
import { computeErasureInventory, type ErasureInventory, type PurgeSelector } from "./inventory.js";

/** The result of an applied erasure. */
export interface ErasureResult {
  readonly inventoryDigest: string;
  /** The storage classes erased (hard), in purge order. */
  readonly erasedClasses: readonly string[];
  /** `true` — an exit-0 erasure ALWAYS reflects a completed post-purge verification. */
  readonly verified: true;
  /** The ordinary-erasure signed-tombstone marker (no canonical rewrite). */
  readonly refReplaced: false;
}

/** An erasure failure the CLI maps to an exit code. */
export class ErasureError extends CliError {}

/** The seams applied erasure drives (the broker authorization + tombstone append). */
export interface ErasureDeps {
  /**
   * Authorize + append the signed tombstone for `inventoryDigest` (broker §12.1). REFUSES an
   * unauthorized/agent caller or a digest that does not match the previewed inventory — thrown
   * BEFORE any row is deleted.
   */
  authorizeTombstone(args: { inventoryDigest: string; selector: PurgeSelector }): Promise<void>;
}

/** Delete every matched row for `selector`, in purge order, within `db` (caller wraps in a txn). */
function eraseRows(db: SqliteDatabase, selector: PurgeSelector): void {
  if (selector.kind === "source") {
    const a = [selector.value.rawContentHash, selector.value.canonicalMediaType];
    // Dependents first (claim_evidence RESTRICT-references renditions), then clear the blob's
    // active-rendition pointer (an immediate RESTRICT FK) BEFORE deleting the renditions it pins.
    db.prepare(`DELETE FROM claim_evidence WHERE raw_content_hash=? AND canonical_media_type=?`).run(...a);
    db.prepare(`DELETE FROM note_sources WHERE raw_content_hash=? AND canonical_media_type=?`).run(...a);
    db.prepare(`UPDATE content_blobs SET active_extractor_version=NULL, active_normalizer_version=NULL WHERE raw_content_hash=? AND canonical_media_type=?`).run(...a);
    db.prepare(`DELETE FROM source_renditions WHERE raw_content_hash=? AND canonical_media_type=?`).run(...a);
    db.prepare(`DELETE FROM source_captures WHERE raw_content_hash=? AND canonical_media_type=?`).run(...a);
    db.prepare(`DELETE FROM content_blobs WHERE raw_content_hash=? AND canonical_media_type=?`).run(...a);
  } else if (selector.kind === "note") {
    const n = selector.value;
    db.prepare(`DELETE FROM claim_evidence WHERE claim_id IN (SELECT claim_id FROM claims WHERE owning_note_id=?)`).run(n);
    db.prepare(`DELETE FROM claims WHERE owning_note_id=?`).run(n);
    db.prepare(`DELETE FROM note_links WHERE source_note_id=? OR target_note_id=?`).run(n, n);
    db.prepare(`DELETE FROM note_identity_keys WHERE note_id=?`).run(n);
    db.prepare(`DELETE FROM note_sources WHERE note_id=?`).run(n);
    db.prepare(`DELETE FROM notes WHERE note_id=?`).run(n);
  } else {
    db.prepare(`DELETE FROM notes WHERE type=?`).run(selector.value);
  }
}

/**
 * Apply the erasure for `selector` under a broker authorization bound to the inventory digest.
 * Authorizes FIRST (an unauthorized caller / digest mismatch is refused here), then deletes every
 * matched row in ONE transaction in purge order, then VERIFIES the selector now resolves to an
 * empty inventory (no prohibited copy survives). Idempotent: a retry re-derives + re-verifies.
 */
export async function applyErasure(db: SqliteDatabase, selector: PurgeSelector, deps: ErasureDeps): Promise<ErasureResult> {
  const inventory: ErasureInventory = computeErasureInventory(db, selector);
  const erasedClasses = inventory.classes.filter((c) => c.disposition === "hard").map((c) => c.storageClass);

  // Authorize BEFORE any deletion — a refused authorization leaves the projection intact.
  await deps.authorizeTombstone({ inventoryDigest: inventory.digest, selector });

  // Erase all matched rows atomically in purge order (a partial erasure can never commit).
  db.transaction(() => eraseRows(db, selector))();

  // Post-purge verification: the selector must now resolve to an EMPTY inventory.
  const after = computeErasureInventory(db, selector);
  if (after.classes.some((c) => c.disposition === "hard")) {
    throw new ErasureError({
      code: "purge-verification-failed",
      message: `post-purge verification found surviving rows for the selector`,
      hint: "The erasure did not fully remove all matched rows; investigate FK/retention constraints.",
      exitCode: EXIT.INTERNAL,
    });
  }

  return { inventoryDigest: inventory.digest, erasedClasses, verified: true, refReplaced: false };
}
