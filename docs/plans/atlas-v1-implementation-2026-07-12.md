# Atlas V1 — Implementation Plan

**Source spec:** `docs/specs/2026-07-11-atlas-v1-design.md` (approved-pending-review)
**Plan date:** 2026-07-12 · **Author:** generated for Aryeh Stark
**Repo:** `21StarkCom/Atlas` · TypeScript strict, ESM, pnpm monorepo

---

## 1. Overview

Atlas is built as a **safety-loop-first** system: the correctness machinery (privilege-separated
brokers, signed audit ledger, typed ChangePlan → validate → section-patch → git-branch apply,
persisted workflow state machine, encrypted ledger backup/restore) is not deferred — it is the
load-bearing spine that every later capability hangs off. The implementation therefore front-loads
the two hardest guarantees into the earliest phases: **Phase 1** stands up persistence *plus* the
minimal privilege-separation seam (broker + git plumbing) so that the encrypted ledger
backup/restore — the ledger's sole DR path — is real and tested from day one; **Phase 2** stands up
the sandboxed parser and the egress broker, deliberately restricting model activity to non-mutating
extraction so hard invariant 3 (retrieval-before-synthesis) holds *before* retrieval exists.

**Key architectural decisions (from spec, load-bearing for ordering):**
- **`contracts` is a leaf package**, not a CLI-internal module, because the separate-identity broker
  must byte-identically re-verify plans/manifests the CLI produced. This forces the shared schema +
  canonical serialization to land in Phase 1.
- **Two brokers, one privilege pattern:** the *integration broker* (protected-ref writes) and the
  *egress broker* (outbound network + provider credential). Authorization core lands Phase 1;
  canonical-integration surface (`approve`/`refresh`/`rollback`) lands Phase 4; egress lands Phase 2.
- **Two classes of state:** vault projections (rebuildable from Markdown) vs the primary
  operational/audit ledger (backed up, never rebuilt). Every DR and rebuild path defers to this split.
- **Effective risk and effective sensitivity each have exactly one producer** (`policies`), consumed
  everywhere; models only *advise*.
- **Contracts are phase-gated**, not one big-bang design gate: cross-cutting safety invariants +
  Phase-1 contracts up front; each later phase approves its own contracts before its code.

**Phases (6):** 0 = per-phase normative contracts (gates, not a phase of code); 1 = skeleton +
persistence + ledger backup/restore + broker/git authorization seam; 2 = sandboxed ingest + jobs +
egress broker (extraction-only); 3 = retrieval/index; 4 = mutating workflows + risk/review + purge;
5 = graduate to real vault (scan → bootstrap migration → agent-branch runs).

---

## 2. Prerequisites

**Must exist before Phase 1 code:**
- `21StarkCom/Atlas` repo created; commits authored `Aryeh Stark <aryeh@21stark.com>`; branch+PR flow.
- Node LTS + pnpm; `tsconfig.base.json` strict/ESM baseline agreed.
- OS keychain access on both supported hosts (macOS Apple-silicon current major; Linux) for AEAD keys,
  approval-signing key, audit-attestation key, provider credential custody.
- Ability to create a **separate OS identity/uid** for the broker (integration + egress) on dev + CI.
- The **up-front Phase-0 gate contracts approved** (see Phase 0).

**Can run in parallel with Phase 1:**
- Authoring the Phase-2 contracts (jobs, sandbox, normalization, per-op ChangePlan schema, provider
  interface) — they gate Phase 2, not Phase 1.
- Building fixture vaults (`empty`, `small-valid`, `broken-links`, `duplicate-ids`,
  `conflicting-claims`, `source-heavy`, one per `schema_version`).
- CI harness scaffold (offline suite + opt-in nightly live-Gemini lane).

---

## 2.5 Global Constraints (verbatim values from spec)

- **Language/build:** TypeScript strict, ESM, pnpm monorepo.
- **Repo:** `21StarkCom/Atlas` (new, standalone); reuses nothing from the Go `2nd-brain` stack.
- **Model provider:** Google Gemini — `gemini-3-5-flash` for generation/extraction/classification/
  synthesis; `gemini-embedding-001` for embeddings; embedding **dimensions pinned + versioned in the index**.
- **Supported V1 hosts:** macOS (Apple-silicon, current major) and Linux — **both native sandbox
  backends in scope** (macOS `sandbox-exec`/Seatbelt; Linux user namespaces + seccomp-bpf +
  network-isolated netns + rlimits).
- **V1 sources:** local files only — Markdown, plain text, PDF, HTML. **OCR out of V1.**
- **Fusion:** RRF only (no cross-encoder / LLM reranking).
- **Jobs:** synchronous single-runner in-process; **no daemon**; `lease_epoch` reserved (written,
  uncontended). No timed lease protocol — process lock only.
- **Frontmatter `id` is immutable in V1** — no ID-migration operation; `ProposeRename` never touches `id`.
- **Duplicate `id` = hard error.** Unresolved duplicate identity is quarantined.
- **`schema_version`:** V1 implements exactly legacy-unversioned→v1 bootstrap + validation of
  `schema_version: 1`; refuse unsupported/newer.
- **Exit codes:** `0` ok · `1` validation · `2` config/vault/lock · `3` secret-scan · `4` internal ·
  `5` user/usage · `6` action-required.
- **Mutation default:** `ingest`/`enrich`/`reconcile`/`maintain` (and `purge`) default to **non-mutating
  preview**; `--apply` mutates; `--dry-run`+`--apply` together ⇒ exit `5`.
