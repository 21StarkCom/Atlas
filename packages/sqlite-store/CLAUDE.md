# `@atlas/sqlite-store` — the persistence core

`@atlas/sqlite-store` owns **all non-jobs tables** and the machinery around them: the `better-sqlite3` connection factory, the gap-tolerant checksum-guarded migration runner, the transactional projection rebuild, the guarded-DML statement runner (`applyLedgerWrite` in `src/statements.ts`), and `db verify`. Private workspace pkg, `type: module`, ESM/NodeNext. Build `tsc -p tsconfig.json`; test `vitest run`.

> **v2 (#338/#339/#340): the audit ledger + AEAD backup are RETIRED.** The §2.8 cross-store write protocol (`finalizeLedgerWrite`, `audit_intents`, `reconcileInterruptedRuns`), the encrypted backup/restore/verify subsystem, and the fail-closed `backup_watermark` gate are all gone — `src/ledger/` and `src/backup/` are deleted, `0014_evidence_v2` DROPs `audit_events`/`audit_intents`/`backup_watermark`/`raw_payloads`, and `0015_source_registry` DROPs the four v1 content-addressed provenance tables. **git (one commit per ChangePlan on `refs/heads/main`) is v2's only safety mechanism** — `git revert <sha>` + `brain sync` is the undo, `git log`/`git blame` is the audit trail. `agent_runs` + `model_calls` are **plain operational tables** (`db rebuild` still never touches them; a fresh vault simply lacks them — they are no longer "recovered from a backup"). What survived: `applyLedgerWrite` + `LedgerStatement`/`LedgerAssertion` (the guarded-DML runner every plain-transaction writer uses), relocated to `src/statements.ts`.

- **Deps:** `@atlas/contracts` (workspace), `better-sqlite3` + `yaml` (`catalog:`). No broker dependency — v2 has no broker.
- **Consumes:** `VaultSnapshot`/`ParsedNote` from `@atlas/contracts`. **Never imports `apps/cli` (D14).**
- **Dependents:** `apps/cli` (all `db *`/`index`/workflow commands + `source`/`evidence` reads), `@atlas/jobs` (registers `0002`/`0007`). The CLI composition root wires everything: `apps/cli/src/commands/store-open.ts` calls `openStore` + `registerWorkflowMigrations` + `registerGenerationMigration` + `registerSyncCursorsMigration`.
- **SSOTs it implements (cross-link, don't duplicate):** `docs/specs/sqlite-data-dictionary.md` (schema / invariants / index contract / rebuild / per-FK `ON DELETE`). Generation fence: `docs/specs/retrieval-index-contract.md` §2. The v2 retirement decision: `docs/adr/0003-retire-security-architecture.md`.

## Two classes of state (the defining split, dictionary "Two classes of state")

- **Projections** (`notes`, `note_identity_keys`, `note_links`, `vault_schema_migrations`, + the vault-derived `evidence` table) are deterministically **rebuildable from canonical Markdown** — delete-and-reinsert on `db rebuild`.
- **Operational** tables (`agent_runs`, `model_calls`, `retrieval_runs`, `retrieval_results`, `source`, `change_plans`, `git_operations`, …) are **primary state `db rebuild` never touches**. v2 retired the audit ledger + AEAD backup, so these are no longer recovered from a backup — a fresh vault simply starts without them (git is the safety mechanism, not a SQLite backup).
- **Authoritative non-derived** tables: **`sync_cursors`** (`0012`) — the per-source vault-adoption cursor; **`jobs`/`job_attempts`** (the `@atlas/jobs` durable queue). `db rebuild` never touches them (`rebuild-preserves-sync-cursors.test.ts`).
- The two classes reference each other **only by scalar historical id — no cross-class FK** — so a projection rebuild can never violate a restrictive FK or orphan operational history.

## Key files (real paths)

- `src/connection.ts` — `openConnection(cfg)`. Every write handle gets **WAL** (concurrent readers during a writer) + **`PRAGMA foreign_keys = ON`** (composite FKs enforced, not advisory) + `busy_timeout` (default 5000ms). `STRICT` is per-table in DDL, no pragma. Also carries the race-safe read-only opener (`openReadonlyLedger`/`captureLedgerIdentity` — fd-identity-pinned, immune to atomic path replace); its `brain watch`/Console consumer is retired in v2, but the primitive still exports.
- `src/migrate.ts` — `runMigrations`, `bootstrapMigrationsTable`, `migrationChecksum`. **Gap-tolerant** (applies registered-but-unapplied by id order; never assumes contiguous max-applied), **checksum-guarded** (`MigrationChecksumError`), **duplicate-guarded** (`DuplicateMigrationError`), **forward-only**. Whole sequence runs under one `BEGIN IMMEDIATE` (`.immediate()`) so concurrent migrators serialize. Tracks applied ids in a runner-owned table **`db_schema_migrations`** — do not confuse with the `vault_schema_migrations` *projection*.
- `src/store.ts` — `openStore(cfg, clock): Store`. Bundles connection + runner + rebuild + verify + repos. Default **retained migration set** = `0001`, `0003`, `0004`, `0005`, `0013`, `0014`, `0015` (the v2 core: `note_links` v2 reshape + vault-derived `evidence` + operational `source` registry, and the expand-and-contract DROPs they carry). `registerMigration(m)` for downstream. `registerGenerationMigration(store)` registers `0008`; `registerSyncCursorsMigration(store)` registers `0012`. Exposes `activateGeneration`/`tombstoneGeneration`/`adoptConfig` → `GenerationRepo`.
- `src/rebuild.ts` — `rebuildProjections(db, snapshot, opts)`: transactional replace of the projection set in ONE txn (dictionary §8). Two ordered registries: **pre-clear** → **projection folds** (v2: the post-restore-rebuild registry is gone with `db restore`). Rejects a snapshot with any `errors` before opening the txn (`SnapshotHasErrorsError`); a dangling `[[wiki-link]]` (or a dangling typed `related:` edge) is `DanglingLinkError` (rolls back). Snapshots + restores the generation fence columns across the clear (#212). Exports `noteIdentityKeys` + `deriveSlug` so the `--from-git` DR path pre-detects cross-note key collisions and drops offenders as gaps (#150).
- `src/verify.ts` — `verify(db)` (§7 invariants) + `checkQueryPlans(db)` (§6 EQP: each must be `SEARCH` not `SCAN`, using the named index). **Table-aware:** any invariant/plan whose table is absent at the current frontier is *skipped*. v2 retired the audit-terminal invariant + `audit-by-run` EQP (with `audit_events`, #338) and the two content-addressed-provenance invariants (with the v1 provenance tables, #340). Surviving invariant: `one-slug-per-note`.
- `src/statements.ts` — the surviving statement-runner seam (relocated out of the deleted `src/ledger/`): `applyLedgerWrite` + `LedgerStatement`/`LedgerAssertion`/`LedgerAssertionError` + `payloadHashOf`. The general guarded-DML runner every plain-transaction writer uses (workflow checkpoints, `query`'s `model_calls`/`retrieval_*` writes, the model-call statement builder).
- `src/repos/` — `projections.ts`, `ledger.ts` (now just the `agent_runs` read/write surface — the `audit_events` append died with the ledger), `evidence.ts` (the flat v2 `evidence` projection), `source.ts` (the v2 operational `source` registry), `generation.ts`.
- `src/evidence/fold.ts` — the **sole surviving projection fold**: reconstructs the flat vault-derived `evidence` projection from note frontmatter `evidence:` blocks. **Self-registers into the rebuild pipeline** (`registerProjectionFold` + `registerPreClear` at module load, reached via the `src/index.ts` barrel). Its per-note primitive `replaceNoteEvidence` is shared with the incremental folds. (The v1 provenance + claims folds are gone with their tables.)
- `src/note-derivation.ts` / `src/fold-notes-for-paths.ts` / `src/fold-notes-v2.ts` — the shared per-note `notes`-row derivation primitive (`deriveAndPersistNote`) + the incremental, note-scoped `notes`-projection folds (O(delta), used by `sync`/`link`). The whole-vault rebuild and the incremental fold run the SAME primitive so the two paths cannot fork (`fold-rebuild-parity.test.ts`).
- `migrations/000N_*.ts` — one exported `Migration` (`{ id, checksum, up }`) + its verbatim `*_DDL` constant each. All re-exported from `src/index.ts`.

## Migration inventory & ownership (§2.7, single-owner invariant)

| id | file | registered by | in default set? |
|----|------|---------------|-----------------|
| `0001_core` | `0001_core.ts` | `openStore` | yes |
| `0002_jobs` | **in `@atlas/jobs`** | jobs `registerJobsMigration` | no |
| `0003_provenance` | `0003_provenance.ts` | `openStore` | yes |
| `0004_claims` | `0004_claims.ts` | `openStore` | yes |
| `0005_ledger_finalize` | `0005_ledger_finalize.ts` | `openStore` | yes |
| `0006_workflow_idempotency` | `0006_*.ts` (this pkg) | CLI `registerWorkflowMigrations` | no |
| `0007_job_cancellations` | **in `@atlas/jobs`** | jobs | no |
| `0008_index_config_revision` | `0008_*.ts` (this pkg) | `registerGenerationMigration` | no |
| `0009_run_supersessions` · `0010_trust_state` · `0011_run_inputs` | this pkg | CLI `registerWorkflowMigrations` (`apps/cli/src/workflows/idempotency.ts`) | no |
| `0012_sync_cursors` | `0012_sync_cursors.ts` (this pkg) | `registerSyncCursorsMigration` (CLI `store-open.ts`) | no |
| `0013_links_v2` | `0013_links_v2.ts` (this pkg) | `openStore` | **yes** (table-rebuilds `note_links` into the v2 shape: nullable `predicate` + `alias`) |
| `0014_evidence_v2` | `0014_evidence_v2.ts` (this pkg) | `openStore` | **yes** (creates the flat vault-derived `evidence` projection; forward-DROPs the v1 `claims`/`claim_evidence` + the retired ledger/backup tables) |
| `0015_source_registry` | `0015_source_registry.ts` (this pkg) | `openStore` | **yes** (creates the v2 operational `source` registry; forward-DROPs the four v1 content-addressed provenance tables, #340) |

- **Expand-and-contract is the v2 subtlety.** `0003`/`0004`/`0005` create-or-ALTER tables (`content_blobs`/…/provenance, `claims`/`claim_evidence`, `audit_intents`/`backup_watermark`) that `0014`/`0015` **forward-DROP within the same `db migrate` run**. They stay in the default set because migrations are **immutable + forward-only** — a released migration is never edited or deleted; the v1 tables are created then dropped in id order, so a fresh migrate lands the v2 schema with none of them.
- **Feature-migration files live here but are registered elsewhere.** `0006/0009/0010/0011` sit in `migrations/` but are registered by the CLI workflows layer; `0008` by `registerGenerationMigration`, `0012` by `registerSyncCursorsMigration`. Keeping them out of `openStore`'s default set keeps the `db.migrate-ownership` fresh-DB diff exactly the §2.7 core set. (`0010_trust_state` persists as a released migration even though the trust subsystem it served is retired in v2.)
- **Gap tolerance is load-bearing, not cosmetic.** `0003`/`0004` are retained PR-A and land BEFORE `0002_jobs` (PR-B). A DB can have `0003` applied while `0002` is first registered later; the runner still applies `0002` in id order. **Do not renumber to "fix" gaps.**
- Feature migrations always go through the **checksum-guarded runner** — never `CREATE TABLE IF NOT EXISTS`.

## §2.8 cross-store write protocol — RETIRED (v2 #338)

The four-step `finalizeLedgerWrite` protocol (intent txn → audit append → ledger commit → backup+watermark), `assertBackupHealthy`, `IntentsRepo`, and `reconcileInterruptedRuns` are **gone**. v2 writes are **one plain `store.db.transaction(() => applyLedgerWrite(store.db, statements))()`** — no audit event, no durable intent, no backup gate. A run's crash-safety is: (1) one commit per ChangePlan on `refs/heads/main` (git is the safety mechanism), and (2) the workflow engine's `agent_runs` state machine, re-driven on startup purely from `agent_runs.status` by the reconciler's run-sweep (`apps/cli/src/workflows/reconciler.ts`).

## Invariants & guardrails

- **FKs enforced on every connection**; `STRICT` tables; WAL for concurrent readers.
- **Guarded-DML CAS (`applyLedgerWrite`, `src/statements.ts`).** `LedgerStatement.assert` (a post-write `SELECT` guard) + `expectChanges` (an affected-row count) let a plain-transaction writer reject a no-op guarded upsert that a stale/concurrent handle would otherwise let masquerade as a successful advance. Used by the workflow-engine checkpoints/terminals. v2: these run in a plain `db.transaction`, not a §2.8 step-3 replay (the audit seq-space + `audit_events` immutability + backup-watermark machinery are gone with the ledger).
- **Rebuild is fail-closed + transactional.** Any fold throw, dangling link, or identity collision rolls the whole rebuild back and leaves the prior projection readable. Folds are self-guarded no-ops when their migration isn't applied.
- **Identity keys use plain INSERT (not upsert):** a `normalized_key` mapping to two notes must surface as a uniqueness failure and roll back. Per-note dedup collapses a slug-equivalent alias into the slug row (slug wins).
- **Generation activation fence** (`GenerationRepo`): SQLite (not LanceDB) is the sole activation authority. CAS updates a note iff `content_hash` unchanged AND config epoch `>= active_generation`. The epoch is **server-issued** from the append-only `index_config_revisions` log (`0008`), resolved by `configKey` inside the repo — **never a caller-supplied integer**.

## Gotchas & sharp edges

- **The pre-clear registry now exists for the flat `evidence` table.** `evidence/fold.ts` registers `clearEvidenceProjection` as a pre-clear so the flat table is emptied at the very start of the rebuild txn, before `ProjectionRepo.clearAll()` deletes `notes`. (The v1 reason — `claim_evidence`'s self-`RESTRICT` + `source_renditions` `RESTRICT` FKs — is retired with those tables.)
- **`evidence` is FK-free by construction.** `noteId` is a SOFT reference (no rebuild-enforced FK), so a projection rebuild can never trip a restrictive FK or orphan a row. `sourceNoteHash` is the between-fold staleness guard — a row whose stamped hash ≠ its note's on-disk content hash is treated as stale, never trusted.
- **`evidence` is REPLACE-semantics, vault-authoritative.** The fold replaces a note's rows from its frontmatter `evidence:` block; an entry dropped from the frontmatter disappears, and `git revert` + `brain sync` re-folds the pre-mutation rows. A missing `id` or out-of-enum `status` is a hard `EvidenceFoldError` (rolls the rebuild back), never a silent skip.
- **`source add` dedup is a NOOP SUCCESS.** `SourceRepo.insert` is idempotent on the UNIQUE `locator` (`INSERT … ON CONFLICT(locator) DO NOTHING` then return the existing id, `inserted:false`) — a repeated `source add <same-locator>` is not an error. `source` is operational (system-of-record), NOT vault-derived: `db rebuild` never touches it.
- **A plain `[[wiki-link]]` is `predicate NULL` in the v2 shape (`0013`);** a typed relationship (frontmatter `related:`, #331) lands as a distinct `note_links` row with a non-null `predicate`. Both resolve targets against the identity namespace (note_id / slug / alias); an unresolved target rolls the rebuild back.
- **`verify` skips absent tables silently** — never read "0 violations" as "fully checked" at an early frontier; check the `skipped` list.

## History (real PRs)

- **#62** Phase-1 skeleton: `0001_core`, connection, migrate, rebuild, verify, repos. **#64** retained PR-A `0003_provenance` + `0004_claims` + folds + registries. **#66** the ledger DR subsystem (`0005`, `backup/*`, `ledger/*`) — **entirely retired in v2**.
- **#74** workflow run state machine + startup reconciler + idempotency (`0006`). **#75** `@atlas/jobs` + `0002`. **#81** generation/config fence (`0008`, `GenerationRepo`). **#145** — register feature migrations at the composition root, not just in tests (a real `db migrate` skipped `0008` → `index rebuild` died `no such table`).
- **#150**/**#153** `--from-git` identity-collision gaps: `rebuild.ts` gains `noteIdentityKeys`/exports so the DR path drops colliding notes as gaps instead of aborting a raw `SQLITE_CONSTRAINT_PRIMARYKEY`.
- **v2 persistence strip:** **#338** removed `src/ledger/`+`src/backup/`, relocated the statement runner to `src/statements.ts`, and stripped the §2.8 protocol; **#331** made typed relationships frontmatter-derived (nullable `predicate`, `0013`); **#339** added the flat `evidence` projection (`0014`); **#340** added the operational `source` registry and forward-DROPped the v1 provenance tables (`0015`).
- Recurring themes: **fail-closed rebuild**, **gap-tolerant + immutable migrations**, **server-owned identity vs caller-supplied integers**, **retained-PR discipline** (a feature revert never orphans a projection — Markdown is SSOT, the fold rebuilds it).

## Open items

- **#65 / ledger-backup DR hardening — MOOTED by v2.** The banked durability residuals (seq-allocator rewind, interrupted-restore recovery, `markCovered`, retry backoff, `--force-unblock`) all lived in the deleted `ledger/`+`backup/` subtrees. Nothing to fix here — git is the safety mechanism.
- **Graduation-scale rebuild determinism — retired with graduation.** `db rebuild ×2` / `index rebuild ×2` determinism is still exercised by the incremental fold + parity tests; the graduation E2E that used to drive it is gone.

## Tests (real paths, what each proves)

`test/db.migrate-concurrency.test.ts` (IMMEDIATE serialization) · `db.migrate-gap-tolerant.test.ts` (0003 before 0002) · `db.migrate-ownership.test.ts` (fresh-DB diff == §2.7 core set) · `migrate.links-v2.test.ts` (0013 `note_links` reshape) · `migrate.evidence-v2.test.ts` (0014 creates `evidence`, DROPs claims + the ledger/backup tables) · `migrate.source-registry.test.ts` (0015 creates `source`, DROPs the v1 provenance tables) · `migrate-0012-sync-cursors.test.ts` · `db.rebuild.test.ts` (transactional replace + failpoint atomicity; `agent_runs` untouched) · `db.rebuild-fence.test.ts` (generation fence survives a rebuild) · `db.rebuild.retention.test.ts` · `rebuild-preserves-sync-cursors.test.ts` · `fold-rebuild-parity.test.ts` (whole-vault == incremental) · `fold-notes-v2.test.ts` · `fold-notes-for-paths.test.ts` · `evidence-fold.test.ts` · `source-repo.test.ts` · `db.verify.test.ts` (invariants + EQP, table-aware skip) · `readonly-open.test.ts` (fd-identity race safety).
