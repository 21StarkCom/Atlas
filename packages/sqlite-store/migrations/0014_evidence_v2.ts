/**
 * `0014_evidence_v2` — the v2 vault-derived evidence projection (phase-4
 * persistence strip, task 4-2).
 *
 * v2 collapses the v1 rendition-pinned evidence model (`claims` + `claim_evidence`,
 * `0004`, with its lineage/payload_hash/supersession machinery coupled to the run
 * ledger) into ONE flat `evidence` projection folded from note frontmatter. The
 * vault is the single authority (the SSOT resolution): claim/citation/status/verdict
 * and the `attempts` counter all live in the note; the row is folded from the
 * committed note on `sync` / `db rebuild`, so a `git revert` + `brain sync` re-folds
 * the row and no stale evidence survives. `noteId` is a SOFT reference (no
 * rebuild-enforced FK). `sourceNoteHash` is the between-fold staleness guard: a row
 * whose recorded hash no longer equals its note's on-disk content hash is treated as
 * stale (`needs-review`), never trusted.
 *
 * EXPAND-AND-CONTRACT — this forward migration is authored across the phase-4
 * commits. Task 4-2 landed the ADDITIVE half (`CREATE TABLE evidence`); task 4-4
 * appended the DROP of the v1 evidence model (`claim_evidence` then `claims`,
 * children-first). THIS commit (task 4-1) appends the DROP of the retired
 * ledger/backup tables (`audit_events`/`audit_intents`/`backup_watermark`/
 * `raw_payloads`) now that the §2.8 audit-ledger write protocol + AEAD backup/
 * watermark are stripped from `@atlas/sqlite-store` and de-ledgered from the
 * workflow engine — their last consumer is gone. git (one commit per ChangePlan on
 * `refs/heads/main`) is v2's only safety mechanism; `agent_runs` / `model_calls`
 * stay as plain operational tables (retained, not dropped). No intermediate commit
 * migrates against a still-live consumer. This is the newest migration on an
 * unreleased branch and is never applied to a real DB before the Phase-5 verified
 * pre-migration snapshot exists, so growing its DDL here is not editing a *released*
 * migration (migrations stay append-only: `0004` is forward-dropped, never edited).
 *
 * FK-free by construction: `evidence` has no foreign keys (`noteId` is soft), so a
 * projection rebuild can never trip a restrictive FK or orphan a row. The whole
 * sequence runs inside the migration runner's single `BEGIN IMMEDIATE`.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/**
 * The DDL owned by `0014_evidence_v2` (the checksum source). The eleven-column v2
 * `evidence` table, copied verbatim from the v2 plan §Phase-4 task 2 / the
 * `sqlite-data-dictionary.md` §5.6 evidence section. STRICT (types enforced;
 * nullability per the column annotations). Column names are the v2 camelCase form
 * the plan pins — the evidence subsystem is authored fresh, with no v1 legacy to
 * match.
 *
 * The CREATE is followed by the CONTRACT half of the expand-and-contract cutover:
 * DROP the v1 `claims`/`claim_evidence` model (task 4-4), children first
 * (`claim_evidence` carries a `CASCADE` FK onto `claims`, a `RESTRICT` FK onto
 * `source_renditions`, and a self-`RESTRICT` supersession FK — so it must be dropped
 * before `claims`; a whole-table DROP is not blocked by the row-level RESTRICT FKs).
 * Then the ledger/backup DROPs (task 4-1): `audit_events`, `audit_intents`,
 * `backup_watermark`, `raw_payloads`. These have no INBOUND FK from any surviving
 * table (`audit_events`/`agent_runs` reference each other by scalar id only, no FK;
 * `raw_payloads`'s only FK is OUTBOUND to `agent_runs`), so drop order is
 * unconstrained.
 */
export const EVIDENCE_V2_DDL = `CREATE TABLE evidence (
  id             TEXT    NOT NULL PRIMARY KEY,
  noteId         TEXT,                                    -- soft reference to notes(note_id); NOT a rebuild-enforced FK
  sectionPath    TEXT,
  claim          TEXT,
  citation       TEXT,
  status         TEXT    CHECK (status IN ('pending', 'resolved', 'failed', 'needs-review')),
  verdict        TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lastCheckedAt  TEXT,
  sourceNoteHash TEXT,                                    -- content-hash staleness guard (row is stale when != note's on-disk hash)
  createdAt      TEXT
) STRICT;
DROP TABLE claim_evidence;
DROP TABLE claims;
DROP TABLE audit_events;
DROP TABLE audit_intents;
DROP TABLE backup_watermark;
DROP TABLE raw_payloads;`;

/** The `0014_evidence_v2` migration (registered in `openStore`'s default set). */
export const migration0014EvidenceV2: Migration = {
  id: "0014_evidence_v2",
  checksum: migrationChecksum(EVIDENCE_V2_DDL),
  up(db) {
    db.exec(EVIDENCE_V2_DDL);
  },
};
