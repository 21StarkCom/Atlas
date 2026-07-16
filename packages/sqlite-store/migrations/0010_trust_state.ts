/**
 * `0010_trust_state` — the trust-state projection for the trust lifecycle (Task 4.8/4.9). A
 * source's trust is advanced on the broker-owned `refs/trust/ledger` (the SSOT); this table is
 * its SQLite projection, read by `trustStateFor` to gate Tier-2 auto-commit + trusted grounding.
 * One row per source blob (`raw_content_hash` + `canonical_media_type`); absence = the fail-closed
 * `untrusted` default (nothing is trusted until an explicit broker-authorized `PromoteTrust`).
 *
 * FEATURE migration (registered by the workflows layer at store-open alongside 0006/0009); NOT in
 * `openStore`'s default retained set, and added to the backup §8.3 known-schema-heads.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The DDL owned by `0010_trust_state` (the checksum source). */
export const TRUST_STATE_DDL = `CREATE TABLE trust_state (
  raw_content_hash      TEXT    NOT NULL,
  canonical_media_type  TEXT    NOT NULL,
  level                 TEXT    NOT NULL CHECK (level IN ('untrusted','provisional','trusted','authoritative')),
  suspended             INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  reason                TEXT,
  updated_at            TEXT    NOT NULL,
  PRIMARY KEY (raw_content_hash, canonical_media_type)
) STRICT;`;

/** The `0010_trust_state` migration (registered by the workflows layer). */
export const migration0010TrustState: Migration = {
  id: "0010_trust_state",
  checksum: migrationChecksum(TRUST_STATE_DDL),
  up(db) {
    db.exec(TRUST_STATE_DDL);
  },
};
