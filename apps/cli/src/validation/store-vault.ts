/**
 * `validation/store-vault` — the production {@link ValidationVault} backed by the SQLite
 * projections (Task 4.11). The validator (Task 4.4) reads vault/graph facts through this seam;
 * this wires each to a projection query (notes, note_identity_keys, provenance, claims/evidence),
 * so the synthesis commands validate a ChangePlan against the REAL current vault state. Read-only.
 */
import { parseSourceHandle, type ChangePlanOperation } from "@atlas/contracts";
import { ProvenanceRepo, type SqliteDatabase } from "@atlas/sqlite-store";
import type { ValidationVault } from "./index.js";

/** Build a {@link ValidationVault} over the current projections in `db`. */
export function makeStoreValidationVault(db: SqliteDatabase): ValidationVault {
  const provenance = new ProvenanceRepo(db);
  const has = (sql: string, ...args: unknown[]): boolean => db.prepare(sql).get(...args) !== undefined;

  return {
    hasNoteId: (id) => has(`SELECT 1 FROM notes WHERE note_id = ?`, id),
    identityOwners: (normalizedKey) =>
      (db.prepare(`SELECT note_id FROM note_identity_keys WHERE normalized_key = ?`).all(normalizedKey) as { note_id: string }[]).map((r) => r.note_id),
    hasSourceRef: (handle) => {
      let parsed;
      try {
        parsed = parseSourceHandle(handle);
      } catch {
        return false; // an unparseable handle resolves to no source
      }
      return provenance.resolveSourceHandle(parsed) !== null;
    },
    hasClaimKey: (claimKey) => has(`SELECT 1 FROM claims WHERE claim_id = ?`, claimKey),
    hasEvidenceLineage: (lineageId) => has(`SELECT 1 FROM claim_evidence WHERE lineage_id = ?`, lineageId),
    hasEvidenceId: (evidenceId) => has(`SELECT 1 FROM claim_evidence WHERE evidence_id = ?`, evidenceId),
    attachWouldDuplicate: (op: ChangePlanOperation) => {
      if (op.op !== "AttachEvidence") return false;
      let r;
      try {
        r = parseSourceHandle(op.renditionId);
      } catch {
        return false;
      }
      if (r.kind !== "rendition") return false;
      // A current evidence head already pinned to this rendition + locator on the same claim is a
      // duplicate re-attach (the fold's UNIQUE index would collapse it; the validator rejects it up front).
      return has(
        `SELECT 1 FROM claim_evidence
          WHERE claim_id = ? AND current = 1
            AND raw_content_hash = ? AND canonical_media_type = ?
            AND extractor_version = ? AND normalizer_version = ?
            AND locator = ?`,
        op.claimKey,
        r.rawContentHash,
        r.canonicalMediaType,
        r.extractorVersion,
        r.normalizerVersion,
        op.locator ?? "(none)",
      );
    },
  };
}
