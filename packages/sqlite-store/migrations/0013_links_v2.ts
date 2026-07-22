/**
 * `0013_links_v2` — the v2 note-link shape (phase-3 demolition, task 3-4).
 *
 * The v1 `note_links` (`0001_core`) cannot represent what the v2 `link` command
 * (task 3-6) needs:
 *   - a **plain** `[[wiki-link]]` (no relationship type) — v1's `predicate` is
 *     `NOT NULL`, so every link had to be forced to a synthetic `"references"`;
 *   - a link **alias** (the `[[target|display text]]` display string) — v1 had no
 *     column for it;
 *   - **two uniqueness rules** — at most one plain edge per `(source, target)`
 *     AND at most one typed edge per `(source, target, predicate)` — which the
 *     single 3-column PK could not express (a plain link has no predicate to key
 *     on, and `NULL` is distinct under a composite PK).
 *
 * This is a **table-rebuild** forward migration (migrations are append-only —
 * `0001_core` is immutable once applied, so we forward-migrate rather than edit
 * it). It builds `note_links_v2` with the new column set, copies every v1 row
 * across (each v1 row carried a non-null `predicate`, so it migrates as a
 * relationship edge with `alias NULL`; the dropped `ordinal` column is not
 * carried — v2 has no authoring-order column), swaps the table in, then rebuilds
 * the indexes:
 *   - `ux_note_links_plain` — partial UNIQUE over `(source, target)` WHERE the
 *     predicate IS NULL (at-most-one plain edge between two notes);
 *   - `ux_note_links_pred`  — partial UNIQUE over `(source, target, predicate)`
 *     WHERE the predicate IS NOT NULL (at-most-one typed edge per predicate);
 *   - `idx_note_links_reverse` — recreated verbatim (dropped with the old table)
 *     for the §6 reverse-traversal EQP;
 *   - `idx_note_links_forward` — the §6 FORWARD-traversal index. v1 got its
 *     forward `SEARCH` for free from the 3-column PK's autoindex prefix; dropping
 *     the PK removes that, so the forward index is recreated EXPLICITLY here to
 *     hold the same `SEARCH note_links` (never `SCAN`) query-plan contract that
 *     `verify`/`checkQueryPlans` asserts.
 *
 * FK-safe by construction: `note_links` has ONLY OUTBOUND FKs (`source`/`target`
 * → `notes`); no other table references it, so dropping and renaming it cannot
 * orphan or trip a foreign key. The whole sequence runs inside the migration
 * runner's single `BEGIN IMMEDIATE`.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The full table-rebuild DDL owned by `0013_links_v2` (the checksum source). */
export const LINKS_V2_DDL = `CREATE TABLE note_links_v2 (
  source_note_id  TEXT    NOT NULL,
  target_note_id  TEXT    NOT NULL,
  predicate       TEXT,                                    -- NULL = a plain [[wiki-link]]; set = a typed relationship
  alias           TEXT,                                    -- the [[target|alias]] display text (NULL when absent)
  FOREIGN KEY (source_note_id) REFERENCES notes(note_id) ON DELETE CASCADE,
  FOREIGN KEY (target_note_id) REFERENCES notes(note_id) ON DELETE CASCADE
) STRICT;

INSERT INTO note_links_v2 (source_note_id, target_note_id, predicate, alias)
  SELECT source_note_id, target_note_id, predicate, NULL FROM note_links;

DROP TABLE note_links;

ALTER TABLE note_links_v2 RENAME TO note_links;

CREATE UNIQUE INDEX ux_note_links_plain ON note_links(source_note_id, target_note_id)
  WHERE predicate IS NULL;
CREATE UNIQUE INDEX ux_note_links_pred ON note_links(source_note_id, target_note_id, predicate)
  WHERE predicate IS NOT NULL;
CREATE INDEX idx_note_links_reverse ON note_links(target_note_id, predicate);
CREATE INDEX idx_note_links_forward ON note_links(source_note_id, target_note_id);`;

/** The `0013_links_v2` migration (registered in `openStore`'s default set). */
export const migration0013LinksV2: Migration = {
  id: "0013_links_v2",
  checksum: migrationChecksum(LINKS_V2_DDL),
  up(db) {
    db.exec(LINKS_V2_DDL);
  },
};
