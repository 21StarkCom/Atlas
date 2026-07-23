/**
 * `validation/store-vault` — the production {@link ValidationVault} backed by the SQLite
 * projections (Task 4.11). The validator (Task 4.4) reads vault/graph facts through this seam;
 * this wires each to a projection query (notes, note_identity_keys, source registry), so the
 * synthesis commands validate a ChangePlan against the REAL current vault state. Read-only.
 *
 * v2 (#340): `hasSourceRef` resolves a note's `sources:` id against the flat operational
 * `source` REGISTRY (`0015_source_registry`), NOT the retired v1 content-addressed provenance
 * model (`content_blobs`/`source_renditions`, `0003`, forward-DROPped in #340). A `sources:`
 * entry is now a source registry `id`; a legacy `sha256:…` handle no longer resolves to any row
 * (it returns `false`) — but a dangling `sources:` id is a NON-FATAL condition (the validator
 * never blocks on it), so a legacy reference never blocks the cutover or enrich/ingest grounding.
 * (The claim/evidence resolvers were retired with the v1 claims model — #337.)
 */
import { SourceRepo, type SqliteDatabase } from "@atlas/sqlite-store";
import type { ValidationVault } from "./index.js";

/** Build a {@link ValidationVault} over the current projections in `db`. */
export function makeStoreValidationVault(db: SqliteDatabase): ValidationVault {
  const sources = SourceRepo.isApplied(db) ? new SourceRepo(db) : null;
  const has = (sql: string, ...args: unknown[]): boolean => db.prepare(sql).get(...args) !== undefined;

  return {
    hasNoteId: (id) => has(`SELECT 1 FROM notes WHERE note_id = ?`, id),
    identityOwners: (normalizedKey) =>
      (db.prepare(`SELECT note_id FROM note_identity_keys WHERE normalized_key = ?`).all(normalizedKey) as { note_id: string }[]).map((r) => r.note_id),
    // A `sources:` entry resolves iff it names a `source` REGISTRY id. A missing
    // registry (0015 unapplied) or an unknown/legacy id resolves to `false`; the
    // validator treats a dangling `sources:` ref as non-fatal (never exit 1).
    hasSourceRef: (handle) => (sources !== null ? sources.byId(handle) !== undefined : false),
  };
}
