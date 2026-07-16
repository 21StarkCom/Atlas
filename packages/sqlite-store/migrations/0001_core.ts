/**
 * `0001_core` — the persistence-core migration owned by `@atlas/sqlite-store`
 * (plan §2.7). Creates the four core vault projections, the operational/audit
 * ledger, and the §6 index-contract indexes it owns.
 *
 * Every `CREATE TABLE` below is copied **VERBATIM** from
 * `docs/specs/sqlite-data-dictionary.md` (§2, §3) — no invented columns, types,
 * constraints, or indexes (dictionary §0 binding conventions). The inline
 * indexes declared alongside their tables in the dictionary are included, plus
 * `idx_notes_needs_index` (§6) — a `notes` index owned by this migration
 * because `notes` is created here.
 *
 * `db_schema_migrations` is NOT created here — it is the runner's bootstrap (§1).
 */
import type { Migration } from "../src/migrate.js";
import { migrationChecksum } from "../src/migrate.js";

/** The verbatim DDL text (dictionary §2–§3 + the §6 `idx_notes_needs_index`). */
export const CORE_DDL = `CREATE TABLE notes (
  note_id            TEXT    NOT NULL PRIMARY KEY,        -- immutable frontmatter \`id\`
  slug               TEXT    NOT NULL,                    -- current human-readable slug
  title              TEXT    NOT NULL,
  type               TEXT    NOT NULL,                    -- source|person|project|concept|decision|...
  schema_version     INTEGER NOT NULL,                    -- V1 supports 1
  status             TEXT    NOT NULL,
  file_path          TEXT    NOT NULL,                    -- vault-relative path
  content_hash       TEXT    NOT NULL,                    -- sha256 of canonical note bytes
  active_generation  INTEGER NOT NULL DEFAULT 0,          -- monotonic fence counter for the needs-index scan (§6)
  active_generation_id TEXT,                              -- composite LanceDB SearchChunk.generationId this note's retrieval is fenced to; NULL until first indexed; set by Store.activateGeneration (Task 3.2). Provisioned here in 0001_core (the retained notes projection); Phase 3's only migration, 0008_index_config_revision, adds the separate config-adoption log, not this column.
  created            TEXT    NOT NULL,
  updated            TEXT    NOT NULL,
  quarantined        INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
  UNIQUE (slug)
) STRICT;

CREATE TABLE note_identity_keys (
  normalized_key      TEXT    NOT NULL PRIMARY KEY,       -- output of the versioned normalization algo
  note_id             TEXT    NOT NULL,
  kind                TEXT    NOT NULL CHECK (kind IN ('slug', 'alias')),
  normalizer_version  INTEGER NOT NULL,                   -- normalization contract version that produced the key
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_note_identity_keys_note ON note_identity_keys(note_id, kind);

CREATE TABLE note_links (
  source_note_id  TEXT    NOT NULL,
  target_note_id  TEXT    NOT NULL,
  predicate       TEXT    NOT NULL,
  ordinal         INTEGER NOT NULL DEFAULT 0,             -- authoring order within (source, predicate)
  PRIMARY KEY (source_note_id, target_note_id, predicate),
  FOREIGN KEY (source_note_id) REFERENCES notes(note_id) ON DELETE CASCADE,
  FOREIGN KEY (target_note_id) REFERENCES notes(note_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_note_links_reverse ON note_links(target_note_id, predicate);

CREATE TABLE vault_schema_migrations (
  schema_version  INTEGER NOT NULL PRIMARY KEY,
  applied_at      TEXT    NOT NULL,
  note_count      INTEGER NOT NULL DEFAULT 0               -- notes migrated to this version
) STRICT;

CREATE TABLE agent_runs (
  run_id            TEXT    NOT NULL PRIMARY KEY,
  operation         TEXT    NOT NULL,                     -- ingest|enrich|reconcile|maintain|...
  status            TEXT    NOT NULL CHECK (status IN (
                      'planned', 'patched', 'worktree-applied', 'agent-committed', 'review-pending',
                      'integrated', 'reindexed', 'finalized',
                      'rejected', 'rolled-back', 'failed', 'cancelled')),
  failed_checkpoint TEXT,                                 -- set iff status IN ('failed','cancelled'); the checkpoint suffix
  checkpoint_seq    INTEGER NOT NULL DEFAULT 0,           -- monotonic per-run checkpoint counter
  target_note_id    TEXT,                                 -- scalar historical id; NO FK into projections
  tier              INTEGER,                              -- 1|2|3 once planned
  started_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  finished_at       TEXT,
  CHECK ((status IN ('failed', 'cancelled')) = (failed_checkpoint IS NOT NULL))
) STRICT;

CREATE INDEX idx_agent_runs_status ON agent_runs(status);

CREATE TABLE model_calls (
  call_id        TEXT    NOT NULL PRIMARY KEY,
  run_id         TEXT    NOT NULL,
  provider       TEXT    NOT NULL,                        -- e.g. 'gemini'
  model          TEXT    NOT NULL,                        -- gemini-3.5-flash | gemini-embedding-001
  operation      TEXT    NOT NULL,                        -- generate|extract|classify|synthesize|embed
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_micros    INTEGER NOT NULL DEFAULT 0,              -- integer micro-USD
  created_at     TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_model_calls_run ON model_calls(run_id);

CREATE TABLE retrieval_runs (
  retrieval_id      TEXT    NOT NULL PRIMARY KEY,
  run_id            TEXT,                                 -- nullable: ad-hoc query not tied to a workflow run
  query_text        TEXT    NOT NULL,
  mode              TEXT    NOT NULL,                     -- id|alias|fts|vector|hybrid
  index_generation  INTEGER NOT NULL,                    -- generation the query ran against
  recall_at_10      REAL,                                 -- eval metrics, populated when measured
  mrr               REAL,
  created_at        TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE retrieval_results (
  retrieval_id  TEXT    NOT NULL,
  rank          INTEGER NOT NULL,                         -- 1-based fused rank
  note_id       TEXT    NOT NULL,                         -- scalar historical id; NO FK into projections
  score         REAL    NOT NULL,                         -- fused RRF score
  channel       TEXT    NOT NULL,                         -- id|alias|fts|vector (contributing channel)
  PRIMARY KEY (retrieval_id, rank),
  FOREIGN KEY (retrieval_id) REFERENCES retrieval_runs(retrieval_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE change_plans (
  plan_id     TEXT    NOT NULL PRIMARY KEY,
  run_id      TEXT    NOT NULL,
  tier        INTEGER NOT NULL,                           -- 1|2|3
  confidence  REAL    NOT NULL,
  summary     TEXT    NOT NULL,
  plan_hash   TEXT    NOT NULL,                           -- sha256 of the canonical plan payload
  created_at  TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE patches (
  patch_id          TEXT    NOT NULL PRIMARY KEY,
  plan_id           TEXT    NOT NULL,
  note_id           TEXT    NOT NULL,                     -- scalar historical id; NO FK into projections
  changed_lines     INTEGER NOT NULL DEFAULT 0,           -- Tier-2 gate input (≤ 50)
  changed_sections  INTEGER NOT NULL DEFAULT 0,           -- Tier-2 gate input (≤ 3)
  patch_hash        TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES change_plans(plan_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE patch_operations (
  patch_id      TEXT    NOT NULL,
  ordinal       INTEGER NOT NULL,                         -- deterministic apply order
  op_type       TEXT    NOT NULL,                         -- e.g. UpdateEvidenceVerification|SetSection|...
  target_path   TEXT    NOT NULL,                         -- section/anchor within the note
  payload_hash  TEXT    NOT NULL,
  PRIMARY KEY (patch_id, ordinal),
  FOREIGN KEY (patch_id) REFERENCES patches(patch_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE validation_results (
  validation_id  TEXT    NOT NULL PRIMARY KEY,
  run_id         TEXT    NOT NULL,
  check_name     TEXT    NOT NULL,
  outcome        TEXT    NOT NULL CHECK (outcome IN ('pass', 'fail', 'warn')),
  detail         TEXT,
  created_at     TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE git_operations (
  git_op_id   TEXT    NOT NULL PRIMARY KEY,
  run_id      TEXT    NOT NULL,
  op_type     TEXT    NOT NULL,                           -- branch|commit|integrate|rollback|...
  ref_name    TEXT    NOT NULL,
  commit_sha  TEXT,                                       -- null until the commit exists
  created_at  TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE audit_events (
  seq           INTEGER NOT NULL PRIMARY KEY,             -- global monotonic allocation
  run_id        TEXT    NOT NULL,                         -- scalar run id; NO FK (survives rebuild)
  event_type    TEXT    NOT NULL CHECK (event_type IN (
                  'run.started', 'run.planned', 'run.integrated', 'run.refreshed', 'run.rejected',
                  'run.rolled_back', 'run.failed', 'run.cancelled', 'run.readonly', 'run.projection',
                  'db.backup', 'db.restore', 'db.force_unblock', 'evidence.retry_enqueued')),
  payload_hash  TEXT    NOT NULL,                         -- hash of the canonical allowlisted-metadata payload
  git_head      TEXT,                                     -- refs/audit/runs head returned by the broker append
  created_at    TEXT    NOT NULL,
  UNIQUE (run_id, seq)
) STRICT;

CREATE INDEX idx_audit_events_run ON audit_events(run_id);

CREATE TABLE audit_intents (
  run_id        TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  payload_hash  TEXT    NOT NULL,                         -- canonical event payload hash (matches audit_events)
  state         TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done')),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (seq)                                            -- enforces the global monotonic allocation
) STRICT;

CREATE TABLE backup_watermark (
  id              INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  seq             INTEGER NOT NULL DEFAULT 0,             -- highest audit seq durably backed up
  healthy         INTEGER NOT NULL DEFAULT 1 CHECK (healthy IN (0, 1)),  -- 0 => 'backup-unhealthy', blocks writes
  last_backup_at  TEXT,
  updated_at      TEXT    NOT NULL
) STRICT;

CREATE TABLE raw_payloads (
  payload_id  TEXT    NOT NULL PRIMARY KEY,
  run_id      TEXT    NOT NULL,                           -- scalar run id
  ciphertext  BLOB    NOT NULL,                           -- AEAD ciphertext
  nonce       BLOB    NOT NULL,
  aead_tag    BLOB    NOT NULL,
  created_at  TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_notes_needs_index ON notes(active_generation, content_hash);`;

/** The `0001_core` migration (id, checksum over {@link CORE_DDL}, `up`). */
export const migration0001Core: Migration = {
  id: "0001_core",
  checksum: migrationChecksum(CORE_DDL),
  up(db) {
    db.exec(CORE_DDL);
  },
};
