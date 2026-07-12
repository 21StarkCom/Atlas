# Atlas — Ledger-backup subsystem contract (normative)

**Status:** normative contract · **Version:** 1 · **Phase:** 0 (lands before any persistence code) ·
**Owner task:** 0.4 (`task-0-4-ledger-backup-retention-contract`) · **Repo:** `21StarkCom/Atlas`

> **Consumes:** the implementation plan's **§2.5** global constraints (exit-code set, lock scopes +
> global order, defaults), **§2.8** cross-store audit write protocol, decision **D6** (audit mapping
> for privileged ledger ops), and decision **D9** (per-OS key custody); the design spec's *Ledger
> backup subsystem*, *Audit SSOT*, and *Two classes of state* sections.
> **Produces:** the DR contract implemented **verbatim** by **Task 1.7** (`db backup|restore`,
> `db verify --backup`, `finalizeLedgerWrite` step 4, `reconcileInterruptedRuns`) and consumed by
> **Task 4.10** (retention execution) and the **[`retention-matrix.md`](./retention-matrix.md)`backups`
> row. Its acceptance section is realized verbatim by `ledger.dr-roundtrip.test` and
> `ledger.fail-closed-watermark.test`.

This document is the **single source of truth for the encrypted SQLite ledger backup/restore
subsystem** — the operational/audit ledger's sole authoritative disaster-recovery path. The git
`refs/audit/runs` stream is a **best-effort partial cross-check only, never the ledger's DR system of
record** (design *Audit SSOT*).

## What this is

The concrete V1 delivery mechanism behind the `sqlite.ledger_backup` config key: the snapshot
method + fallback, the temp-then-rename atomicity rule, the trigger policy, the **fail-closed
watermark state machine** (`healthy → degraded → blocked → unblocked`), the `backup-unhealthy`
blocking set, the audited `--force-unblock` override, key custody per D9, retention
(keep-N + keep-forever-latest), the integrity stamp, and the ordered restore protocol.

## What this is not

- **Not** the DDL for `backup_watermark` — Task 0.2 / migration `0001_core` owns its columns and
  types (`docs/specs/sqlite-data-dictionary.md`). This contract *consumes* that row; it does not
  redefine it.
- **Not** the §2.8 cross-store ordering — the intent → git-append → ledger-commit → backup/watermark
  ordering lives in the plan's **§2.8** and is *consumed* here as "step 4", not duplicated.
- **Not** the authorization mechanism — `db restore` / `db backup --force-unblock` presence-assertion
  and challenge binding are owned by the **security/broker contract** (`security-broker-contract.md`,
  Task 0.3) and the `commands.json` `privilege` field. This contract states *when* authorization is
  required and *what* it audits, not *how* the signature is verified.
- **Not** the config bounds — `config-schema.md` (Task 0.5-adjacent, phase-gated Phase 1) is the sole
  owner of each key's type/default/bounds. Values quoted here are the V1 defaults it must encode.
- **Not** the full persistent-store registry — `state-inventory.md` owns per-store restore ordering
  and reconciliation for the broker-owned artifacts (trust ledger, WORM anchor, nonce/replay state,
  quarantine). This contract covers the **SQLite ledger DB** component of the shared cut and points to
  `state-inventory.md` for the rest.

---

## 1. Snapshot method + better-sqlite3 fallback (record before Task 1.7 starts)

- **Primary method — SQLite Online Backup API.** The backup writer takes a **consistent snapshot via
  the SQLite Online Backup API** (no reader/writer stall) of the ledger database at a fixed **ledger
  sequence cut** captured at snapshot start. In `better-sqlite3` this is
  `db.backup(destination, { attached?, progress? })`, which drives `sqlite3_backup_step`/`_finish`
  under the hood.
