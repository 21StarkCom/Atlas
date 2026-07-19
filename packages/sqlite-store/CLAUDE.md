# `@atlas/sqlite-store` — the persistence core

`@atlas/sqlite-store` owns **all non-jobs tables** and the machinery around them: the `better-sqlite3` connection factory, the gap-tolerant checksum-guarded migration runner, the transactional projection rebuild, the append-only audit ledger + its §2.8 cross-store write protocol, the fail-closed encrypted backup/restore/verify subsystem, and `db verify`. Private workspace pkg, `type: module`, ESM/NodeNext. Build `tsc -p tsconfig.json`; test `vitest run`.

- **Deps:** `@atlas/contracts` (workspace), `better-sqlite3` + `yaml` (`catalog:`). `@atlas/broker` is a **devDependency only** — see the acyclic seam below.
- **Consumes:** `VaultSnapshot` from `@atlas/contracts`. **Never imports `apps/cli` (D14).**
- **Dependents:** `apps/cli` (all `db *`/`index`/`purge`/workflow commands), `@atlas/jobs` (registers `0002`/`0007`). The CLI composition root wires everything: `apps/cli/src/commands/store-open.ts` calls `openStore` + `registerGenerationMigration`; `apps/cli/src/workflows/idempotency.ts` registers the feature migrations.
- **SSOTs it implements (cross-link, don't duplicate):** `docs/specs/sqlite-data-dictionary.md` (schema/invariants/index contract/rebuild), `docs/specs/ledger-backup-contract.md` (DR), `docs/specs/retention-matrix.md` (FK `ON DELETE` + purge order). Generation fence: `docs/specs/retrieval-index-contract.md` §2. Response-scan boundary: `docs/adr/0001-egress-response-scan-released-bytes.md`.

## Two classes of state (the defining split, dictionary "Two classes of state")

- **Projections** (`notes`, `note_identity_keys`, `note_links`, `vault_schema_migrations`, + provenance/claims tables) are deterministically **rebuildable from canonical Markdown** — delete-and-reinsert on `db rebuild`.
- **Ledger** tables (`agent_runs`, `audit_events`, `audit_intents`, `backup_watermark`, `model_calls`, …) are **primary state `db rebuild` never touches** — recovered only from the encrypted backup.
- **Authoritative non-derived** tables that are neither projections nor ledger: **`sync_cursors`** (`0012`) — the per-source adoption cursor. `last_absorbed_oid`/`cycle_seq` are primary sync state; `db rebuild` never touches them. Seeded once at adoption via `seedSyncCursor` (`INSERT OR IGNORE`); advanced only by the sync engine.
- The two classes reference each other **only by scalar historical id — no cross-class FK** — so a projection rebuild can never violate a restrictive FK or orphan ledger history.

## Key files (real paths)

- `src/connection.ts` — `openConnection(cfg)`. Every write handle gets **WAL** + **`PRAGMA foreign_keys = ON`** (composite FKs enforced, not advisory) + `busy_timeout` (default 5000ms). `STRICT` is per-table in DDL, no pragma.
- `src/migrate.ts` — `runMigrations`, `bootstrapMigrationsTable`, `migrationChecksum`. **Gap-tolerant** (applies registered-but-unapplied by id order; never assumes contiguous max-applied), **checksum-guarded** (`MigrationChecksumError`), **duplicate-guarded** (`DuplicateMigrationError`), **forward-only**. Whole sequence runs under one `BEGIN IMMEDIATE` (`.immediate()`) so concurrent migrators serialize. Tracks applied ids in a runner-owned table **`db_schema_migrations`** — do not confuse with the `vault_schema_migrations` *projection*.
- `src/store.ts` — `openStore(cfg, clock): Store`. Bundles connection + runner + rebuild + verify + repos. Default **retained migration set** = `0001`, `0003`, `0004`, `0005`. `registerMigration(m)` for downstream. `registerGenerationMigration(store)` registers `0008`. Exposes `activateGeneration`/`tombstoneGeneration`/`adoptConfig` → `GenerationRepo`.
- `src/rebuild.ts` — `rebuildProjections(db, snapshot, opts)`: transactional replace of the projection set in ONE txn (dictionary §8). Three ordered registries: **pre-clear** → **projection folds** → **post-restore rebuild** (async, run by `db restore`). Rejects a snapshot with any `errors` before opening the txn (`SnapshotHasErrorsError`); a dangling `[[wiki-link]]` is `DanglingLinkError` (rolls back). Exports `noteIdentityKeys` + `deriveSlug` so the `--from-git` DR path pre-detects cross-note key collisions and drops offenders as gaps (#150).
- `src/verify.ts` — `verify(db)` (§7 invariants) + `checkQueryPlans(db)` (§6 EQP: each must be `SEARCH` not `SCAN`, using the named index). **Table-aware:** any invariant/plan whose table is absent at the current frontier is *skipped*.
- `src/ledger/` — `intents.ts` (seq allocation + durable intent + `applyLedgerWrite` + `DB_EVENT_SEQ_BASE` + `safeBackupCutSeq`), `finalize.ts` (`finalizeLedgerWrite` — sole §2.8 orchestrator + `runBackupStep`), `reconcile.ts` (`reconcileInterruptedRuns` crash recovery).
- `src/backup/` — `aead.ts` (AES-256-GCM, header-as-AAD), `backup.ts` (`takeBackup`/`verifyBackup`/`listBackups`/`pruneRetention` + `KNOWN_SCHEMA_HEADS`), `restore.ts` (`restoreBackup`/`forceUnblock`/`recoverInterruptedRestore`), `watermark.ts` (`WatermarkRepo` + fail-closed gate).
- `src/repos/` — `projections.ts`, `ledger.ts`, `provenance.ts`, `claims.ts`, `generation.ts`.
- `src/provenance/fold.ts`, `src/claims/fold.ts` — rebuild readers reconstructing provenance/claims projections from Markdown frontmatter manifests; **self-register into the rebuild pipeline as side-effect imports** (`store.ts` imports both for effect, provenance first).
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

- **Feature-migration files live here but are registered elsewhere.** `0006/0009/0010/0011` sit in `migrations/` but are registered by the CLI workflows layer; `0008` by `registerGenerationMigration`. Keeping them out of `openStore`'s default set keeps the `db.migrate-ownership` fresh-DB diff exactly the §2.7 core set.
- **Gap tolerance is load-bearing, not cosmetic.** `0003`/`0004` are retained PR-A and land BEFORE `0002_jobs` (PR-B). A DB can have `0003` applied while `0002` is first registered later; the runner still applies `0002` in id order. **Do not renumber to "fix" gaps.**
- **`0005` is a forward migration.** `0001` is immutable once applied, so `0005` adds `audit_intents.event_json`/`write_json` + `backup_watermark.retry_count`/`next_retry_at` via `ALTER TABLE ADD COLUMN` with back-filled defaults (`event_json`/`write_json`/`retry_count` NOT NULL; `next_retry_at` nullable). Those backfilled defaults create the "legacy-pending-intent" case `reconcile.ts` handles.
- Feature migrations always go through the **checksum-guarded runner** — never `CREATE TABLE IF NOT EXISTS`.

## §2.8 cross-store write protocol (`finalizeLedgerWrite`, sole orchestrator)

Every ledger-writing run funnels through it. The `AuditBroker` interface is **structural** — the store never imports `@atlas/broker` (acyclic seam; broker is a devDep only).

0. **Intrinsic fail-closed gate** — `assertBackupHealthy` refuses up-front if the watermark is blocked (before any state change).
1. **Intent txn (SQLite)** — `IntentsRepo.allocate` under `BEGIN IMMEDIATE` (the serialization point): allocate the monotonic `run.*` seq, persist the `pending` intent with canonical `event_json` + `write_json`.
2. **Git append (broker)** — `broker.signAndAppendAuditEvent(unsigned)` (broker signs internally; idempotent on `(runId, seq)`).
3. **Ledger commit (SQLite)** — one txn writes the run's `ledgerWrite` rows + optional `extraCommit` + the `audit_events` row + flips the intent to `done`. `extraCommit` lands `db rebuild`'s projection replacement atomically with its `run.projection` audit event, closing a TOCTOU.
4. **Backup + watermark** — post-commit verified backup with bounded durable retries; success advances the watermark, exhaustion marks it blocked (never throws — this run already committed, so the NEXT run is gated). `strictBackup` makes exhaustion throw for a real state change.

## Invariants & guardrails

- **FKs enforced on every connection**; `STRICT` tables; WAL for the Online-Backup path.
- **Two disjoint seq spaces on the shared `audit_events.seq` PK.** `run.*` events (git-anchored, gapless `seq == last+1`) grow from 0. Ledger-internal D6 events carry no git event, so they allocate from a disjoint HIGH range `DB_EVENT_SEQ_BASE = 1_000_000_000_000` (`nextDbEventSeq` counts all non-`run.*` events, incl. `evidence.retry_enqueued` — narrowing to `db.%` would collide two ledger-internal kinds, #139).
- **`safeBackupCutSeq` = `min(latestRunSeq, lowestPendingSeq − 1)`**, returns **−1** ("nothing covered" sentinel). The watermark seeds `seq = −1` (not 0) so "nothing covered" stays distinct from "seq 0 covered". Never claims coverage of a seq whose step-3 commit hasn't landed.
- **`audit_events` is append-only + immutable.** `LedgerRepo.insertAuditEvent` is idempotent on `seq` but re-reads and compares EVERY immutable column; a divergent retry is `AuditEventConflictError`, never a silent success.
- **Ledger-write CAS is serialized.** `LedgerStatement.assert` + `expectChanges` travel in `write_json`, so they're enforced identically on the live step-3 path AND crash-recovery replay — a no-op guarded upsert can't masquerade as a successful advance.
- **Rebuild is fail-closed + transactional.** Any fold throw, dangling link, or identity collision rolls the whole rebuild back and leaves the prior projection readable. Folds are self-guarded no-ops when their migration isn't applied.
- **Identity keys use plain INSERT (not upsert):** a `normalized_key` mapping to two notes must surface as a uniqueness failure and roll back. Per-note dedup collapses a slug-equivalent alias into the slug row (slug wins).
- **Generation activation fence** (`GenerationRepo`): SQLite (not LanceDB) is the sole activation authority. CAS updates a note iff `content_hash` unchanged AND config epoch `>= active_generation`. The epoch is **server-issued** from the append-only `index_config_revisions` log (`0008`), resolved by `configKey` inside the repo — **never a caller-supplied integer**.
- **One current evidence head per lineage** — a partial UNIQUE index enforces at-most-one; the claims fold additionally rejects a tombstoned-only lineage (at-least-one) inside the rebuild txn.

## Gotchas & sharp edges

- **Provenance fold must run before claims fold** — `store.ts` imports them in that order deliberately: claim evidence pins renditions the provenance fold reconstructs.
- **Pre-clear ordering exists for one FK reason.** `claim_evidence` has a self-`ON DELETE RESTRICT` supersession FK + a RESTRICT FK onto `source_renditions`. `clearAll()` in both `ClaimsRepo` and `ProvenanceRepo` first NULLs the restricting pointers so table-wide DELETEs don't trip RESTRICT at statement time; the claims pre-clear runs before the core `notes` clear.
- **`content_blobs` active-rendition FK is `DEFERRABLE INITIALLY DEFERRED`** but RESTRICT is still enforced at statement time on delete — hence the NULL-first clear ordering.
- **Absent locator/quote_hash are the literal 6-byte `(none)` sentinel (`SENTINEL_NONE`), never SQL NULL** — otherwise the `payload_hash` idempotency UNIQUE index would be bypassed by NULL-distinctness. `evidence_id` defaults to a deterministic hash of `payload_hash` so a Markdown rebuild reproduces byte-identical rows.
- **`restoreBackup` closes the passed store's connection** (the DB file is atomically replaced) and runs post-restore steps on a fresh connection — callers must re-open the store afterward.
- **Restore is only exception-atomic in-process.** A PROCESS crash between renames needs `recoverInterruptedRestore(dir)` run **BEFORE** opening the store; it infers truth from `.restore-journal.json` + filesystem (prior DB present ⇒ roll back; prior DB gone ⇒ live is authoritative).
- **`verify` skips absent tables silently** — never read "0 violations" as "fully checked" at an early frontier; check the `skipped` list.
- **`schemaHead` for the backup stamp is `ORDER BY id DESC LIMIT 1`** over `db_schema_migrations` — relies on lexicographic id ordering, which holds because ids are zero-padded `NNNN_*`.
- **`registerKnownSchemaHead` avoids a dependency cycle.** `@atlas/jobs`'s `0002`/`0007` heads can't be imported here; jobs must register them at the composition root or `verifyBackup` rejects its own backups as "future/unknown schema."

## History (real PRs)

- **#62** Phase-1 skeleton: `0001_core`, connection, migrate, rebuild, verify, repos. **#64** retained PR-A `0003_provenance` + `0004_claims` + folds + registries.
- **#66** the big one — Phase-1 broker trio + **the entire ledger DR subsystem** (`0005`, `backup/*`, `ledger/*`). **#65 opened from the #23/#25 multi-round review** to bank residual durability findings.
- **#74** workflow run state machine + startup reconciler + idempotency (`0006`, durable `write_json`, serialized CAS, halt-on-conflict barrier). **#75** `@atlas/jobs` + `0002` → `backup.ts` learns `registerKnownSchemaHead`.
- **#81** generation/config fence (`0008`, `GenerationRepo`). **#145** — `registerGenerationMigration` existed but only a test called it, so a real `db migrate` skipped `0008` and `index rebuild` died `no such table`. **Register feature migrations at the composition root, not just in tests.**
- **#150** (`#147`/`#144`) `--from-git` identity-collision gaps: `rebuild.ts` gains `noteIdentityKeys`/exports so the DR path drops colliding notes as gaps instead of aborting a raw `SQLITE_CONSTRAINT_PRIMARYKEY`. **#153** — a note can collide with itself via slug **and** alias; a losing note sheds every claim.
- Recurring themes: **fail-closed everywhere**, **crash-recovery correctness** (four-step protocol, restore journal), **server-owned identity vs caller-supplied integers**, **retained-PR-A discipline** (a feature revert never orphans a projection — Markdown is SSOT, the fold rebuilds it).

## Open items

- **#65 (OPEN)** — ledger/backup hardening residuals from the #23/#25 review. Body cites `finalize.ts`/`reconcile.ts`. The two banked items: (1) **`db rebuild` projection mutation not durably replayable** — the rebuild's replacement is an in-memory `extraCommit` closure while the durable intent persists `ledgerWrite: []`; a crash after the broker append would let reconciliation commit `run.projection` without reproducing the rebuild (mitigated: mutation is in-txn, recovery is re-run the command). (2) **strict backup can exit 0 without covering its own seq** — a strict run treats any successful `takeBackup` as sufficient even when `safeBackupCutSeq` stopped below this run's event; fix is to assert `backup_watermark.seq >= allocated.seq` before returning success. Related durability edges from the same review still live in the code: `markCovered` sets `healthy = 1` unconditionally (a slow older-cut backup can clear a block prematurely); `runBackupStep` records `next_retry_at` (`recordRetry`) but never consults it — each `finalize`/`reconcile` starts a fresh `retries+1` budget; **`recoverInterruptedRestore` exists here but universal-startup wiring is CLI's** — it must run before *every* file-backed store open, not only `db restore` (else an ordinary command opens/creates an empty DB after a crash between renames); and **authorized restore can't recover a deleted/corrupt live DB** — `restoreBackup` reads `preRestoreSeq = latestRunSeq(store.db)` from the LIVE store before replacement, exactly the store missing in the disaster case. The last two edges above are the ones that bite in a real DR scenario.
- **#60 (OPEN)** — graduation E2E at scale exercises `db migrate`/`db rebuild`; `db rebuild ×2` and `index rebuild ×2` proved deterministic (identical 199 notes / 1,647 chunks). Remaining slices (workflow-runs/purge, `tools/scale-bench.ts`, ingest→index hook) are not this pkg's internals.

## Tests (real paths, what each proves)

`test/db.migrate-concurrency.test.ts` (IMMEDIATE serialization) · `db.migrate-gap-tolerant.test.ts` (0003 before 0002) · `db.migrate-ownership.test.ts` (fresh-DB diff == §2.7 core set) · `db.rebuild.test.ts` (transactional replace + failpoint atomicity) · `db.verify.test.ts` (invariants + EQP, table-aware skip) · `db.ledger.test.ts` · `db.post-restore-hook.test.ts` · `provenance-fold.test.ts` · `claims-fold.test.ts` · `test/ledger/{audit.cross-store-ordering,ledger.dr-roundtrip,ledger.fail-closed-watermark,restore.atomicity}.test.ts` + `restore-crash-child.mjs` (out-of-process crash injection) — the last four realize `ledger-backup-contract.md` §12 acceptance verbatim.
