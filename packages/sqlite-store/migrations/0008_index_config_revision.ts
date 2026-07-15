/**
 * `0008_index_config_revision` — the DURABLE indexing-config **adoption log**
 * (Task 3.2; retrieval-index-contract §2, carry-forward #1). This is the
 * "durable revision ownership" the generation/config fence rests on.
 *
 * ## Why this table exists (round-2 finding 1 + round-3 findings 3 & 4)
 * The activation CAS (`GenerationRepo.activateGeneration`) fences a stale-config
 * worker on `active_generation` — a monotonic **config epoch**. That epoch must be
 * a **server-issued, durably-owned, monotonic** number, NOT an arbitrary
 * caller-supplied integer: a caller who invents the value could inflate it (fencing
 * out every future worker) or under-shoot it (permanently rejecting a legitimate
 * config). So SQLite — the sole activation authority — OWNS the allocation, AND
 * activation consumes a **config identity** (`config_key`), never a raw integer:
 * the caller supplies the config, the server issues and looks up the number
 * (round-3 finding 3).
 *
 * ## Adoption EVENTS, not a permanent first-seen mapping (round-3 finding 4)
 * A permanent `config_key → revision` mapping (allocate-once, first-seen) is wrong:
 *   - **rollback is impossible** — adopt A (rev 1), adopt B (rev 2), then roll back
 *     to A: a permanent map returns A's old rev 1, which can never supersede B's
 *     rev 2, so the rollback can never go live; and
 *   - **first-seen ≠ recency** — an old config first *resolved* after a newer one
 *     would receive a strictly-higher epoch and wrongly win.
 * So this table is an append-only **adoption log**: every adoption EVENT gets a new
 * `MAX(revision) + 1` epoch, and exactly one row is flagged `is_current` (the
 * durable "current configuration"). Re-adopting a config that is not current
 * (a rollback or a re-adoption) records a NEW event with a strictly-higher epoch,
 * so it CAN supersede whatever is live; re-adopting the already-current config is
 * idempotent (no new event). A config's live epoch is therefore
 * `MAX(revision) WHERE config_key = ?` — its most-recent adoption — which reflects
 * **adoption recency**, exactly what the fence needs. `GenerationRepo.adoptConfig`
 * appends events; `activateGeneration`/`tombstoneGeneration` look the epoch up.
 *
 * ## Migration ownership (plan §2.7 + the retained-vs-feature PR split)
 * This is a FEATURE migration, authored and registered exactly like `0002_jobs`
 * (PR-B) and `0006_workflow_idempotency` (Task 2.5): it lives here in
 * `packages/sqlite-store/migrations/` as a first-class, checksum-guarded
 * {@link Migration}, registered via {@link registerGenerationMigration}
 * (`Store.registerMigration`) BEFORE `Store.migrate()` at store-open. It is now
 * recorded in the authoritative §2.7 migration-ownership table (plan + the
 * `sqlite-data-dictionary.md` inventory + the `MIGRATION_OWNERSHIP` contract gate
 * in `tools/cli-contract.ts`), so the single-owner migration contract is honoured
 * (round-3 finding 5). It is applied through the NORMAL `runMigrations` runner —
 * never lazily created (`CREATE TABLE IF NOT EXISTS`) during a command.
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The DDL owned by `0008_index_config_revision` (the checksum source, copied
 * verbatim into the `sqlite-data-dictionary.md` §2.7 inventory). */
export const INDEX_CONFIG_REVISION_DDL = `CREATE TABLE index_config_revisions (
  revision    INTEGER NOT NULL PRIMARY KEY,   -- monotonic adoption epoch (>= 1); each adoption event gets MAX(revision)+1
  config_key  TEXT    NOT NULL,               -- deterministic hash of the fence-relevant indexing config (chunker_version, embedding_model, dimensions)
  is_current  INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),  -- 1 on exactly one row: the durable "current configuration"
  adopted_at  TEXT    NOT NULL,               -- RFC3339 time this adoption event was recorded
  CHECK (revision >= 1)
) STRICT;

CREATE UNIQUE INDEX idx_index_config_revisions_current ON index_config_revisions(is_current) WHERE is_current = 1;
CREATE INDEX idx_index_config_revisions_key ON index_config_revisions(config_key);`;

/** The `0008_index_config_revision` migration (id, checksum, `up`). */
export const migration0008IndexConfigRevision: Migration = {
  id: "0008_index_config_revision",
  checksum: migrationChecksum(INDEX_CONFIG_REVISION_DDL),
  up(db) {
    db.exec(INDEX_CONFIG_REVISION_DDL);
  },
};