- **Effective risk producer:** `policies` package only; model `proposedRisk` never gates.
- **Effective sensitivity producer:** `policies` package only; `declaredSensitivity ∈
  {public|internal|confidential|restricted}` is the sole authored input; unlabeled ⇒ `internal`.
- **Secret scanning is fail-closed and pre-persistence** (raw bytes + normalized output scanned before
  any vault/SQLite/worktree/git write); quarantine under AEAD, key in OS keychain, mode-0700 dir.
- **No agent/parser/workflow process holds provider credential or outbound network** — egress broker only.
- **No agent/parser filesystem access can advance a protected ref** — integration broker only; agents
  hold object-write + `refs/agent/*` only.
- **Audit event cardinality owner = *Audit SSOT*:** each terminal event type exactly once per run,
  preceded by its lifecycle events; **never "one event per run."**
- **Tier-2 auto-commit default threshold:** model+validation confidence ≥ 0.8 **and** patch ≤ 50
  changed lines across ≤ 3 sections of a single note (larger ⇒ Tier-3).
- **Retrieval eval gate:** recall@10 ≥ 0.85 and MRR ≥ 0.7 for canonical-note discovery.
- **Config file:** `brain.config.yaml`; keys `sqlite.ledger_retention` (default keep-forever),
  `sqlite.ledger_backup.*`, `sqlite.raw_payload_store` (default off), `policies.allow_auto_merge=false`,
  `policies.allow_auto_delete=false`, `policies.require_sources_for_synthesis`.
- **Pagination:** `--limit` default 50 / max 500 + `--offset`, stable sort + unique tie-breaker,
  best-effort under concurrency; opaque cursors deferred.
- **Every human-mode output** routes through a single terminal-safe renderer; `--plain` disables all
  animation; honor `NO_COLOR`/`--no-color`.
- **CLI contract single source of truth:** `docs/specs/cli-contract/commands.json` registry owns command
  membership; per-command `<command>.schema.json` is authoritative; Markdown + test fixtures +
  acceptance inventory are generated from it.
- **Task surface reserved:** `task` note type + `CreateTask`/`UpdateTaskState` schemas ship and validate,
  but validation **rejects any ChangePlan containing a task operation** (fail-closed); no V1 workflow
  exercises them.

---

## 3. Phases

### Phase 0: Normative contracts (per-phase gates)

**Goal:** Land the versioned normative contracts that govern each phase, gated *before* the code they
govern — not all before Phase 1.
**Dependencies:** none (up-front subset); each later subset depends on the prior phase's learnings.
**Estimated effort:** L (spread across the project)

#### Tasks
1. **Up-front safety-invariant + Phase-1 contracts**
   - What: author + approve `docs/specs/recovery-state-machine.md` (full per-state transition table:
     required artifacts, atomic write, legal next states incl. `failed@`/`cancelled@`, idempotency
     check, retained artifacts, worktree cleanup, audit emission, recovery action per checkpoint);
     `docs/specs/sqlite-data-dictionary.md` (complete DDL — component-scalar composite PKs/FKs, CHECK
     enums, conflict targets, ON DELETE per retention matrix, invariant-validation queries);
     `sqlite.ledger_backup` subsystem contract; security/authorization+broker contract (broker OS
     boundary, protected refs, challenge/response JSON schemas, Ed25519, nonce replay, OS-presence);
     `docs/specs/retention-matrix.md`; `docs/specs/cli-contract/commands.json` (registry seed) +
     `cli-contract/*.schema.json` for Phase-1 commands (`inspect`, `doctor`, `status`, `db *`).
   - Files: `docs/specs/*`, `docs/specs/cli-contract/*`.
   - Interfaces — **Produces:** the normative state set `planned → patched → worktree-applied →
     agent-committed → [review-pending] → integrated → reindexed → finalized` + terminals `rejected`,
     `rolled-back`, `failed`, `cancelled`; the table names, PK/FK component columns, and audit event
     types (`run.started/planned/integrated/rejected/rolled_back/failed/cancelled/readonly/projection`)
     that every later task consumes. **Consumes:** the spec.
   - Test: contract lint — a CI check parses `commands.json` and asserts every command in the prose CLI
     surface is present with schema ref, phase, idempotency class, privilege tier.
   - Acceptance: Phase-1 code cannot start until this subset is approved on the PR.
2. **Phase-2 contracts** (gate Phase 2): `jobs-contract.md`, `sandbox-contract.md`,
   `normalization-contract.md`, per-operation ChangePlan schema, provider-interface + error-taxonomy,
   `cli-contract/*` for Phase-2 commands.
   - Interfaces — **Produces:** jobs state enum + transitions + backoff + process-lock + dead-runner
     recovery; sandbox guarantee set + per-host isolation primitive + startup capability checks;
     normalization envelope + error-code set; discriminated ChangePlan payload schemas; provider error
     union `{validation|authentication|quota|rate_limit|timeout|transport|cancelled|partial_batch|
     model_incompatible}` each with `retryable`+`retryAfter`.
3. **Phase-3 contracts:** retrieval/index contracts (generation fencing, chunk schema, staleness,
   RRF) + Phase-3 `cli-contract/*`.
4. **Phase-4 contracts:** workflow + risk contracts, `purge.schema.json`, trust-model contract,
   rollback dependency-check contract, `acceptance-thresholds.md` **workflow subset**.
