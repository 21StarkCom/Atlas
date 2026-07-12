# Atlas — Retention matrix (normative)

**Status:** normative contract · **Version:** 1 · **Phase:** 0 (lands before Phase 2) ·
**Owner task:** 0.4 (`task-0-4-ledger-backup-retention-contract`) · **Repo:** `21StarkCom/Atlas`

> **Consumes:** the design spec's *Retention & deletion*, *Two classes of state*, *Ledger backup
> subsystem*, and *Data-minimization* sections; the plan's **§2.5** defaults; and the
> [`ledger-backup-contract.md`](./ledger-backup-contract.md) (the `backups` row).
> **Produces:** the per-class retention contract consumed by **Task 4.10** (`purge` + retention
> execution) and the **`ON DELETE` column** of `docs/specs/sqlite-data-dictionary.md` (Task 0.2
> cross-references this matrix; each dictionary FK's `ON DELETE` is the value in the **ON DELETE**
> column here).

This document governs **every entity/storage class** of the spec's retention list, one row per class.
`ON DELETE` values are the authority for the data-dictionary's FK annotations; retention execution
(Task 4.10) implements the compaction triggers, purge ordering, and config bounds verbatim.

## What this is not

- **Not** the DDL — column types/constraints live in `sqlite-data-dictionary.md`; this matrix owns
  only the `ON DELETE` semantics + retention policy per class.
- **Not** the config-key bounds authority — `config-schema.md` (phase-gated Phase 1) owns each key's
  type/default/bounds; values below are the V1 defaults it must encode.
- **Not** the backup mechanism — the `backups` class points to `ledger-backup-contract.md`.
- **Not** the purge command contract — `brain purge` authorization + git-history-rewrite protocol
  live in the design spec + `security-broker-contract.md`; this matrix owns the **storage-class purge
  ordering** those commands honor.

## 0. Binding conventions

- **Soft delete = tombstone** (row retained, marked inactive/superseded via a `tombstoned_at` /
  `current` / `active` marker); the row's stable id survives so ledger + audit references stay
  interpretable. **Hard delete = row removed.** **Audit-referenced rows tombstone, never cascade.**
- **`ON DELETE` values:** `CASCADE` (structural child of its parent), `RESTRICT` (audit-/cost-
  referenced or cited — cannot be deleted out from under a reference; delete is blocked until the
  reference is tombstoned), or `n/a` (no FK / root class).
- **Purge ordering** is the **child → parent, FK-safe** order `brain purge` follows so no `RESTRICT`
  FK is violated mid-transaction; all cleanup is **transactional + auditable** (design *Retention &
  deletion*). Ledger/audit rows are the **last** touched and are tombstoned, never dropped.
- **keep-forever** classes are never pruned by any automatic trigger; only an authorized `brain purge`
  (privileged, broker-authorized) can erase them, and it preserves tombstones for audit-referenced
  rows.

---

## 1. Retention matrix

