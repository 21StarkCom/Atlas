/**
 * `0015_source_registry` — the v2 operational `source` registry (phase-4
 * persistence strip, task 4-3a / #339).
 *
 * v2 replaces the v1 content-addressed provenance model (`content_blobs` +
 * `source_captures` + `source_renditions` + `note_sources`, `0003`, with its
 * rendition-pinning + trust/capture machinery) with ONE flat operational registry:
 * one row per source, keyed by a stable `id`, deduped on the UNIQUE `locator`. It
 * is the **system-of-record for source rows** (NOT a vault-derived projection): a
 * plain SQLite table `db rebuild` never touches and never re-derives from Markdown,
 * so an operator's `source add` survives a projection rebuild. `source add` writes
 * it directly (no git commit, no capture/normalize — that is `ingest`); `source
 * list`/`show` read it.
 *
 * EXPAND-AND-CONTRACT — this migration is ADDITIVE in task 4-3a: `CREATE TABLE
 * source` ONLY. The v1 provenance tables (`content_blobs`/`source_captures`/
 * `source_renditions`/`note_sources`) STILL COEXIST after `0015` because `ingest` +
 * `apps/cli/src/validation/{provenance,store-vault}.ts` still consume them; their
 * rebase off provenance is task 4-3b (#340), which appends the DROP of the four v1
 * provenance tables to THIS migration's DDL once their last consumer is gone (the
 * `0014_evidence_v2` claims/ledger DROP pattern, applied to `0015`). No intermediate
 * commit migrates against a still-live consumer. This is the newest migration on an
 * unreleased branch, never applied to a real DB before the Phase-5 verified
 * pre-migration snapshot exists, so growing its DDL in #340 is not editing a
 * *released* migration (migrations stay append-only: `0003` is forward-dropped in
 * #340, never edited).
 *
 * FK-free by construction: `source` has no foreign keys, so a fresh `db migrate`
 * cannot trip a restrictive FK. The whole sequence runs inside the migration
 * runner's single `BEGIN IMMEDIATE`.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/**
 * The DDL owned by `0015_source_registry` (the checksum source). The six-column v2
 * `source` registry, copied verbatim from the v2 plan §Phase-4 task 3 /
 * `sqlite-data-dictionary.md` §5.7. STRICT (types enforced). `locator` is UNIQUE
 * (the dedup key — `source add` is a NOOP SUCCESS on a duplicate locator) and `kind`
 * carries a CHECK enum (`'file'` | `'url'`). Column names are the v2 camelCase form
 * the plan pins (`addedAt`/`lastIngestedAt`).
 *
 * ADDITIVE in #339 — the DROP of the v1 provenance tables (`content_blobs`,
 * `source_captures`, `source_renditions`, `note_sources`) is appended here in task
 * 4-3b/#340, children-first, once `ingest` + provenance validation are rebased off
 * them (expand-and-contract).
 */
export const SOURCE_REGISTRY_DDL = `CREATE TABLE source (
  id             TEXT NOT NULL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('file', 'url')),
  locator        TEXT NOT NULL UNIQUE,
  title          TEXT,
  addedAt        TEXT NOT NULL,
  lastIngestedAt TEXT
) STRICT;`;

/** The `0015_source_registry` migration (registered in `openStore`'s default set). */
export const migration0015SourceRegistry: Migration = {
  id: "0015_source_registry",
  checksum: migrationChecksum(SOURCE_REGISTRY_DDL),
  up(db) {
    db.exec(SOURCE_REGISTRY_DDL);
  },
};
