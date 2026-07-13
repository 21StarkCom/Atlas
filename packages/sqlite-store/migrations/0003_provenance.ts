/**
 * `0003_provenance` — the provenance projection migration owned by
 * `@atlas/sqlite-store` (plan §2.7). Creates the four provenance projection
 * tables: `content_blobs` (immutable blob + component-column active-rendition
 * pointer), `source_captures` (origin-observation aggregate), `source_renditions`
 * (immutable per-version normalized outputs), and `note_sources` (note-level
 * provenance citations).
 *
 * **Retained PR-A discipline (plan §1 / §2.7, fixes R4-F5/R3-F9).** This
 * migration lands as its own retained PR ahead of the feature PR-B and later
 * reverts never touch it, so `db rebuild` keeps reproducing the provenance
 * projections from canonical Markdown manifests (via
 * {@link foldProvenanceManifests}) after any feature revert.
 *
 * **Gap tolerance (plan Review-Hint, D-migration order).** `0003_provenance`
 * applies BEFORE `0002_jobs` (which lands in the later PR-B). The
 * gap-tolerant runner (Task 1.4) applies the registered-but-unapplied set by id
 * order and never assumes contiguous numbering, so registering `0003` while
 * `0002` is absent is correct — do NOT renumber.
 *
 * Every `CREATE TABLE`/`CREATE ... INDEX` below is copied **VERBATIM** from
 * `docs/specs/sqlite-data-dictionary.md` §5 — no invented columns, types,
 * constraints, or indexes (dictionary §0 binding conventions). The active
 * rendition is the **component column pair** `active_extractor_version` +
 * `active_normalizer_version` (nullable), never a packed `renditionId`
 * (dictionary §5 / plan Review-Hint, fixes R3-F6).
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The verbatim provenance DDL (dictionary §5, in FK-dependency-safe order). */
export const PROVENANCE_DDL = `CREATE TABLE content_blobs (
  raw_content_hash           TEXT    NOT NULL,
  canonical_media_type       TEXT    NOT NULL,
  size_bytes                 INTEGER NOT NULL,
  vault_path                 TEXT    NOT NULL,            -- immutable copy under sources/
  first_seen_at              TEXT    NOT NULL,
  active_extractor_version   INTEGER,                     -- nullable pointer component
  active_normalizer_version  INTEGER,                     -- nullable pointer component
  PRIMARY KEY (raw_content_hash, canonical_media_type),
  FOREIGN KEY (raw_content_hash, canonical_media_type, active_extractor_version, active_normalizer_version)
    REFERENCES source_renditions(raw_content_hash, canonical_media_type, extractor_version, normalizer_version)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((active_extractor_version IS NULL) = (active_normalizer_version IS NULL))
) STRICT;

CREATE TABLE source_captures (
  capture_id            TEXT    NOT NULL PRIMARY KEY,     -- deterministic hash of (contentId, origin)
  raw_content_hash      TEXT    NOT NULL,
  canonical_media_type  TEXT    NOT NULL,
  origin                TEXT    NOT NULL,                 -- original path snapshot
  first_seen_at         TEXT    NOT NULL,
  last_seen_at          TEXT    NOT NULL,
  observation_count     INTEGER NOT NULL DEFAULT 1 CHECK (observation_count >= 1),
  UNIQUE (raw_content_hash, canonical_media_type, origin),
  FOREIGN KEY (raw_content_hash, canonical_media_type)
    REFERENCES content_blobs(raw_content_hash, canonical_media_type) ON DELETE CASCADE
) STRICT;

CREATE TABLE source_renditions (
  raw_content_hash         TEXT    NOT NULL,
  canonical_media_type     TEXT    NOT NULL,
  extractor_version        INTEGER NOT NULL,
  normalizer_version       INTEGER NOT NULL,
  normalized_content_hash  TEXT    NOT NULL,
  size_bytes               INTEGER NOT NULL,
  locator_scheme           TEXT    NOT NULL,              -- byte/char | page+span | dom-anchor
  created_at               TEXT    NOT NULL,
  PRIMARY KEY (raw_content_hash, canonical_media_type, extractor_version, normalizer_version),
  FOREIGN KEY (raw_content_hash, canonical_media_type)
    REFERENCES content_blobs(raw_content_hash, canonical_media_type) ON DELETE CASCADE
) STRICT;

CREATE TABLE note_sources (
  note_id               TEXT    NOT NULL,                 -- scalar note id (projection→projection FK ok)
  raw_content_hash      TEXT    NOT NULL,
  canonical_media_type  TEXT    NOT NULL,
  extractor_version     INTEGER,                          -- NULL = cite blob generally; ≥1 = specific rendition
  normalizer_version    INTEGER,                          -- NULL together with extractor_version, or both ≥1
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE,
  FOREIGN KEY (raw_content_hash, canonical_media_type)
    REFERENCES content_blobs(raw_content_hash, canonical_media_type) ON DELETE RESTRICT,
  FOREIGN KEY (raw_content_hash, canonical_media_type, extractor_version, normalizer_version)
    REFERENCES source_renditions(raw_content_hash, canonical_media_type, extractor_version, normalizer_version)
    ON DELETE RESTRICT,
  CHECK ((extractor_version IS NULL) = (normalizer_version IS NULL)),
  CHECK (extractor_version IS NULL OR (extractor_version >= 1 AND normalizer_version >= 1))
) STRICT;

CREATE UNIQUE INDEX idx_note_sources_identity ON note_sources(
  note_id, raw_content_hash, canonical_media_type,
  COALESCE(extractor_version, 0), COALESCE(normalizer_version, 0));`;

/** The `0003_provenance` migration (id, checksum over {@link PROVENANCE_DDL}, `up`). */
export const migration0003Provenance: Migration = {
  id: "0003_provenance",
  checksum: migrationChecksum(PROVENANCE_DDL),
  up(db) {
    db.exec(PROVENANCE_DDL);
  },
};
