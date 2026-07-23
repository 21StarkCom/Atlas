/**
 * `validation/store-vault` — the production {@link ValidationVault} backed by the SQLite
 * projections (Task 4.11). The validator (Task 4.4) reads vault/graph facts through this seam;
 * this wires each to a projection query (notes, note_identity_keys, provenance), so the synthesis
 * commands validate a ChangePlan against the REAL current vault state. Read-only. (The claim/
 * evidence resolvers were retired with the v1 claims model — #337.)
 */
import { parseSourceHandle } from "@atlas/contracts";
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
  };
}