5. **Phase-5 contracts:** `bootstrap-migration.md` + `acceptance-thresholds.md` retrieval-eval + scale
   profiles.

#### Risks
- Over-freezing later interfaces before earlier slices validate assumptions: mitigated by the
  per-phase gating rule itself.
- Registry ↔ prose drift: mitigated by generating Markdown + fixtures from schema, CI-enforced.

#### Verification
- Each subset approved on its PR before the governed code merges; contract-lint CI green.

---

### Phase 1: Skeleton + persistence + ledger DR + broker/git seam

**Goal:** A working CLI over a fixture vault that can `inspect`/`doctor`/`db rebuild`, plus the
encrypted ledger backup/restore under a real privilege-separated broker.
**Dependencies:** Phase 0 up-front subset.
**Estimated effort:** L

#### Tasks
1. **Monorepo scaffold + `contracts` leaf package**
   - What: `pnpm-workspace.yaml` declaring tree-A packages; `tsconfig.base.json`; `apps/cli` shell.
     Implement `packages/contracts`: stable ID types, `ChangePlan` + run-manifest Zod schemas,
     **canonical serialization** (byte-identical on both process seam sides).
   - Files: root config, `packages/contracts/src/*`.
   - Interfaces — **Produces:** `canonicalize(value): Uint8Array`, `ChangePlanSchema`,
     `RunManifestSchema`, `NoteId`/`ContentId`/`RenditionId`/`RunId` types (component-scalar form per
     data dictionary). **Consumes:** Phase-0 schemas.
   - Test: `contracts.canonical.test` — same logical object serialized in CLI vs broker context yields
     identical bytes; round-trip stable.
   - Acceptance: zero deps in `contracts`; broker + CLI both import it, neither imports the other's internals.
2. **`config` module + startup validation**
   - What: typed load of `brain.config.yaml`, env-override, fail-loud on invalid; expose config to CLI.
   - Interfaces — **Produces:** `loadConfig(): Config` with `vault`, `sqlite`, `lancedb`, `indexing`,
     `git`, `models`, `policies`, `logs` sections. **Consumes:** none.
   - Test: `config.validate.test` — malformed config exits `2` with named key + file location.
3. **`vault` module — Markdown read/write**
   - What: read/write notes, frontmatter parse/serialize preserving unknown fields + formatting,
     wikilink parse.
   - Interfaces — **Produces:** `readNote(id|slug)`, `writeNoteSection(...)`, `parseFrontmatter`,
     `serializeFrontmatter` (unknown-field-preserving). **Consumes:** `contracts` IDs.
   - Test: `vault.roundtrip.test` — read→serialize preserves unknown frontmatter + body byte-for-byte.
4. **`sqlite-store` — connection, migration runner, projection tables + `db rebuild`**
   - What: DB connection (FKs on, WAL), the migration runner + `db_schema_migrations` ledger (checksum-
     guarded), the projection tables + operational/audit ledger tables per data dictionary, versioned
     index contract, `brain db migrate|rebuild|status|verify`. `db rebuild` replaces **only** projection
     tables in one txn; never touches ledger tables. Exposes the migration harness that `jobs` registers into.
   - Interfaces — **Produces:** `db()` connection, `registerMigrations(module)`, `rebuildProjections()`,
     `verifyInvariants()` (runs dictionary invariant queries). **Consumes:** `contracts`, data dictionary.
   - Test: `db.rebuild.test` — drop projection tables, `db rebuild` from fixture Markdown reproduces them
     exactly; ledger tables untouched. `db.migrate-order.test` — migrate (DDL) completes before rebuild;
     both crash-idempotent.
   - Acceptance: `brain db rebuild` never mutates `db_schema_migrations` or any ledger table.
5. **`git` package — repo/ref plumbing + protected-ref ownership model**
   - What: branch/worktree/commit primitives; protected refs (canonical, `refs/audit/runs`, trust ledger)
     owned by broker uid via filesystem ownership/mode; agent capability = object-write + `refs/agent/*`.
   - Interfaces — **Produces:** `createAgentBranch`, `writeObject`, `readRef`; broker-only
     `advanceProtectedRef` (guarded). **Consumes:** `contracts`.
   - Test: `git.protected-ref.test` — agent-uid `update-ref`/raw ref-file write against canonical fails EACCES.
6. **`broker` package — authorization core + audit-ref append (restore/backup surface)**
   - What: separate-identity broker sufficient to authorize + execute `db restore`/`db backup`:
     challenge/response (`--export-challenge` → OS-presence assertion **or** `--authorization`), Ed25519
     verification, nonce replay-protection, protected-ref/audit-ref ownership, audit-event append,
     credential/key custody. Full `approve`/`refresh`/`rollback` deferred to Phase 4.
   - Interfaces — **Produces:** `mintChallenge(op, targets)`, `verifyAuthorization(challenge, sig, signerId)`,
     `appendAuditEvent(signedEvent)`, `advanceProtectedRef(...)`. **Consumes:** `contracts` canonicalization,
     Phase-0 broker contract.
   - Test: `broker.authz.test` — `--yes` alone never authorizes; forged/replayed/expired signature rejected;
     drift (canonical moved, wrong commit, wrong signer) rejected with stable codes.