- **Fallback — `VACUUM INTO` + WAL checkpoint under the `ledger-maintenance` lock.** If the Online
  Backup API is unavailable in the deployed binding (older `better-sqlite3`, or a build where the
  backup entrypoint is absent), the writer falls back to, **while holding the `ledger-maintenance`
  exclusive lock** (§2.5 lock order `vault-maintenance ⊐ ledger-maintenance ⊐ jobs-runner ⊐
  canonical-integration`):
  1. `PRAGMA wal_checkpoint(TRUNCATE)` — fold the WAL into the main DB so the copy is complete;
  2. `VACUUM INTO '<temp-path>'` — write a defragmented, transactionally consistent copy to the temp
     path.
  The `ledger-maintenance` lock guarantees no concurrent ledger write advances the DB between the
  checkpoint and the `VACUUM INTO`, so the fallback copy is at a single well-defined cut, exactly like
  the Online-Backup path. The Online-Backup path does **not** require the lock (it snapshots live); the
  fallback **does**. Both paths produce identical downstream artifacts (§2 onward) — the choice is an
  internal implementation detail recorded in the backup catalog entry's `method` field
  (`online-backup` | `vacuum-into`).
- **Detection is deterministic + logged.** The writer probes the Online Backup entrypoint once at
  process start; `db verify --backup` and the `--json` health surface report which method a given
  backup used. There is no silent per-call switching.

## 2. Cut identifier + shared-cut packaging

A backup bundle is taken at a shared **cut identifier** = the ledger sequence at snapshot start
(`cutSeq`). The bundle is a **versioned, AEAD-encrypted** artifact containing:

| Component | Source of truth | Restore treatment |
|---|---|---|
| SQLite ledger DB snapshot | this contract (§1) | restored transactionally (§7) |
| Backup catalog entry | `backup_watermark` + catalog | restored, then reconciled fail-closed |
| Broker trust-ledger ref / trust journal | `state-inventory.md` | restored, reconciled fail-closed |
| Authorization nonce/replay state | `state-inventory.md` | restored, reconciled fail-closed |
| Encrypted quarantine metadata | `state-inventory.md` | restored, reconciled fail-closed |
| External WORM audit/trust-head anchor | D8 (broker-owned, outside repo) | **verified against, never restored from** |

The SQLite-ledger component is the subject of this contract; per-component packaging and
cross-component restore ordering for the broker-owned artifacts are normative in `state-inventory.md`.
Each component carries **its own content hash**; a bundle whose component hash set does not verify is
**not selectable** for restore.

## 3. Atomicity — write-temp-then-atomic-rename

- The writer writes the encrypted bundle to a **temp path in the same directory** as the final
  destination (`<dest>/.tmp-<cutSeq>-<rand>`), `fsync`s the file, then performs an **atomic
  `rename(2)`** to the final `<dest>/atlas-ledger-<cutSeq>-<utc>.abk` name, then `fsync`s the
  directory.
- A **partially written backup is never selectable**: catalog registration + watermark advance
  happen **only after** the rename succeeds. A crash mid-write leaves a `.tmp-*` file that is
  ignored by selection and swept on the next backup / `db verify --backup`.
- Files are mode `0600`; the destination directory is mode `0700`.

## 4. Trigger policy (V1, no scheduler)

- **(a) Post-ledger-writing-run (automatic).** A backup is taken **after every run that writes ledger
  rows** (post-commit), as **step 4 of §2.8**. This gives an effective **RPO of one run**.
- **(b) On demand.** `atlas db backup` (`--json` prints `{ backupRef, seq, method }`).
- **Non-recursive / coalescing.** Each snapshot covers a fixed `cutSeq` taken at snapshot start. The
  backup's **own** completion writes (catalog row + `backup_watermark.seq` advance) are **exempt from
  triggering another post-run backup** — they fold into the next externally triggered snapshot. Crash
  recovery treats ledger rows committed after `cutSeq` as covered by the next snapshot, never a lost
  gap.
- **Read-run coalescing.** A Tier-0 read run writes its ledger row + audit event but does **not** each
  force a full encrypted backup — the watermark **coalesces** (a backup covers up to the latest ledger
  seq, debounced), so high-frequency reads cannot amplify into unbounded backup/storage growth.

## 5. Fail-closed watermark state machine (`healthy → degraded → blocked → unblocked`)

