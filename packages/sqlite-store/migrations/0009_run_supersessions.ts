/**
 * `0009_run_supersessions` — the supersession ledger for the Tier-3 refresh loop
 * (Task 4.5 §refresh). `git refresh` / `refreshRun` regenerates a review-pending run
 * against the current canonical head, producing a NEW agent commit that SUPERSEDES the
 * prior review-pending commit while the run stays in the review gate. Each refresh
 * records one row here: the canonical head it rebased onto (`base_commit`), the commit
 * it superseded, and the new superseding commit.
 *
 * ## Migration ownership (plan §2.7 + the retained-vs-feature PR split)
 * A FEATURE migration authored + registered exactly like `0006_workflow_idempotency`:
 * it lives here as a first-class, checksum-guarded {@link Migration}, is NOT part of
 * `openStore`'s default retained set, and is applied through the workflows layer's
 * `registerWorkflowMigrations` at store-open via the normal checksum-guarded runner.
 *
 * ## Key = `(run_id, base_commit)` — the refresh idempotency key
 * The natural key is `(run_id, base_commit)`: refresh is **key-accepting against the
 * canonical head** (spec §refresh — "a repeat refresh against the same canonical head
 * returns the existing superseding commit rather than creating another"). A repeat
 * refresh while canonical has not moved finds the existing row and returns its
 * `new_commit`; once canonical advances, `base_commit` differs and a fresh refresh is
 * recorded. The superseded commit is RETAINED for the audit trail (a dangling git
 * object after the agent ref advances), never fast-forwarded onto canonical.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The DDL owned by `0009_run_supersessions` (the checksum source). */
export const RUN_SUPERSESSIONS_DDL = `CREATE TABLE run_supersessions (
  run_id            TEXT NOT NULL,
  base_commit       TEXT NOT NULL,
  superseded_commit TEXT NOT NULL,
  new_commit        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, base_commit)
) STRICT;`;

/** The `0009_run_supersessions` migration (registered by the workflows layer). */
export const migration0009RunSupersessions: Migration = {
  id: "0009_run_supersessions",
  checksum: migrationChecksum(RUN_SUPERSESSIONS_DDL),
  up(db) {
    db.exec(RUN_SUPERSESSIONS_DDL);
  },
};
