# SQLite data dictionary (normative)

> **Status:** normative contract · **Version:** 1 · **Phase:** 0 (lands before any persistence code).
> **Consumes:** the implementation plan's **§2.7 migration-ownership table** (the single authoritative
> table set) and the design spec's *Data model* / *Two classes of state* sections.
> **Produces:** the DDL single source of truth. Tasks **1.4, 2.1, 2.7, 4.1** copy each table's
> `CREATE TABLE` **verbatim** from here into their owning migration. No migration invents columns,
> types, constraints, or indexes not fixed in this document.

This document fixes, for **every** table in §2.7: every column, SQL type, PK/FK, nullability,
UNIQUE, CHECK, `ON DELETE` behavior (per the retention matrix), and the **upsert conflict target**.
It also fixes the **versioned index contract** (composite indexes + query-plan assertions) and the
**invariant-validation queries** `atlas db verify` runs.

It is gated by `tools/contract-lint.test.ts` — the **table-inventory check** parses every
`CREATE TABLE` in this file and asserts the set is **exactly** §2.7's (no missing, extra, or
duplicate table), the same load-bearing guarantee the registry↔fixture and `stateTable`
completeness gates provide.

---

## 0. Binding conventions

- **`STRICT` tables.** Every table is declared `STRICT` (SQLite ≥ 3.37): column types are enforced,
  no silent affinity coercion. `TEXT` timestamps are RFC-3339 UTC strings (`YYYY-MM-DDTHH:MM:SSZ`);
  booleans are `INTEGER` `0`/`1` with a `CHECK (col IN (0,1))`. Money/cost is integer micro-units
  (`INTEGER`), never floating point. Scores are `REAL`.
- **`PRAGMA foreign_keys = ON`** for every connection (design: *FKs on*). Composite FKs use
  SQLite's default `MATCH SIMPLE`: if **any** referencing column is `NULL` the constraint is not
  enforced — this is exactly how the nullable active-rendition pointer (§4.1) works.
- **Composite identifiers are component scalar columns, never packed strings** (design *Normative
  schema*, plan Review-Hint; fixes R3-F6). (The v1 `content_blobs`/`source_renditions` composite-PK
  provenance tables that embodied this rule are retired — #340 — but the CLI-facing `sourceId`/
  `contentId`/`renditionId` handle parsing survives in `packages/contracts/src/ids.ts` as a serialized
  convenience parsed to components at the command boundary, never persisted as a packed string.)
- **Two classes of state** (design *Two classes of state*): **vault projections** are deterministically
  rebuildable from canonical Markdown; `atlas db rebuild` replaces them in one transaction. The
  **operational/audit ledger** is primary state, has no Markdown form, and MUST be backed up.
  **Cross-class FKs are forbidden:** ledger tables reference notes/sources **only by immutable
  scalar historical identifiers**, never a SQL FK into a replaceable projection — so delete-and-reinsert
  of projections during a rebuild can never violate a restrictive FK. FKs therefore exist **only within
  a single class** (projection→projection, ledger→ledger).
- **`ON DELETE` per the retention matrix** (design *Normative schema*): **audit-referenced rows
  tombstone, never cascade**; a parent whose children are audit history is `RESTRICT`; a parent whose
  children are pure structural detail of the same aggregate is `CASCADE`. Each FK below names its
  `ON DELETE` explicitly (acceptance criterion).
- **Every upsert names its conflict target** (acceptance criterion). Where a table is written via
  `INSERT … ON CONFLICT(<target>) DO UPDATE/NOTHING`, the target column set is stated in the table's
  *Upsert* line and is always a declared PK or UNIQUE constraint.
- **Migration attribution.** Each `CREATE TABLE` heading names its owning §2.7 migration. Exactly one
  migration creates each table; the runner treats an applied migration as a checksum-guarded no-op and
  **never drops tables on downgrade**.

Migration ownership (verbatim from §2.7):