Backup failure fails **CLOSED**: the post-run backup is the ledger's sole authoritative DR path, so
its failure MUST NOT be silently best-effort. A durable **backup watermark** (`backup_watermark.seq`,
its own ledger-adjacent row) records the highest ledger sequence covered by a **verified** backup.

The subsystem is a four-state machine. `doctor` and the `--json` health surface report the current
state; a per-command **degraded-mode matrix** (§6) says what each state permits.

### 5.1 States

| State | Meaning | Invariant |
|---|---|---|
| **healthy** | `backup_watermark.seq == latest committed ledger seq` — a verified backup covers every committed row. | Ledger-writing runs proceed normally. RPO ≤ one run. |
| **degraded** | A post-run backup attempt is **in flight or has failed but bounded retries are not yet exhausted**; `watermark.seq < latest ledger seq` transiently. | Retries with backoff are running; the surface reports `degraded`. Not yet blocking. |
| **blocked** | Bounded durable retries are **exhausted** without a verified backup; `watermark.seq < latest ledger seq` and no further attempt is pending. | Further **ledger-writing** runs are refused with `backup-unhealthy` (exit `2`). Non-persisting diagnostics + `db restore` remain available (§6). |
| **unblocked** | A verified backup has **caught the watermark up** to the latest ledger seq (retry succeeded, `db backup` succeeded, `db restore` established a fresh watermark, or an audited `--force-unblock` recorded an accepted RPO gap). | Returns to `healthy` on the next fully-covered cut; the transition is audited when reached via `--force-unblock` or `db restore`. |

### 5.2 Transitions (fully enumerated)

| # | From | To | Trigger | Effect |
|---|---|---|---|---|
| T1 | healthy | degraded | A ledger-writing run commits (§2.8 step 3); the post-commit backup begins. | Watermark lags by the just-committed seq; retries begin on failure. |
| T2 | degraded | healthy | The post-run backup is **verified** and the watermark advances to the run's ledger seq. | Normal steady state; nothing blocked. |
| T3 | degraded | degraded | A retry fails but the **bounded retry budget is not exhausted**. | Backoff, re-attempt. Surface stays `degraded`. |
| T4 | degraded | blocked | **Bounded durable retries exhausted** without a verified backup. | Enter the `backup-unhealthy` blocking set; further ledger-writing runs refused (exit `2`). |
| T5 | blocked | unblocked | A subsequent **`db backup`** produces a verified backup covering the latest ledger seq. | Watermark caught up; blocking set cleared. Emits `db.backup` audit row (D6). |
| T6 | blocked | unblocked | **`db backup --force-unblock`** — audited privileged override records the accepted-RPO-gap. | Blocking set cleared **without** a new verified backup; emits `db.force_unblock` ledger audit row (D6) capturing the RPO gap (`from_seq`, `to_seq`). |
| T7 | blocked | unblocked | **`db restore <backupRef>`** — emergency restore of a verified prior backup establishes a **fresh watermark** at the restored cut. | Records the accepted loss window; emits `db.restore` ledger audit row (D6). |
| T8 | unblocked | healthy | The next post-run backup fully covers the latest ledger seq (watermark == latest). | Steady state restored. |
| T9 | unblocked | degraded | A new ledger-writing run commits before the next cut fully covers it. | Same as T1 from the caught-up baseline. |

**Only genuinely non-persisting diagnostics** (`inspect`/`status`/`doctor` / `--json` health that
write **no** ledger row) stay available in `blocked`; **audited/model-backed reads are blocked**
precisely because they would advance the ledger past the failed watermark (per the §2.5 preview rule:
they write ledger rows). `db restore` is **explicitly NOT blocked** — it is the recovery path when the
live DB cannot itself produce a new verified backup.

## 6. Degraded-mode matrix (per-command, normative for the CLI contract)

| Command class | healthy | degraded | blocked |
|---|---|---|---|
| Non-persisting diagnostics (`inspect`, `status`, `doctor`, `--json` health) | allow | allow | **allow** |
| Audited/model-backed read runs (writes a ledger row) | allow | allow | **refuse `backup-unhealthy` (exit 2)** |
| Mutating workflows, `approve`, `refresh`, `rollback`, `purge`, `quarantine resolve`, `graduation migrate --apply` | allow | allow | **refuse `backup-unhealthy` (exit 2)** |
| `db backup` | allow | allow | **allow** (its success is the primary unblock, T5) |
| `db backup --force-unblock` | n/a (nothing to unblock) | n/a | **allow** (audited override, T6) |
| `db restore` | allow (privileged) | allow (privileged) | **allow** — emergency restore (T7), never blocked |