7. **Encrypted ledger backup/restore subsystem**
   - What: SQLite Online Backup API → AEAD-encrypted file (key in OS keychain, mode 0600, write-temp-then-
     rename); `backup_watermark_seq`; **fail-closed** post-run backup with bounded retries → `backup-unhealthy`
     (exit `2`) blocking ledger-writing runs until watermark catches up; `--force-unblock` privileged override;
     `brain db backup|restore`, `db verify --backup`; restore is privileged/destructive under broker, holds
     `vault-maintenance` lock, restores ledger txn-atomically then triggers projection + index rebuild.
   - Interfaces — **Produces:** `backupLedger()`, `restoreLedger(backupRef)`, `verifyBackup(ref)`,
     `backupWatermark()`. **Consumes:** broker authorization, `sqlite-store` connection.
   - Test: `ledger.dr-roundtrip.test` (**release-blocking**) — backup → wipe → restore recovers every
     ledger-only row; wrong/revoked key rejected; truncated/corrupt rejected; interrupted restore atomic;
     schema-version gate; fail-closed watermark blocks then unblocks; `--force-unblock` records RPO gap.
8. **`brain inspect` / `doctor` / `status`**
   - What: inspect vault + projections; `doctor` health incl. dir/file modes 0700/0600, worktree cleanup,
     encrypted-volume marker, backup health, quarantine-security, `--reclaim-locks` step.
   - Interfaces — **Consumes:** all above; `policies.effectiveSensitivity` producer (stub until Phase 4
     computes it, but the reader uses the producer, never recomputes).
   - Test: `doctor.health.test` — missing checkable prerequisite fails loud; JSON health surface reports degraded.

#### Risks
- **Broker OS-identity setup on CI:** mitigated by documenting the two-uid setup + capability startup
  checks that fail fast; skill `replicate-infra-platform` not applicable (no GCP here).
- **Canonical-serialization drift between seam sides:** mitigated by the `contracts` byte-identity test (Task 1).
- **Backup fail-closed deadlocking dev:** mitigated by the audited `--force-unblock` override.

#### Verification
- `brain inspect|doctor|db rebuild|db backup|db restore|db verify --backup` all green on fixtures.
- Release-blocking ledger DR round-trip + corruption tests pass (Phase-1 exit criteria).
- Protected-ref EACCES + broker authz negative tests green.

---

### Phase 2: Sandboxed ingest + jobs + egress broker (extraction-only)

**Goal:** Deterministic immutable source capture through a sandboxed parser, a persistent single-runner
job queue, and the egress broker — with model use restricted to non-mutating extraction.
**Dependencies:** Phase 1; Phase-2 contracts approved.
**Estimated effort:** L

#### Tasks
1. **`jobs` package — persistent single-runner queue (sole owner of `jobs`/`job_attempts`)**
   - What: DDL migrations registered into `sqlite-store`'s runner; repository + txns; state enum
     `pending→claimed→running→succeeded|failed|cancelled`; `attempt`/`max_attempts`, backoff/`next_run_at`,
     `idempotency_key` unique per `(workflow,key)`, `lease_epoch` reserved; process-lock ownership;
     dead-runner startup recovery (reset to `pending` under lock); transactional side-effect-id recording.
     `brain jobs list|run|retry|cancel` with `<jobId>|--all` mutual exclusion + bulk contract.
   - Interfaces — **Produces:** `enqueue(workflow, key, payload)`, `claimAndRun()`, `retry`, `cancel`,
     job snapshot read API (one-way consumer for `sqlite-store`). **Consumes:** `sqlite-store` connection +
     migration harness, jobs-contract.
   - Test: `jobs.single-runner.test` (**release-blocking**) — two concurrent `jobs run` processes: one
     acquires lock + drains, other fails fast `locked:<scope>` exit `2`, every job runs exactly once.
     `jobs.recovery.test` — dead-runner job reset to pending. `jobs.idempotency.test` — key collision.
2. **`sources` package — sandboxed normalization**
   - What: normalize md/txt/pdf/html in a dedicated low-privilege worker (empty allowlisted env, no
     network, isolated fs namespace exposing only read-only input + disposable output, isolated temp,
     CPU/mem/time caps, syscall restrictions, MIME-signature validation, scripts/external-resources
     disabled). Enforce `normalization-contract.md` envelope + typed rejections. Both native backends
     (Seatbelt / userns+seccomp+netns+rlimits); `doctor` verifies sandbox availability at startup.
   - Interfaces — **Produces:** `normalize(inputHandle): Rendition | TypedRejection` with error codes
     (`unsupported-encoding`, `encrypted-source`, `no-extractable-text`, …). **Consumes:** sandbox +
     normalization contracts.
   - Test: `sandbox.containment.test` — network/env/keychain/fd/out-of-scope-path/subprocess/syscall all
     fail; caps enforce + cleanup after forced kill. `normalization.conformance.test` — per-format fixtures
     (malformed/encrypted/scanned/mixed-encoding/oversized/script-bearing); partial extraction ⇒ typed
     rejection; deterministic byte-identical output.
3. **Provenance model + capture commit**
   - What: `content_blobs`/`source_captures`/`source_renditions` (+ `active_rendition_id`); copy raw bytes
     into `sources/` immutable; capture idempotency keyed `(contentId, origin)`; canonical Markdown
     manifest per entity foldable by `db rebuild`. Deterministic model-free source-capture commit → RunReport.
   - Interfaces — **Produces:** `captureSource(path)` → `{contentId, captureId, renditionId}` separately;
     `resolveSourceId(sourceId)` → active rendition. **Consumes:** `sources`, `vault`, `sqlite-store`.
   - Test: `provenance.versioning.test` — same bytes/new path adds capture not blob; changed bytes ⇒ new
     contentId; extractor upgrade ⇒ new rendition, old retained, active repointed, dependents `stale`.
