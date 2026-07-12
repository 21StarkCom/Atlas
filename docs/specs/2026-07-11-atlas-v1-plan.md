# Atlas V1 — Implementation Plan

**Source spec:** `docs/specs/2026-07-11-atlas-v1-design.md` · **Date:** 2026-07-12 · **Author:** Aryeh Stark (hand-written)
**Provenance:** replaces the unresolved 5-round `stark-spec-to-plan` lead/wing output. The wing-approved
architectural resolutions from rounds 2–5 are adopted; every round-4/round-5 blocking finding is fixed
in this document (see `2026-07-11-atlas-v1-design.s2p-review.md` for the round-by-round audit).

**Altitude rule (how to read this plan).** The spec schedules ~14 normative contract documents
(`docs/specs/*.md`, `cli-contract/*`). This plan makes each contract an explicit, ordered **task
deliverable**, and later tasks **consume the contract file as the single source of truth** — the plan
does not duplicate their enumerations (that would create a drifting second copy). A task is executable
top-down because everything it consumes is produced by an earlier task of this plan, including the
contract docs themselves.

---

## 1. Overview

Atlas V1 is built as a pnpm/TypeScript monorepo in six PR-gated phases, each ending in a working,
verifiable increment: **Phase 0** lands the repo scaffold + the retained CLI-contract harness + the
up-front normative contracts; **Phase 1** delivers the skeleton (contracts package, config, vault
read, SQLite store + migrations, git plumbing, the privilege-separated broker's authorization core,
the encrypted ledger backup/restore subsystem, and the `inspect`/`doctor`/`status`/`db *` CLI);
**Phase 2** the ingest loop (sandboxed normalization, fail-closed secret scanning, immutable source
capture through the broker, the jobs queue, the egress broker with the Gemini adapter restricted to
non-mutating extraction); **Phase 3** retrieval (LanceDB chunk/embed/hybrid + RRF, `query`, index
ops with generation fencing); **Phase 4** the full mutation workflows (ChangePlan pipeline, risk
tiers, review gate, approve/refresh/rollback, trust, claims/evidence, purge); **Phase 5** graduation
to a **copy** of the real vault (fail-closed scan → read-only audit → review-gated bootstrap
migration → eval + scale gates).

Key architectural decisions (wing-vetted in rounds 2–5, restated here as binding):

- **Acyclic broker↔ledger seam.** `@atlas/broker`'s git-side primitives (`appendAuditEvent`,
  `advanceProtectedRef`, `integrateSourceCapture`) never import `@atlas/sqlite-store`.
  `finalizeLedgerWrite` (sqlite-store) is the **sole cross-store orchestrator** and *calls* broker
  primitives. Dependency direction is strictly ledger → broker; no cycle (fixes R4-F1).
- **Two provisioned runtime identities from day one.** `atlas-broker` (integration: protected refs,
  approval verification, WORM anchor) and `atlas-egress` (egress: provider credential + outbound
  network) are distinct OS users, both created by Phase 1 Task 1.0 with a per-key ACL matrix and a
  separation test (fixes R4-F2). The spec permits sharing one identity; this plan deliberately does
  **not** (also resolves red-team finding rt1).
- **Scanner before any persistence.** The secret-scan engine + `PrePersistenceGuard` land before
  normalization and capture; `normalize` and `captureSource` take the guard as a **required**
  constructor dependency, so no raw or normalized byte can persist or transmit unscanned (fixes R4-F3).