`backup-unhealthy` is the stable error code, **exit `2`** (config/vault class, per §2.5). There is no
path in which repeated backup failures silently accumulate unrecoverable ledger rows.

## 7. Key custody (per D9)

- The backup bundle is **AEAD-encrypted**; the AEAD key is **trusted-CLI-readable** — the CLI process
  that writes the ledger encrypts/decrypts its **own** backup (there is no broker backup-IPC
  primitive; the crypto runs CLI-side). This is the D13 privilege boundary: the SQLite ledger DB is
  not broker-owned.
- **Custody mechanism (D9):**
  - **macOS:** a Keychain item in the CLI identity's login keychain (never in the vault or env).
  - **Linux:** a root-provisioned file under `/etc/atlas/keys/<identity>/` (dir `0700` owned by that
    identity).
  A uniform accessor reads the key in-process; the ACL matrix (Task 1.0) is the binding contract.
- **Rotation/revocation** follows the **same key-custody rules as the quarantine store**; a backup
  encrypted under a rotated-out key remains decryptable until its retention expires (the catalog
  records the key id), then is pruned per §9.

## 8. Integrity stamp

Each backup carries a **stored content hash + schema-version stamp** (the `vault_schema_migrations` /
`db_schema_migrations` head applied at `cutSeq`). `atlas db verify --backup <backupRef>` validates,
without mutating anything:
1. **Decryptability** — the AEAD key opens the bundle and the auth tag verifies (tamper-evident);
2. **Content hash** — the stored hash matches the recomputed hash of the decrypted snapshot;
3. **Schema compatibility** — the stamped schema version is compatible with the current binary;
4. **Failure-domain** (when a non-local destination is configured) — the destination is reachable and
   on an independent failure domain.
`db verify --backup` exits `0` on success, `1` on integrity failure. It writes **no** ledger row
(non-persisting; available even in `blocked`).

## 9. Retention (keep-N + keep-forever-latest)

- Config key **`sqlite.ledger_backup.keep`** — **default keep-N = 10** most-recent verified backups,
  **plus keep-forever-latest**.
- **keep-forever-latest is NEVER pruned**, even if it falls outside the keep-N window. Pruning
  computes the retained set as `{ latest-verified } ∪ { N most-recent verified }` and deletes only
  backups outside that union.
- A backup referenced by an in-flight `db restore` is pinned until the restore completes.
- Pruning is **transactional + auditable** and runs as retention execution in **Task 4.10** (see the
  [`retention-matrix.md`](./retention-matrix.md) `backups` row); it removes the bundle file
  (temp-then-rename semantics — never leaves a half-deleted selectable backup) and its catalog entry
  together.
- **Failure model (D-narrowed).** The default beside-the-DB destination covers logical corruption,
  accidental deletion, and process crashes (RPO one run); it does **not** by itself survive
  filesystem/device/host loss. V1 either requires a configured destination on an **independent
  failure domain** (validated by `db verify --backup`) or, if left local, **narrows the guarantee to
  local logical recovery** and documents an operator-owned off-device replication procedure with its
  RPO/RTO.

## 10. Restore protocol (privileged, destructive — ordered and complete)

`atlas db restore <backupRef>` is a **privileged, destructive** operation under the
separation-of-duties boundary (OS presence assertion bound to the broker challenge, or the
non-interactive `--export-challenge` → sign → `--authorization` flow). Authorization mechanics are
owned by `security-broker-contract.md`. The steps are strictly ordered; the operation is
**all-or-nothing** (an interrupted restore leaves the prior DB intact):

1. **Authorize.** Verify the privileged authorization for `op=db.restore` bound to `backupRef` (the
   challenge carries the target `backupRef` + content hash). Reject on drift.