4. **Pre-persistence secret scanner + quarantine**
   - What: fail-closed scan of raw bytes + normalized output before any write; quarantine outside repo,
     mode-0700, AEAD (keychain key), minimized filenames, bounded retention, crash-safe purge.
   - Interfaces — **Produces:** `scanOrQuarantine(bytes|text)` → pass | quarantined. **Consumes:** keychain
     key custody (shared rules with backup key).
   - Test: `quarantine.test` — ciphertext only (AEAD integrity), key inaccessible to parser/model, crash
     mid-quarantine leaves no plaintext, rotation/revocation/expiry work.
5. **`models` package + egress broker (extraction-only in Phase 2)**
   - What: provider-neutral `generateText`/`generateObject<T>`/`embed` as typed IPC client to the egress
     broker (sole credential holder + sole outbound network; agent processes network-denied at OS layer).
     Broker scans exact serialized payload inside itself + audits sanitized metadata. Gemini adapter.
     Records provider/model/template id+version/temp/tokens/latency/cost/retries/errors.
   - Interfaces — **Produces:** `generateText`, `generateObject`, `embed`, provider-error union.
     **Consumes:** provider-interface contract, egress broker.
   - Test: `egress.bypass.test` — agent-side direct provider call fails at OS network layer; IPC payload
     scanned + audited. `gemini.adapter.test` — malformed/timeout/rate-limit(`retryAfter`→`retryAfterMs`)/
     auth(no retries)/cancellation(before/during/mid-batch)/partial-batch/dimension-mismatch; audit record
     per outcome.
6. **Phase-2 operation allowlist enforcement**
   - What: allowlist = source-capture + projection-update ops only; synthesis ChangePlan **creation**
     forbidden; model used only for non-mutating extraction/classification for preview display.
   - Interfaces — **Consumes:** validation layer, `policies`.
   - Test: `phase2.non-integration.test` (**release-blocking**) — model-derived ops at every proposed risk
     level + injection-shaped input: canonical HEAD + Markdown never change; **no synthesis ChangePlan even
     created**; no approval path integrates a model artifact; only deterministic capture commits.
7. **`brain ingest <path>` (preview default / `--apply`) + `source add|list|show`**
   - Interfaces — **Consumes:** all above; key-accepting `--idempotency-key` (intrinsic identifier =
     content hash). **Produces:** ingest RunReport.
   - Test: `ingest.preview.test` — bare invocation no side effects; `--apply` captures; `--dry-run`+`--apply`
     ⇒ exit `5`.

#### Risks
- **Sandbox parity across macOS/Linux:** mitigated by platform-neutral guarantee set + per-host startup
  capability checks that fail fast; execution-environment matrix in CI.
- **Egress broker latency / IPC complexity:** accepted — it is the non-bypassable security seam.
- **Invariant-3 violation via an accidental synthesis plan:** mitigated by the release-blocking
  non-integration exit test + code-level allowlist.

#### Verification
- Ingest one source end-to-end; single-runner queue + containment + non-integration exit tests green.
- `doctor` reports sandbox + egress health.

---

### Phase 3: Retrieval + indexing

**Goal:** Hybrid retrieval over the vault with generation-fenced, rebuildable LanceDB.
**Dependencies:** Phase 2; Phase-3 contracts.
**Estimated effort:** M

#### Tasks
1. **`lancedb-index` — chunk + embed + hybrid search**
   - What: chunk by semantic section (preserve heading hierarchy, include title + aliases); embed via
     egress broker (`gemini-embedding-001`, pinned dims); id/alias/fts/vector/hybrid search; `SearchChunk`
     stores `contentHash`/`chunkerVersion`/`embeddingModel`/`embeddingDimensions`.
   - Interfaces — **Produces:** `indexNote(noteId, generationId)`, `search(query, mode)`. **Consumes:**
     `models.embed`, retrieval/index contract.
   - Test: `index.staleness.test` — dim/chunker/model change opens new generation.
2. **Generation fencing + SQLite↔LanceDB reconciliation**
   - What: generation id = `(noteId, contentHash, chunkerVersion, embeddingModel, embeddingDimensions)`;
     write chunks tagged; SQLite CAS activates iff `contentHash` matches; retrieval filters by active
     generation; retire/marker steps independently retryable; crash-safe.
   - Interfaces — **Produces:** `activateGeneration(id)` (SQLite CAS), `reconcileIndex(noteId)`.
     **Consumes:** `sqlite-store`, `lancedb-index`.
   - Test: `index.fencing.test` — stale worker CAS fails; half-written generation never queryable;
     orphaned chunks inert + compacted. Failpoint tests per reconciliation step.
3. **`retrieval` module — RRF fusion + context packing**
   - Interfaces — **Produces:** `retrieve(query): ContextPack` (RRF only). **Consumes:** `lancedb-index`,
     resolver precedence (id → slug → unique alias).
   - Test: `retrieval.rrf.test` — deterministic fusion; ambiguous alias ⇒ error not silent pick.
4. **`brain query` + `brain index status|verify|repair|rebuild`**
   - What: `index rebuild`/`repair`/`db rebuild` are projection-only (no canonical commit; broker appends
     one `run.projection` event); `query` is Tier-0 (broker appends one `run.readonly` event).
   - Interfaces — **Consumes:** `retrieval`, broker audit append. **Produces:** query answer + provenance.
   - Test: `index.rebuild.test` — LanceDB fully rebuilt from Markdown. `tier0.audit.test` — executed query
     appends exactly one `run.readonly`; preview/dry-run appends none.