- **Retained-vs-feature PR split for migrations.** Every phase that registers a SQLite migration
  lands it in a separate **PR-A (retained)** ahead of the feature **PR-B**, so a feature revert never
  orphans applied DDL or breaks `db rebuild` (fixes R4-F5; generalizes to Phase 4's claims migration).
- **Retained CLI-contract harness.** `commands.json` (the full command registry, seeded Phase 0 with a
  `phase` field per command), `cli-surface.fixture.txt`, and `tools/gen-cli-contract.ts` +
  `contract-lint` live in Phase 0 Task 0.0 and survive every later revert (fixes R4-F6, R3-F8).
- **Evidence/claims tests live with their schema.** Provenance tests in Phase 2 assert provenance
  behavior only; dependent-evidence staleness assertions move to Phase 4 where `claims`/
  `claim_evidence` exist (fixes R4-F4).

| Phase | Goal | Effort |
|---|---|---|
| 0 | Scaffold + retained contract harness + up-front contracts | M |
| 1 | Skeleton: store, broker auth core, ledger backup DR, base CLI | L |
| 2 | Ingest loop: sandbox, scanner, capture, jobs, egress broker | L |
| 3 | Retrieval: LanceDB, embeddings, hybrid search, `query`, index ops | M |
| 4 | Workflows: ChangePlan pipeline, review gate, rollback, trust, purge | L |
| 5 | Graduation: real-vault copy, bootstrap migration, eval + scale gates | M |

---

## 2. Prerequisites

- **Hosts:** macOS (Apple-silicon, pinned supported majors — 15 and 26) and Linux — the two supported V1 targets. Local dev
  needs `sudo` once for provisioning (Task 1.0). Node ≥ 24 (built-in `--experimental-strip-types` not
  used — we compile with `tsc`), pnpm ≥ 10, git ≥ 2.44, SQLite ≥ 3.45 (bundled via `better-sqlite3`).
- **Test runner:** vitest (workspace mode). Live-Gemini tests opt-in via `ATLAS_LIVE_GEMINI=1`;
  provisioning-dependent suites gate on `ATLAS_PROVISIONED=1` and **skip with an explicit reason**
  otherwise (CI always provisions, so CI never skips them — a skip on CI fails the job).
- **CI:** GitHub Actions, matrix `ubuntu-latest` + `macos-15` **+ `macos-26` (arm64)** — each supported macOS major is an explicit compatibility lane with its own pinned Seatbelt/provisioning profile (no moving "current major"). Both runners have passwordless sudo;
  the workflow runs `sudo provisioning/ci/setup.sh` before the test step (see Task 1.0 for the
  two-UID mechanism). No cloud resources; the only secret is `ATLAS_GEMINI_KEY` for the opt-in
  nightly live suite (repo Actions secret, injected only into the egress-broker test fixture).
- **Gemini access:** one API key for `gemini-3-5-flash` + `gemini-embedding-001`; custody per the
  egress-broker key ACL (Task 1.0) — never in agent/parser env.
- **Parallel with Phase 1:** Phase-2 contract authoring (Task 2.0) and fixture-vault authoring
  (Task 0.6) have no code dependency on Phase 1 and may proceed concurrently once Phase 0 merges.
- **Verification hygiene (all phases):** every fixture-vault Verification block copies the fixture
  into a fresh temp dir, `git init`s it with **repo-local** identity `Aryeh Stark
  <aryeh@21stark.com>` (never relying on global git config), and passes a temp `--config` with all
  derived paths under that temp dir; the committed `fixtures/` tree and this implementation repo stay
  byte-unchanged (a git ceiling / vault-root assertion prevents discovery of the enclosing repo).

---

## 2.5 Global Constraints (verbatim from the spec — every task implicitly includes these)

- Language/layout: **TypeScript (strict, ESM, pnpm monorepo)**; repo `21StarkCom/Atlas`.
- Models: **`gemini-3-5-flash`** (generation/extraction/classification/synthesis),
  **`gemini-embedding-001`** (embeddings, dimensions pinned + versioned in the index).
- Exit codes: **`0` ok · `1` validation · `2` config/vault · `3` secret-scan · `4` internal ·
  `5` user/usage · `6` action-required**.
- Normative workflow state set: **`planned → patched → worktree-applied → agent-committed →
  [review-pending] → integrated → reindexed → finalized`; terminals `rejected`, `rolled-back`,
  `failed`, `cancelled`** (recorded `failed@<checkpoint>` / `cancelled@<checkpoint>`).
- Audit event types (closed set): **`run.started`, `run.planned`, `run.integrated`, `run.rejected`,
  `run.rolled_back`, `run.failed`, `run.cancelled`, `run.readonly`, `run.projection`** — cardinality:
  **each terminal event type exactly once per run** (Audit SSOT owns this; no other assertion).
- Lock scopes + global order: **`vault-maintenance ⊐ ledger-maintenance ⊐ jobs-runner ⊐
  canonical-integration`**, plus concurrent `shared`; failure code **`locked:<scope>`** (exit `2`).
  (`jobs-runner` is the plan-defined name for the spec's "single-runner process lock" — see §2.6.)
- Tier-2 auto-commit thresholds: **confidence ≥ 0.8 AND patch ≤ 50 changed lines across ≤ 3 sections
  of a single note** (larger ⇒ Tier-3). Retrieval eval: **recall@10 ≥ 0.85, MRR ≥ 0.7**.
- Defaults: **`declaredSensitivity: internal`** for unlabeled content; ledger retention
  **keep-forever** (`sqlite.ledger_retention`); collection pagination **`--limit` default 50 / max
  500 + `--offset`**, best-effort under concurrency.
- Mutation default: `ingest`/`enrich`/`reconcile`/`maintain` are **non-mutating previews** by
  default; `--apply` mutates; `--dry-run`+`--apply` together ⇒ exit `5`. Previews emit **no**
  audit-ref event. **`--yes` never authorizes** a privileged op.
- Privileged ops (`approve`, `refresh`-integration, `rollback`, `purge`, `db restore`, trust
  `promote`/`revoke`): authorized **only** by an OS-mediated presence assertion bound to the broker
  challenge **or** the non-interactive `--export-challenge` → sign → `--authorization` flow.
- Audit/ledger rows and audit-ref events carry **allowlisted metadata only** (identifiers, hashes,
  classifications, destinations, metrics) — raw payloads only in the opt-in AEAD store
  (`sqlite.raw_payload_store`, default **off**).
- Module discipline: `contracts` is a **zero-dependency leaf** consumed by CLI (`domain` re-export),
  `sqlite-store`, `git`, and `broker`; the broker **never imports `apps/cli`**; **`jobs` is the sole
  owner** of `jobs`/`job_attempts` DDL + repository + transactions; `policies`, `validation`,
  `workflows`, `vault`, `markdown`, `retrieval`, `config`, `domain` are **internal modules** of
  `apps/cli` (never workspace packages in V1).
- Vault safety: **fixture vaults only until Phase 5**; Phase 5 operates on a **copy** of
  `main-vault`, agent-branch-only, never `main`.
- Process: **each phase is its own PR (plus the retained PR-A where defined), green before the
  next**; commits authored `Aryeh Stark <aryeh@21stark.com>`.

## 2.6 Plan-resolved decisions (ambiguities the spec left to the implementer — now fixed)

| # | Decision | Value (binding for V1) |
|---|---|---|
| D1 | CI two-UID mechanism | CI runners execute `sudo provisioning/ci/setup.sh` which creates `atlas-broker` + `atlas-egress` users, `atlas-git` group, and installs a sudoers drop-in (`/etc/sudoers.d/atlas-ci`) allowing the runner user to `sudo -u atlas-broker` / `sudo -u atlas-egress` **only** the two launcher scripts. Agent-side tests run as the unprivileged runner user. Same script family works on macOS (`sysadminctl -addUser`) and Linux (`useradd -r`). |
| D2 | `effectiveSensitivity` representation | **Computed on read, never persisted** in V1 (the spec's default). No projection column; recompute cost is acceptable at V1 vault sizes; revisit only if the Phase-5 scale gate fails. |
| D3 | `sourceId` acceptance & serialization | Commands taking a source handle accept either a serialized `renditionId` `sha256:<rawContentHash>:<canonicalMediaType>:<extractorVersion>:<normalizerVersion>` or a serialized `contentId` `sha256:<rawContentHash>:<canonicalMediaType>` (resolved via `content_blobs.active_rendition_id`). Colon-delimited, lowercase hex. Parsing lives in `packages/contracts/src/ids.ts` only. |
| D4 | Initial `chunker_version` | **`1`** (config `indexing.chunker_version`, seeded in `brain.config.example.yaml`). |
| D5 | Jobs single-runner lock | New named scope **`jobs-runner`** (exclusive), defined in `jobs-contract.md`, registered in the lock manager, error `locked:jobs-runner`; ordered between `ledger-maintenance` and `canonical-integration` (a draining job may acquire `canonical-integration` per job). |
| D6 | Audit mapping for privileged ledger ops | `db backup` / `db restore` / `--force-unblock` write **ledger** audit rows (`audit_events` table, ledger-internal event kinds `db.backup`/`db.restore`/`db.force_unblock`) and **no `run.*` git-ref event of their own** — the git-ref stream covers the run classes of the observability matrix; the post-restore projection rebuild emits its own `run.projection` like any executed projection-only command. Canonized in the security/broker contract (Task 0.3). |
| D7 | Embedding dimensions | **768** (`indexing.dimensions: 768` in the example config; `gemini-embedding-001` `output_dimensionality=768`). Config-owned; changing it opens a new index generation by construction. |
| D8 | WORM anchor default path | `git.audit_anchor_path` default **`/var/lib/atlas/audit-anchor`** (Linux) / **`/usr/local/var/atlas/audit-anchor`** (macOS) — broker-owned `0600`, parent `0700`, **outside** the vault and repo — but treated only as a **local
   cache**: the authoritative monotonic checkpoint lives in storage the broker identity cannot
   rewrite (an append-only external transparency/monotonic service or separately-administered
   immutable object store), so a compromised broker rewriting the local file **and** ref is still
   detected (fixes R3-F3). |
| D9 | Key custody mechanism per OS | macOS: Keychain items readable per-identity via separate login keychains for `atlas-broker`/`atlas-egress` (created by provisioning). Linux: root-provisioned files under `/etc/atlas/keys/<identity>/` (dir `0700` owned by that identity). Uniform accessor in each privileged process; the ACL matrix in Task 1.0 is the contract. |
| D10 | Broker IPC | Unix domain sockets: `broker.socket_path` default `/var/run/atlas/broker.sock`, `egress.socket_path` default `/var/run/atlas/egress.sock` (macOS: `/usr/local/var/run/atlas/*.sock`); socket files use **separate groups** (`atlas-broker-clients` / `atlas-egress-clients`, never the shared `atlas-git`), files `0660`, and every RPC enforces a **peer-credential (`SO_PEERCRED`/`getpeereid`) caller check** against an explicit per-RPC caller matrix, so neither broker can invoke the other's service (tested: each broker is rejected by the other's socket). Framed JSON messages validated by `contracts` schemas on both sides. |
| D11 | `source add` vs `ingest` | `source add <path>` = deterministic Tier-1 capture, applies immediately (key-accepting, no preview mode). `ingest <path>` = capture **preview + extraction/classification preview** by default; `--apply` performs the capture (Phase 2) and, from Phase 4, the synthesis follow-on. Both funnel through the same `captureSource`. |
| D12 | `brain status` semantics | Read-only summary: open runs (by state), queued/failed jobs, quarantine count, backup watermark health, audit head + anchor check. Tier-0; executed run emits `run.readonly`. |

## 2.7 Migration ownership (single authoritative table — fixes R2-F3, R3-F5)

Exactly one migration creates each table; the runner treats an applied migration as a checksum-guarded
no-op and **never drops tables on downgrade**. The runner applies migrations by **sparse id** (any
registered id not yet in `db_schema_migrations` is applied exactly once, even if a higher id was
applied earlier — it is **not** a max-version monotonic runner), so out-of-order landing (`0003`
before `0002`) is a supported, tested contract (`db.sparse-migration.test`: apply 0001+0003, then
register 0002 → 0002 applied once). Every migration — including `0002_jobs` — lands in a **retained**
migration PR ahead of its feature PR so a feature revert never orphans applied DDL.

| Migration | Owner package | Phase / PR | Tables |
|---|---|---|---|
| `0001_core` | `sqlite-store` | 1 | `notes`, `note_identity_keys`, `note_links`, `vault_schema_migrations`, `agent_runs`, `model_calls`, `retrieval_runs`, `retrieval_results`, `change_plans`, `patches`, `patch_operations`, `validation_results`, `git_operations`, `audit_events`, `audit_intents`, `audit_id_map` (salted-audit-id ↔ real-id mapping that purge deletes for unlinkability; key custody + uniqueness + deletion semantics + backup handling + verification queries owned here), `backup_watermark`, `raw_payloads` |
| `0002_jobs` | `jobs` (registered into sqlite-store's runner) | 2 **PR-A (retained)** | `jobs`, `job_attempts` |
| `0003_provenance` | `sqlite-store` | 2 **PR-A (retained)** | `content_blobs`, `source_captures`, `source_renditions`, `note_sources` |
| `0004_claims` | `sqlite-store` | 4 **PR-A (retained)** | `claims`, `claim_evidence` |
| (runner bootstrap) | `sqlite-store` | 1 | `db_schema_migrations` (created by the runner itself, not a migration) |

`db rebuild` replaces **only** the vault-projection tables that exist at that point
(`notes`, `note_identity_keys`, `note_links`, `vault_schema_migrations`; + the `0003` provenance
tables via `foldProvenanceManifests` once PR-A lands; + `claims`/`claim_evidence` via the claims fold
once `0004` lands) inside one transaction; it never touches ledger tables or `db_schema_migrations`.

## 2.8 Cross-store audit write protocol (referenced by tasks as “§2.8” — fixes R3-F7)

Every ledger-writing run funnels through `finalizeLedgerWrite` with this exact ordering:

1. **Intent txn (SQLite):** acquire the cross-process **`audit-append`** lock (serializes the
   allocate→append interval so a later-allocated writer cannot reach the broker before an
   earlier-allocated one — fixes the reversed-arrival broker rejection/deadlock); open a
   transaction; allocate the audit `seq` monotonically and persist a **complete durable outbox
   record** in `audit_intents` (`runId`, `seq`, the **full canonical signed event**
   (event + signature + signerId), a **deterministic serialization of every ledger mutation** the
   write callback will perform, and state `pending`); commit. The outbox — not a bare hash — is what
   a fresh process replays, so recovery needs no retained in-memory callback.
2. **Git append (broker):** send the persisted signed event to `broker.appendAuditEvent` while still
   holding the `audit-append` lock; the broker verifies monotonic `seq` against the ref head,
   appends, returns `{seq, head}`; release the lock (later writers wait/retry).
3. **Ledger commit (SQLite):** one transaction writes the run's ledger rows + the `audit_events` row
   and flips the intent to `done`.
4. **Backup + watermark:** post-commit encrypted backup with bounded durable retries; on verified
   success advance `backup_watermark.seq`; on failure the health surface degrades and further
   ledger-writing runs are blocked (`backup-unhealthy`, exit `2`) per the fail-closed contract.

**Crash recovery (both directions), run by `reconcileInterruptedRuns` on startup:** a `pending`
intent **with** a matching git event (same `runId`+`seq` on the ref) → complete step 3 idempotently;
a `pending` intent **without** a git event → re-drive step 2 from the persisted signed event in the
outbox (the broker append is idempotent on `(runId, seq)`), then step 3 from the persisted
ledger-mutation record; a `done` intent with no backup coverage → re-attempt step 4. Idempotency key
end-to-end is `(runId, seq)`. `audit.cross-store-ordering.test` restarts in a genuinely fresh process (no retained callbacks) and
injects a crash between every pair of steps in both directions, replaying only from the durable
outbox, and asserts convergence with no duplicate or lost event.

---

## 3. Phases

## Phase 0: Scaffold + retained harness + up-front contracts
**Goal:** a building repo whose contract harness survives every later revert, plus the normative
contracts that gate Phase 1.
**Dependencies:** none.
**Estimated effort:** M

### Tasks

0. **Task 0.0 — Repo scaffold + retained CLI-contract harness**
   - What: pnpm workspace skeleton (all package dirs from the **authoritative workspace inventory enumerated in
     this task's Files/Produces below** — mirroring the spec's tree-A layout but self-contained here
     so the task is executable without external context — with placeholder
     `package.json` + `src/index.ts` exporting nothing), `tsconfig.base.json` (strict, ESM, NodeNext),
     vitest workspace config, `.github/workflows/ci.yml` (matrix ubuntu-latest + macos-15; steps: checkout →
     **setup-node@v4 pinning Node 24 → Corepack-pinned pnpm 10 → assert `node --version` /
     `pnpm --version`** → pnpm install → `pnpm -r build` → `pnpm -r test`; the provisioning step is
     added by Task 1.0), root `package.json` scripts, a committed **`pnpm-lock.yaml`** with CI using
     `pnpm install --frozen-lockfile`, an explicit lifecycle-script allowlist
     (`pnpm.onlyBuiltDependencies`), git deps pinned to immutable commits, and a dependency
     vulnerability + provenance gate in the release CI. The **retained harness**: the full command registry with
     one row per command/subcommand — name, `schemaRef`, `phase`, idempotency class
     (`key-accepting`/`intrinsic`), privilege tier — seeded for **every** command in §7's inventory
     including the Phase-5 `graduation`/`quarantine` groups; the CLI-surface fixture (the prose
     inventory `contract-lint` parses — fixes R4-F6); the generator that emits per-command Markdown
     refs + contract-test fixtures + the acceptance-case inventory from the schemas; and
     `contract-lint` asserting registry ↔ fixture ↔ schema-presence-for-implemented-phase consistency.
   - Files: `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`,
     `.github/workflows/ci.yml`, `docs/specs/cli-contract/commands.json`,
     `docs/specs/cli-contract/cli-surface.fixture.txt`, `tools/gen-cli-contract.ts`,
     `tools/contract-lint.test.ts`, `package.json`, `AGENTS.md`.
   - Interfaces — **Consumes:** —. **Produces:** `commands.json` row shape
     `{name: string, schemaRef: string, phase: 0|1|2|3|4|5, idempotency: "key-accepting"|"intrinsic"|"none", privilege: "shared"|"privileged", implemented: boolean}`;
     `gen-cli-contract.ts` CLI (`--check` mode used by lint; `--write` regenerates derived files).
   - Test: `contract-lint.test` — key assertions: every fixture line has a registry row and vice
     versa; every row with `implemented: true` has an existing `schemaRef` file; the generator is
     deterministic (`--check` clean after `--write`).
   - Acceptance: `pnpm -r build && pnpm -r test` green on both OS from an empty checkout; lint fails
     if a command is added to the fixture without a registry row (proven by a fixture-mutation test).

1. **Task 0.1 — `recovery-state-machine.md` (normative contract)**
   - What: the full per-state transition table for the workflow state machine — for **every**
     checkpoint of the normative state set (§2.5): required artifacts + hashes, the single atomic
     write, legal next states incl. `failed`/`cancelled` entry conditions, idempotency check,
     retained artifacts, worktree cleanup, audit emission, recovery action. Failpoint tests
     (Task 4.11) are **generated from this table**.
   - Files: `docs/specs/recovery-state-machine.md`.
   - Interfaces — **Consumes:** —. **Produces:** the transition table consumed by Tasks 2.5, 4.5,
     4.11 (machine-readable appendix: a fenced JSON block `stateTable` the failpoint generator parses).
   - Test: `contract-lint.test` extension asserting the `stateTable` JSON parses and covers every
     state in §2.5's set (checked by `tools/contract-lint.test.ts` — table-completeness assertion).
   - Acceptance: every state + terminal appears; no state lacks a recovery action.

2. **Task 0.2 — `sqlite-data-dictionary.md` + versioned index contract**
   - What: complete per-table DDL for **all** tables in §2.7 (every column, SQL type, PK/FK,
     nullability, UNIQUE, CHECKs, ON DELETE per the retention matrix, upsert conflict targets), the
     composite-identifier rule (component scalar columns, never packed strings — `source_renditions`
     PK = (`raw_content_hash`,`canonical_media_type`,`extractor_version`,`normalizer_version`);
     dependent tables carry the same components as composite FKs, so **`content_blobs`'s active
     rendition is the component column set `active_extractor_version` + `active_normalizer_version`**
     (nullable pair, FK with the blob's own PK components to `source_renditions`) — fixes R3-F6);
     `claim_evidence.evidence_id` non-null hash with sentinel encoding; the invariant-validation
     queries `brain db verify` runs; and the **versioned index contract** (composite indexes for job
     eligibility (`state`,`next_run_at`), `note_links` bidirectional traversal, run lookup by
     `status`, `note_identity_keys(normalized_key)`, needs-index scans
     (`active_generation`,`contentHash`), audit lookup by `run_id`) with query-plan assertions.
   - Files: `docs/specs/sqlite-data-dictionary.md`.
   - Interfaces — **Consumes:** §2.7 **+ the retention/deletion-policy portion of
     `retention-matrix.md` (Task 0.4, split to land before this task so ON DELETE is not frozen ahead
     of its contract; Task 0.2 acceptance gates on an automated comparison against it)**. **Produces:**
     the DDL source of truth consumed by Tasks 1.4, 2.1, 2.7, 4.1 (each migration copies its tables'
     DDL verbatim from here).
   - Test: named later as `db.migrate-ownership.test` (Task 1.4) — the dictionary itself is gated by
     `contract-lint`'s table-inventory check against §2.7.
   - Acceptance: every §2.7 table present; every FK names its ON DELETE; every upsert names its
     conflict target.

3. **Task 0.3 — Security / authorization / broker contract**
   - What: one normative doc fixing: protected-ref set + filesystem permission model (refs +
     ref-dirs owned `atlas-broker:atlas-git`, dirs `0750`, files `0640` — group-**readable** so
     agents read canonical to branch from it, broker-only writes — fixes R3-F2; `refs/agent/*` owned
     by the agent user, group `atlas-git`, dirs `0770`); the per-key ACL matrix (approval **verify**
     key broker-readable; audit-attestation key agent-readable by design; backup AEAD key
     broker-only; quarantine AEAD key trusted-CLI-only, parser/model-denied; `atlas.gemini.key`
     **egress-broker-only**); WORM anchor format (signed head hash + monotonic event count) at D8's
     path; the challenge/response JSON schemas (`AuthorizationChallenge`, `AuthorizationResponse`,
     drift-rejection error catalog); Ed25519 envelope + canonicalization; nonce store + expiry;
     signer registry; key rotation/revocation procedure; audit-event payload schema (**opaque salted
     IDs** for note/source identifiers + the ledger mapping table, so ordinary erasure needs no
     ref rewrite); the D6 event-mapping decision; the signed-tombstone audit-ref replacement
     protocol for erasure.
   - Files: `docs/specs/security-broker-contract.md`.
   - Interfaces — **Consumes:** D1, D6, D8, D9, D10. **Produces:** the contract consumed by Tasks
     1.0, 1.6, 1.7, 4.9, 4.10.
   - Test: schemas in this doc are mirrored as Zod in Task 1.1; `contracts.authorization.test`
     (Task 1.1) asserts the JSON examples in this doc validate against those schemas.
   - Acceptance: every privileged op maps to challenge fields + verification steps + stable error
     codes; every key names its readable identities.

4. **Task 0.4 — Ledger-backup subsystem contract + `retention-matrix.md`**
   - What: (a) the backup contract — SQLite Online Backup API snapshot → single AEAD file,
     write-temp-then-rename atomicity, trigger policy (post-ledger-writing-run + `db backup`),
     fail-closed watermark semantics + `backup-unhealthy` blocking set + audited `--force-unblock`,
     key custody per D9, retention `sqlite.ledger_backup.keep` (default keep-N=10 + keep-forever
     latest), integrity stamp (content hash + schema version), restore protocol (privileged;
     verify → exclusive locks → transactional ledger-table restore → post-restore rebuild hooks);
     (b) `retention-matrix.md` — per entity class: system of record, minimum retention, compaction
     trigger, soft-vs-hard delete + tombstones, ON DELETE, purge ordering, config key + bounds
     (V1 defaults verbatim from the spec).
   - Files: `docs/specs/ledger-backup-contract.md`, `docs/specs/retention-matrix.md`.
   - Interfaces — **Consumes:** D6, D9. **Produces:** contracts consumed by Tasks 1.7, 4.10; the retention/deletion-policy rows land
     **before** Task 0.2 so the dictionary's ON DELETE column derives from (not precedes) the matrix.
   - Test: `ledger.dr-roundtrip.test` + `ledger.fail-closed-watermark.test` (Task 1.7) implement
     this contract's acceptance section verbatim.
   - Acceptance: every storage/entity class of the spec's retention list has a row; the fail-closed
     state machine (healthy → degraded → blocked → unblocked) is fully enumerated.

5. **Task 0.5 — Phase-1 `cli-contract/*` schemas + JSON error envelope**
   - What: per-command JSON Schemas for the Phase-1 commands — `inspect`, `doctor`, `status`,
     `db status|verify|migrate|rebuild|backup|restore` (incl. `db verify --backup`) — each capturing
     args, flags + defaults + constraints, side effects, prohibited effects, exit codes, stable
     per-command error codes, `--json` output shape; plus the shared **JSON error envelope** schema
     (discriminated `{code, message, hint, details{field?,path?,location?}, errors[]?, retryable,
     retryAfterMs?, runId?, jobId?}`) and the doctor check inventory for Phase 1 (modes/permissions,
     lock liveness + `--reclaim-locks`, backup watermark health, audit-head anchor check).
     Registry rows for these commands flip `implemented: false → true` per delivering task.
   - Files: `docs/specs/cli-contract/error-envelope.schema.json`,
     `docs/specs/cli-contract/{inspect,doctor,status,db-status,db-verify,db-migrate,db-rebuild,db-backup,db-restore}.schema.json`.
   - Interfaces — **Consumes:** Task 0.0 registry. **Produces:** schemas consumed by Tasks 1.8, 1.9
     (runtime validation of `--json` output in contract tests is generated by `gen-cli-contract.ts`).
   - Test: `contract-lint.test` (schema-presence) + generated per-command fixture stubs compile.
   - Acceptance: every Phase-1 registry row has a schema; envelope schema validates the doc's examples.

6. **Task 0.6 — Fixture vaults + `@atlas/testing` scaffold**
   - What: the fixture-vault set (`empty`, `small-valid`, `broken-links`, `duplicate-ids`,
     `conflicting-claims`, `source-heavy`, `schema-v1`) as committed directories, plus
     `@atlas/testing` helpers to copy a fixture into a temp dir with a fresh git repo (agents never
     test against a shared fixture in place).
   - Files: `fixtures/{empty,small-valid,broken-links,duplicate-ids,conflicting-claims,source-heavy,schema-v1}/**`,
     `fixtures/inputs/{sample.md,sample.txt,sample.pdf,sample.html,secret-bearing.md,adversarial-ansi.md}`
     (loose ingest-input files, incl. the scanner + renderer adversarial fixtures),
     `packages/testing/src/fixture.ts`, `packages/testing/package.json`.
   - Interfaces — **Consumes:** —. **Produces:**
     `withFixtureVault(name: FixtureName, fn: (ctx: {vaultDir: string, git: SimpleGitHandle}) => Promise<void>): Promise<void>`;
     `FixtureName = "empty"|"small-valid"|"broken-links"|"duplicate-ids"|"conflicting-claims"|"source-heavy"|"schema-v1"`.
   - Test: `testing.fixture.test` — copying `small-valid` yields a clean git repo with the fixture
     tree; mutations do not leak back into `fixtures/`.
   - Acceptance: all seven fixtures load; `duplicate-ids` really contains a duplicate `id` pair.

### Risks
- **Registry over-freezing:** seeding all commands in Phase 0 could ossify names. Mitigation: the
  registry is data; renames are one-row diffs gated by `contract-lint`, and schemas land per phase.
- **Contract docs drifting from code:** mitigated by generated fixtures (0.0) and by Zod mirrors
  asserting the docs' own examples (0.3/0.5 pattern).

### Verification (run from repo root)
```bash
pnpm install
pnpm -r build && pnpm -r test          # scaffold + harness + fixture tests green (both OS in CI)
node tools/gen-cli-contract.ts --check # deterministic; exits 0
```

### Rollback
- Precondition: Phase-0 PR merged; any later contract revision.
- Procedure: `git revert <phase0-followup-sha>` of the offending contract commit **only** — Task 0.0
  (scaffold + harness) is never reverted (it is the retained bootstrap every later rollback's
  verification depends on — fixes R3-F8).
- Schema compatibility: no SQLite DDL exists in Phase 0; nothing to downgrade.
- Verify supported state: `pnpm -r build && pnpm -r test` and
  `node tools/gen-cli-contract.ts --check` still exit 0 (the seed registry + fixture lint clean even
  with all contract docs reverted: ∅ == ∅).

---

## Phase 1: Skeleton — store, broker authorization core, ledger DR, base CLI
**Goal:** a provisioned host can `inspect`/`doctor`/`status` a fixture vault; SQLite store with
migrations + projection rebuild; the broker owns protected refs + audit append; the encrypted ledger
backup/restore round-trips destructively.
**Dependencies:** Phase 0.
**Estimated effort:** L

### Tasks

0. **Task 1.0 — Host + CI provisioning (both runtime identities)**
   - What: idempotent provisioning scripts creating users **`atlas-broker`**, **`atlas-egress`**, and the
     **`atlas-trusted-cli`** identity that owns the quarantine key and runs destructive
     ledger/purge/restore ops (constrained launcher `provisioning/bin/trusted-cli-launcher.sh`,
     explicit key+data ownership, peer-authenticated attachment, teardown), group **`atlas-git`**
     (agent user + all three identities are members) — but destructive restore/purge run **only**
     behind the trusted-cli service boundary, so importing a library or opening SQLite directly
     cannot bypass authorization; protected-ref permission layout
     per Task 0.3 (dirs `0750`, ref files `0640`, `refs/agent/` agent-owned `0770`); WORM anchor file at the **resolved `git.audit_anchor_path` config value** (defaulting to D8's path;
     provisioning validates + owns whatever path config resolves, so a non-default configured path is
     created broker-owned `0600`, parent `0700`, never left unprovisioned); key provisioning per the ACL matrix
     (D9) including the **`atlas-test-approver`** approval keypair provisioned **only** in
     explicitly-marked ephemeral CI/dev environments (never on a graduation/production host), with
     its signer ID **hard-rejected by the broker outside test mode** (real privileged ops require an
     OS presence assertion / hardware-backed external signer); agent
     **outbound-network denial** (macOS: Seatbelt profile `provisioning/profiles/agent.sb` applied
     by the agent launcher; Linux: network-isolated netns via `provisioning/linux/netns.sh` +
     seccomp allowlist) while `atlas-egress` retains network; **the agent launcher `provisioning/bin/agent-launcher.sh` is
     the mandatory entrypoint for every agent-side CLI/test process (CI and dev invoke the installed
     `brain` only through it), and startup asserts the process is inside its profile/netns before any
     work** so a compromised CLI cannot escape isolation; launchers
     `provisioning/bin/broker-launcher.sh` + `provisioning/bin/egress-launcher.sh` (drop to the
     respective identity, exec the built broker binaries); CI setup (`provisioning/ci/setup.sh`, D1)
     + dev setup/teardown (`provisioning/dev/{setup,teardown}.sh`). Fixes R2-F2, R4-F2.
   - Files: `provisioning/dev/setup.sh`, `provisioning/dev/teardown.sh`, `provisioning/ci/setup.sh`,
     `provisioning/bin/broker-launcher.sh`, `provisioning/bin/egress-launcher.sh`,
     `provisioning/bin/trusted-cli-launcher.sh`, `provisioning/bin/agent-launcher.sh`,
     `provisioning/profiles/agent.sb`, `provisioning/linux/netns.sh`,
     `provisioning/keys.acl.json` (**generated** from the single canonical ACL in `@atlas/contracts`,
     which the Task 0.3 table is also generated from — not an independent authority; provisioning and
     the separation test both derive from it, so a 0.3 revocation propagates and cannot leave a stale
     JSON), `.github/workflows/ci.yml` (add
     `sudo provisioning/ci/setup.sh` + `ATLAS_PROVISIONED=1`).
   - Interfaces — **Consumes:** Task 0.3 contract. **Produces:** the provisioned-host contract every
     broker/egress test consumes; `keys.acl.json` rows
     `{key: string, path: {darwin: string, linux: string}, readableBy: Identity[], identity: "atlas-broker"|"atlas-egress"|"agent"|"trusted-cli"}`.
   - Test: `provisioning.separation.test` — key assertions: agent read of each broker-only key path
     fails EACCES; `atlas-egress` cannot read the approval/backup keys; `atlas-broker` cannot read
     `atlas.gemini.key`; agent `git update-ref` on a protected ref fails EACCES while agent **read**
     of canonical succeeds; agent outbound TCP fails **when the installed `brain` is invoked exactly as users do (through the
     mandatory launcher), with the process profile/netns asserted first**; egress outbound TCP
     succeeds; teardown removes **every artifact in a shared machine-readable inventory** — all three users +
     group + anchor + Linux key dirs + macOS keychains + the sudoers drop-in (re-parsed after
     deletion) + sockets + netns + profiles + signer-registry entries, terminating privileged
     processes — asserted by re-running the test expecting absent artifacts; `provisioning.
     production-negative.test` asserts the `atlas-test-approver` key + signer are absent and the
     broker refuses the test signer id outside test mode.
   - Acceptance: setup → test → teardown is idempotent twice in a row on both OS; CI matrix runs it; a non-default
     configured anchor path is provisioned with correct ownership/modes and the broker appends to it.

1. **Task 1.1 — `@atlas/contracts` (leaf package)**
   - What: stable ID mint/parse (D3 serialization), canonical serialization, the ChangePlan
     **envelope** schema (target, rationale, sourceIds, retrievedEvidence, confidence,
     `proposedRisk`, reversibility, `idempotencyKey?` — per-operation payload schemas are Phase 2's
     gate, **not** promised here — fixes R2-F1/R3-F1), run-manifest schema, audit-event + authorization schemas **generated from Task 0.3's normative JSON Schemas** (single
     machine-readable authority; the Zod validators are emitted, never hand-mirrored) with an
     equivalence/property test over accepted **and rejected** input spaces, provider-error union type (taxonomy only; adapter is
     Phase 2), zero runtime dependencies (Zod only).
   - Files: `packages/contracts/src/{ids,canonical,changeplan-envelope,run-manifest,audit,authorization,provider-errors}.ts`,
     `packages/contracts/src/index.ts`, `packages/contracts/test/*.test.ts`.
   - Interfaces — **Consumes:** Task 0.3 doc. **Produces:**
     `newRunId(): string` (ULID) · `parseSourceHandle(s: string): ContentId | RenditionId` ·
     `serializeRenditionId(r: RenditionId): string` ·
     `canonicalSerialize(v: unknown): Uint8Array` (sorted keys, NFC, no NaN/Infinity) ·
     `saltedOpaqueId(kind: "note"|"source", id: string, salt: Uint8Array): string` ·
     `ChangePlanEnvelopeSchema: z.ZodType<ChangePlanEnvelope>` ·
     `RunManifestSchema: z.ZodType<RunManifest>` ·
     `AuditEventSchema: z.ZodType<AuditEvent>` · `SignedAuditEvent = {event: AuditEvent, signature: Uint8Array, signerId: string}` ·
     `AuthorizationChallengeSchema` / `AuthorizationResponseSchema` ·
     `ProviderError` (discriminated union of `validation|authentication|quota|rate_limit|timeout|transport|cancelled|partial_batch|model_incompatible`, each `{retryable: boolean, retryAfter?: number}`).
   - Test: `contracts.canonical.test` (byte-identical serialization across key orders + Unicode
     forms); `contracts.authorization.test` (Task 0.3's JSON examples validate) + a schema-equivalence/property
     check that the generated Zod accepts exactly the JSON-Schema-valid space (not only the examples).
   - Acceptance: package has zero deps besides `zod`; `pnpm --filter @atlas/contracts test` green.

2. **Task 1.2 — `config` internal module**
   - What: typed load + startup validation of `brain.config.yaml` (sections per spec:
     `vault`, `sqlite` (incl. `ledger_backup.*`, `ledger_retention`, `raw_payload_store`),
     `lancedb`, `indexing` (chunker_version=1, embedding model, `dimensions: 768`), `git`
     (worktrees_path, auto_commit_risk_levels, `audit_anchor_path`), `models`, `policies`, `logs`,
     `broker` (socket paths)); env-var overrides `ATLAS_<SECTION>_<KEY>`; ships the example config.
   - Files: `apps/cli/src/config/{schema,load}.ts`, `brain.config.example.yaml`,
     `apps/cli/test/config.test.ts`.
   - Interfaces — **Consumes:** Task 1.1 (`canonicalSerialize` for config hash). **Produces:**
     `loadConfig(cwd: string, env: NodeJS.ProcessEnv, opts?: {configPath?: string}): AtlasConfig`
     (resolves an explicit `--config` path or `brain.config.yaml`; throws `ConfigError` with
     file/key/location → exit `2`); `AtlasConfig` typed per section. Every phase Verification block
     generates a temp config from the example with all paths rooted in the temp dir and passes it via
     `--config`; missing config is tested as a deliberate fail-fast error.
   - Test: `config.test` — invalid enum/missing path fail with the offending key named; env
     override wins; example config validates.
   - Acceptance: every config key referenced anywhere in this plan exists in the schema + example.

3. **Task 1.3 — `vault` + `markdown` read layer**
   - What: vault reader (enumerate notes, parse frontmatter to typed fields incl. `id`, `type`,
     `schema_version`, `aliases`, `sources`, `declaredSensitivity`, `data_categories`; wikilink
     extraction; content hashing), identity-key canonicalization (NFC, case-fold,
     whitespace/punctuation normalization), and the vault **writer primitive** used only by
     workflow code (atomic write-temp-rename within the vault). Section/AST patch **generation** is
     Phase 4 (Task 4.2); this task ships the section **model** (heading tree with stable section
     selectors) that both reader and future patcher share.
   - Files: `apps/cli/src/vault/{reader,writer,frontmatter,identity}.ts`,
     `apps/cli/src/markdown/{parse,sections}.ts`, `apps/cli/test/vault.test.ts`.
   - Interfaces — **Consumes:** 1.1, 1.2. **Produces:**
     `readVault(cfg: AtlasConfig): Promise<VaultSnapshot>` ·
     `VaultSnapshot = {notes: ParsedNote[], errors: VaultError[]}` ·
     `ParsedNote = {id: string, path: string, type: NoteType, schemaVersion: number, aliases: string[], sources: string[], declaredSensitivity: Sensitivity, links: WikiLink[], sections: SectionTree, contentHash: string, raw: string}` ·
     `normalizeIdentityKey(s: string): string` · `writeNoteFile(path: string, content: string): Promise<void>`.
   - Test: `vault.identity.test` — mixed Hebrew/English alias normalization is rune-safe and
     deterministic; duplicate-id fixture surfaces both offenders.
   - Acceptance: `small-valid` parses with zero errors; `broken-links`/`duplicate-ids` produce the
     expected typed errors (not throws).

4. **Task 1.4 — `@atlas/sqlite-store`: connection, migrations, projections, `db` core commands**
   - What: better-sqlite3 connection (WAL, FKs on), checksum-guarded migration runner +
     `db_schema_migrations` bootstrap, `0001_core` DDL verbatim from the dictionary, repositories
     for projection + ledger tables, projection rebuild (transactional replace of the Phase-1
     projection set from a `VaultSnapshot`), the post-restore rebuild **hook registry** (fixes
     R1-F1: restore triggers whatever rebuild steps are registered; Phase 3 registers the index
     step), invariant queries (`db verify`), the composite indexes + query-plan assertions from the index contract, and the **shared lock
     manager** (`withLock` + named scopes) so restore (1.7) can acquire exclusive locks before the
     CLI layer (1.8) wires command-level scope usage.
   - Files: `packages/sqlite-store/src/{connection,migrate,rebuild,verify,repos/*.ts}.ts`,
     `packages/sqlite-store/migrations/0001_core.ts`, `packages/sqlite-store/test/*.test.ts`.
   - Interfaces — **Consumes:** 0.2 dictionary, 1.1, 1.3 (`VaultSnapshot`). **Produces:**
     `openStore(cfg: SqliteConfig): Store` ·
     `Store.migrate(): MigrationReport` · `Store.registerMigration(m: Migration): void` (jobs
     registers `0002` here) ·
     `Store.rebuildProjections(snapshot: VaultSnapshot): RebuildReport` ·
     `Store.verify(): VerifyReport` ·
     `registerPostRestoreRebuild(step: (ctx: RebuildCtx) => Promise<void>): void` ·
     `Migration = {id: string, checksum: string, up(db: Database): void}`.
   - Test: `db.migrate-ownership.test` — every §2.7 table is created by exactly its declared
     migration (fresh DB diff vs dictionary); `db.rebuild.test` — rebuild after note edits converges;
     ledger rows survive rebuild untouched; query-plan assertions use the contract's indexes.
   - Acceptance: `db migrate` idempotent; rebuild transactional (crash mid-rebuild leaves old
     projection readable — asserted with a failpoint).

5. **Task 1.5 — `@atlas/git` (plumbing client)**
   - What: typed git plumbing over the vault repo: read refs/heads, resolve commits, write objects,
     create agent branches (`refs/agent/<runId>`), worktree add/remove, commit with signed-manifest
     trailer, read protected refs (read-only from the agent side). No protected-ref writes here —
     that is broker-only.
   - Files: `packages/git/src/{repo,refs,worktree,commit}.ts`, `packages/git/test/*.test.ts`.
   - Interfaces — **Consumes:** 1.1. **Produces:**
     `openRepo(dir: string): Repo` · `Repo.readRef(name: string): Promise<string | null>` ·
     `Repo.createAgentBranch(runId: string, base: string): Promise<string>` ·
     `Repo.addWorktree(ref: string, dir: string): Promise<Worktree>` ·
     `Worktree.commit(msg: string, manifest: RunManifest): Promise<string>` ·
     `Repo.removeWorktree(dir: string): Promise<void>`.
   - Test: `git.plumbing.test` — agent branch + worktree + commit round-trip on a fixture repo;
     manifest trailer parses back to an equal `RunManifest`.
   - Acceptance: no code path in this package opens protected refs for writing (grep-guarded test
     `git.no-protected-write.test` asserting the write API surface only accepts `refs/agent/*`).

6. **Task 1.6 — `@atlas/broker`: authorization core + protected-ref primitives + audit append**
   - What: the broker daemon (runs as `atlas-broker` via the launcher; unix-socket server per D10)
     with: challenge mint/verify (nonce store, expiry, drift rejection per Task 0.3), Ed25519
     verification, protected-ref CAS advance with ancestry + signature + audit-event re-verification,
     **`integrateSourceCapture`** (the narrowly scoped Tier-1 capture integration Phase 2 consumes —
     **independently re-scans the exact git objects being integrated** (broker-side, engine from
     `@atlas/scan`), rejects symlinks + malformed manifests, verifies the commit touches only
     `sources/**` + manifest paths, requires a non-forgeable scanner attestation bound to the commit
     tree hash + ruleset version, and fast-forwards canonical under CAS — so a crafted RPC that skips
     `captureSource` cannot land unscanned bytes; fixes R1-F2), audit-ref append — the agent **cannot mint unrestricted events**: `appendAuditEvent` requires a
     one-time capability bound to the exact `(intentHash, runId, seq, eventType, expectedHead)`
     issued by `finalizeLedgerWrite`, so an agent can neither fabricate a terminal event nor consume
     a sequence without a matching SQLite intent (monotonic seq check, signed events only),
     WORM-anchor update on every append, and the client library; plus **daemon lifecycle** — `provisioning/bin/{broker,egress}-launcher.sh`
     install/start/stop hooks, socket cleanup, a readiness probe (`BrokerClient.connect` waits for
     socket + handshake), PID ownership, and startup-failure logging, invoked by
     `provisioning/{dev,ci}/setup.sh` and every Verification flow needing IPC. **No
     `@atlas/sqlite-store` import**
     (§2.8 direction; enforced by test). Includes `tools/test-signer.ts` (signs a challenge with the
     provisioned `atlas-test-approver` key) so every privileged flow is executable in tests/CI.
   - Files: `packages/broker/src/{server,client,authorize,refs,audit-append,anchor}.ts`,
     `packages/broker/bin/atlas-broker.ts`, `tools/test-signer.ts`,
     `packages/broker/test/*.test.ts`.
   - Interfaces — **Consumes:** 0.3, 1.0 (identities/keys), 1.1, 1.5. **Produces:**
     `BrokerClient.connect(socketPath: string): Promise<BrokerClient>` ·
     `BrokerClient.appendAuditEvent(e: SignedAuditEvent): Promise<{seq: number, head: string}>` ·
     `BrokerClient.advanceProtectedRef(r: RefAdvanceRequest): Promise<RefAdvanceResult>` where
     `RefAdvanceRequest = {ref: ProtectedRef, expectedOld: string, newCommit: string, manifest: RunManifest, authorization?: AuthorizationResponse, auditEvent: SignedAuditEvent}` ·
     `BrokerClient.integrateSourceCapture(r: {captureCommit: string, expectedBase: string, manifest: RunManifest, auditEvent: SignedAuditEvent}): Promise<RefAdvanceResult>` ·
     `BrokerClient.mintChallenge(op: PrivilegedOpDescriptor): Promise<AuthorizationChallenge>` ·
     `BrokerClient.execAuthorized(op: PrivilegedOpDescriptor, auth: AuthorizationResponse): Promise<PrivilegedOpResult>` ·
     `tools/test-signer.ts` CLI: `node tools/test-signer.ts --key atlas-test-approver < challenge.json > authorization.json`.
   - Test: `broker.no-ledger-dep.test` (import graph contains no sqlite-store);
     `approval-boundary.adversarial.test` (Phase-1 subset): agent direct `update-ref` on protected
     refs → EACCES; forged/replayed/expired signature → typed refusal; append with non-monotonic seq → refusal; direct fabricated append / sequence-consumption without a
     matching intent-bound capability → refusal; `anchor.anti-truncation.test`: truncate the audit ref, broker startup + verify detect count
     regression vs anchor; `capture.broker-rescan.test`: a crafted secret-bearing capture commit
     submitted directly to `integrateSourceCapture` (bypassing the CLI) is refused.
   - Acceptance: broker runs under `broker-launcher.sh` on both OS; all adversarial cases refused
     with the contract's stable error codes.

7. **Task 1.7 — Ledger finalization + encrypted backup/restore (`db backup|restore|verify --backup`)**
   - What: `finalizeLedgerWrite` implementing §2.8 exactly (intent txn + seq allocation → broker
     append → ledger commit → backup + watermark), `reconcileInterruptedRuns`, the AEAD backup
     writer (Online Backup API snapshot, temp-then-rename, content hash + schema stamp, retention
     pruning) — the AEAD **encrypt/decrypt** step runs behind narrowly scoped `atlas-broker` RPCs
     (`sealBackup`/`openBackup`) that accept/return backup streams without exposing the broker-only
     backup key to the unprivileged CLI (fixes the inaccessible-key defect), watermark fail-closed gate (blocks the **mutating** ledger-writing command set with
     `backup-unhealthy` exit `2` until covered, while the narrowly defined health-surface reads
     (`status`/`inspect`) run in **degraded mode** — render health immediately and durably queue
     their audit intent for later reconciliation rather than being blocked by the condition they
     report; audited `db backup --force-unblock` override), and
     the **privileged restore**: challenge/authorization via broker (`op: "db.restore"`, challenge
     carries backupRef + content hash), exclusive `vault-maintenance`+`ledger-maintenance` locks (the lock manager + `withLock` are
     delivered as a shared primitive in **Task 1.4 — moved ahead of 1.7** — with Task 1.8 adding
     CLI-level scope wiring; fixes the ordering gap),
     transactional ledger-table restore with a **restore-specific reconciliation against the broker's
     current audit head**: verify the backup audit head is a prefix of the anchored ref, **advance
     the seq allocator to the broker head** (never re-allocate an already-appended seq), explicitly
     record/declare the post-backup RPO gap (lost N+1..M rows), append the `db.restore` event at
     head+1, **then** run the post-restore hooks (projection rebuild now; index rebuild added Phase
     3). D6 audit rows for backup/restore/force-unblock.
   - Files: `packages/sqlite-store/src/ledger/{finalize,intents,reconcile}.ts`,
     `packages/sqlite-store/src/backup/{backup,restore,watermark}.ts`,
     `apps/cli/src/commands/db-backup.ts`, `apps/cli/src/commands/db-restore.ts`,
     `packages/sqlite-store/test/ledger/*.test.ts`.
   - Interfaces — **Consumes:** 0.4 contract, 1.1, 1.4, 1.6 (`appendAuditEvent`), 1.2 (config).
     **Produces:**
     `finalizeLedgerWrite<T>(store: Store, broker: BrokerClient, run: RunContext, write: (tx: LedgerTx) => T): Promise<T>` ·
     `reconcileInterruptedRuns(store: Store, broker: BrokerClient): Promise<ReconcileReport>` ·
     `takeBackup(store: Store, cfg: LedgerBackupConfig): Promise<{backupRef: string, seq: number}>` ·
     `verifyBackup(cfg: LedgerBackupConfig, backupRef: string): Promise<void>` ·
     `restoreBackup(store: Store, backupRef: string): Promise<void>` (invoked only by the
     authorized CLI path) · `watermarkHealth(store: Store): {seq: number, coveredSeq: number, healthy: boolean}`.
   - Test: `ledger.dr-roundtrip.test` — backup → wipe DB → authorized restore (via
     `tools/test-signer.ts`) → every ledger row recovered byte-equal; `restore.atomicity.test` — crash mid-restore leaves the prior DB intact, and a concurrent rebuild/
     integration/second-restore is excluded by the locks; `restore.non-latest-continuity.test` —
     restoring a non-latest backup after several later ledger-writing runs, then running a new ledger
     write, succeeds with no non-monotonic broker rejection (seq allocator advanced to head, RPO gap
     recorded); `ledger.fail-closed-watermark.test` — injected
     backup failure blocks a subsequent ledger-writing run with `backup-unhealthy`, read-only
     commands still work, verified backup unblocks, `--force-unblock` records the audited RPO gap;
     `audit.cross-store-ordering.test` per §2.8; wrong/revoked key + truncated/corrupt backup
     rejection.
   - Acceptance: the Phase-1 exit criteria — destructive restore + corruption tests — are green in
     CI on both OS, exercised as the **actual unprivileged CLI identity** (backup key never
     CLI-readable; encrypt/decrypt only via the broker RPCs).

8. **Task 1.8 — CLI foundation: entrypoint, renderer, envelope, locks, diagnostics**
   - What: the `brain` entrypoint (command routing from the registry, `--json|--quiet|--verbose`,
     exit-code mapping), the **terminal-safe renderer** as the single human-output channel (strips/
     escapes ANSI/CSI/OSC-8/OSC-52/C0-C1/CR-overwrite; isolates bidi controls; preserves
     newline/tab), `--plain` + `NO_COLOR`/`--no-color`/`TERM=dumb`/non-TTY degradation with
     append-only progress lines, the JSON error envelope emitter (0.5 schema), the **lock manager**
     (named scopes + §2.5 global order incl. `jobs-runner`; owner pid + start time;
     `locked:<scope>` exit `2`; `doctor --reclaim-locks` for dead-pid locks), and **diagnostics
     logging** (structured JSONL to `logs.dir`, rotation + retention per `logs.*`, run/job-id
     correlation, redaction boundary — never raw prompts/quotes/secrets). Fixes R1-F13's missing
     owners.
   - Files: `apps/cli/src/{main,router}.ts`, `apps/cli/src/render/{safe,plain,progress}.ts`,
     `apps/cli/src/errors/envelope.ts`, `apps/cli/src/locks/manager.ts`,
     `apps/cli/src/diag/logger.ts`, `apps/cli/test/{renderer,locks,envelope}.test.ts`.
   - Interfaces — **Consumes:** 0.5 schemas, 1.2. **Produces:**
     `runCli(argv: string[], env: NodeJS.ProcessEnv): Promise<number>` ·
     `render(text: string, opts: RenderOpts): string` (the ONLY human-output path) ·
     `withLock<T>(scope: LockScope, fn: () => Promise<T>): Promise<T>` where
     `LockScope = "vault-maintenance"|"ledger-maintenance"|"jobs-runner"|"canonical-integration"` ·
     `emitError(e: CliError): never` · `diag(runId: string | null): Logger` where
     `Logger = {info(msg: string, ctx?: object): void; warn(msg: string, ctx?: object): void; error(msg: string, ctx?: object): void; child(ctx: object): Logger}`
     (full method signatures, fixes R2-F6).
   - Test: `terminal-renderer.safety.test` — adversarial ANSI/OSC-8/OSC-52/CR/bidi fixtures neutered;
     `plain-mode.announcements.test` — long-running command in `--plain` emits append-only
     `started…/progress: N/M/done` lines, non-duplicated; `locks.conflict-matrix.test` — the
     contract's coexistence matrix, incl. dead-pid reclaim.
   - Acceptance: no command bypasses `render()` (lint rule banning direct `process.stdout.write` of
     non-JSON outside the renderer + JSON emitter modules).

9. **Task 1.9 — `inspect`, `doctor`, `status` + Tier-0/projection audit wiring**
   - What: `inspect` (vault + projection summary), `doctor` (Phase-1 check inventory per 0.5:
     file/dir modes 0700/0600 across vault/SQLite/worktrees/temp, encrypted-volume marker where
     detectable, lock liveness + `--reclaim-locks`, backup watermark health, audit-head anchor
     check, provisioning presence), `status` per D12. Executed `inspect`/`status` append one terminal
     **`run.readonly`** event via §2.8; but under a `backup-unhealthy` gate these health-surface
     reads run in **degraded mode** — they render the watermark/health immediately and **durably
     queue their audit intent** (reconciled when backup recovers) rather than being rejected by the
     very condition they must report (fixes the read-survival contradiction); executed `db rebuild` (from 1.4) appends **`run.projection`** — wired
     here so the Phase-1 projection-only command is audited from day one. Previews/`doctor` emit no
     run events (doctor is a health surface, not a run — per the spec's closed Tier-0 enumeration).
   - Files: `apps/cli/src/commands/{inspect,doctor,status}.ts`, `apps/cli/src/audit/readonly.ts`,
     `apps/cli/test/e2e/phase1.e2e.test.ts`.
   - Interfaces — **Consumes:** 1.3, 1.4, 1.6, 1.7 (`finalizeLedgerWrite`), 1.8. **Produces:**
     `recordReadonlyRun(kind: "run.readonly"|"run.projection", cmd: string, store, broker): Promise<RunId>`
     (consumed by `query` in 3.5 and `index` ops in 3.6).
   - Test: `phase1.e2e.test` — on `small-valid`: `inspect --json` exit 0 + schema-valid; `doctor`
     exit 0 on a provisioned host / names the failing check otherwise; `status` shows watermark;
     the audit ref gained exactly one `run.readonly` per executed inspect (cardinality assertion);
     `db rebuild` emits exactly one `run.projection`.
   - Acceptance: Phase-1 exit — all named suites green + the Verification block below passes on
     both OS.

### Risks
- **Provisioning friction on dev machines** (sudo, users): mitigated by `ATLAS_PROVISIONED` skips
  locally + mandatory CI coverage; `doctor` names exactly what is missing.
- **better-sqlite3 Online Backup API coverage:** if the binding lacks it, fall back to
  `VACUUM INTO` + WAL checkpoint under `ledger-maintenance` lock — decision recorded in Task 0.4's
  contract before Task 1.7 starts.
- **macOS Seatbelt deprecation churn:** the sandbox/network profiles are pinned per macOS major and
  capability-probed at startup (`doctor` fails loud), per the sandbox contract.

### Verification (run from repo root; requires `sudo provisioning/dev/setup.sh` once, which also starts the broker + egress daemons and waits for socket readiness)
```bash
pnpm -r build && pnpm -r test                              # all Phase-0/1 suites green
ATLAS_PROVISIONED=1 pnpm --filter @atlas/broker --filter @atlas/sqlite-store test
V=$(mktemp -d)/vault && cp -R fixtures/small-valid "$V" && git -C "$V" init -q && git -C "$V" add -A \
  && git -C "$V" -c user.name='Aryeh Stark' -c user.email='aryeh@21stark.com' commit -qm seed   # isolated vault, not the committed fixture
CFG=$(mktemp); # + a temp --config with all derived paths under "$V" (see Prerequisites verification hygiene)
node apps/cli/dist/index.js --vault "$V" db migrate        # exit 0, idempotent on rerun
node apps/cli/dist/index.js --vault "$V" db rebuild        # exit 0; emits one run.projection
node apps/cli/dist/index.js --vault "$V" inspect --json    # exit 0; validates inspect.schema.json
node apps/cli/dist/index.js --vault "$V" doctor            # exit 0 on provisioned host
REF=$(node apps/cli/dist/index.js --vault "$V" db backup --json | jq -r .backupRef)
node apps/cli/dist/index.js --vault "$V" db verify --backup "$REF"   # exit 0
node apps/cli/dist/index.js --vault "$V" db restore "$REF" --export-challenge > /tmp/ch.json
node tools/test-signer.ts --key atlas-test-approver < /tmp/ch.json > /tmp/auth.json
node apps/cli/dist/index.js --vault "$V" db restore "$REF" --authorization /tmp/auth.json  # exit 0
```

### Rollback
- Precondition: Phase-1 PR merged; Phase 2 not started.
- Procedure (single branch): `git revert <phase1-PR-merge-sha>` on a branch → revert PR → merge.
  Host provisioning is **not** torn down by a code revert (it is stateful host config;
  `provisioning/dev/teardown.sh` is run only when decommissioning a host).
- Schema compatibility: `0001_core` DDL already applied to local DBs remains readable; the migration
  runner no-ops on re-apply after a roll-forward; **no downgrade DDL is ever run**.
- Verify supported state (commands that survive the revert — Phase-0 harness only):
  `pnpm -r build && pnpm -r test` and `node tools/gen-cli-contract.ts --check` exit 0.

---

## Phase 2: Ingest loop — scanner, sandbox, capture, jobs, egress broker
**Goal:** `brain ingest`/`source add` capture local files (md/txt/pdf/html) as immutable,
provenanced source notes through the broker; jobs queue runs; the Gemini adapter exists behind the
egress broker and is provably restricted to non-mutating extraction/classification.
**Dependencies:** Phase 1. Lands as **two PRs**: PR-A (Task 2.1, retained) then PR-B (all else).
**Estimated effort:** L

### Tasks

0. **Task 2.0 — Phase-2 contracts gate**
   - What: author + approve `jobs-contract.md` (legal transitions, retry classification + bounded
     defaults, backoff schedule, terminal semantics, **`jobs-runner` process-lock ownership** (D5),
     dead-runner startup recovery), `sandbox-contract.md` (per-guarantee isolation primitive on
     macOS Seatbelt + Linux userns/seccomp/netns/rlimits, startup capability checks, supported-host
     matrix), `normalization-contract.md` (per-format MIME signatures + canonical media tokens,
     encodings, rejection codes `unsupported-encoding`/`encrypted-source`/`no-extractable-text`,
     partial-extraction-is-rejection, determinism requirement, size limits, conformance fixture
     list, media alt-text rules), the **per-operation ChangePlan schemas** as code in `contracts`
     (all 17 ops as a discriminated union incl. reserved `CreateTask`/`UpdateTaskState`; exact
     files below — fixes R3-F1), the provider-interface contract doc (request/result types, batch
     semantics, `AbortSignal`, error taxonomy binding), and `cli-contract/*` schemas for `ingest`,
     `source add|list|show`, `source trust show`, `note show|related|history`,
     `jobs list|run|retry|cancel`, `git status|cleanup`.
   - Files: `docs/specs/jobs-contract.md`, `docs/specs/sandbox-contract.md`,
     `docs/specs/normalization-contract.md`, `docs/specs/provider-interface.md`,
     `packages/contracts/src/ops/{create-note,update-section,append-section,frontmatter,add-alias,links,relationship,claim,evidence,merge,rename,archive,trust,task}.ts`,
     `packages/contracts/src/changeplan.ts` (`ChangePlanSchema` union),
     `docs/specs/cli-contract/{ingest,source-add,source-list,source-show,source-trust-show,note-show,note-related,note-history,jobs-list,jobs-run,jobs-retry,jobs-cancel,git-status,git-cleanup}.schema.json`.
   - Interfaces — **Consumes:** 1.1 envelope. **Produces:**
     `ChangePlanSchema: z.ZodType<ChangePlan>` (envelope × discriminated op payloads) ·
     `ChangePlanOperation` union type · per-op result/error-code types.
     Byte-identity across the process seam is asserted by `contracts.operations.test`.
   - Test: `contracts.operations.test` — every op schema round-trips canonical serialization
     byte-identically in two separate processes (CLI-side + broker-side harness).
   - Acceptance: all Phase-2 registry rows have schemas; contract docs' fenced examples validate.

1. **Task 2.1 — PR-A (retained): `0003_provenance` migration + manifest fold**
   - What: the provenance DDL (per dictionary: `content_blobs` with component-column active
     rendition, `source_captures` with `UNIQUE(contentId-components, origin)`, `source_renditions`,
     `note_sources`) + `foldProvenanceManifests` — the rebuild reader that reconstructs all three
     entities (and `note_sources`) from canonical Markdown manifests, registered into
     `rebuildProjections`. Lands as its own PR that later reverts never touch (fixes R4-F5, R3-F9).
   - Files: `packages/sqlite-store/migrations/0003_provenance.ts`,
     `packages/sqlite-store/src/provenance/fold.ts`, `packages/sqlite-store/test/provenance-fold.test.ts`.
   - Interfaces — **Consumes:** 0.2, 1.4 (`registerMigration`, rebuild pipeline). **Produces:**
     `foldProvenanceManifests(snapshot: VaultSnapshot, tx: RebuildTx): void` (consumed by 1.4's
     rebuild from now on); the provenance repos
     (`upsertBlob`, `recordCapture`, `recordRendition`, `setActiveRendition`, `resolveSourceHandle(h: ContentId | RenditionId): RenditionRow | null`).
   - Test: `provenance-fold.test` — hand-authored manifest fixtures rebuild to the exact expected
     rows, including the derived active-rendition pointer.
   - Acceptance: with **only** PR-A merged, `db rebuild` on `source-heavy` reproduces provenance
     projections from manifests alone.

2. **Task 2.2 — Secret-scan engine + guards + quarantine store**
   - What: the scan engine (representative secret formats + entropy heuristics; deterministic,
     versioned ruleset), **`PrePersistenceGuard`** (raw bytes + normalized output; consumed by
     normalize/capture as a required dependency) and **`GeneratedArtifactGuard`** (exact serialized
     form of model responses + derived artifacts incl. future patches/diffs/commit messages — the
     same engine, second enforcement point; exists from the first model call), and the quarantine
     store: AEAD (key per ACL matrix, trusted-CLI identity), mode-0700 dir **outside the repo**,
     minimized filenames, bounded retention, crash-safe purge (temp-then-rename; no plaintext ever
     on disk), `doctor` quarantine-security checks.
   - Files: `packages/scan/src/{engine,rules,pre-persistence,generated-artifact}.ts` +
     `packages/scan/package.json` (a **dependency-leaf `@atlas/scan` package** consumed by `apps/cli`,
     `@atlas/sources`, and `@atlas/broker` — eliminates the CLI→package→CLI runtime cycle and the
     module-boundary violation), `apps/cli/src/quarantine/store.ts` (quarantine orchestration stays
     app-internal), `packages/scan/test/*.test.ts`, `apps/cli/test/scan/*.test.ts`.
   - Interfaces — **Consumes:** 1.2, 1.8 (diag). **Produces:**
     `scanBytes(input: {bytes: Uint8Array, context: ScanContext}): ScanVerdict`
     (`ScanVerdict = {clean: true} | {clean: false, findings: SecretFinding[]}`) ·
     `PrePersistenceGuard.assertClean(a: {bytes: Uint8Array, origin: string}): Promise<void>`
     (throws `SecretDetectedError` after quarantining; exit `3` at the CLI boundary) ·
     `GeneratedArtifactGuard.assertClean(a: {text: string, sink: PersistenceSink, runId: string}): Promise<void>` ·
     `PersistenceSink = "sqlite"|"worktree"|"git-object"|"lancedb"|"log"|"audit"`.
   - Test: `quarantine.security.test` — ciphertext-only at rest (AEAD integrity), parser/model
     identities cannot read the key, filenames minimized, rotation + retention expiry, crash
     mid-quarantine leaves no plaintext; `scan.engine.test` — representative formats detected,
     clean fixtures pass.
   - Acceptance: guard refusal quarantines + aborts with exit `3`; nothing persists to any sink.
     Import-graph tests assert `@atlas/scan` is a leaf consumed by CLI, sources, and broker with no
     back-edge into `apps/cli`, so all three enforcement points share one scanner without duplication.

3. **Task 2.3 — `@atlas/sources`: sandboxed parser worker**
   - What: the sandbox launcher per `sandbox-contract.md` — dedicated low-privilege spawn,
     **allowlisted empty environment**, no network, isolated FS namespace (read-only input handle +
     disposable output dir), isolated temp, CPU/memory/time/output caps, syscall restrictions,
     MIME-signature validation before parse, scripts/external resources disabled; startup capability
     probes that fail fast (wired into `doctor`). Both backends (macOS Seatbelt, Linux
     userns+seccomp+netns+rlimits).
   - Files: `packages/sources/src/sandbox/{launcher,darwin,linux,probes}.ts`,
     `packages/sources/src/worker/main.ts`, `packages/sources/test/sandbox-containment.test.ts`.
   - Interfaces — **Consumes:** 0.3 (identities), 2.0 sandbox contract. **Produces:**
     `runInSandbox(req: {inputPath: string, format: SourceFormat, limits: SandboxLimits}): Promise<WorkerResult>`
     (`WorkerResult = {ok: true, outputDir: string} | {ok: false, rejection: NormalizationRejection}`) ·
     `probeSandbox(): Promise<SandboxCapabilityReport>` (consumed by `doctor`).
   - Test: `sandbox.containment.test` (adversarial): probe parsers assert network, env, keychain,
     inherited FDs, out-of-scope paths, subprocess spawn, forbidden syscalls all fail; caps enforce
     incl. cleanup after forced termination.
   - Acceptance: containment suite green on both OS in CI.

4. **Task 2.4 — Normalization per contract (consumes the guard)**
   - What: md/txt/pdf/html normalizers running in the worker, driven by `normalization-contract.md`:
     canonical media-type detection, encoding rules, typed rejections, deterministic output +
     locator schemes (byte/char offsets, pdf page+span, DOM anchor), per-format size limits, media
     alt-text handling (preserve useful `alt`, `alt=""` for decorative, meaningful-image gap records
     — auto-generated descriptions are out of Phase 2 since they'd be synthesis; the Tier-3 gate
     applies when Phase 4 enables them). `normalize` **requires** a `PrePersistenceGuard` and scans
     raw bytes before parse and normalized output before return (fixes R4-F3).
   - Files: `packages/sources/src/normalize/{index,markdown,text,pdf,html,media}.ts`,
     `packages/sources/test/normalization-conformance.test.ts`.
   - Interfaces — **Consumes:** 2.0 contract, 2.2 guard, 2.3 sandbox. **Produces:**
     `normalize(input: {path: string, guard: PrePersistenceGuard}): Promise<NormalizeResult>`
     (`NormalizeResult = {ok: true, rendition: NormalizedRendition} | {ok: false, rejection: NormalizationRejection}`;
     `NormalizedRendition = {contentId: ContentId, extractorVersion: number, normalizerVersion: number, normalizedContentHash: string, sizeBytes: number, locatorScheme: LocatorScheme, text: string, gaps: RepresentedGap[]}`).
   - Test: `normalization-conformance.test` — the contract's fixture matrix per format (encodings,
     encrypted/scanned PDF rejections, script-bearing HTML static-DOM, partial-extraction rejection,
     determinism: same bytes+versions ⇒ byte-identical hash); `normalize.scans-before-return.test` —
     a secret-bearing fixture never yields a rendition and lands in quarantine.
   - Acceptance: conformance matrix green; determinism proven by double-run hash equality.

5. **Task 2.5 — `workflows` core: persisted run state machine + reconciler**
   - What: the run lifecycle engine per `recovery-state-machine.md`: durable checkpoints in
     `agent_runs` (single atomic write per transition with the gating artifacts/hashes),
     `failed@`/`cancelled@` semantics, `AbortSignal` plumbing, startup reconciler (integrated-but-
     unfinalized → finalize; review-pending → leave intact; applied-uncommitted → commit iff plan
     hash + base unmoved else `failed@worktree-applied`; orphaned worktrees → clean), run-report
     assembly, and the **caller-idempotency layer** for key-accepting workflow commands (persist
     normalized request hash + terminal result per `(command, --idempotency-key)`; identical retry
     returns the prior result; key reuse with different input rejected; concurrent duplicates block
     on the persisted key). Consumed by capture now, synthesis in Phase 4.
   - Files: `apps/cli/src/workflows/{engine,checkpoints,reconciler,run-report}.ts`,
     `apps/cli/test/workflows-core.test.ts`.
   - Interfaces — **Consumes:** 0.1 table, 1.4 repos, 1.7 (`finalizeLedgerWrite`), 1.5/1.6 (git,
     broker). **Produces:**
     `startRun(kind: RunKind, input: RunInput): Promise<RunHandle>` ·
     `RunHandle.checkpoint(state: RunState, artifacts: CheckpointArtifacts): Promise<void>` ·
     `RunHandle.fail(at: RunState, reason: string): Promise<TerminalRun>` ·
     `RunHandle.cancel(at: RunState): Promise<TerminalRun>` ·
     `reconcileRunsOnStartup(deps: {store: Store, repo: Repo, broker: BrokerClient}): Promise<ReconcileReport>`.
   - Test: `workflows-core.test` — each legal transition persists exactly its contract artifacts;
     illegal transitions throw; reconciler cases from the contract table (subset exercised here;
     full generated matrix in Task 4.11).
   - Acceptance: a capture run driven through the engine survives kill -9 at every checkpoint and
     reconciles per the table.

6. **Task 2.6 — Capture pipeline + `ingest` / `source add`**
   - What: `captureSource` — dedup + capture-event idempotency per the spec (blob by
     `(rawContentHash, canonicalMediaType)`, capture keyed `(contentId, origin)`, changed bytes ⇒
     new blob), immutable raw-byte copy under `sources/`, the three canonical Markdown manifests,
     deterministic capture commit on an agent branch, integration via
     `broker.integrateSourceCapture` (Tier-1 CAS), projections via `finalizeLedgerWrite`, RunReport.
     `ingest` (preview default: prints planned capture + extraction preview; `--apply` captures) and
     `source add` (immediate capture, D11) both funnel here. **`captureSource` requires the guard**
     (scan-before-persist — fixes R4-F3).
   - Files: `apps/cli/src/ingest/{capture,manifests}.ts`,
     `apps/cli/src/commands/{ingest,source-add}.ts`, `apps/cli/test/e2e/ingest.e2e.test.ts`.
   - Interfaces — **Consumes:** 2.1 repos, 2.2 guard, 2.4 normalize, 2.5 engine, 1.6
     (`integrateSourceCapture`). **Produces:**
     `captureSource(req: {path: string, guard: PrePersistenceGuard, deps: CaptureDeps}): Promise<CaptureResult>`
     (`CaptureResult = {contentId: ContentId, captureId: string, renditionId: RenditionId, noteId: string, runId: string, reused: {blob: boolean, capture: boolean}}`).
   - Test: `capture.scans-before-persist.test` — secret-bearing file: no vault/SQLite/worktree/git/
     temp persistence, quarantined, exit `3`; `provenance.versioning.test` — the spec's table-driven
     matrix (same bytes new path ⇒ capture not blob; changed bytes ⇒ new blob; extractor upgrade ⇒
     new rendition + re-pointed active; retried same-path ingest ⇒ no new capture) — **provenance
     behavior only; dependent-evidence staleness asserted in Phase 4** (fixes R4-F4);
     `ingest.e2e.test` — preview creates **no canonical/vault/worktree/git mutation** (any
     model-call/transmission-audit rows an extraction preview writes are the enumerated observability
     writes, not vault state, per the single preview-side-effect contract), `--apply` commits via
     broker CAS, canonical advanced exactly one commit.
   - Acceptance: capture idempotency proven under retry + crash injection at each checkpoint.

7. **Task 2.7 — PR-B: `@atlas/jobs` + `jobs` CLI**
   - What: `0002_jobs` migration (its DDL + runner registration ship in the **retained migration PR** with the
     Phase-2 PR-A wave so a PR-B revert never orphans applied jobs DDL; sole ownership retained; the
     runner applies it by sparse id per §2.7), repository + transactions (state enum, attempts, `lease_epoch` reserved-written,
     `next_run_at` backoff, idempotency keys unique per (workflow, key), side-effect-id recording),
     synchronous single-runner (`jobs-runner` lock, bounded attempts, backoff), startup dead-runner
     recovery (reset to `pending` under the lock), `jobs list|run|retry|cancel` per D5 + the
     registry (bulk selection semantics, per-job result array + aggregate exit).
   - Files: `packages/jobs/migrations/0002_jobs.ts`, `packages/jobs/src/{repo,runner,recovery}.ts`,
     `apps/cli/src/commands/jobs.ts`, `packages/jobs/test/*.test.ts`.
   - Interfaces — **Consumes:** 2.0 jobs-contract, 1.4 (`registerMigration`), 1.8 (`withLock`).
     **Produces:**
     `enqueue(tx: LedgerTx, job: JobSpec): JobId` (`JobSpec = {workflow: string, idempotencyKey: string, payload: unknown, maxAttempts?: number}`) ·
     `runAll(deps: JobsDeps, selector: {jobId?: string, all?: boolean}): Promise<JobRunReport>` ·
     `readSnapshot(store: Store, id: JobId): JobSnapshot` (the one-way API sqlite-store consumers use).
   - Test: `jobs.single-runner-exclusion.test` — two concurrent `jobs run` processes: one drains,
     the other exits `2` `locked:jobs-runner`, every job executes exactly once;
     `jobs.lifecycle.test` — idempotency collisions, retry exhaustion → terminal, startup recovery,
     cancel queued-vs-running, controlled clocks + crash injection.
   - Acceptance: jobs-contract acceptance section green; `jobs retry`/`cancel` with no selector
     exit `5`.

8. **Task 2.8 — Egress broker + `@atlas/models` (Gemini, extraction-only) + operation gate**
   - What: the egress-broker daemon (runs as `atlas-egress` via its launcher; unix socket per D10):
     sole credential holder, sole outbound-network process; scans the **exact serialized payload**
     in-broker on every request/response (engine from 2.2), writes sanitized-metadata ledger rows + audit events for every transmission via a **durable egress
     outbox**: the broker persists a request **receipt (end-to-end request/idempotency id)** before
     any network transmission and persists the terminal outcome **before replying**; the CLI-side
     `finalizeLedgerWrite` correlation (request/response hashes, destination, model, tokens, latency,
     cost, retries) then **acknowledges** the receipt, and `reconcileInterruptedRuns` on restart
     records any unacknowledged receipt — so a crash between transmission and finalization can never
     lose or silently re-bill a transmission. `@atlas/models`
     = typed IPC client (`generateText`/`generateObject<T>`/`embed`, versioned request/result types,
     `AbortSignal`, adapter-owned retry, taxonomy mapping incl. `retryAfter` propagation). The
     Gemini adapter lives **inside** the egress broker. Plus **`policies.operationGate`** — the
     narrow Phase-2 policy subset (fixes R1-F3): capture/projection ops allowed, synthesis ops
     rejected fail-closed, reserved task ops rejected always.
   - Files: `packages/models/src/{client,types}.ts`,
     `packages/broker/src/egress/{server,gemini,scan}.ts`, `packages/broker/bin/atlas-egress.ts`,
     `apps/cli/src/policies/operation-gate.ts`, `packages/models/test/*.test.ts`.
   - Interfaces — **Consumes:** 2.0 provider contract, 2.2 engine, 1.0 (identity/keys), 1.1
     (`ProviderError`). **Produces:**
     `generateText(req: GenerateTextRequest, signal?: AbortSignal): Promise<GenerateTextResult>` ·
     `generateObject<T>(req: {schemaId: SchemaRef, prompt: PromptRef, input: string}, signal?: AbortSignal): Promise<T>` (the IPC carries a **registered schema id / serializable JSON Schema**, never a Zod instance — the client keeps the `z.ZodType<T>` locally for result validation, since Zod objects are not JSON-serializable across the framed-JSON seam) ·
     `embed(req: {texts: string[], dimensions: number}, signal?: AbortSignal): Promise<EmbedResult>`
     (batch semantics: `partial_batch` names succeeded indices, never persisted as complete) ·
     `assertOperationAllowed(op: ChangePlanOperation, phase: 2 | 4): void` (throws typed
     `OperationForbiddenError`; Phase-4 extends the same owner with tier gating — single source).
   - Test: `egress.bypass.test` — agent-context direct fetch fails at OS layer (network denial);
     a secret planted in a prompt is blocked in-broker, quarantined, audited; adapter suite per the
     spec (doubles by default; malformed/truncated output, schema violations, timeouts, rate-limit
     `retryAfter → retryAfterMs`, cancellation before/during/mid-batch, auth failures: stable `authentication`, `retryable: false`,
     zero retries, sanitized diagnostics); crash/socket-loss failpoints at the network/IPC/
     finalization boundaries prove request-succeeds/ledger-fails and intent-succeeds/request-fails
     both reconcile via the outbox (idempotent, no double-transmit).
   - Acceptance: `ATLAS_LIVE_GEMINI=1` smoke passes nightly; no provider key readable outside
     `atlas-egress` (re-asserted by `provisioning.separation.test`).

9. **Task 2.9 — Read/maintenance commands: `source list|show`, `source trust show`, `note show|related|history`, `git status|cleanup`**
   - What: registry-driven read commands over projections + git (pagination contract: `--limit`
     default 50/max 500 + `--offset`, defined sort key + unique tie-breaker, `total`/`hasMore`,
     documented best-effort anomalies); `source trust show` reads the trust state (default
     untrusted pre-Phase-4); `git status` lists open agent branches/worktrees with run id/risk/
     validation/base; `git cleanup` prunes terminal-run branches/worktrees.
   - Files: `apps/cli/src/commands/{source,note,git-status,git-cleanup}.ts`,
     `apps/cli/test/pagination.contract.test.ts`.
   - Interfaces — **Consumes:** 1.4/2.1 repos, 1.5, 1.8. **Produces:** — (leaf commands).
   - Test: `pagination.contract.test` — deterministic ordering with tie-breakers, out-of-range
     offset/limit bounds (exit `5`), stable JSON schemas, concurrent-insert anomaly bounds.
   - Acceptance: each command's generated contract fixtures pass.

10. **Task 2.10 — Phase-2 non-integration exit test + observability rows**
    - What: the release-blocking E2E proving the Phase-2 restriction: submit model-derived
      operations at every proposed risk level + prompt-injection-shaped inputs; assert canonical
      HEAD + canonical Markdown never change, **no synthesis ChangePlan is even created** (gate
      rejects), no approval path integrates a model-derived artifact, only deterministic capture
      commits. Plus the Phase-2 rows of the observability run-matrix (capture Tier-1, readonly,
      projection, failed@, cancelled@ — asserting ledger completeness + audit cardinality + `--from-git`
      reproduction for these classes; full matrix completes in Task 4.11).
    - Files: `apps/cli/test/e2e/phase2-non-integration.e2e.test.ts`,
      `apps/cli/test/observability-matrix.test.ts` (phase-2 rows).
    - Interfaces — **Consumes:** everything above. **Produces:** —.
    - Test: `phase2.non-integration.test` — the assertions above, byte-level canonical comparison
      before/after.
    - Acceptance: suite is in the required CI gate; a synthetic gate-bypass mutation makes it fail
      (proven once by mutation).

### Risks
- **Sandbox capability variance across macOS versions:** startup probes + `doctor` fail loud;
  contract pins the supported major (mitigation lives in 2.3, not prose).
- **PDF extraction determinism:** pin the extractor library version in the rendition identity
  (`extractorVersion` bumps with the dependency) so an upgrade is a new rendition, never silent drift.
- **Egress IPC latency for embeddings:** batch API amortizes; measured in Phase-5 scale gate before
  any optimization.

### Verification (run from repo root)
```bash
pnpm -r build && pnpm -r test
ATLAS_PROVISIONED=1 pnpm --filter @atlas/sources --filter @atlas/jobs --filter @atlas/broker test
V=$(mktemp -d)/vault && cp -R fixtures/small-valid "$V" && git -C "$V" init -q && git -C "$V" add -A && git -C "$V" commit -qm seed
node apps/cli/dist/index.js --vault "$V" db migrate
node apps/cli/dist/index.js --vault "$V" ingest fixtures/inputs/sample.md        # preview; exit 0; no sinks written
node apps/cli/dist/index.js --vault "$V" ingest fixtures/inputs/sample.md --apply --json | jq -e .runId
node apps/cli/dist/index.js --vault "$V" source list --json | jq -e '.total >= 1'
node apps/cli/dist/index.js --vault "$V" jobs list --json                        # exit 0
pnpm --filter ./apps/cli test -- --testNamePattern "phase2.non-integration"      # release gate green
```

### Rollback
- Precondition: Phase-2 PR-B merged (PR-A retained by design).
- Procedure (single branch): `git revert <phase2-PR-B-merge-sha>` → revert PR → merge. **PR-A
  (`0003_provenance` + fold) is never reverted** — so `db rebuild` keeps reproducing provenance
  projections from manifests via the retained fold + registration; there is no sub-case where
  provenance rebuild is unsupported (fixes R4-F5).
- Schema compatibility: applied `0002_jobs`/`0003_provenance` DDL stays; runner no-ops re-apply;
  persisted job rows remain readable (jobs repo code is reverted, tables idle).
- Verify supported state (survives the revert): Phase-1 Verification block passes; plus
  `node apps/cli/dist/index.js --vault "$V" db rebuild` exits 0 and `db verify` reports provenance
  projections consistent with manifests.

---

## Phase 3: Retrieval — LanceDB, embeddings, hybrid search, `query`, index ops
**Goal:** hybrid retrieval over the fixture vaults with generation-fenced consistency; `brain query`
answers with packed context; index maintenance commands exist.
**Dependencies:** Phase 2 (egress broker for embeddings).
**Estimated effort:** M

### Tasks

0. **Task 3.0 — Phase-3 contracts gate**
   - What: retrieval/index contract doc (chunking rules: semantic sections, heading hierarchy,
     title+aliases in chunk text; generation identity; reconciliation steps; staleness detection;
     RRF weights + layer precedence: exact id → slug → unique alias → fts/vector fusion) +
     `cli-contract/*` for `query`, `index status|verify|repair|rebuild`.
   - Files: `docs/specs/retrieval-index-contract.md`,
     `docs/specs/cli-contract/{query,index-status,index-verify,index-repair,index-rebuild}.schema.json`.
   - Interfaces — **Consumes:** D4, D7. **Produces:** the contract consumed by 3.1–3.6.
   - Test: `contract-lint.test` schema-presence for Phase-3 rows.
   - Acceptance: registry rows flip to implemented as tasks land.

1. **Task 3.1 — `@atlas/lancedb-index`: schema + chunker + generations**
   - What: LanceDB table schema (`SearchChunk`: chunk text, noteId, section path, `contentHash`,
     `chunkerVersion`, `embeddingModel`, `embeddingDimensions`, `generationId`, embedding vector),
     the deterministic section chunker (v1 per D4), immutable generation ids
     (`noteId`,`contentHash`,`chunkerVersion`,`embeddingModel`,`embeddingDimensions`).
   - Files: `packages/lancedb-index/src/{schema,chunker,generation}.ts`,
     `packages/lancedb-index/test/chunker.test.ts`.
   - Interfaces — **Consumes:** 1.3 (`SectionTree`), 3.0. **Produces:**
     `chunkNote(note: ParsedNote, cfg: IndexingConfig): Chunk[]` ·
     `generationId(note: ParsedNote, cfg: IndexingConfig): GenerationId`.
   - Test: `chunker.test` — deterministic chunk set for fixture notes; heading hierarchy + aliases
     present; rune-safe on Hebrew/English mixed content.
   - Acceptance: same input ⇒ byte-identical chunk set.

2. **Task 3.2 — Embedding + index write path (fenced)**
   - What: embed chunks via `models.embed` (through the egress broker; batch; D7 dimensions from
     config), write chunks tagged with their generation, then the SQLite CAS activation
     (`notes.active_generation` flips iff `contentHash` unchanged), then independently-retryable
     retirement + `indexed` marker — the spec's reconciliation pipeline, each step crash-safe.
   - Files: `packages/lancedb-index/src/{writer,activate,retire}.ts`,
     `packages/sqlite-store/src/repos/generation.ts` (adds the `activateGeneration` CAS repo method
     to sqlite-store — SQLite is the activation authority),
     `packages/lancedb-index/test/generation-fencing.test.ts`.
   - Interfaces — **Consumes:** 2.8 (`embed`), 1.4 (activation CAS lives in sqlite-store repo API:
     `Store.activateGeneration(noteId: string, gen: GenerationId, expectedContentHash: string): boolean`),
     3.1. **Produces:**
     `indexNote(note: ParsedNote, deps: IndexDeps): Promise<IndexOutcome>` ·
     `reconcileIndex(deps: IndexDeps): Promise<IndexReconcileReport>` (retirement + markers).
   - Test: `index.generation-fencing.test` — stale worker's CAS fails after a newer activation;
     orphaned/mixed generations are filtered from retrieval and later compacted; crash between every
     pipeline step converges on rerun.
   - Acceptance: fencing suite green; a permanent embedding failure surfaces as a typed outcome
     (repairable via `index repair`).

3. **Task 3.3 — Hybrid search + `retrieval` module**
   - What: id/alias/fts/vector/hybrid layers with RRF fusion per the contract; metadata filters
     (note type, sensitivity flag pass-through); context packing (dedup by note, section-aware
     assembly, evidence trust flags surfaced-but-unverified per the gating rules).
   - Files: `packages/lancedb-index/src/search.ts`, `apps/cli/src/retrieval/{layers,rrf,pack}.ts`,
     `apps/cli/test/retrieval.test.ts`.
   - Interfaces — **Consumes:** 3.1/3.2, 1.4 (identity resolution), 2.8 (`embed` for query vector).
     **Produces:**
     `retrieve(q: RetrievalQuery, deps: RetrievalDeps): Promise<RetrievalResult>`
     (`RetrievalQuery = {text: string, k?: number, filters?: RetrievalFilters}`;
     `RetrievalResult = {items: RankedItem[], layersUsed: Layer[], retrievalRunId: string}`) ·
     `packContext(r: RetrievalResult, budget: TokenBudget): ContextPack`.
   - Test: `retrieval.test` — resolver precedence (exact id beats slug beats alias; ambiguous
     normalized value ⇒ typed ambiguity error, never a silent pick); RRF fusion deterministic.
   - Acceptance: layered retrieval returns traceable per-layer provenance in `retrieval_results`.

4. **Task 3.4 — `brain query`**
   - What: the Tier-0 command: retrieve → packed context → `generateText` answer with cited note
     ids; records `retrieval_runs`/`retrieval_results`/`model_calls` via `finalizeLedgerWrite`;
     executed run emits `run.readonly` (reuses 1.9's `recordReadonlyRun`); post-run backup applies
     (it writes ledger rows).
   - Files: `apps/cli/src/commands/query.ts`, `apps/cli/test/e2e/query.e2e.test.ts`.
   - Interfaces — **Consumes:** 3.3, 2.8, 1.7, 1.9. **Produces:** —.
   - Test: `query.audit-readonly.test` — one executed query ⇒ exactly one `run.readonly` terminal
     event + complete correlated ledger rows; no canonical/worktree mutation (asserted across sinks).
   - Acceptance: `query` returns grounded answers on `source-heavy` with per-item citations.

5. **Task 3.5 — `index status|verify|repair|rebuild` + staleness + restore hook**
   - What: staleness detection (hash/chunker/model/dimensions drift), `index verify` (SQLite↔Lance
     consistency report), `index repair` (converge divergences incl. permanent-failure re-embed),
     `index rebuild` (full regeneration from Markdown), all projection-only ⇒ each executed run
     emits `run.projection`; registers the index rebuild step into the post-restore hook registry
     (completes R1-F1's restore contract: from this phase, `db restore` triggers projection +
     index rebuild).
   - Files: `apps/cli/src/commands/index.ts`, `packages/lancedb-index/src/{staleness,verify,repair}.ts`,
     `apps/cli/test/index-ops.test.ts`.
   - Interfaces — **Consumes:** 3.2, 1.4 (`registerPostRestoreRebuild`), 1.9. **Produces:**
     `indexVerify(deps: IndexDeps): Promise<IndexVerifyReport>` ·
     `indexRepair(deps: IndexDeps, report?: IndexVerifyReport): Promise<IndexRepairReport>` (both
     full signatures — fixes R2-F6).
   - Test: `index-ops.test` — delete LanceDB entirely → `index rebuild` reconstructs; `verify`
     detects an injected mismatch; `repair` converges it; each op appended exactly one
     `run.projection`.
   - Acceptance: post-restore hook proven: `db restore` on a Phase-3 host ends with a consistent
     rebuilt index (extends the 1.7 round-trip test).

6. **Task 3.6 — Retrieval eval harness (labeled fixtures)**
   - What: the versioned labeled fixture set (queries → expected canonical notes) + the eval runner
     computing recall@K and MRR; wired as an opt-in suite now, threshold-gated in Phase 5 per
     `acceptance-thresholds.md`.
   - Files: `fixtures/retrieval-eval/{queries.json,labels.json}`, `tools/retrieval-eval.ts`,
     `apps/cli/test/retrieval-eval.test.ts` (opt-in via `ATLAS_LIVE_GEMINI=1`).
   - Interfaces — **Consumes:** 3.3. **Produces:**
     `runRetrievalEval(deps): Promise<{recallAt10: number, mrr: number, perQuery: EvalRow[]}>`.
   - Test: the harness itself is tested with a stubbed retriever (metric math verified against
     hand-computed values).
   - Acceptance: eval runs end-to-end on `source-heavy` + the labeled set under live embeddings.

### Risks
- **Embedding cost/latency in CI:** offline suites use recorded vectors (deterministic doubles);
  live embedding only in nightly + Phase-5 gate.
- **LanceDB FTS maturity:** if FTS quality blocks, hybrid degrades to vector+id/alias with RRF —
  the layer interface isolates the change to `search.ts`; decision recorded in the Phase-3 contract.

### Verification (run from repo root)
```bash
pnpm -r build && pnpm -r test
V=$(mktemp -d)/vault && cp -R fixtures/source-heavy "$V" && git -C "$V" init -q && git -C "$V" add -A && git -C "$V" commit -qm seed
node apps/cli/dist/index.js --vault "$V" db migrate && node apps/cli/dist/index.js --vault "$V" db rebuild
ATLAS_LIVE_GEMINI=1 node apps/cli/dist/index.js --vault "$V" index rebuild        # exit 0; run.projection appended
ATLAS_LIVE_GEMINI=1 node apps/cli/dist/index.js --vault "$V" query "what sources discuss meridian" --json | jq -e '.items | length > 0'
node apps/cli/dist/index.js --vault "$V" index verify --json | jq -e '.consistent == true'
```

### Rollback
- Precondition: Phase-3 PR merged.
- Procedure (single branch): `git revert <phase3-PR-merge-sha>` → revert PR → merge.
- Schema compatibility: Phase 3 registers **no SQLite migration** (activation state uses `notes`
  columns from `0001_core`); LanceDB directory is disposable derived state — after revert, delete
  `lancedb.dir` wholesale (it is a projection; nothing references it).
- Verify supported state (survives the revert): Phase-2 Verification block passes; `db rebuild`
  exits 0; `rm -rf <lancedb.dir>` leaves `inspect`/`doctor` green (index checks report
  not-configured, not failed — asserted by the doctor fixture).

---

## Phase 4: Workflows — ChangePlan pipeline, review gate, rollback, trust, claims, purge
**Goal:** the full mutation loop: `enrich`/`reconcile`/`maintain`/`validate` with risk-tiered
auto-commit vs review; `git approve|refresh|reject|rollback|verify`; trust lifecycle; claims +
evidence with re-verification; `purge`. Lands as **PR-A (Task 4.1, retained)** then PR-B.
**Dependencies:** Phase 3.
**Estimated effort:** L

### Tasks

0. **Task 4.0 — Phase-4 contracts gate**
   - What: `acceptance-thresholds.md` **§workflow** (Tier-2 thresholds sourced from a **single
     machine-readable policy module in `@atlas/contracts`** — the doc, config defaults, and
     `effectiveRisk` all read the **same** constants; runtime config **cannot loosen** these binding
     V1 safety limits (overrides validated against immutable bounds, rejected otherwise), so a value
     beyond confidence 0.8 / 50 lines / 3 sections can never auto-integrate while a comparison test
     stays green; doctor/verify check inventories consolidated; per-command failure exit codes), the
     workflow/risk
     contract (per-type mutation policy table → `policies` inputs; tier definitions; CAS/refresh
     semantics), and `cli-contract/*` for `enrich`, `reconcile`, `maintain`, `validate`,
     `git review|refresh|approve|reject|rollback|verify`, `purge`,
     `source trust promote|revoke`; plus a **revision of `db-rebuild.schema.json`** for the new
     `--from-git` flag (flag compatibility, report/gap output shape, exit codes, generated acceptance
     fixtures) so the retained harness validates the flag Task 4.11 adds.
   - Files: `docs/specs/acceptance-thresholds.md` (§workflow), `docs/specs/workflow-risk-contract.md`,
     `docs/specs/cli-contract/{enrich,reconcile,maintain,validate,git-review,git-refresh,git-approve,git-reject,git-rollback,git-verify,purge,source-trust-promote,source-trust-revoke,db-rebuild}.schema.json` (the last a revision adding `--from-git`).
   - Interfaces — **Consumes:** 0.1, 0.3. **Produces:** contracts consumed by 4.3–4.11.
   - Test: `contract-lint.test` schema-presence; threshold values asserted equal to §2.5 constants
     by a literal-comparison test (no drift between plan/spec/contract).
   - Acceptance: all Phase-4 registry rows have schemas before any Phase-4 feature code merges.

1. **Task 4.1 — PR-A (retained): `0004_claims` migration + claims fold**
   - What: `claims` + `claim_evidence` DDL per dictionary (non-null `evidence_id` hash with
     sentinels, UNIQUE index, `verification` CHECK enum, composite rendition FK) + the claims-block
     Markdown fold into rebuild (canonical `claims:` block parser → rows), registered retained.
   - Files: `packages/sqlite-store/migrations/0004_claims.ts`,
     `packages/sqlite-store/src/claims/fold.ts`, `packages/sqlite-store/test/claims-fold.test.ts`.
   - Interfaces — **Consumes:** 0.2, 1.4. **Produces:** claims repos
     (`upsertClaim`, `attachEvidence` (idempotent by `evidence_id`), `setEvidenceVerification`,
     `evidenceForRendition(contentId: ContentId): EvidenceRow[]`); fold consumed by rebuild.
   - Test: `claims-fold.test` — `conflicting-claims` fixture rebuilds to expected rows; evidence
     idempotency under sentinel encoding (absent locator/quoteHash never bypasses uniqueness).
   - Acceptance: with only PR-A merged, rebuild of a claims-bearing vault is lossless.

2. **Task 4.2 — `markdown` patch generator**
   - What: section/AST-level patch generation + application: per-op patch construction with
     precondition tokens (section selector + expected content hash), unknown frontmatter +
     formatting preservation, stale-context safe failure, human-readable diff summaries.
   - Files: `apps/cli/src/markdown/{patch,apply,diff-summary}.ts`, `apps/cli/test/patch.test.ts`.
   - Interfaces — **Consumes:** 1.3 (`SectionTree`), 2.0 op schemas. **Produces:**
     `generatePatch(note: ParsedNote, op: ChangePlanOperation): Patch` ·
     `applyPatch(raw: string, patch: Patch): {ok: true, next: string} | {ok: false, error: StaleContextError}` ·
     `Patch = {noteId: string, ops: PatchOp[], preconditions: Precondition[], summary: string}`.
   - Test: `patch.test` — property-style round-trips on fixture notes (apply → reparse → semantic
     equality); stale hash ⇒ typed failure, file untouched; unknown frontmatter keys survive.
   - Acceptance: whole-file rewrites impossible by construction (API takes ops, not content).

3. **Task 4.3 — `policies`: effective risk + effective sensitivity (single producers)**
   - What: extend the 2.8 gate module (same owner): `effectiveRisk` derived deterministically from
     operation type × target note type × scope × config (the model's `proposedRisk` never gates);
     `effectiveSensitivity` computed-on-read (D2) as most-restrictive over declared + input chain;
     per-type mutation policy table (immutability of sources/decisions, append-only rules);
     Tier-2 threshold values read from the single machine-readable policy module (§2.5 constants;
     runtime config cannot loosen them — overrides validated against immutable bounds).
   - Files: `apps/cli/src/policies/{risk,sensitivity,mutation-policy}.ts`,
     `apps/cli/test/policies.test.ts`.
   - Interfaces — **Consumes:** 4.0 contract, 2.0 ops, 1.3. **Produces:**
     `effectiveRisk(plan: ChangePlan, ctx: PolicyContext): RiskTier` (`RiskTier = 0|1|2|3`) ·
     `effectiveSensitivity(noteId: string, deps: SensitivityDeps): Sensitivity` ·
     `mutationPolicyFor(type: NoteType): MutationPolicy`.
   - Test: `policies.test` — table-driven: every op×type cell yields the contract's tier; source
     mutation ⇒ policy violation; sensitivity chain (source→claim→note) takes the max; `proposedRisk`
     is demonstrably ignored for gating; and the Tier-2 threshold values used by `effectiveRisk` are
     asserted identical to the §2.5 policy-module constants (no config-loosening path).
   - Acceptance: exactly one call site computes risk (grep-guard test: no other module references
     `proposedRisk` for control flow).

4. **Task 4.4 — `validation` module**
   - What: deterministic checks: schema validation per op, path policy, identity-namespace
     validation (alias/slug collisions pre-commit), dangling `sourceId`/`noteId`/`claimId`,
     duplicate evidence, provenance requirements (`require_sources_for_synthesis`), Markdown
     accessibility checks (single top-level heading, no skipped levels, descriptive links, list
     structure, alt rules), reserved-task-op rejection (fail-closed), evidence-verification gating
     inputs (non-`valid` evidence cannot support Tier-2).
   - Files: `apps/cli/src/validation/{index,identity,provenance,accessibility}.ts`,
     `apps/cli/test/validation.test.ts`.
   - Interfaces — **Consumes:** 2.0 ops, 4.1 repos, 4.3, 1.3. **Produces:**
     `validatePlan(plan: ChangePlan, ctx: ValidationContext): ValidationReport`
     (`ValidationReport = {ok: boolean, findings: ValidationFinding[], gates: {tier2Eligible: boolean}}`).
   - Test: `validation.test` — each check has a triggering fixture + a passing fixture; a
     `CreateTask`-bearing plan is rejected with the stable code `reserved-operation`.
   - Acceptance: `brain validate` (Task 4.11) is a thin wrapper over this owner.

5. **Task 4.5 — ChangePlan pipeline: synthesis stages + tiered integration + refresh**
   - What: extend the 2.5 engine with synthesis stages: plan (LLM `generateObject<ChangePlan>`
     via egress, **retrieval-first enforced in orchestration**: the plan stage takes a
     `RetrievalResult` handle it must present) → validate (4.4) → patch (4.2) → worktree apply →
     agent commit (manifest per 1.5) → tier branch: Tier-1/2 CAS auto-integrate via
     `advanceProtectedRef` with rebase-regenerate-revalidate on CAS miss; Tier-3 stop at
     `review-pending` (exit `6`, success-shaped `review_pending` + runId). `git refresh`
     implementation (new commit + manifest, supersession record, back to review-pending,
     key-accepting identity per the spec). The `GeneratedArtifactGuard` wraps every persisted
     artifact (plans, patches, diffs, worktree contents, manifests, commit messages).
   - Files: `apps/cli/src/workflows/{synthesis,integrate,refresh}.ts`,
     `apps/cli/test/workflows-synthesis.test.ts`.
   - Interfaces — **Consumes:** 2.5 engine, 2.8 models+gate, 3.3 retrieve, 4.2–4.4, 1.6 broker,
     1.7. **Produces:**
     `runSynthesisWorkflow(kind: "enrich"|"reconcile"|"maintain", input: WorkflowInput, mode: "preview"|"apply"): Promise<WorkflowOutcome>` ·
     `refreshRun(runId: string, deps): Promise<{newCommit: string, superseded: string}>`.
   - Test: `retrieval.order-invariant.test` — inject retrieval failure/empty: no ChangePlan, patch,
     worktree mutation, or commit exists for a synthesis mutation (checkpoint + event-sequence
     inspection); `concurrent-integration.test` — canonical moved between validation and commit ⇒
     CAS fails, regenerate+revalidate, no lost update/duplicate commit; Tier-3 apply ⇒ durable
     plan/branch/worktree/commit + exit `6`.
   - Acceptance: preview mode provably free of **canonical/vault/worktree/git** side effects across those sinks
     (same assertion harness as 2.6); the enumerated model-call/transmission-audit writes a
     model-backed preview performs are permitted by the single preview-side-effect contract and
     asserted **distinct from vault state** (no `run.*` audit-ref event, no vault mutation).

6. **Task 4.6 — Claims & evidence operations**
   - What: `CreateClaim`/`AttachEvidence`/`UpdateEvidenceVerification` op execution: canonical
     `claims:` block serialization in the owning note (Markdown is SSOT for `verification`),
     `sourceId` → active `renditionId` resolution at the command boundary, persisted pinned
     components only; `CreateRelationship` typed wikilinks → `note_links`.
   - Files: `apps/cli/src/workflows/ops/{claims,evidence,relationship}.ts`,
     `apps/cli/test/evidence.test.ts`.
   - Interfaces — **Consumes:** 4.1 repos, 4.2, 2.1 (`resolveSourceHandle`), 4.5 pipeline.
     **Produces:** op executors registered with the pipeline
     (`executeOp(op: ChangePlanOperation, ctx: OpContext): Promise<OpOutcome>` per op module).
   - Test: `evidence.test` — evidence persists rendition components (never the alias); a bare
     SQLite verification write is impossible through any public API (only the ChangePlan path);
     rebuild reproduces verification state from Markdown.
   - Acceptance: dangling/duplicate evidence rejected per 4.4.

7. **Task 4.7 — Rendition-bump re-verification (staleness protocol)**
   - What: on `setActiveRendition` re-point: deterministic affected-evidence enumeration, one
     re-verification **job per owning note** (idempotency key `(contentId, newRenditionId,
     owningNoteId)`), deterministic quoteHash re-anchoring with the three outcomes (exact ⇒ `valid`
     re-pinned; ambiguous/moved ⇒ `pending` + Tier-3 escalation; not-found ⇒ `failed`), transitional
     `stale` marking, all applied as validated `UpdateEvidenceVerification` ChangePlans per note.
   - Files: `apps/cli/src/workflows/reverify.ts`, `apps/cli/test/evidence-reverification.test.ts`.
   - Interfaces — **Consumes:** 2.7 (`enqueue`), 4.6, 4.5. **Produces:**
     `enqueueReverification(tx: LedgerTx, bump: RenditionBump): JobId[]` (one per owning note).
   - Test: `evidence.reverification.test` — a bump spanning N notes enqueues N non-colliding jobs;
     each of the three outcomes; the Phase-2-deferred assertion lands here: **extractor upgrade
     marks dependent evidence `stale`** (fixes R4-F4); gating: `stale`/`pending`/`failed` evidence
     blocks Tier-2 auto-commit + trusted grounding.
   - Acceptance: no affected note left `stale` after its job completes; retry idempotent.

8. **Task 4.8 — Trust lifecycle + taint**
   - What: `source trust promote|revoke` (privileged; challenge/authorization; bound to
     `sourceId`+`rawContentHash`; trust ledger ref advanced by broker **through `finalizeLedgerWrite` (§2.8) with a trust intent** —
     ref advancement is idempotent by operation id, the intent defines which store is authoritative
     at each checkpoint, and `reconcileInterruptedRuns` converges both crash directions
     (ref-advanced/ledger-failed and ledger-first/ref-failed); immutable audit record),
     transitive taint (claim/context/synthesis derived from untrusted stays untrusted; mixed
     evidence ⇒ untrusted; no laundering), Tier-2 block for untrusted-derived mutations, revocation
     semantics: pre-integration run ⇒ `failed@<checkpoint>` reason `trust-revoked`; integrated run ⇒
     spawn Tier-3 **remediation run** referencing source + affected run.
   - Files: `apps/cli/src/trust/{state,taint,revoke}.ts`,
     `apps/cli/src/commands/source-trust.ts`, `apps/cli/test/trust-lifecycle.test.ts`.
   - Interfaces — **Consumes:** 1.6 (challenge + ref advance), 1.7 (`finalizeLedgerWrite`), 4.5, 2.7. **Produces:**
     `trustStateFor(contentId: ContentId): TrustState` · `taintOf(inputs: EvidenceRef[]): "trusted"|"untrusted"` ·
     `spawnRemediationRun(revokedSource: ContentId, affectedRun: string): Promise<RunId>`.
   - Test: `trust.lifecycle.test` — the spec's full matrix: forged/agent promotion refused, hash
     change invalidates authorization, replay rejected, multi-hop taint, revocation both branches, audit records present; crash between trust-ref CAS and ledger
     finalization converges on restart in both directions.
   - Acceptance: an untrusted-ingest-driven Tier-2 mutation is forced to review until promotion.

9. **Task 4.9 — Full `git` surface: `review|approve|reject|rollback|verify`**
   - What: `review` (diff + manifest, read-only), `approve` (challenge-bound; FF-only CAS of the
     exact signed commit; stale base ⇒ stable `refresh-required` exit `6`; idempotent re-approve),
     `reject` (terminal + cleanup), `rollback` (privileged; deterministic revert-commit derivation
     in the challenge; **operation-class semantics**: capture-only run ⇒ tombstone/deactivate
     rendition+capture, retain blob; downstream dependents ⇒ `has-dependents` refusal listing them,
     compensating-ChangePlan path; self-contained ⇒ direct revert; mandatory reconciliation +
     single `run.rolled_back`), `git verify` (manifest↔index convergent repair + anchor validation).
   - Files: `apps/cli/src/commands/git-{review,approve,reject,rollback,verify}.ts`,
     `packages/broker/src/ops/{approve,rollback}.ts`, `apps/cli/test/e2e/review-lifecycle.e2e.test.ts`.
   - Interfaces — **Consumes:** 1.6, 4.5, 4.1 (dependency enumeration via claims/evidence repos),
     3.5 (reconciliation). **Produces:** — (terminal command surface).
   - Test: `approval-boundary.adversarial.test` (full): signature copied between plans/commits,
     commit mutation after signing, `--yes`-only attempt, stale-base refresh-required (never
     rebases), TOCTOU canonical move pre-merge — each refused; `rollback.dependency-checks.test` —
     three operation classes + dependents refusal + tombstone semantics; non-interactive round trip
     for approve/rollback via `tools/test-signer.ts` asserting drift rejection (canonical moved,
     nonce expired/replayed, wrong signer).
   - Acceptance: review lifecycle E2E green: Tier-3 enrich → review → approve → reindex → finalize;
     then rollback with reconciliation.

10. **Task 4.10 — `purge` + audit-ref reconciliation + retention execution**
    - What: `purge` per its normative command contract (selector → printed erasure inventory →
      challenge bound to inventory digest → `vault-maintenance` lock → per-storage-class erasure
      with resumable per-class checkpoints → tombstones → projection+index rebuild → post-purge
      verification across **every** storage class incl. no re-linkable audit identifier);
      audit-ref reconciliation (ordinary erasure = ledger-mapping deletion renders opaque IDs
      unlinkable; legally-required removal = broker signed-tombstone replacement + external
      checkpoint per 0.3); git-history rewrite protocol where required — via a **dedicated broker-authorized canonical
      rewrite operation** (`broker.rewriteCanonicalHistory`, distinct from the FF-only advance) bound
      to the complete erasure-inventory digest, old+new graph hashes, authorization nonce, and
      external checkpoint, followed by post-rewrite reachability scans across every ref, reflog,
      worktree, backup, and object store (a raw non-broker rewrite is never permitted); **retention/
      compaction execution** — the scheduled-work owner (R1-F13): retention jobs that **only schedule
      and invoke each storage module's own idempotent maintenance API** (`pruneBackups` (1.7),
      `expireQuarantine` (2.2), `rotateLogs` (1.8), `compactRetiredGenerations` (3.2)) with the
      resolved shared config — never reimplementing policy — enqueued via 2.7 and run by `jobs run`/
      workflow drains, with tests proving scheduled and inline triggers produce identical results.
    - Files: `apps/cli/src/commands/purge.ts`, `apps/cli/src/purge/{inventory,erase,verify}.ts`,
      `packages/broker/src/ops/audit-tombstone.ts`, `apps/cli/src/retention/jobs.ts`,
      `apps/cli/test/e2e/purge.e2e.test.ts`.
    - Interfaces — **Consumes:** 0.4 matrix, 1.2 (resolved shared config), 1.6, 1.7, 2.2 (quarantine), 3.5, 2.7. **Produces:**
      `computeErasureInventory(sel: PurgeSelector): Promise<ErasureInventory>` ·
      `registerRetentionJobs(deps): void`.
    - Test: `purge.e2e.test` (privileged, fixture vault): seed uniquely-identifiable content in
      every storage class; unauthorized/agent caller denied + replay-protected; full inventory;
      interruption + resume (never restarting a completed class); backup re-minimization/expiry;
      post-purge cross-class search proves no prohibited copy; `retention.jobs.test` — each matrix
      row's trigger fires its job.
    - Acceptance: Phase-4 exit criterion — purge E2E green on fixtures (re-exercised on the Phase-5
      copy).

11. **Task 4.11 — Workflow commands + `validate` + generated failpoints + full observability matrix**
    - What: `enrich <note>`, `reconcile`, `maintain` (orphans/broken-links/stale → proposals;
      destructive proposals always Tier-3), `validate` (4.4 wrapper) — uniform preview/apply per
      §2.5; the **failpoint suite generated from `recovery-state-machine.md`'s `stateTable`**
      (crash before/after every external git effect + checkpoint write, incl. integration-hash
      idempotency anchor both sides, reconciliation transitions, failed/cancelled artifact
      retention); the **complete observability run-matrix** (every run class × ledger completeness ×
      audit cardinality × `--from-git` reproduction incl. read-only/projection/failed/cancelled);
      `db rebuild --from-git` fold rules implementation (supersession, revert records, explicit
      gaps).
    - Files: `apps/cli/src/commands/{enrich,reconcile,maintain,validate}.ts`,
      `packages/sqlite-store/src/rebuild-from-git.ts`, `tools/gen-failpoints.ts`,
      `apps/cli/test/{crash-recovery.failpoints,observability-matrix}.test.ts`.
    - Interfaces — **Consumes:** 4.5, 4.4, 1.6, 0.1 `stateTable`. **Produces:**
      `rebuildFromGit(store: Store, repo: Repo): Promise<FromGitReport>` (gaps surfaced, never
      dropped).
    - Test: `crash-recovery.failpoints.test` (generated; asserts convergence, no duplicate chunks/
      lost updates/false-indexed/orphaned worktrees/double-commits/half-integrated refs);
      `observability.run-matrix.test` (full); `audit-dr.from-git.test` — delete SQLite + backup,
      rebuild mutating rows best-effort, tampered/partial history surfaces gaps.
    - Acceptance: Phase-4 exit — every suite in the safety-invariant CI gate green.

### Risks
- **Failpoint matrix runtime:** generated tests are many; shard by state in CI and keep each
  deterministic (controlled clocks, no sleeps).
- **Rollback dependency enumeration completeness:** derived from FK graph in the dictionary — the
  `db verify` invariant queries double-check orphan absence after every rollback test.
- **LLM plan quality:** irrelevant to safety (validation + tiers gate); quality iterated via
  prompt versions recorded per call.

### Verification (run from repo root)
```bash
pnpm -r build && pnpm -r test
V=$(mktemp -d)/vault && cp -R fixtures/source-heavy "$V" && git -C "$V" init -q && git -C "$V" add -A && git -C "$V" commit -qm seed
node apps/cli/dist/index.js --vault "$V" db migrate && node apps/cli/dist/index.js --vault "$V" db rebuild
node apps/cli/dist/index.js --vault "$V" enrich project-meridian                 # preview; exit 0 or 6; no sinks written
set +e
OUT=$(ATLAS_LIVE_GEMINI=1 node apps/cli/dist/index.js --vault "$V" enrich project-meridian --apply --json)
RC=$?
set -e
test "$RC" -eq 6                                                                # Tier-3 ⇒ review-pending
RUN_ID=$(printf '%s' "$OUT" | jq -r .runId)
node apps/cli/dist/index.js --vault "$V" git review "$RUN_ID"                    # exit 0
node apps/cli/dist/index.js --vault "$V" git approve "$RUN_ID" --export-challenge > /tmp/ch.json
node tools/test-signer.ts --key atlas-test-approver < /tmp/ch.json > /tmp/auth.json
node apps/cli/dist/index.js --vault "$V" git approve "$RUN_ID" --authorization /tmp/auth.json   # exit 0; FF integrate
node apps/cli/dist/index.js --vault "$V" git rollback "$RUN_ID" --export-challenge > /tmp/ch2.json
node tools/test-signer.ts --key atlas-test-approver < /tmp/ch2.json > /tmp/auth2.json
node apps/cli/dist/index.js --vault "$V" git rollback "$RUN_ID" --authorization /tmp/auth2.json # exit 0; revert + reconcile
pnpm --filter ./apps/cli test -- --testNamePattern "crash-recovery.failpoints|observability"
```
(The `set +e` wrapper captures the deliberate exit-6 without tripping `set -e` CI shells — fixes R3-F11.)

### Rollback
- Precondition: Phase-4 PR-B merged (PR-A retained).
- Procedure (single branch): protect data first — `node apps/cli/dist/index.js db backup`; then
  `git revert <phase4-PR-B-merge-sha>` → revert PR → merge. Canonical **vault** content changes are
  never reverted by code rollback; an unwanted integrated vault change uses the broker `git
  rollback` path **before** reverting the code that provides it (fixes R3-F10 ordering).
- Schema compatibility: `0004_claims` (PR-A) stays applied + folded by rebuild; feature tables none.
- Verify supported state (survives the revert — Phases 1–3 commands only): Phase-3 Verification
  block passes; `db rebuild` + `index rebuild` + `doctor` exit 0; `ledger.dr-roundtrip` +
  `audit.cross-store-ordering` suites green. (Never `git verify`/failpoints — the revert removes
  them; fixes R3-F10.)

---

## Phase 5: Graduation to the real vault (copy)
**Goal:** the copied `main-vault` passes fail-closed scanning, read-only audit, and the review-gated
bootstrap migration; agent-branch-only operation verified; eval + scale gates met.
**Dependencies:** Phase 4.
**Estimated effort:** M

### Tasks

0. **Task 5.0 — Phase-5 contracts gate**
   - What: `bootstrap-migration.md` (ID-derivation + collision rules, `type`-inference precedence,
     link-rewrite/preservation algorithm, per-note checkpoints, review artifacts, rollback,
     per-quarantine-category operator flows, executable migration fixtures);
     `acceptance-thresholds.md` **§retrieval + §scale** (recall@10 ≥ 0.85, MRR ≥ 0.7;
     representative + maximum vault profiles; latency/throughput/memory/disk/recovery thresholds);
     `cli-contract/*` + registry `implemented` flips for `graduation scan|audit|migrate`,
     `quarantine inspect|resolve` (rows seeded in Task 0.0; spec's CLI-surface prose already
     regenerated from the registry by `gen-cli-contract.ts`, so no drift).
   - Files: `docs/specs/bootstrap-migration.md`, `docs/specs/acceptance-thresholds.md` (§retrieval,
     §scale), `docs/specs/cli-contract/{graduation-scan,graduation-audit,graduation-migrate,quarantine-inspect,quarantine-resolve}.schema.json`.
   - Interfaces — **Consumes:** 0.0 registry. **Produces:** contracts consumed by 5.1–5.4.
   - Test: `contract-lint.test` schema-presence for Phase-5 rows.
   - Acceptance: migration fixtures in the contract are executable (consumed by 5.3's suite).

1. **Task 5.1 — `graduation scan` (fail-closed full-vault scan on the copy)**
   - What: run a **read-only history scan on the source first**; only then create the disposable copy in a
     **unique, encrypted, mode-0700, non-backed-up staging dir** (atomically renamed to
     `.scratch/atlas-graduation-copy` only after clone verification), and re-scan working tree **and
     git history** before any rebuild/index/migration/model call; a blocking scan **securely deletes
     all copied objects + temp packs** (cleanup guaranteed on every failure path); findings block graduation
     and route to reviewed-remediation / encrypted-quarantine (accounting for history copies).
   - Files: `apps/cli/src/commands/graduation-scan.ts`, `apps/cli/src/graduation/copy.ts`,
     `apps/cli/test/e2e/graduation-scan.e2e.test.ts`.
   - Interfaces — **Consumes:** 2.2, 1.8. **Produces:**
     `createGraduationCopy(src: string, dst: string): Promise<{head: string}>` ·
     `scanFullVault(dir: string, opts: {includeHistory: true}): Promise<VaultScanReport>`.
   - Test: `graduation-scan.e2e.test` — a seeded secret in an **old commit** (not the working tree)
     is found and blocks with exit `3`; clean copy passes; a blocked scan leaves no copied objects behind
     (staging dir removed); an interrupted run followed by retry is safe — `--replace` performs
     destructive recreation, and a stale partial copy is never silently resumed.
   - Acceptance: no downstream graduation step runs while findings are unresolved (enforced by a
     persisted scan-state gate the later commands check).

2. **Task 5.2 — `graduation audit` (read-only bootstrap audit)**
   - What: inventory legacy notes missing `id`/`type`/`schema_version`, ambiguous aliases,
     duplicate identities, incompatible links — **zero mutation**.
   - Files: `apps/cli/src/commands/graduation-audit.ts`, `apps/cli/test/bootstrap-audit.test.ts`.
   - Interfaces — **Consumes:** 1.3, 5.1 gate. **Produces:**
     `bootstrapAudit(dir: string): Promise<BootstrapAuditReport>` (per-category note lists).
   - Test: `bootstrap.audit-readonly.test` — key assertions: report covers **every** category
     (missing-id/type/schema_version, ambiguous alias, duplicate identity, incompatible link) on a
     legacy fixture, **and the vault tree hash is byte-identical before/after** (fixes R1-F17's
     missing named test).
   - Acceptance: report categories map 1:1 to `bootstrap-migration.md` quarantine categories.

3. **Task 5.3 — `graduation migrate` + `quarantine inspect|resolve`**
   - What: the deterministic, review-gated bootstrap migration per the contract: assign stable ids,
     infer `type` by the contract's precedence, initialize `schema_version: 1`, preserve/rewrite
     links, quarantine identity conflicts; per-note checkpoints (idempotent, resumable), review
     artifacts, rollback via per-note checkpoints (`graduation migrate --rollback`);
     `quarantine inspect|resolve` operator commands;
     graduation criteria enforcement (zero unresolved quarantines; projections rebuild clean).
     Runs under `vault-maintenance` lock, Tier-3 review-gated (broker-authorized apply).
   - Files: `apps/cli/src/commands/{graduation-migrate,quarantine}.ts`,
     `apps/cli/src/graduation/{migrate,quarantine}.ts`, `apps/cli/test/e2e/bootstrap-migration.e2e.test.ts`.
   - Interfaces — **Consumes:** 5.0 contract, 5.2, 4.5 (review gate), 1.6. **Produces:**
     `runBootstrapMigration(dir: string, mode: "preview"|"apply"): Promise<MigrationReport>` ·
     `resolveQuarantine(category: QuarantineCategory, noteId: string, resolution: Resolution): Promise<void>`.
   - Test: `bootstrap.migration.test` — the contract's executable fixtures: interrupted + rerun
     idempotent; unsupported/future `schema_version` refused; unknown frontmatter + provenance
     preserved; rebuild-after-migration clean; rollback of a failed bootstrap via checkpoints.
   - Acceptance: graduation criteria queryable (`graduation audit` post-migrate reports zero
     unresolved).

4. **Task 5.4 — Graduation E2E: real-copy operation, purge, eval, scale**
   - What: on the migrated copy — agent-branch-only workflow runs (Tier-2 auto-commit + Tier-3
     review round via test signer), git-rollback verification, full derived-state rebuild (`db
     rebuild` + `index rebuild` byte-consistent projections), the purge E2E re-exercised with
     uniquely-identifiable classified content in **every** storage class, the retrieval eval vs
     §retrieval thresholds, and the §scale benchmark profiles (ingest/query/index/reconcile/
     migrate/rebuild) with the stable regression subset wired into CI.
   - Files: `apps/cli/test/e2e/graduation.e2e.test.ts`, `tools/scale-bench.ts`,
     `.github/workflows/ci.yml` (nightly job: live eval + bench regression subset).
   - Interfaces — **Consumes:** everything. **Produces:** — (terminal phase).
   - Test: `graduation.e2e.test` — the sequence above end-to-end; eval asserts recall@10 ≥ 0.85 ∧
     MRR ≥ 0.7; bench asserts §scale thresholds.
   - Acceptance: **V1 acceptance criteria** (spec §Acceptance) all demonstrably green; the live
     `main-vault` was never touched (asserted: its HEAD unchanged across the whole phase).

### Risks
- **Real-vault content surprises** (encodings, giant files, weird frontmatter): the copy is
  disposable; scan/audit run first by construction; quarantine absorbs conflicts.
- **Eval thresholds miss:** thresholds gate *graduation*, not earlier merges — iterate chunker/
  RRF weights (config-owned) on the copy without touching phase code.

### Verification (run from repo root; operates ONLY on the copy)
```bash
pnpm -r build && pnpm -r test
MAIN_VAULT="$HOME/Code/Vaults/main-vault"; BASELINE=$(mktemp -d)/main-vault-baseline
git -C "$MAIN_VAULT" rev-parse HEAD > "$BASELINE.head"
git -C "$MAIN_VAULT" status --porcelain --untracked-files=all > "$BASELINE.status"
git -C "$MAIN_VAULT" ls-files -s | git hash-object --stdin > "$BASELINE.tree"  # deterministic content baseline, persisted OUTSIDE the vault
chmod -R a-w "$MAIN_VAULT" 2>/dev/null || true   # source read-only during graduation where possible
node apps/cli/dist/index.js graduation scan --source "$MAIN_VAULT" --copy .scratch/atlas-graduation-copy   # exit 0 (or 3 with findings)
node apps/cli/dist/index.js --vault .scratch/atlas-graduation-copy graduation audit --json | jq -e '.unresolved == 0 or .categories'
node apps/cli/dist/index.js --vault .scratch/atlas-graduation-copy graduation migrate            # preview
node apps/cli/dist/index.js --vault .scratch/atlas-graduation-copy graduation migrate --apply --export-challenge > /tmp/ch.json
node tools/test-signer.ts --key atlas-test-approver < /tmp/ch.json > /tmp/auth.json
node apps/cli/dist/index.js --vault .scratch/atlas-graduation-copy graduation migrate --apply --authorization /tmp/auth.json
ATLAS_LIVE_GEMINI=1 node tools/retrieval-eval.ts --vault .scratch/atlas-graduation-copy          # thresholds met
test "$(git -C "$MAIN_VAULT" rev-parse HEAD)" = "$(cat "$BASELINE.head")" \
  && diff <(git -C "$MAIN_VAULT" status --porcelain --untracked-files=all) "$BASELINE.status" \
  && test "$(git -C "$MAIN_VAULT" ls-files -s | git hash-object --stdin)" = "$(cat "$BASELINE.tree")"   # live vault byte-untouched incl. untracked/working-tree
```

### Rollback
- Precondition: any Phase-5 failure at any step.
- Procedure (single branch — the copy is disposable): 1) if a bootstrap apply is mid-flight, roll it
  back via its per-note checkpoints:
  `node apps/cli/dist/index.js --vault .scratch/atlas-graduation-copy graduation migrate --rollback`;
  2) discard the copy wholesale: `rm -rf .scratch/atlas-graduation-copy` (no dirty-worktree
  reconciliation exists — agent branches die with the copy; fixes R2-F10); 3) if Phase-5 code must
  come out: `git revert <phase5-PR-merge-sha>` → revert PR → merge.
- Schema compatibility: Phase 5 introduces **no SQLite DDL** (reuses `0001`–`0004`); nothing to
  downgrade.
- Verify supported state: `git -C "$MAIN_VAULT" rev-parse HEAD` + porcelain status + tree hash equal the persisted `$BASELINE.*` files (not an in-memory var — survives a fresh shell after a crash);
  `test ! -e .scratch/atlas-graduation-copy`; Phase-4 Verification block still passes on fixtures.

---

## 4. Integration Points

- **`@atlas/contracts` (process seam):** CLI (`domain` re-export), `sqlite-store`, `git`, and both
  broker daemons produce/verify identical stable IDs, `RunManifestSchema`,
  `ChangePlanEnvelopeSchema`, and canonical serialization from Phase 1; the per-operation
  `ChangePlanSchema` joins at the Phase-2 gate. **Byte-identity across the seam is the contract**
  (`contracts.operations.test` runs the serialization in two processes).
- **Acyclic broker↔ledger seam (§2.8):** `@atlas/broker` primitives never import
  `@atlas/sqlite-store` (`broker.no-ledger-dep.test`); `finalizeLedgerWrite` is the sole
  cross-store orchestrator and calls broker primitives. Every ledger writer — readonly/projection
  runs (1.9), capture (2.6), egress transmissions (2.8), query (3.4), synthesis/integration (4.5),
  trust (4.8), rollback/purge (4.9/4.10), re-verification jobs (4.7) — funnels through it, which is
  what threads the fail-closed backup watermark everywhere (R2-F5).
- **`sqlite-store` ↔ `jobs`:** `jobs` authors + registers + owns `0002_jobs`; `sqlite-store` owns
  the connection + runner + all other tables and consumes jobs read-only via `readSnapshot`.
- **Tier-1 capture seam:** Phase-2 capture lands canonical commits **only** through
  `broker.integrateSourceCapture` (delivered Phase 1); no agent advances canonical directly.
- **Scanner-before-persistence seam:** `PrePersistenceGuard` is a required constructor dependency
  of `normalize` and `captureSource`; `GeneratedArtifactGuard` wraps every model-derived artifact
  sink from the first model call (2.8) through patches/commits (4.5).
- **SQLite ↔ LanceDB:** SQLite is the sole activation authority (generation CAS); retrieval filters
  by active generation; retirement + markers are independently retryable convergence steps.
- **Integration-broker seam:** agents hold object-write + `refs/agent/*` + protected-ref **read**;
  `atlas-broker` is the sole protected-ref **mutator**, re-verifying signature + CAS + ancestry +
  audit event per request.
- **Egress-broker seam:** agents have no provider credential and no outbound network (Task 1.0);
  `@atlas/models` is a typed IPC client; `atlas-egress` scans + audits every payload in-process.
- **Audit SSOT:** SQLite ledger = system of record; encrypted backup = primary DR;
  `refs/audit/runs` = signed best-effort cross-check anchored to the external WORM file;
  `db rebuild --from-git` folds mutating rows best-effort with explicit gaps. Cardinality owner:
  each terminal event type exactly once per run.
- **Config:** `brain.config.yaml` is the single owner of every threshold/path this plan names
  (D4/D7/D8/D10 values live there); tasks consume config, never literals.
- **CLI contract registry:** `commands.json` owns command membership from Phase 0 (with `phase` +
  `implemented`); `gen-cli-contract.ts` generates docs + fixtures + the acceptance inventory; the
  graduation/quarantine groups are ordinary rows, so no inventory can drift.

## 5. Testing Strategy

- **Unit:** parse/hash/identity-normalize/chunk/patch/risk/schema/canonical-serialization/per-op
  payloads — colocated per package, offline, deterministic.
- **Integration:** sqlite repos + migrations ownership, provenance fold, lancedb fencing, git
  worktrees, jobs retries/recovery, model adapter (doubles), evidence re-verification, cross-store
  audit ordering (§2.8), locks conflict matrix.
- **E2E (fixture vaults):** ingest one source; update existing note (Tier-2); reject duplicate-id;
  Tier-3 review round; recover after index failure; rebuild all derived state; rollback applied
  change; purge.
- **Safety-invariant CI gate (release-blocking, offline):** `provisioning.separation` ·
  `broker.no-ledger-dep` · `approval-boundary.adversarial` · `anchor.anti-truncation` ·
  `ledger.dr-roundtrip` · `ledger.fail-closed-watermark` · `audit.cross-store-ordering` ·
  `restore.atomicity` · `pre-persistence-guard` (`normalize.scans-before-return` +
  `capture.scans-before-persist`) · `quarantine.security` · `sandbox.containment` ·
  `egress.bypass` · `phase2.non-integration` · `jobs.single-runner-exclusion` ·
  `retrieval.order-invariant` · `index.generation-fencing` · `crash-recovery.failpoints` ·
  `observability.run-matrix` · `trust.lifecycle` · `rollback.dependency-checks` · `purge.e2e` ·
  `terminal-renderer.safety` · `db.migrate-ownership`. Any regression here is release-blocking.
- **Security negative:** fail-closed scan on every egress path; path-traversal/symlink-escape/
  symlink-race; disguised/oversized attachments; injection-shaped Markdown/frontmatter; indirect
  prompt injection; a provider response echoing a secret — always asserting **no persistence to any
  sink** (raw storage, worktrees, git objects+refs, LanceDB, temp/parser, diagnostics, audit,
  `raw_payloads`, every backup).
- **Order of arrival:** provisioning + broker + ledger DR + finalization gate (Phase 1) before any
  ingest; scanner + sandbox + non-integration exit (Phase 2) before retrieval; fencing (Phase 3)
  before workflows; the full gate (Phase 4) before the real-vault copy (Phase 5). **Deferred with
  their milestones:** multi-worker/lease crash matrix; multi-version migration matrices.
- **Environment matrix:** macOS (arm64) + Linux for provisioning/sandbox/permission/symlink/WAL
  suites; offline suite on every change; live-Gemini opt-in + nightly (`ATLAS_LIVE_GEMINI=1`);
  flaky tests quarantined (vitest retry-tagged, tracked, never silently retried in the safety gate).

Aggregate offline gate (CI, every change — working directory **repo root**; fixes R5-F2):
```bash
pnpm -r build && pnpm -r test
```

## 6. Rollback Plan

Each phase carries exactly **one deterministic rollback branch** inline above (preconditions, exact
commands, schema-compatibility statement, and a verify step using only commands that survive the
revert). Shared rules:

- **All rollbacks are PR reverts** — never force-pushes over shared branches. Unwanted **vault**
  content reversal uses the broker `git rollback` path (dependency-checked revert commit) *before*
  reverting the code that provides it; never a raw `git revert` of vault content.
- **The Phase-0 harness is never reverted** (Task 0.0) — `contract-lint` + `gen-cli-contract
  --check` are always runnable, and lint is clean even with every contract doc reverted (∅ == ∅).
- **Retained PR-A discipline:** `0003_provenance` (2.1) and `0004_claims` (4.1) land in retained
  PRs so `db rebuild` reproduces provenance/claims projections after any feature revert — there is
  no unsupported-rebuild sub-case.
- **DB schema is forward-compatible within V1:** migrations are additive + checksum-guarded; the
  runner no-ops applied migrations and never drops tables on downgrade; each table has exactly one
  owning migration (§2.7).
- **Protect the ledger before any code revert:** `db backup` first; recover via authorized
  `db restore` (+ post-restore hooks per phase).
- **Cleanup is transactional + auditable:** audit-referenced rows tombstone, never cascade;
  git-history rewrite only inside the documented purge protocol.
- **Provisioning teardown** (`provisioning/dev/teardown.sh`) only when decommissioning a host,
  verified by `provisioning.separation.test` finding no atlas artifacts.

## 7. Spec-coverage matrix

**Commands → delivering task** (registry `phase` column mirrors this):

| Command | Task | Command | Task |
|---|---|---|---|
| `inspect` | 1.9 | `index status\|verify\|repair\|rebuild` | 3.5 |
| `doctor` | 1.9 | `db status\|verify\|migrate\|rebuild` | 1.4 |
| `status` | 1.9 | `db backup\|restore`, `db verify --backup` | 1.7 |
| `ingest` | 2.6 | `jobs list\|run\|retry\|cancel` | 2.7 |
| `query` | 3.4 | `git status\|cleanup` | 2.9 |
| `enrich`/`reconcile`/`maintain` | 4.11 | `git review\|refresh\|approve\|reject\|rollback\|verify` | 4.9 (refresh: 4.5) |
| `validate` | 4.11 | `purge` | 4.10 |
| `source add\|list\|show` | 2.6 / 2.9 | `graduation scan\|audit\|migrate` | 5.1 / 5.2 / 5.3 |
| `source trust show` | 2.9 | `quarantine inspect\|resolve` | 5.3 |
| `source trust promote\|revoke` | 4.8 | `note show\|related\|history` | 2.9 |

**Normative capabilities → owner task:** provisioning/separation 1.0 · contracts seam 1.1/2.0 ·
config 1.2 · identity namespace 1.3 (validation 4.4) · migrations + rebuild 1.4 (§2.7) · git
plumbing 1.5 · broker auth core + anchor 1.6 · ledger DR + fail-closed watermark + §2.8 1.7 ·
renderer/a11y/`--plain` + JSON envelope + locks + diagnostics 1.8 · Tier-0/projection audit 1.9 ·
per-op schemas 2.0 · provenance entities + fold 2.1 · scanner/guards/quarantine 2.2 · sandbox 2.3 ·
normalization envelope + media alt 2.4 · run state machine 2.5 · capture + dedup/idempotency 2.6 ·
jobs queue + `jobs-runner` lock 2.7 · egress broker + provider taxonomy + operation gate 2.8 ·
pagination 2.9 · Phase-2 restriction proof 2.10 · chunking/generations 3.1 · fencing 3.2 · hybrid
RRF + packing 3.3 · query audit 3.4 · staleness/repair + restore hook 3.5 · eval harness 3.6 ·
claims schema + fold 4.1 · patches 4.2 · risk/sensitivity single producers 4.3 · validation +
accessibility + reserved-op rejection 4.4 · synthesis pipeline + CAS/refresh + artifact guard 4.5 ·
evidence ops 4.6 · re-verification protocol 4.7 · trust/taint/revocation 4.8 · approve/rollback
semantics 4.9 · purge + audit-ref erasure + retention execution 4.10 · failpoints + observability +
`--from-git` 4.11 · graduation scan/audit/migrate/quarantine 5.1–5.3 · eval + scale gates 5.4 ·
raw-payload opt-in store: table 1.4 (§2.7), config 1.2, backup inclusion 1.7, retention 4.10.

**Deferred by the spec (not planned, listed so absence is deliberate):** MCP server/cloud hub;
network adapters; reranking; scheduling daemons; multi-worker leases/fencing; autonomous
destructive ops; local inference; task-workflow *behavior* (schemas ship in 2.0, rejected by 4.4);
contradiction `disputed`/`superseded` transitions; opaque pagination cursors; OCR; ID-migration
protocol; multi-version schema chains.

