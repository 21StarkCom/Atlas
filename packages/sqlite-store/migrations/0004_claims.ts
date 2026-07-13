/**
 * `0004_claims` — the claims projection migration owned by `@atlas/sqlite-store`
 * (plan §2.7). Creates the two claims projection tables: `claims` (a claim
 * serialized into its owning note's Markdown) and `claim_evidence` (evidence
 * pinning a rendition as component columns, with a non-null `evidence_id`
 * surrogate, a non-null `payload_hash` UNIQUE index for idempotent attach, a
 * `verification` CHECK enum, and the partial UNIQUE current-head index).
 *
 * **Retained PR-A discipline (plan §1 / §2.7 / §4.1, fixes R4-F5).** This
 * migration lands as its own retained PR ahead of the Phase-4 feature PRs and
 * later reverts never touch it, so `db rebuild` keeps reproducing the claims
 * projections from the canonical Markdown `claims:` blocks (via
 * {@link foldClaimManifests}) after any feature revert.
 *
 * **Gap tolerance (plan Review-Hint, D-migration order).** `0004_claims` applies
 * even though `0002_jobs` (PR-B) may be absent. The gap-tolerant runner (Task
 * 1.4) applies the registered-but-unapplied set by id order and never assumes
 * contiguous numbering — do NOT renumber.
 *
 * Every `CREATE TABLE`/`CREATE ... INDEX` below is copied **VERBATIM** from
 * `docs/specs/sqlite-data-dictionary.md` §5 (`claims`, `claim_evidence`) — no
 * invented columns, types, constraints, or indexes (dictionary §0 binding
 * conventions). The absent-`locator`/`quote_hash` sentinel is the fixed 6-byte
 * printable-ASCII string `(none)` (dictionary §5) — see {@link ClaimsRepo}.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The verbatim claims DDL (dictionary §5, in FK-dependency-safe order). */
export const CLAIMS_DDL = `CREATE TABLE claims (
  claim_id        TEXT    NOT NULL PRIMARY KEY,
  owning_note_id  TEXT    NOT NULL,                       -- scalar note id (projection→projection FK ok)
  text            TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disputed', 'superseded')),  -- V1 exercises only 'active'
  created_at      TEXT    NOT NULL,
  FOREIGN KEY (owning_note_id) REFERENCES notes(note_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE claim_evidence (
  evidence_id             TEXT    NOT NULL PRIMARY KEY,   -- immutable surrogate hash, non-null
  lineage_id              TEXT    NOT NULL,               -- stable lineage key = root row's evidence_id; inherited on re-anchor
  claim_id                TEXT    NOT NULL,
  raw_content_hash        TEXT    NOT NULL,               -- pinned renditionId components
  canonical_media_type    TEXT    NOT NULL,
  extractor_version       INTEGER NOT NULL,
  normalizer_version      INTEGER NOT NULL,
  locator                 TEXT    NOT NULL,               -- sentinel '(none)' when absent, never NULL
  quote_hash              TEXT    NOT NULL,               -- sentinel '(none)' when absent, never NULL
  payload_hash            TEXT    NOT NULL,               -- hash of tagged (claimId,renditionId,locator,quoteHash)
  verification            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (verification IN ('valid', 'stale', 'pending', 'failed')),
  current                 INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  tombstoned_at           TEXT,                           -- set iff current = 0
  supersedes_evidence_id  TEXT,                           -- prior head this row re-anchored from
  created_at              TEXT    NOT NULL,
  FOREIGN KEY (claim_id) REFERENCES claims(claim_id) ON DELETE CASCADE,
  FOREIGN KEY (raw_content_hash, canonical_media_type, extractor_version, normalizer_version)
    REFERENCES source_renditions(raw_content_hash, canonical_media_type, extractor_version, normalizer_version)
    ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_evidence_id) REFERENCES claim_evidence(evidence_id) ON DELETE RESTRICT,
  CHECK ((current = 1) = (tombstoned_at IS NULL))
) STRICT;

CREATE UNIQUE INDEX idx_claim_evidence_payload ON claim_evidence(payload_hash);
CREATE UNIQUE INDEX idx_claim_evidence_current_head ON claim_evidence(lineage_id) WHERE current = 1;`;

/** The `0004_claims` migration (id, checksum over {@link CLAIMS_DDL}, `up`). */
export const migration0004Claims: Migration = {
  id: "0004_claims",
  checksum: migrationChecksum(CLAIMS_DDL),
  up(db) {
    db.exec(CLAIMS_DDL);
  },
};