#### Risks
- **Cross-store consistency without distributed txn:** mitigated by SQLite-as-sole-activation-authority
  + generation fencing (spec design).
- **Retrieval quality unknown until eval:** eval fixtures land Phase 5; here assert mechanics only.

#### Verification
- `brain query` returns grounded answers; index verify/repair/rebuild converge; fencing failpoints green.

---

### Phase 4: Mutating workflows + risk/review + purge

**Goal:** The full synthesis loop — enrich/reconcile/maintain/validate — gated by risk tiers, the review
lifecycle through the integration broker, and the human-authorized erasure workflow.
**Dependencies:** Phase 3; Phase-4 contracts + workflow acceptance thresholds.
**Estimated effort:** L

#### Tasks
1. **`policies` — effective risk + effective sensitivity (sole producers) + per-type mutation policy + taint**
   - What: derive+persist `effectiveRisk` from op type + note type + scope + config (Tier 0–4); derive
     `effectiveSensitivity` (most-restrictive over declared + inputs, computed on read or as rebuildable
     projection); per-type mutation policy table; transitive taint (untrusted evidence ⇒ untrusted claim/
     note; no laundering).
   - Interfaces — **Produces:** `effectiveRisk(op, target)`, `effectiveSensitivity(entity)`,
     `mutationPolicy(type)`, `isTainted(entity)`. **Consumes:** `contracts`, security contract.
   - Test: `policies.risk.test` — Tier-2 gate = confidence ≥ 0.8 **and** ≤ 50 lines / ≤ 3 sections;
     model `proposedRisk` never gates. `taint.transitive.test` — multi-hop; mixed evidence keeps untrusted.
2. **`validation` — deterministic checks + per-op schema validation + task fail-closed guard**
   - What: schema + path-policy + provenance validation; reject dangling refs + duplicate evidence;
     **reject any ChangePlan containing a task operation**; Markdown accessibility checks (one top-level
     heading, no skipped levels, descriptive links, list structure, alt-text) run in `validate`.
   - Interfaces — **Produces:** `validatePlan(plan)` → typed results. **Consumes:** per-op ChangePlan schema.
   - Test: `validation.task-guard.test` — task op ⇒ rejected. `validate.a11y.test` — degrading change blocked.
3. **`markdown` — section/AST patch generator**
   - What: section-level patches (never whole-file), preserve unknown frontmatter/formatting, fail on stale
     context (expected content hash precondition), human-readable diffs.
   - Interfaces — **Produces:** `generatePatch(note, op)` → patch + diff summary. **Consumes:** `vault`.
   - Test: `patch.stale-context.test` — stale hash ⇒ safe failure, no write.
4. **`workflows` — orchestrator + persisted state machine + concurrent-integration CAS**
   - What: deterministic orchestrator running the normative state machine with durable per-checkpoint
     atomic writes (plan/patch/worktree/commit hashes); enforce retrieval-before-synthesis in code;
     startup reconciler; Tier-1/2 auto-commit under CAS (rebase+regenerate+re-retrieve+re-validate on
     stale base); Tier-3 halts at `review-pending`.
   - Interfaces — **Produces:** `runWorkflow(cmd, target)` advancing checkpoints. **Consumes:** `policies`,
     `validation`, `markdown`, `retrieval`, `git`, `jobs`, recovery-state-machine contract.
   - Test: `ordering.retrieval-before-synthesis.test` (**CI safety gate**) — inject retrieval failure/empty:
     no plan/patch/worktree/commit for synthesis; capture exempt. `crash-recovery.failpoints.test`
     (**generated from transition table**) — crash before/after every git effect + checkpoint incl.
     integration-hash; convergence, no double-commit/half-integrated ref.
5. **Integration broker full surface — `git status/review/approve/reject/refresh/rollback/cleanup/verify`**
   - What: extend Phase-1 broker: `approve` = fast-forward CAS of exact signed commit only (stale ⇒
     `refresh-required` exit `6`, never rebase); `refresh` = rebase+regenerate+re-validate → new commit +
     fresh-approval-required; `rollback` = privileged revert of integrated run with downstream-reference
     dependency checks (`has-dependents` refusal / compensating plan); `reject`; `cleanup`; `verify`
     (manifest↔index repair + audit-head external-anchor check). Signed append-only `refs/audit/runs`
     event stream (audit-attestation key distinct from approval key; broker sole ref writer); WORM anchor
     anti-truncation.
   - Interfaces — **Produces:** the `git *` commands + audit event emission per *Audit SSOT*. **Consumes:**
     Phase-1 broker core, `contracts`, `workflows`.
   - Test: `approval-boundary.adversarial.test` — agent `approve`/direct ref write fails EACCES;
     forged/replayed/copied signature; commit mutation after signing; `--yes` alone; stale-base
     `refresh-required` never rebases; TOCTOU refused; non-interactive challenge/response drift rejected;
     audit-head truncation detected. `rollback.dependents.test` — `has-dependents` refusal + compensating plan.