| # | Entity / storage class | System of record | Minimum retention | Compaction / archival trigger | Soft vs hard delete + tombstone | `ON DELETE` | Purge ordering | Config key + bounds |
|---|---|---|---|---|---|---|---|---|
| 1 | **Canonical Markdown notes** (`notes`, `note_identity_keys`, `note_links`) | Git working tree (Markdown files) — projection tables rebuildable | **keep-forever** | never (rebuilt, not compacted) | soft: `ProposeArchive`/`ProposeDelete` (Tier-3, dependency-checked) tombstone the note; identity keys + links `CASCADE` | `notes`: n/a (root projection) · `note_identity_keys`, `note_links`: **CASCADE** | purge note → links + identity keys cascade first, then the note row + Markdown file | keep-forever (no key) |
| 2 | **Immutable source notes / captures** (`source_captures`) | Git Markdown + `content_blobs` | **keep-forever** | never | soft: capture `tombstoned/deactivated` on supersede (marked inactive, excluded from resolution) | **CASCADE** (from `content_blobs`) | purge source → captures + renditions cascade before the blob | keep-forever (no key) |
| 3 | **Raw content blobs** (`content_blobs`) | `content_blobs` (own store) | **keep-forever** while any capture/rendition/note cites it | never | hard delete only via `brain purge` (erasure); cited blobs blocked by `RESTRICT` | active-rendition FK **RESTRICT**; cited by `note_sources` **RESTRICT** | purge: tombstone citing `note_sources` → cascade captures/renditions → delete blob last | keep-forever (no key) |
| 4 | **Normalized copies / renditions** (`source_renditions`) | `source_renditions` | keep-forever while active; superseded renditions retained | superseded on re-normalization (new extractor/normalizer version) | soft: superseded rendition retained, active pointer moves; excluded from current head | **CASCADE** (from `content_blobs`); cited by `note_sources`/`claim_evidence` **RESTRICT** | purge: tombstone citing rows first, then cascade with the blob | keep-forever (no key) |
| 5 | **Note→source citations** (`note_sources`) | `note_sources` | keep-forever with the citing note | never | soft: tombstoned with the note | `note_id` **CASCADE**; blob + rendition FKs **RESTRICT** | deleted when the note is purged (cascade), releasing the `RESTRICT` on blob/rendition | keep-forever (no key) |
| 6 | **Operational / audit ledger** (`agent_runs`) | SQLite ledger (Audit SSOT); DR via `sqlite.ledger_backup` | **keep-forever** | never | soft: tombstone only via authorized `brain purge`; never cascade | n/a (ledger root) — children `RESTRICT` | ledger rows are **last** in purge order and are tombstoned, never dropped | **`sqlite.ledger_retention`** (default **keep-forever**) |
| 7 | **Model-call payloads** (`model_calls`) | SQLite ledger | keep-forever (metadata only) | never | metadata-only by policy (no raw content); audit-referenced | `run_id → agent_runs` **RESTRICT** | tombstoned with its run under purge; never independently pruned | keep-forever; raw content off by default (`sqlite.raw_payload_store`) |
| 8 | **Retrieval runs** (`retrieval_runs`) | SQLite ledger | keep-forever (metadata only) | never | metadata-only; audit-referenced | `run_id → agent_runs` **RESTRICT** | tombstoned with its run | keep-forever |
| 9 | **Retrieval results** (`retrieval_results`) | SQLite ledger | keep-forever with parent run | never | structural child of a retrieval run | `retrieval_id → retrieval_runs` **CASCADE** | cascade with the retrieval run | keep-forever |
| 10 | **Change plans** (`change_plans`) incl. **rejected plans** | SQLite ledger | keep-forever (audit trail incl. rejected) | never | soft: rejected plans retained as audit history, never hard-deleted | `run_id → agent_runs` **RESTRICT** | tombstoned with its run | keep-forever |
| 11 | **Patches** (`patches`) | SQLite ledger | keep-forever | never | audit-referenced; retained | `plan_id → change_plans` **RESTRICT** | tombstoned with its plan/run | keep-forever |
| 12 | **Patch operations** (`patch_operations`) | SQLite ledger | keep-forever with parent patch | never | structural child of a patch | `patch_id → patches` **CASCADE** | cascade with the patch | keep-forever |
| 13 | **Validation records** (`validation_results`) | SQLite ledger | keep-forever | never | audit-referenced; retained | `run_id → agent_runs` **RESTRICT** | tombstoned with its run | keep-forever |
| 14 | **Git operations** (`git_operations`) | SQLite ledger | keep-forever | never | audit-referenced; retained | `run_id → agent_runs` **RESTRICT** | tombstoned with its run | keep-forever |
| 15 | **Audit events** (`audit_events`) | SQLite ledger (Audit SSOT); git `refs/audit/runs` is best-effort cross-check | **keep-forever** | never | never deleted; tombstoned only under `brain purge` with a signed-tombstone audit-ref replacement | n/a (ledger, closed-set event stream) | absolute **last**; audit head is preserved, tombstones replace erased refs | **`sqlite.ledger_retention`** (keep-forever) |
| 16 | **Audit intents** (`audit_intents`) | SQLite ledger | keep-forever (seq-allocation serialization record) | never | never deleted (idempotency key `(runId, seq)`) | n/a | last, with the ledger | keep-forever |
| 17 | **Backup watermark** (`backup_watermark`) | SQLite ledger (ledger-adjacent) | keep-forever (single durable row) | never | never deleted; reconciled fail-closed on restore | n/a | never purged; re-established on `db restore` | keep-forever |
| 18 | **Ledger backups** (`backups` — encrypted bundles + catalog) | filesystem bundles + backup catalog | **keep-N + keep-forever-latest** | pruned when count exceeds keep-N (retained set = `{latest} ∪ {N most-recent verified}`) | hard delete of pruned bundles (temp-then-rename); **keep-forever-latest never pruned** | n/a (filesystem) | pruned independently by retention execution (Task 4.10); a bundle pinned by an in-flight `db restore` is retained | **`sqlite.ledger_backup.keep`** (default **N=10** + keep-forever-latest); bounds ≥ 1 |
| 19 | **Optional raw-payload store** (`raw_payloads`) | AEAD raw-payload store (**deferred out of V1**; default **off**) | configurable window when on; **default: never stored** | expiry when the window elapses (when enabled) | hard delete on expiry; retained with its run while present | `run_id → agent_runs` **RESTRICT** | expired independently by window; else tombstoned with its run | **`sqlite.raw_payload_store`** (default **off**); retention window bound (days) when on |
| 20 | **Jobs** (`jobs`) | SQLite (`0002_jobs`, owned by `jobs`) | keep-forever (operational history) | terminal jobs may be archived/compacted on a configurable window | soft: terminal state retained; attempts cascade | n/a (jobs root); attempts **CASCADE** | purge job → attempts cascade → job row | keep-forever; optional archive window (config-owned) |
| 21 | **Job attempts** (`job_attempts`) | SQLite | keep-forever with parent job | archived with the parent job | structural child of a job | `job_id → jobs` **CASCADE** | cascade with the job | keep-forever with parent |
| 22 | **Claims** (`claims`) | SQLite projection (`0004_claims`) — rebuildable from Markdown | keep-forever while owning note exists | rebuilt, not compacted | soft: tombstoned with the note | `owning_note_id → notes` **CASCADE** | cascade when the note is purged | keep-forever |
| 23 | **Claim evidence** (`claim_evidence`) | SQLite projection | keep-forever; superseded evidence retained | superseded evidence retained (single current head per lineage) | soft: `tombstoned_at`/`current` marker; superseded predecessor retained | `claim_id → claims` **CASCADE**; rendition + `supersedes_evidence_id` **RESTRICT** | cascade with the claim; cited rendition released only after tombstone | keep-forever |
| 24 | **Git manifests / history** (`refs/audit/runs`, canonical refs, run manifests) | Git object store | **keep-forever** | never (except the broker-only `brain purge` history-rewrite exception) | soft: purge rewrites history + records old→replacement heads in the WORM anchor | n/a (git) | rewritten only by broker-mediated `brain purge`; post-purge verification asserts no erased object remains reachable | keep-forever |
| 25 | **Worktrees** (per-run git worktrees) | filesystem (ephemeral) | until run terminal + cleanup | removed on run finalization/rejection/rollback per the recovery state machine | hard delete (removed on cleanup); no tombstone (not primary state) | n/a (filesystem) | removed at run terminal; orphans swept by `doctor`/`--reclaim-locks` | ephemeral (no retention key) |
| 26 | **Logs** (structured JSONL) | filesystem (`logs.dir`) | configurable window | rotation + size/age retention | hard delete on rotation/expiry; PII/secret-redacted before write | n/a (filesystem) | rotated/expired independently; never blocks a purge | **`logs.*`** (`logs.dir`, rotation + retention window; config-owned bounds) |
| 27 | **Obsolete LanceDB generations** (index) | LanceDB (fully rebuildable from Markdown) | until the successor generation is activated | **compacted after activation** of a new generation | hard delete of obsolete generation after activation | n/a (rebuildable projection) | compacted independently of the ledger; `index rebuild` re-derives from Markdown | index generation config (dimensions/chunker pinned per generation; config-owned) |
| 28 | **Trust ledger** (broker-owned trust-ledger ref / journal) | broker-owned git ref / SQLite trust journal | **keep-forever** | never | never deleted; loss forces affected content to **untrusted** until authorized repair; reconciled fail-closed on restore | n/a (broker-owned) | not purged by content purge; managed by trust `promote`/`revoke` | keep-forever (state-inventory-owned) |
| 29 | **WORM audit/trust-head anchor** (external, D8) | external broker-owned append-only file (outside repo) | **keep-forever** (append-only) | never | append-only; never deleted | n/a (external) | verified-against on restore, never restored from; never purged | keep-forever (path `git.audit_anchor_path`, D8) |
| 30 | **Authorization nonce / replay state** | SQLite / broker state | retained per replay-window policy | expired nonces pruned after the replay window | hard delete of expired nonces | n/a | reconciled fail-closed on restore; not content-purged | replay-window bound (config-owned) |
| 31 | **Encrypted quarantine store** (quarantine metadata + payloads) | AEAD quarantine store | bounded retention; crash-safe purge | resolved/expired quarantine entries purged (temp-then-rename, no plaintext on disk) | hard delete on resolution/expiry (crash-safe) | n/a (own store) | purged by `quarantine resolve` (privileged) + retention; reconciled fail-closed on restore | quarantine retention bounds (config-owned; same key custody as backups) |
| 32 | **Vault schema migrations** (`vault_schema_migrations`, `db_schema_migrations`) | SQLite | keep-forever (checksum-guarded migration record) | never | never deleted; never dropped on downgrade | n/a | never purged | keep-forever |

