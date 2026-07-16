/**
 * `0011_run_inputs` — the persisted synthesis input for a run (Task 4.11). `git refresh <runId>`
 * re-plans a review-pending run against current canonical, which needs the run's original
 * generation input. The KIND (`enrich`/`reconcile`/`maintain`) and TARGET are already on
 * `agent_runs` (`operation` + `target_note_id`); the INSTRUCTION + retrieval knobs are not, so this
 * table records them — one row per run, written when the run is created. Absence ⇒ the run predates
 * this table (or was not a synthesis run) ⇒ `refresh` reports it cannot reconstruct the input.
 *
 * FEATURE migration (registered by the workflows layer at store-open alongside 0006/0009/0010); NOT
 * in `openStore`'s default retained set, and added to the backup §8.3 known-schema-heads.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The DDL owned by `0011_run_inputs` (the checksum source). */
export const RUN_INPUTS_DDL = `CREATE TABLE run_inputs (
  run_id        TEXT    NOT NULL PRIMARY KEY,
  instruction   TEXT    NOT NULL,
  retrieval_k   INTEGER,
  type_filter   TEXT
) STRICT;`;

/** The `0011_run_inputs` migration (registered by the workflows layer). */
export const migration0011RunInputs: Migration = {
  id: "0011_run_inputs",
  checksum: migrationChecksum(RUN_INPUTS_DDL),
  up(db) {
    db.exec(RUN_INPUTS_DDL);
  },
};