6. **Claims/evidence + rendition-upgrade staleness protocol**
   - What: `claims`/`claim_evidence` canonical in Markdown (`claims:` block); `verification ∈
     {valid,stale,pending,failed}` authored in Markdown (never bare SQLite); `AttachEvidence` resolves
     `sourceId`→`renditionId` at boundary, persists pinned components, idempotent via `evidence_id`;
     rendition bump enqueues one re-verification job per owning-note (key `(contentId, newRenditionId,
     owningNoteId)`), re-anchors quoteHash → valid/pending(Tier-3)/failed; gating: stale/pending/failed
     evidence can't support Tier-2 or trusted synthesis.
   - Interfaces — **Produces:** `attachEvidence`, `UpdateEvidenceVerification` op flow. **Consumes:**
     `policies` gating, `jobs`.
   - Test: `evidence.reverify.test` — multi-note bump enqueues one non-colliding job per note; three
     outcomes; gating assertion; all changes flow through ChangePlan+git (bare SQLite write lost on rebuild).
7. **Trust promotion/revocation**
   - What: `brain source trust show|promote|revoke` + `PromoteTrust`/`RevokeTrust` ops, broker-authorized,
     bound to `sourceId`+`rawContentHash`; revocation of pre-integration run ⇒ `failed@<checkpoint>`
     (`trust-revoked`); of integrated run ⇒ new Tier-3 remediation run (forward, never backward edge).
   - Interfaces — **Consumes:** broker, `workflows`. **Produces:** trust ledger records.
   - Test: `trust.lifecycle.test` — forged/agent promotion refused; hash-change invalidates; replay rejected;
     revocation spawns remediation run.
8. **`brain enrich|reconcile|maintain|validate` + `note show|related|history`**
   - What: uniform preview/`--apply`; Tier-3 destructive proposals (merge/delete/archive) stop at
     `review-pending` exit `6`; `maintain` proposes never silently destroys.
   - Test: `workflow.review-gate.test` — Tier-3 apply produces durable run + exit `6`, no canonical FF.
9. **`brain purge` — human-authorized erasure**
   - What: broker-authorized Tier-3-equivalent; `--note|--source|--data-category` selector → printed
     inventory before challenge; preview default / `--apply`; touches all storage classes (Markdown+git
     history, worktrees, SQLite projection+ledger, LanceDB, logs, quarantine, every backup, audit ref via
     opaque-ID unlink / signed tombstone + WORM checkpoint); holds `vault-maintenance` lock; key-accepting +
     resumable; post-purge verification asserts no re-linkable copy remains.
   - Interfaces — **Consumes:** broker, all stores, audit-ref reconciliation. **Produces:** erasure record.
   - Test: `purge.e2e.test` (**Phase-4 exit criterion**) — seed every storage class; unauthorized/agent
     denial + replay protection; complete inventory; git-history handling; ordering+tombstones; audit-ref
     reconciliation; backup expiration; interruption/resume; post-purge cross-class no-prohibited-copy.

#### Risks
- **Approval-signature ↔ commit binding subtleties (stale base):** mitigated by `refresh-required`
  contract + adversarial suite; `approve` never rebases.
- **Rollback dangling provenance:** mitigated by downstream-reference set + `has-dependents` refusal.
- **Concurrent auto-integration lost updates:** mitigated by CAS + regenerate/re-retrieve tests.

#### Verification
- Full enrich/reconcile/maintain/validate loop; review gating; rollback; purge E2E; safety-invariant CI
  gate (retrieval-before-synthesis, review gating, approval boundary) green.

---

### Phase 5: Graduate to real vault

**Goal:** Operate against a **sandbox copy** of `main-vault`, agent-branch-only, after a fail-closed scan
and a deterministic review-gated bootstrap migration.
**Dependencies:** Phase 4; Phase-5 contracts (`bootstrap-migration.md`, retrieval-eval + scale thresholds).
**Estimated effort:** M

#### Tasks
1. **Fail-closed full-vault secret + sensitive-data scan (before any rebuild/index/migrate/model call)**
   - What: scan the copied sandbox; findings block graduation → reviewed-remediation / encrypted-quarantine
     (accounting for pre-existing git history).
   - Test: `graduation.scan.test` — planted secret blocks graduation.
2. **Read-only bootstrap audit**
   - What: inventory notes missing `id`/`type`/`schema_version`, ambiguous aliases, duplicate identities,
     incompatible links.
   - Interfaces — **Produces:** audit report (no mutation).
3. **Deterministic review-gated bootstrap migration**
   - What: per `bootstrap-migration.md` — ID-derivation + collision rules, `type`-inference precedence,
     link-rewrite/preservation, per-note checkpoints, review artifacts, rollback; quarantine identity
     conflicts; init `schema_version: 1`; set `declaredSensitivity` only; per-quarantine-category
     `inspect`/`resolve` operator commands.
   - Interfaces — **Consumes:** `workflows` state machine, `validation`. **Produces:** migrated vault.
   - Test: `bootstrap.migration.test` — interrupted+rerun idempotent; unknown-frontmatter + provenance
     preserved; rebuild-after-migration; rollback of failed bootstrap.
4. **Agent-branch-only real-vault run + DR verification + retrieval eval + real-vault purge exercise**
   - What: run workflows agent-branch-only (never `main`); verify git-rollback + full derived-state rebuild;
     retrieval eval on labeled set (recall@10 ≥ 0.85, MRR ≥ 0.7); exercise `purge` against uniquely-
     identifiable classified content in every class.
   - Test: `realvault.e2e.test` — agent branch only; rollback + rebuild; eval thresholds; purge cross-class.

#### Risks
- **Live-vault data risk:** mitigated — **sandbox copy only, agent-branch-only, never `main`** (spec decision).
- **Bootstrap ambiguity:** mitigated by quarantine + zero-unresolved graduation criterion.