2. **Acquire exclusive locks.** Acquire, in §2.5 global order, the exclusive **`vault-maintenance`**
   then **`ledger-maintenance`** locks. On contention, fail `locked:<scope>` (exit `2`) — never
   partial.
3. **Verify integrity + schema.** Run the full `db verify --backup` sequence (§8) on `backupRef`;
   abort (leaving the live DB untouched) if decryptability, content hash, schema compatibility, or
   the component-hash set (§2) does not verify.
4. **Transactional ledger-table restore.** Decrypt the snapshot to a temp DB in the destination
   directory, then **atomically replace** the live ledger DB (temp-then-rename), restoring the
   **ledger tables** transactionally. Interrupted restore is atomic — the original is only unlinked
   after the replacement is durably renamed.
5. **Restore + reconcile broker-owned components.** Restore the trust-ledger/trust-journal,
   authorization nonce/replay state, and quarantine metadata from the bundle per `state-inventory.md`;
   **verify (not restore) the external WORM anchor** and force **fail-closed reconciliation on any
   disagreement** (losing/mismatched trust state forces affected content to untrusted until an
   authorized repair completes).
6. **Establish a fresh watermark.** Set `backup_watermark.seq` to the restored cut, transitioning the
   state machine to `unblocked` → `healthy` (T7 → T8), and **record the accepted loss window**
   (`restoredCutSeq`, `preRestoreSeq`).
7. **Post-restore rebuild hooks.** Trigger a **projection rebuild** (`db rebuild`) and **index
   rebuild** (`index rebuild`) so the vault-projection tables + LanceDB **re-derive from Markdown**
   around the restored ledger. The projection rebuild emits its own **`run.projection`** git-ref
   event like any executed projection-only command (D6). Ledger tables are never touched by rebuild.
8. **Audit (D6).** `db restore` writes a **ledger** audit row (`audit_events`, event kind
   `db.restore`) and **no `run.*` git-ref event of its own**; the post-restore projection rebuild's
   `run.projection` is the only git-ref event the flow emits.

## 11. Audit mapping (D6 — normative)

`db backup`, `db restore`, and `--force-unblock` write **ledger** audit rows (`audit_events` table,
ledger-internal event kinds **`db.backup`** / **`db.restore`** / **`db.force_unblock`**) and **no
`run.*` git-ref event of their own** — the git-ref stream covers the run classes of the observability
matrix. The **post-restore projection rebuild** emits its own **`run.projection`** like any executed
projection-only command. This mapping is canonized in `security-broker-contract.md` (Task 0.3) and
consumed here.

## 12. Acceptance (implemented verbatim by Task 1.7)

`ledger.dr-roundtrip.test` and `ledger.fail-closed-watermark.test` realize this section verbatim:

- **DR round-trip.** `db backup` → wipe/corrupt the ledger DB → authorized `db restore <backupRef>`
  (via the test signer under `ATLAS_TEST_MODE=1`, D20) reproduces the exact ledger rows; the
  post-restore projection + index rebuild re-derive projections from Markdown; the run carries
  `backupRef` + content hash.
- **Fail-closed watermark.**
  - A **simulated backup failure** (exhausted retries, T4) **blocks** a subsequent ledger-writing run
    with `backup-unhealthy` (exit `2`);
  - **read-only non-persisting** commands (`inspect`/`status`/`doctor`) still work in `blocked`;
  - a **verified backup unblocks** (T5) and steady state returns (T8);
  - **`db backup --force-unblock`** clears the block (T6) and records the audited RPO gap;
  - `db restore` is **never blocked** and establishes a fresh watermark (T7).
- **Integrity + key failures.** A **wrong/revoked key** and a **truncated/corrupt backup** both fail
  `db verify --backup` (exit `1`) and are non-selectable for restore.
- **Cross-store ordering.** `audit.cross-store-ordering.test` (per §2.8) injects a crash between every
  pair of steps in both directions and asserts convergence with no duplicate or lost event; a `done`
  intent with no backup coverage re-attempts step 4.
- **keep-forever-latest is never pruned** — retention (§9) always retains the latest verified backup.