## 2. Purge ordering (summary — the FK-safe order `brain purge` honors)

For a note/source erasure, `brain purge` deletes in this **child → parent** order so no `RESTRICT` FK
is violated, all inside one auditable transaction, with ledger/audit rows tombstoned **last**:

1. Projection children with `CASCADE` FKs: `claim_evidence` → `claims`, `note_links`,
   `note_identity_keys`, `note_sources` (releases the `RESTRICT` on `content_blobs` / `source_renditions`).
2. Source graph: `source_captures`, `source_renditions` (`CASCADE` from `content_blobs`), then the
   `content_blobs` row.
3. The `notes` row + its Markdown file.
4. LanceDB entries for the erased content (index rebuild re-derives).
5. Optional `raw_payloads` rows for affected runs (if the store is enabled).
6. Git history rewrite (broker-only exception) recording old→replacement heads in the WORM anchor;
   post-purge verification asserts no erased object remains reachable.
7. **Ledger + audit rows (`agent_runs`, `model_calls`, `audit_events`, …) are tombstoned, never
   dropped** — the signed-tombstone audit-ref replacement preserves the audit head.

## 3. Acceptance

- **Every storage/entity class of the spec's retention list has a row** (§1, rows 1–32): the spec's
  enumerated classes — immutable source notes, normalized copies, model-call payloads, retrieval
  results, job attempts, rejected plans, patches, validation records, git manifests/history,
  worktrees, logs, backups, obsolete LanceDB generations — plus the ledger, tombstoned projection
  classes, and the broker-owned primary-state stores (trust ledger, WORM anchor, nonce/replay,
  quarantine).
- **Every FK's `ON DELETE`** in `sqlite-data-dictionary.md` matches this matrix's **ON DELETE**
  column (audit-referenced → `RESTRICT`, structural child → `CASCADE`).
- **keep-forever-latest** (row 18) is never pruned by retention execution (Task 4.10).
- **Purge ordering** (§2) is FK-safe and tombstones audit-referenced rows rather than cascading them.