#### Verification
- Zero unresolved quarantines; projections rebuild clean; retrieval eval meets thresholds before any
  real-vault workflow; purge verified.

---

## 4. Integration Points

- **`contracts` (process seam):** CLI (`domain` re-export) + both brokers produce/verify identical stable
  IDs, ChangePlan/run-manifest schemas, canonical serialization. Byte-identity is the contract.
- **`sqlite-store` ↔ `jobs`:** `sqlite-store` owns connection + migration runner + non-jobs tables; `jobs`
  registers its own migrations and solely owns `jobs`/`job_attempts`; `sqlite-store` is one-way read consumer.
- **SQLite ↔ LanceDB:** SQLite is the sole activation authority via generation-fencing CAS; LanceDB filtered
  by active generation. No distributed transaction.
- **Integration broker seam:** agents write objects + `refs/agent/*` only; broker (separate uid) is sole
  mutator of canonical/`refs/audit/runs`/trust refs; re-verifies signature + CAS + ancestry + audit event.
- **Egress broker seam:** agents have no credential + no network; `models` is a typed IPC client; broker
  scans + audits every payload.
- **Audit SSOT:** SQLite ledger is system of record; encrypted backup is primary DR; `refs/audit/runs` is
  a signed best-effort cross-check; `--from-git` folds mutating-run rows best-effort.
- **Config:** `brain.config.yaml` is the single owner of thresholds/paths; tasks read from config, never hardcode.
- **CLI contract registry:** `commands.json` owns membership; schemas generate docs + fixtures + acceptance.

---

## 5. Testing Strategy

- **Unit:** parse/hash/ID-normalize/chunk/patch/risk/schema/canonical-serialization.
- **Integration:** sqlite repos, lancedb indexing, SQLite↔LanceDB consistency + fencing, git worktrees,
  job retries, model adapter (doubles), provenance versioning, evidence re-verification.
- **E2E:** ingest one source; update existing note; reject duplicate-id creation; require review for
  high-risk; recover after index failure; rebuild all derived state; rollback applied change; purge.
- **Safety-invariant CI gate (release-blocking):** retrieval-before-synthesis ordering; review gating;
  approval boundary (broker EACCES + challenge/response); rollback; rebuild; source immutability; Phase-2
  non-integration; single-runner exclusion; ledger DR round-trip; crash-recovery failpoints (generated
  from transition table); quarantine crash-safety; egress bypass; generated-artifact persistence guard.
- **Security negative:** fail-closed scan on every egress path; path-traversal/symlink-escape/symlink-race;
  disguised/oversized attachments; injection-shaped Markdown/frontmatter; indirect prompt injection;
  provider response echoing a secret; assert no persistence to **any** sink (raw storage, worktrees, git
  objects+refs, LanceDB, temp/parser, diagnostics, audit, every backup).
- **What first:** persistence + broker + ledger DR (Phase 1) before any ingest; sandbox containment +
  non-integration exit (Phase 2) before retrieval; retrieval mechanics (Phase 3) before workflows;
  full safety gate (Phase 4) before real vault (Phase 5). **What can wait:** retrieval-quality eval,
  scale/perf thresholds — Phase 5. **Deferred:** multi-worker/lease crash matrix; multi-version migration matrices.
- **Env matrix:** macOS + Linux integration suites (sandbox availability, permission modes, symlink
  behavior/races, git worktrees, SQLite WAL+locking, encrypted-volume detection); offline suite on every
  change, live-Gemini opt-in/nightly, flaky quarantined.

---

## 6. Rollback Plan

- **Phase 0:** revert contract PR; no code depends yet.
- **Phase 1:** revert PR; ledger DR is the safety net — `db restore` from encrypted backup recovers ledger;
  `db rebuild`+`index rebuild` recover projections. Broker/git seam is additive; disabling it reverts to no
  privileged ops (dev-only).
- **Phase 2:** revert; immutable source captures remain valid Markdown; drop `jobs`/`sources`/egress via PR
  revert; captured sources are keep-forever and unaffected.
- **Phase 3:** LanceDB is disposable — `index rebuild` reconstructs; revert retrieval PR with no canonical impact.
- **Phase 4:** every canonical change is a git commit → `brain git rollback` (broker-authorized, dependency-
  checked revert commit, never history rewrite) + projection reconciliation. Purge/trust are additive commands.
- **Phase 5:** operates on a **copy** of `main-vault`, agent-branch-only — discard the sandbox; live vault
  never touched. Bootstrap migration has per-note checkpoints + documented rollback.
- **General:** all cleanup commands transactional + auditable; audit-referenced rows tombstone (never cascade);
  git-history rewrite only within the documented `purge` protocol under the broker.

---

## Open ambiguities flagged for implementers

1. **Broker OS-identity on CI:** the spec mandates a separate uid but not the CI mechanism — decide
   container-user vs dedicated-account before Phase 1; document in the deployment doc.
2. **`effectiveSensitivity` persistence:** spec allows compute-on-read *or* rebuildable projection — pick
   one in Phase 4's `policies` contract to avoid a second source of truth.
3. **`sourceId` alias handle ergonomics:** CLI returns `contentId`/`captureId`/`renditionId` separately;
   confirm which commands accept the `sourceId` alias vs explicit `renditionId` in each Phase-2/4 schema.
4. **Chunker version bootstrapping:** `indexing.chunker_version` initial value + bump policy is config-owned
   but its first value isn't specified — fix in the Phase-3 index contract.