| Migration | Owner package | Phase / PR | Tables |
|---|---|---|---|
| `0001_core` | `sqlite-store` | 1 | `notes`, `note_identity_keys`, `note_links`, `vault_schema_migrations`, `agent_runs`, `model_calls`, `retrieval_runs`, `retrieval_results`, `change_plans`, `patches`, `patch_operations`, `validation_results`, `git_operations` ~~`audit_events`, `audit_intents`, `backup_watermark`, `raw_payloads`~~ *(created by `0001`, forward-dropped by `0014_evidence_v2` — #338; absent from a fresh DB)* |
| `0002_jobs` | `jobs` | 2 PR-B | `jobs`, `job_attempts` |
| `0003_provenance` | `sqlite-store` | 2 PR-A (retained) | ~~`content_blobs`, `source_captures`, `source_renditions`, `note_sources`~~ *(created by `0003`, forward-dropped by `0015_source_registry` — #340; absent from a fresh DB)* |
| `0004_claims` | `sqlite-store` | 4 PR-A (retained) | ~~`claims`, `claim_evidence`~~ *(created by `0004`, forward-dropped by `0014_evidence_v2` — #337; absent from a fresh DB)* |
| `0008_index_config_revision` | `sqlite-store` (feature migration) | 3 (Task 3.2) | `index_config_revisions` |
| `0013_links_v2` | `sqlite-store` (default set) | 3 (task 3-4) | *(no new table — table-rebuilds `note_links` into the v2 shape)* |
| `0014_evidence_v2` | `sqlite-store` (default set) | 4 (task 4-2/4-4) | `evidence` *(and forward-DROPs the v1 `claims`/`claim_evidence`)* |
| `0015_source_registry` | `sqlite-store` (default set) | 4 (task 4-3) | `source` *(and forward-DROPs the v1 `content_blobs`/`source_captures`/`source_renditions`/`note_sources` — #340)* |
| (runner bootstrap) | `sqlite-store` | 1 | `db_schema_migrations` |

---

## 1. Runner bootstrap

### `db_schema_migrations` — (runner bootstrap)

The operational ledger of applied **SQLite DDL** migrations. Created by the migration runner itself
(not a numbered migration). **Ledger class** — NOT a vault projection; `atlas db rebuild` never touches
it. `atlas db migrate` is the sole writer.

```sql
CREATE TABLE db_schema_migrations (
  id          TEXT    NOT NULL PRIMARY KEY,   -- migration id, e.g. '0001_core'
  checksum    TEXT    NOT NULL,               -- sha256 of the migration SQL text
  applied_at  TEXT    NOT NULL                -- RFC-3339 UTC
) STRICT;
```

- **FK:** none.
- **Upsert:** conflict target **`id`** — `ON CONFLICT(id) DO NOTHING`; the runner re-verifies the stored
  `checksum` equals the migration's checksum and **errors on mismatch** (a changed migration body is a
  hard failure, never a silent overwrite).

---

## 2. Core vault projections — `0001_core`

These four are **vault projections** (rebuildable from Markdown; `atlas db rebuild` replaces them in one
transaction). **Exception inside `notes`:** the two generation-fence columns
(`active_generation`, `active_generation_id`) are **activation state** owned by
`Store.activateGeneration`/`tombstoneGeneration` (retrieval-index-contract §2), not a projection of
Markdown — a rebuild **preserves** them for every surviving `note_id` (#212; wiping them forced a
full-corpus re-embed and blanked retrieval until `index repair`). A note whose content changed keeps
its fence pointing at the old generation — the normal `stale` state repair re-embeds.

### `notes` — `0001_core` (vault projection)

```sql
CREATE TABLE notes (
  note_id            TEXT    NOT NULL PRIMARY KEY,        -- immutable frontmatter `id`
  slug               TEXT    NOT NULL,                    -- current human-readable slug
  title              TEXT    NOT NULL,
  type               TEXT    NOT NULL,                    -- source|person|project|concept|decision|...
  schema_version     INTEGER NOT NULL,                    -- V1 supports 1
  status             TEXT    NOT NULL,
  file_path          TEXT    NOT NULL,                    -- vault-relative path
  content_hash       TEXT    NOT NULL,                    -- sha256 of canonical note bytes
  active_generation  INTEGER NOT NULL DEFAULT 0,          -- monotonic config-revision epoch (the generation/config fence, Task 3.2); server-issued + durably owned via the 0008_index_config_revision allocator; drives the needs-index scan (§6). 0 = never indexed.
  active_generation_id TEXT,                              -- composite LanceDB SearchChunk.generationId this note's retrieval is fenced to; NULL until first indexed; set by Store.activateGeneration (Task 3.2). Provisioned here in 0001_core (the retained notes projection); Phase 3's only migration, 0008_index_config_revision, adds the separate config-adoption log, not this column.
  created            TEXT    NOT NULL,
  updated            TEXT    NOT NULL,
  quarantined        INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
  UNIQUE (slug)
) STRICT;
```

- **FK:** none (root of the projection graph).
- **Upsert:** conflict target **`note_id`** — `ON CONFLICT(note_id) DO UPDATE` merging all mutable
  columns; `note_id` is immutable (design: `ProposeRename` never touches `id`).
- **Indexing:** `active_generation` + `content_hash` drive the needs-index scan (§6). `active_generation_id`
  is the join key from a fenced note to its active LanceDB generation (retrieval filters chunks by it);
  the integer counter orders staleness, the id identifies the active generation.

### `note_identity_keys` — `0001_core` (vault projection)

One global identity namespace across slugs and aliases (design *Note identity*). `normalized_key` is
globally UNIQUE (it is the PK).

```sql
CREATE TABLE note_identity_keys (
  normalized_key      TEXT    NOT NULL PRIMARY KEY,       -- output of the versioned normalization algo
  note_id             TEXT    NOT NULL,
  kind                TEXT    NOT NULL CHECK (kind IN ('slug', 'alias')),
  normalizer_version  INTEGER NOT NULL,                   -- normalization contract version that produced the key
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_note_identity_keys_note ON note_identity_keys(note_id, kind);
```

- **FK:** `note_id → notes(note_id)` **`ON DELETE CASCADE`** (an identity key is structural detail of
  its note; both are projection rows rebuilt together).
- **Upsert:** conflict target **`normalized_key`** — `ON CONFLICT(normalized_key) DO UPDATE`; a key that
  would move to a different `note_id` during rebuild is an ambiguity error caught **before** commit
  (design), never a silent re-point.
- **Invariant:** exactly one `kind='slug'` row per `note_id` (§7).

### `note_links` — `0001_core`, reshaped by `0013_links_v2` (vault projection)

Plain `[[wiki-link]]`s (rebuilt from canonical wikilinks — `predicate NULL`, optional display text in
`alias`) **and** typed relationships (`predicate` set, authored by the `link` command). Supports
**bidirectional traversal** (§6). The shape below is the **v2** shape after `0013_links_v2` (a
table-rebuild forward migration): `0001_core` created a 3-column-PK, `NOT NULL predicate`, `ordinal`-carrying,
alias-less table; `0013_links_v2` drops the PK + `ordinal`, makes `predicate` nullable, adds `alias`, and
replaces the PK with two partial unique indexes. Migrations are append-only — `0001_core` is not edited.

```sql
CREATE TABLE note_links (
  source_note_id  TEXT    NOT NULL,
  target_note_id  TEXT    NOT NULL,
  predicate       TEXT,                                   -- NULL = a plain [[wiki-link]]; set = a typed relationship
  alias           TEXT,                                   -- the [[target|alias]] display text (NULL when absent)
  FOREIGN KEY (source_note_id) REFERENCES notes(note_id) ON DELETE CASCADE,
  FOREIGN KEY (target_note_id) REFERENCES notes(note_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX ux_note_links_plain ON note_links(source_note_id, target_note_id)
  WHERE predicate IS NULL;
CREATE UNIQUE INDEX ux_note_links_pred ON note_links(source_note_id, target_note_id, predicate)
  WHERE predicate IS NOT NULL;
CREATE INDEX idx_note_links_reverse ON note_links(target_note_id, predicate);
CREATE INDEX idx_note_links_forward ON note_links(source_note_id, target_note_id);
```

- **FK:** both `→ notes(note_id)` **`ON DELETE CASCADE`** (a link is structural detail; a deleted note's
  links are meaningless). `note_links` has ONLY outbound FKs — nothing references it — which is what makes
  the `0013_links_v2` drop-and-rebuild FK-safe. Validation rejects dangling `noteId` references before commit.
- **Uniqueness:** at most one **plain** edge per `(source, target)` (`ux_note_links_plain`, partial
  `WHERE predicate IS NULL`) AND at most one **typed** edge per `(source, target, predicate)`
  (`ux_note_links_pred`, partial `WHERE predicate IS NOT NULL`). The two are disjoint, so a plain link and a
  typed edge between the same pair coexist. The rebuild fold upserts against the matching partial index
  (conflict target names the partial `WHERE`), refreshing `alias`.
- **Traversal:** forward via `idx_note_links_forward(source_note_id, target_note_id)` (v1 got this from the
  dropped PK prefix); reverse via `idx_note_links_reverse(target_note_id, predicate)`.

### `vault_schema_migrations` — `0001_core` (vault projection)

The canonical **note content-schema** history (which `schema_version` upgrades have been applied to
vault Markdown). This **is** a vault projection, rebuilt from Markdown; it has no bearing on SQLite DDL
(that is `db_schema_migrations`, §1) — the two ledgers are **never conflated**.

```sql
CREATE TABLE vault_schema_migrations (
  schema_version  INTEGER NOT NULL PRIMARY KEY,
  applied_at      TEXT    NOT NULL,
  note_count      INTEGER NOT NULL DEFAULT 0               -- notes migrated to this version
) STRICT;
```

- **FK:** none.
- **Upsert:** conflict target **`schema_version`** — `ON CONFLICT(schema_version) DO UPDATE`.

---

## 3. Operational / audit ledger — `0001_core`

Primary state, **not rebuildable from Markdown**, MUST be backed up. FKs stay **within the ledger
class**; every reference to a note/source is a **scalar historical identifier with no FK** into
the projections (so a rebuild never invalidates ledger history).

### `agent_runs` — `0001_core` (ledger)

The **single authoritative record of the current workflow state + checkpoint sequence** (design
*Invariants*). `status` holds the base §2.5 state class; `failed`/`cancelled` at a checkpoint records the
checkpoint in `failed_checkpoint` (the `failed@<cp>` / `cancelled@<cp>` form of the recovery contract).

```sql
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
```

- **FK:** none (root of the ledger graph).
- **Upsert:** conflict target **`run_id`** — `ON CONFLICT(run_id) DO UPDATE` advancing `status`,
  `checkpoint_seq`, timestamps (the single atomic state write of the recovery state machine).

### `model_calls` — `0001_core` (ledger)

```sql
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
```

- **FK:** `run_id → agent_runs(run_id)` **`ON DELETE RESTRICT`** (cost/audit history; audit-referenced
  rows never cascade).
- **Upsert:** conflict target **`call_id`** — `ON CONFLICT(call_id) DO NOTHING` (immutable audit record;
  idempotent on retry).

### `retrieval_runs` — `0001_core` (ledger)

```sql
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
```

- **FK:** `run_id → agent_runs(run_id)` **`ON DELETE RESTRICT`** (nullable; `MATCH SIMPLE` skips the
  check when `NULL`).
- **Upsert:** conflict target **`retrieval_id`** — `ON CONFLICT(retrieval_id) DO NOTHING`.

### `retrieval_results` — `0001_core` (ledger)

```sql
CREATE TABLE retrieval_results (
  retrieval_id  TEXT    NOT NULL,
  rank          INTEGER NOT NULL,                         -- 1-based fused rank
  note_id       TEXT    NOT NULL,                         -- scalar historical id; NO FK into projections
  score         REAL    NOT NULL,                         -- fused RRF score
  channel       TEXT    NOT NULL,                         -- id|alias|fts|vector (contributing channel)
  PRIMARY KEY (retrieval_id, rank),
  FOREIGN KEY (retrieval_id) REFERENCES retrieval_runs(retrieval_id) ON DELETE CASCADE
) STRICT;
```

- **FK:** `retrieval_id → retrieval_runs(retrieval_id)` **`ON DELETE CASCADE`** (results are structural
  detail of their retrieval run, both within the ledger class — the run is not itself audit-referenced by
  another table).
- **Upsert:** conflict target **`(retrieval_id, rank)`** — `ON CONFLICT(retrieval_id, rank) DO UPDATE`.

### `change_plans` — `0001_core` (ledger, immutable)

Immutable, plan-specific (design *Invariants*).

```sql
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
```

- **FK:** `run_id → agent_runs(run_id)` **`ON DELETE RESTRICT`**.
- **Upsert:** conflict target **`plan_id`** — `ON CONFLICT(plan_id) DO NOTHING` (immutable).

### `patches` — `0001_core` (ledger)

```sql
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
```

- **FK:** `plan_id → change_plans(plan_id)` **`ON DELETE RESTRICT`**.
- **Upsert:** conflict target **`patch_id`** — `ON CONFLICT(patch_id) DO NOTHING`.

### `patch_operations` — `0001_core` (ledger)

```sql
CREATE TABLE patch_operations (
  patch_id      TEXT    NOT NULL,
  ordinal       INTEGER NOT NULL,                         -- deterministic apply order
  op_type       TEXT    NOT NULL,                         -- e.g. UpdateEvidenceVerification|SetSection|...
  target_path   TEXT    NOT NULL,                         -- section/anchor within the note
  payload_hash  TEXT    NOT NULL,
  PRIMARY KEY (patch_id, ordinal),
  FOREIGN KEY (patch_id) REFERENCES patches(patch_id) ON DELETE CASCADE
) STRICT;
```

- **FK:** `patch_id → patches(patch_id)` **`ON DELETE CASCADE`** (operations are structural detail of a
  patch, same ledger class).
- **Upsert:** conflict target **`(patch_id, ordinal)`** — `ON CONFLICT(patch_id, ordinal) DO UPDATE`.

### `validation_results` — `0001_core` (ledger)

```sql
CREATE TABLE validation_results (
  validation_id  TEXT    NOT NULL PRIMARY KEY,
  run_id         TEXT    NOT NULL,
  check_name     TEXT    NOT NULL,
  outcome        TEXT    NOT NULL CHECK (outcome IN ('pass', 'fail', 'warn')),
  detail         TEXT,
  created_at     TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE RESTRICT
) STRICT;
```

- **FK:** `run_id → agent_runs(run_id)` **`ON DELETE RESTRICT`**.
- **Upsert:** conflict target **`validation_id`** — `ON CONFLICT(validation_id) DO NOTHING`.

### `git_operations` — `0001_core` (ledger)

```sql
CREATE TABLE git_operations (
  git_op_id   TEXT    NOT NULL PRIMARY KEY,
  run_id      TEXT    NOT NULL,
  op_type     TEXT    NOT NULL,                           -- branch|commit|integrate|rollback|...
  ref_name    TEXT    NOT NULL,
  commit_sha  TEXT,                                       -- null until the commit exists
  created_at  TEXT    NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE RESTRICT
) STRICT;
```

- **FK:** `run_id → agent_runs(run_id)` **`ON DELETE RESTRICT`**.
- **Upsert:** conflict target **`git_op_id`** — `ON CONFLICT(git_op_id) DO NOTHING`.

> **v2 (#338): the audit/backup ledger is retired.** The `audit_events`,
> `audit_intents`, `backup_watermark`, and `raw_payloads` tables — the §2.8
> audit-ledger write protocol + AEAD backup/watermark — are DROPPED by
> `0014_evidence_v2`. git (one commit per ChangePlan on `refs/heads/main`) is v2's
> only safety mechanism; `agent_runs` / `model_calls` remain as plain operational
> tables. Their `CREATE TABLE`s stay only in the immutable `0001_core` DDL as
> historical record.

---

## 4. Jobs — `0002_jobs`

The `jobs` package is the **sole owner** of these two tables' DDL, repository, and transactions
(design; plan D5). Ledger class (primary state).

### `jobs` — `0002_jobs`

Per-`(workflow, idempotency_key)` uniqueness (design; the rendition-upgrade protocol's key is
`(contentId, new renditionId, owningNoteId)` serialized into `idempotency_key`).

```sql
CREATE TABLE jobs (
  job_id           TEXT    NOT NULL PRIMARY KEY,
  workflow         TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  state            TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 1,
  lease_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),  -- reserved fencing token (design; multi-worker leases deferred post-V1)
  next_run_at      TEXT,                                  -- eligibility time; null => not scheduled
  payload          TEXT    NOT NULL,                      -- durable canonical-JSON work payload (Task 2.7 decision 2)
  payload_hash     TEXT    NOT NULL,                      -- sha256(canonicalSerialize(payload)); verified against `payload` on read
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  UNIQUE (workflow, idempotency_key)
) STRICT;

CREATE INDEX idx_jobs_eligibility ON jobs(state, next_run_at);
```

- **FK:** none.
- **Upsert:** conflict target **`(workflow, idempotency_key)`** —
  `ON CONFLICT(workflow, idempotency_key) DO NOTHING` (enqueue is idempotent; the per-owning-note
  re-verification job cannot be suppressed by a sibling note's key).
- **Eligibility:** `idx_jobs_eligibility(state, next_run_at)` (§6).
- **`lease_epoch`:** the reserved monotonic fencing token (design; plan Task 2.7 "`lease_epoch`
  reserved-written"). V1 is a synchronous single-runner, so it is written `0` and never advanced;
  the column exists now so the deferred multi-worker lease/fencing migration copies complete DDL
  verbatim rather than adding a column later.
- **`payload`:** the durable canonical-JSON work payload (Task 2.7 decision 2). `raw_payloads`
  (§3) is deferred out of V1, default **off**, and retention-windowed, so startup dead-runner
  recovery (jobs-contract §6) MUST reconstruct a job's work from the `jobs` row itself — the
  payload therefore lives on the row, not only in the opt-in raw store. It is **allowlisted
  operational metadata** (the enqueued job spec, e.g. a `renditionId` + protocol key), never
  free-form document content. `payload_hash = sha256(canonicalSerialize(payload))` is stored
  alongside and **re-verified on every read** (recovery/execution): a mismatch is a hard
  corruption/tamper error, never a silent execute.

### `job_attempts` — `0002_jobs`

```sql
CREATE TABLE job_attempts (
  job_id          TEXT    NOT NULL,
  attempt_no      INTEGER NOT NULL,
  outcome         TEXT    NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed', 'cancelled')),
  error_code      TEXT,
  side_effect_id  TEXT,                                   -- transactional side-effect id (Task 2.7 decision 1); NULL for content-addressed effects
  started_at      TEXT    NOT NULL,
  finished_at     TEXT,
  PRIMARY KEY (job_id, attempt_no),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
) STRICT;
```

- **FK:** `job_id → jobs(job_id)` **`ON DELETE CASCADE`** (attempts are structural detail of a job, same
  ledger class).
- **Upsert:** conflict target **`(job_id, attempt_no)`** — `ON CONFLICT(job_id, attempt_no) DO UPDATE`
  (an attempt row is finalized in place: `outcome`/`finished_at`/`side_effect_id`).
- **`side_effect_id`:** the durable, transactionally-recorded side-effect id (Task 2.7 decision 1,
  resolving the jobs-contract §7 OPEN block). Written **in the SAME transaction as the attempt's
  finalization** so a crash cannot land the effect without its id (or vice-versa). Phase-2 capture
  effects are all content-addressed (broker capture keyed by `captureId`, notes by identity hash),
  so those attempts leave it **NULL** and rely on content-addressing for crash-idempotency. It is
  populated for **mutable** Phase-4 effects (evidence re-verification status, backup pruning,
  quarantine expiry) where re-deriving a content id cannot prove whether a mutation committed
  before a crash — such an effect needs this durable id to be crash-idempotent.

---

## 5. Provenance — RETIRED (#340)

**The v1 content-addressed provenance model is gone.** The four projection tables
(`content_blobs` + `source_captures` + `source_renditions` + `note_sources`, `0003_provenance`, with
their rendition-pinning / active-rendition-pointer / origin-observation machinery) are
**forward-dropped by `0015_source_registry`** (children-first: `note_sources`, then `source_captures` +
`source_renditions`, then `content_blobs`). v2 replaces them with ONE flat operational **`source`
registry** (§5.7) — one row per source, keyed by a stable `id`, deduped on a UNIQUE `locator` — and
`ingest` produces a first-class note committed directly onto `refs/heads/main` (the canonical mutation
order), whose `sources:` frontmatter cites the registry `id`. `0003_provenance` still runs (it is an
immutable applied migration) but its four tables are dropped in the same forward migration that creates
`source`, so a fresh DB never carries them. Their CREATE DDL is retained only in the immutable
`0003_provenance.ts` migration file (historical vocabulary), never in this dictionary.

**Retired (#337): the v1 `claims` / `claim_evidence` model.** The rendition-pinned evidence model
(`claims` + `claim_evidence`, `0004_claims`, with its lineage/payload_hash/supersession machinery
coupled to the run ledger) is **forward-dropped by `0014_evidence_v2`** and replaced by the flat
vault-derived `evidence` projection (§5.6). `0004_claims` still runs (it is an immutable applied
migration) but its two tables are dropped in the same forward migration that creates `evidence`, so a
fresh DB never carries them. Their CREATE DDL is retained only in the immutable `0004_claims.ts`
migration file (historical vocabulary), never in this dictionary.

---

## 5.5 Retrieval index generation fence — `0008_index_config_revision`

### `index_config_revisions` — `0008_index_config_revision` (ledger, adoption log)

The durable **indexing-config adoption log** the generation/config fence rests on (Task 3.2;
retrieval-index-contract §2, carry-forward #1). **Ledger class** — operational state with no Markdown
form; `atlas db rebuild` never touches it. A FEATURE migration (registered via
`registerGenerationMigration`, like `0002_jobs`/`0006_workflow_idempotency`), NOT in `openStore`'s
default retained set.

`active_generation` on `notes` carries the **config epoch** the active generation was produced under;
that epoch must be **server-owned**, not a caller-invented integer (an inflated value would fence out
every future worker; an under-shot one would permanently reject a legitimate config). So activation
consumes a **config identity** (`config_key`, a deterministic hash of `chunker_version` /
`embedding_model` / `dimensions`) and the store resolves + issues the epoch. This table records an
append-only **adoption event** per `MAX(revision) + 1`, with exactly one `is_current` row (the durable
"current configuration"). Re-adopting the current config is idempotent; adopting a different one — an
upgrade OR a rollback/re-adoption — mints a NEW, strictly-higher epoch, so a rolled-back-to config can
supersede whatever is live. A config's live epoch is `MAX(revision) WHERE config_key = ?` — its
most-recent adoption — so **adoption recency** (operator order), not first-seen order, drives the fence.

```sql
CREATE TABLE index_config_revisions (
  revision    INTEGER NOT NULL PRIMARY KEY,   -- monotonic adoption epoch (>= 1); each adoption event gets MAX(revision)+1
  config_key  TEXT    NOT NULL,               -- deterministic hash of the fence-relevant indexing config (chunker_version, embedding_model, dimensions)
  is_current  INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),  -- 1 on exactly one row: the durable "current configuration"
  adopted_at  TEXT    NOT NULL,               -- RFC3339 time this adoption event was recorded
  CHECK (revision >= 1)
) STRICT;

CREATE UNIQUE INDEX idx_index_config_revisions_current ON index_config_revisions(is_current) WHERE is_current = 1;
CREATE INDEX idx_index_config_revisions_key ON index_config_revisions(config_key);
```

- **FK:** none (a self-contained adoption log; `notes.active_generation` references an epoch by value,
  never a SQL FK — the cross-class ledger→projection rule).
- **Invariant:** `idx_index_config_revisions_current` (partial UNIQUE on `is_current WHERE is_current = 1`)
  enforces **at most one current configuration**; `GenerationRepo.adoptConfig` clears the prior current
  in the same transaction it inserts the new event, so switching is atomic.
- **Upsert:** none — `adoptConfig` is an explicit append (`INSERT`) of a new adoption event; the CAS
  reads the config's live epoch (`MAX(revision) WHERE config_key = ?`) and never writes this table.

---

## 5.6 Evidence — `0014_evidence_v2`

### `evidence` — `0014_evidence_v2` (vault projection)

The v2 **flat, vault-derived** evidence projection (Phase-4 persistence strip). It replaces the v1
rendition-pinned model (`claims` + `claim_evidence`, `0004`, with its lineage/payload_hash/supersession
machinery coupled to the run ledger) with ONE row per evidence entry folded from note frontmatter.

**SSOT resolution — the vault is the single authority.** The note frontmatter owns all evidence state
(`claim` / `citation` / `status` / `verdict` / `attempts`); the evidence commands mutate it via
ChangePlans through the canonical mutation order, and the row is **folded from the committed note on
`sync` / `db rebuild`**. So `git revert <sha>` + `brain sync` re-folds the row and no stale evidence
survives. `noteId` is a **soft reference** to `notes(note_id)` — deliberately **not** a rebuild-enforced
FK (a `db rebuild` regenerates evidence from note frontmatter, so a transiently-dangling reference must
never abort the rebuild). `sourceNoteHash` is the **between-fold staleness guard**: a row whose recorded
hash no longer equals its note's on-disk content hash is treated as stale (`needs-review`), never trusted.

```sql
CREATE TABLE evidence (
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
```

- **FK:** none by construction (`noteId` is soft; a rebuild regenerates every row from note frontmatter,
  so a restrictive FK could never fire).
- **Class:** vault projection — `db rebuild` regenerates it from the working tree (unlike the retained
  operational tables). Column names are the v2 camelCase form (the subsystem is authored fresh, no v1
  legacy to match).

---

## 5.7 Source registry — `0015_source_registry`

### `source` — `0015_source_registry`

The v2 **flat operational source registry** (Phase-4 persistence strip). It replaces the v1
content-addressed provenance model (`content_blobs` + `source_captures` + `source_renditions` +
`note_sources`, `0003`, with its rendition-pinning coupled to the run ledger) with ONE row per source.

**Operational, NOT vault-derived — the system-of-record for source rows.** Unlike the evidence/provenance
projections, `source` is primary operational state: a plain SQLite table `db rebuild` never touches and
never re-derives from Markdown, so an operator's `source add` survives a projection rebuild. `source add`
writes it directly (no git commit, no capture/normalize — that is `ingest`, which stamps `lastIngestedAt`);
`source list`/`show` read it. Dedup is on the UNIQUE `locator`: a duplicate locator is a NOOP SUCCESS
returning the existing row's id, so a repeated `source add <same-locator>` is intrinsically idempotent.

```sql
CREATE TABLE source (
  id             TEXT NOT NULL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('file', 'url')),
  locator        TEXT NOT NULL UNIQUE,
  title          TEXT,
  addedAt        TEXT NOT NULL,
  lastIngestedAt TEXT
) STRICT;
```

- **FK:** none by construction (a self-contained operational registry; no cross-table reference).
- **Invariant:** `locator` is UNIQUE — at most one row per locator; the insert is `ON CONFLICT(locator) DO
  NOTHING` then a SELECT of the existing id (noop success). `kind` is constrained to `'file'`/`'url'`.
- **Class:** operational — `db rebuild` never touches it (like `agent_runs`/`model_calls`), and it is not
  re-derived from the vault. Column names are the v2 camelCase form (`addedAt`/`lastIngestedAt`).
- **Staged cutover (expand-and-contract):** `0015_source_registry` is ADDITIVE in #339 (this table only);
  the v1 provenance tables (§5.4) still COEXIST because `ingest` + provenance validation still consume them,
  and their DROP is appended to `0015` in task 4-3b/#340 once those are rebased off provenance.

---

## 6. Versioned index contract

**Version: 1.** These indexes map the design's *access patterns* to composite indexes, verified with
`EXPLAIN QUERY PLAN` (EQP) assertions at the **V1 vault profile + growth margin** (maximum-scale profiles
deferred). Any embedding-dimension or chunk-schema change opens a **new index generation** by
construction (config `indexing.dimensions` / `indexing.chunker_version`); this contract governs the
**SQLite** operational indexes only.

| # | Access pattern | Index | EQP assertion |
|---|---|---|---|
| 1 | Job eligibility scan (drain: next runnable job) | `idx_jobs_eligibility(state, next_run_at)` | `SELECT … FROM jobs WHERE state = ? AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at` → `SEARCH jobs USING INDEX idx_jobs_eligibility (state=?)` — **no `SCAN jobs`**. |
| 2 | `note_links` forward traversal | `idx_note_links_forward(source_note_id, target_note_id)` | `… WHERE source_note_id = ?` → `SEARCH note_links USING INDEX idx_note_links_forward (source_note_id=?)` — **no `SCAN`** (v1 used the dropped PK prefix; `0013_links_v2` recreates the forward index explicitly). |
| 3 | `note_links` reverse (bidirectional) traversal | `idx_note_links_reverse(target_note_id, predicate)` | `… WHERE target_note_id = ?` → `SEARCH note_links USING INDEX idx_note_links_reverse (target_note_id=?)` — **no `SCAN`**. |
| 4 | Run lookup by status | `idx_agent_runs_status(status)` | `… FROM agent_runs WHERE status = ?` → `SEARCH agent_runs USING INDEX idx_agent_runs_status (status=?)`. |
| 5 | Identity resolution | PK `note_identity_keys(normalized_key)` | `… WHERE normalized_key = ?` → `SEARCH note_identity_keys USING … (normalized_key=?)` (PK). |
| 6 | Notes-needing-index scan | `idx_notes_needs_index(active_generation, content_hash)` | `… FROM notes WHERE active_generation < ?` → `SEARCH notes USING INDEX idx_notes_needs_index (active_generation<?)` — **no full `SCAN`**. |

*(v2 #338: the audit-lookup-by-run EQP assertion is retired with the `audit_events` table.)*

The one index not co-located with its table above (a `notes` index dedicated to the needs-index scan):

```sql
CREATE INDEX idx_notes_needs_index ON notes(active_generation, content_hash);
```

All other required indexes are declared inline with their tables (§2–§5): `idx_jobs_eligibility`,
`idx_note_links_forward`, `idx_note_links_reverse`, `ux_note_links_plain`, `ux_note_links_pred`,
`idx_agent_runs_status`,
`idx_note_identity_keys_note`, `idx_model_calls_run`. `db verify`'s
query-plan assertion suite (Task 1.4) runs each EQP above and fails on any `SCAN` where a `SEARCH … USING
INDEX` is asserted.

---

## 7. Invariant-validation queries (`atlas db verify`)

`atlas db verify` runs each query below; a non-empty result set (or the boolean stated) is a violation.

1. **Exactly one `slug` key per note.**
   ```sql
   SELECT n.note_id FROM notes n
   LEFT JOIN (SELECT note_id, COUNT(*) c FROM note_identity_keys WHERE kind='slug' GROUP BY note_id) k
     ON k.note_id = n.note_id
   WHERE COALESCE(k.c, 0) <> 1;
   ```
   (The v1 `note_sources` rendition-specific-citation-resolves + active-rendition-consistency
   invariants were retired with the content-addressed provenance model — #340; `0015_source_registry`
   forward-drops `content_blobs`/`source_captures`/`source_renditions`/`note_sources`, and the flat
   `source` registry has no rendition graph to cross-check.)

   (The v1 `claim_evidence` invariants — no-dangling-evidence-rendition, exactly-one-current-head-per-
   lineage, effective-staleness — were retired with the claims model (#337); `0014_evidence_v2`
   forward-drops the table.)

   (v2 #338: the **audit terminal-event cardinality** invariant was retired with the `audit_events`
   table — the §2.8 audit ledger is gone; `agent_runs` is now a plain operational table whose terminal
   status IS the record, so there is no separate terminal-event to reconcile against.)

---

## 8. `db rebuild` scope (per §2.7)

`atlas db rebuild` replaces **only** the vault-projection tables that exist at that point, inside one
transaction, and **never** touches ledger tables or `db_schema_migrations`:

- Always: `notes`, `note_identity_keys`, `note_links`, `vault_schema_migrations`.
- Once `0014_evidence_v2` has landed: `evidence` (via the v2 evidence fold). (The v1 `claims`/
  `claim_evidence` model + its claims fold were retired — #337 — and `0014` forward-drops the tables.
  The v1 `content_blobs`/`source_captures`/`source_renditions`/`note_sources` provenance projections +
  their `foldProvenanceManifests` fold were retired — #340 — and `0015` forward-drops those tables; the
  flat `source` registry is OPERATIONAL, never rebuilt from Markdown.)

Because ledger tables reference projections only by scalar identifier (no cross-class FK), the
delete-and-reinsert of the projection set inside the rebuild transaction can never violate a restrictive
FK or orphan ledger history.
