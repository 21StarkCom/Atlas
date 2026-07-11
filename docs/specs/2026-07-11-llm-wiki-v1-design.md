# LLM Wiki — V1 Design

**Status:** approved-pending-review · **Date:** 2026-07-11 · **Author:** Aryeh Stark
**Repo:** `21StarkCom/llm-wiki` (new, standalone) · **Language:** TypeScript (strict, ESM, pnpm monorepo)

## Purpose

A local-first, agent-maintained knowledge system in the spirit of Karpathy's "LLM Wiki":
Markdown is the memory, an LLM curates it, and every mutation is safe, typed, provenanced,
and git-reversible. Built **from scratch** — it reuses nothing from the existing
`2nd-brain` Go stack (brain-cli/brain-hub/vault-keeper). The only shared thing is the
Obsidian-compatible Markdown vault *format*.

Governing principle:

> Markdown is the memory. SQLite is the operational projection. LanceDB is the retrieval
> projection. Git is the safety/audit mechanism. The LLM is a reasoning component, not the
> database. Derived state is always rebuildable from canonical Markdown.

## Scope

**In V1:** a CLI-driven `brain`-style tool operating over a vault, with SQLite operational
projection, LanceDB hybrid retrieval, a SQLite-backed job queue, deterministic + typed
mutation safety, git-branch application, and the core workflows:
`inspect`, `doctor`, `ingest`, `query`, `enrich`, `reconcile`, `maintain`, `validate`,
plus `db` / `index` / `git` / `jobs` ops commands.

**Out of V1 (explicit non-goals):**
- MCP server (deferred to V2)
- Cloud hub (deferred to V2)
- Slack / email / web-capture / GitHub adapters — V1 sources are **local files only**
  (Markdown, plain text, PDF, HTML)
- Cross-encoder / LLM reranking (RRF fusion only)
- launchd / systemd scheduling (jobs run in-process / on-demand)
- Autonomous delete, merge, rename, or contradiction-erasure — all stay Tier-3
  review-required
- Local model inference (V1 is cloud-only; interface stays provider-neutral for later)

## Decisions (this session)

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Matches research prompt; strong LanceDB/Zod/AI-SDK ecosystem. Diverges from the Go-backend default deliberately, since this is a standalone from-scratch system. |
| Repo home | New `21StarkCom/llm-wiki` | Cleanly separate from the 2nd-brain monorepo. |
| Vault safety | Fixture vault first; sandbox **copy** of `main-vault` only at Phase 5 | Zero risk to live hub-synced notes; deterministic tests. Real vault, when reached, is agent-branch-only — never `main`. |
| V1 breadth | Everything except cloud hub + MCP | User directive. Delivered as phased milestones, not big-bang. |
| Model provider | Google Gemini, `gemini-3-5-flash` | V1 default for extraction, classification, and synthesis. Embeddings via `gemini-embedding-001`. Provider-neutral interface preserved. |

## Architecture — the safety loop

```
local file ─▶ Capture + Normalize ─▶ Immutable source note (sources/)
                                              │
                          SQLite projection ◀─┤ (registry, links, jobs, runs, plans)
                          LanceDB projection ◀┘ (chunks, embeddings, hybrid search)
                                              │
     query / ingest ─▶ Retrieve (id/alias/fts/vector/hybrid + RRF) ─▶ Context pack
                                              │
                        Orchestrator ─▶ Typed ChangePlan (Zod) ─▶ Section-level patch gen
                                              │
                   Deterministic validate ─▶ Risk classify ─▶ git branch / worktree
                                              │
                        Apply + commit ─▶ reindex changed notes ─▶ RunReport
                                              │
                                   review required if Tier ≥ 3
```

**Hard invariants:**
1. Raw model output never writes a file directly. Every write passes typed plan → schema +
   path-policy + provenance validation → section-level patch → git-branch apply.
2. Derived state (SQLite, LanceDB) is rebuildable from Markdown at any time
   (`brain db rebuild`, `brain index rebuild`).
3. Retrieval happens **before** any *synthesis* mutation, enforced by orchestration code,
   not prompts. Canonical source capture and the projection updates that follow it are
   explicitly exempt — capturing an immutable source is not a synthesis mutation and does
   not require prior retrieval. (This is why the mutating ingest loop can land in Phase 2
   before retrieval in Phase 3 without violating the invariant.)
4. Raw sources are immutable/append-only; synthesis notes are mutable but source-backed.
5. **End-to-end mutation is a persisted workflow state machine.** Every run advances through
   durable checkpoints (`planned → patched → worktree-applied → committed → reindexed →
   finalized`) recorded in `agent_runs`/`change_plans`. On startup a reconciler scans for
   runs left mid-flight: an already-committed-but-unfinalized run is finalized (never
   re-applied — the commit hash is the idempotency anchor), an applied-but-uncommitted
   worktree is either committed or discarded, and orphaned worktrees are cleaned. Resume is
   idempotent per checkpoint; ambiguous states fail fast and surface in `brain doctor`.

## Repo layout (pnpm monorepo, strict TS)

Trimmed from the research prompt's 18-package baseline to V1 needs (no `daemon`,
`mcp-server`, `cloud-hub`, `sync`, `observability`-as-package):

```
llm-wiki/
  apps/cli/
  packages/
    domain/        types, stable IDs, Zod schemas, ChangePlan operations
    config/        typed config load + startup validation
    vault/         read/write Markdown, frontmatter, wikilinks (rune-safe, no byte slicing)
    markdown/      parse + section/AST-level patch generator (preserves unknown frontmatter)
    sources/       normalize md / txt / pdf / html into NormalizedSource
    sqlite-store/  registry, links, jobs, runs, plans; migrations; repository interfaces
    lancedb-index/ chunk + embed + hybrid (fts + vector) search
    retrieval/     layered retrieve + Reciprocal Rank Fusion + context packing
    models/        provider-neutral generateText / generateObject / embed (Gemini adapter)
    workflows/     deterministic orchestrator + typed stages
    policies/      note-type mutation policy + risk tiers
    validation/    deterministic checks (+ optional semantic proposals)
    git/           branch / worktree / commit / rollback
    jobs/          SQLite-backed queue (retries, backoff, leases, idempotency keys)
    testing/       fixture-vault helpers
  fixtures/  migrations/  prompts/  schemas/  docs/
  AGENTS.md  brain.config.example.yaml  package.json  pnpm-workspace.yaml  tsconfig.base.json
```

No package without a clear ownership boundary. Explicit services/adapters/repositories over
frameworks. No cross-package "share code via import" hacks that violate boundaries.

**Packaging pragmatics (V1).** The above is the *logical* module map. V1 ships as **one CLI
application with internal modules**; only components with a demonstrated isolation need
(provider adapters, persistence implementations) start as separate packages. The remaining
boundaries (`domain`/`policies`/`validation`/`workflows`, `vault`/`markdown`) stay internal
modules, promoted to workspace packages only when independent reuse/versioning/ownership
becomes concrete — avoiding premature package-API overhead with no V1 consumer.

**Jobs in V1.** The `jobs` queue runs **synchronously in the CLI** (no daemon). It persists
job status, attempt count, idempotency key, and retry eligibility. Full lease epochs /
fencing tokens / multi-worker claiming are specified but only *needed* once a concurrent
worker or daemon exists; V1 still validates the current `lease_epoch` transactionally before
each durable side effect (git commit, projection write) and records side-effect ids so a
resumed attempt continues rather than repeats — so even the on-demand path cannot
double-commit. Idempotency keys are unique per (workflow, key).

## Data model

### Note identity & frontmatter
- Human-readable slug filename + **stable frontmatter `id`** (filenames may change, IDs
  never do) + `type` + `schema_version` + `aliases` + `sources` + `created`/`updated` +
  `status`.
- Duplicate `id` = hard error; unresolved duplicate identity is quarantined.
- **`ProposeRename` never touches `id`** — it renames title, slug, filename, or alias only.
  The frontmatter `id` is immutable for V1; there is no ID-migration operation. (If ID
  migration is ever required it becomes its own documented protocol covering redirects,
  reference rewrites, projection re-key, and audit history — explicitly out of V1.)
- Schema migrations are explicit and versioned. **Migration protocol:** each note declares
  `schema_version`; the tool declares a minimum supported reader version and refuses to load
  newer ones; transforms run as an ordered, idempotent chain with a per-note checkpoint and
  pre-commit validation; a failed/interrupted migration is resumable and leaves untouched
  notes valid; every migration boundary forces a projection rebuild, and any
  embedding-dimension or chunk-schema change opens a new index generation.

Example:
```yaml
---
id: project-meridian
type: project
schema_version: 1
title: Meridian
aliases: [Meridian cockpit]
status: active
created: 2026-07-11
updated: 2026-07-11
sources: [source-2026-07-11-meridian-design]
---
```

### Per-type mutation policy
| Type | Policy |
|---|---|
| source / transcript | immutable (or append-only) |
| daily note | append-oriented |
| person | mutable, source-backed |
| project | mutable |
| concept | mutable synthesis |
| decision | immutable body, append-only follow-up |
| research synthesis | mutable, versioned |
| task | state-machine controlled |

### Source manifest & normalization (provenance)
Every ingested artifact produces a **versioned `NormalizedSource`** record: stable
`sourceId` (derived from raw-content hash + media type), `rawContentHash`,
`normalizedContentHash`, `mediaType`, `sizeBytes`, `captureTime`, `origin` (original path
snapshot), `extractorVersion` + `normalizerVersion`, and a stable per-format `locator`
scheme (byte/char offsets for txt/md, page+span for pdf, DOM anchor for html). Raw bytes are
**copied into the vault** under `sources/` (immutable) so re-extraction is deterministic.
Re-ingesting the same `rawContentHash` returns the existing source (no duplicate); a path
whose content changed produces a **new immutable source version** rather than mutating the
old one. Parser/normalizer version bumps that change `normalizedContentHash` invalidate
dependent `quoteHash`/`locator` values and mark affected claims for re-verification.

### Claims & provenance
Claims carry evidence (`sourceId` + optional `locator` + `quoteHash`) and a status
(`active` / `disputed` / `superseded`). An LLM-generated synthesis must never become an
unmarked source. **Canonical schema:** each claim has a stable `claimId`, an `owningNoteId`,
`text` (or structured predicate), and `status` with defined transitions
(`active → disputed → superseded`, plus `supersedes`/`disputes` references to other
`claimId`s), and serializes canonically into its owning note's Markdown (a `claims:` block)
so it is deterministically rebuildable into the `claims`/`claim_evidence` tables. Evidence is
unique per (`claimId`,`sourceId`,`locator`,`quoteHash`) — making `AttachEvidence` idempotent.
`CreateRelationship` writes a typed relationship (predicate + source/target `noteId`) as a
canonical typed wikilink in frontmatter, rebuilt into `note_links`. Validation rejects
dangling `sourceId`/`noteId`/`claimId` references and duplicate evidence.

### SQLite tables (V1 subset)
`notes, note_aliases, note_links, sources, note_sources, claims, claim_evidence, jobs,
job_attempts, agent_runs, model_calls, retrieval_runs, retrieval_results, change_plans,
patches, patch_operations, validation_results, git_operations, schema_migrations`.
FKs on, WAL considered, content-hash change detection, idempotent upserts.

**Two classes of state — only one is a vault projection:**
- **Vault projections** (`notes, note_aliases, note_links, sources, note_sources, claims,
  claim_evidence, schema_migrations`) are deterministically rebuildable from canonical
  Markdown. `brain db rebuild` rebuilds *only* these.
- **Operational/audit ledger** (`jobs, job_attempts, agent_runs, model_calls,
  retrieval_runs, retrieval_results, change_plans, patches, patch_operations,
  validation_results, git_operations`) has no Markdown representation and is **durable, not
  rebuildable**. `brain db rebuild` preserves it (rebuild replaces projection tables inside
  one transaction, never truncating ledger tables). The ledger is additionally projected
  into git commit run-manifests (see Git workflow) so it survives a total SQLite loss via
  `brain db rebuild --from-git`; retention/backup is a config concern
  (`sqlite.ledger_retention`, default keep-forever). This is what keeps runs inspectable
  and external transmissions audited across a projection rebuild.

**Job lifecycle** — `jobs` rows carry a state enum (`pending → claimed → running →
succeeded | failed | cancelled`), `attempt`/`max_attempts`, `lease_epoch`, `next_run_at`
(backoff), `idempotency_key` (unique per workflow+key), and a `result`/`error` JSON payload.
Legal transitions, lease-expiry reclaim, terminal states, cancellation-of-queued-vs-running,
and deterministic responses for terminal/concurrently-changing jobs are defined in the jobs
package contract; see CLI `brain jobs`.

### LanceDB
Disposable retrieval projection only (chunks, embeddings, fts, vector, hybrid, metadata
filters). Never holds workflow/approval/job/identity/git state. `SearchChunk` records store
`contentHash`, `chunkerVersion`, `embeddingModel`, `embeddingDimensions` for staleness
detection. Chunk by semantic section, preserve heading hierarchy, include title + aliases.

### SQLite↔LanceDB consistency
Idempotent reconciliation (no distributed transactions): parse → hash → SQLite txn → mark
needs-index → chunk → embed → **write under a new immutable generation** → verify the
complete expected chunk-ID set → **conditionally activate** the generation only if SQLite
still references the same source hash → retire prior generations → mark indexed with version
+ hash. Safely retryable; crash-recoverable after any step.

**Generation fencing.** Every index attempt is keyed by an immutable generation id =
(`noteId`, `contentHash`, `chunkerVersion`, `embeddingModel`, `embeddingDimensions`). Chunks
are written tagged with that generation; a worker may only activate its generation if the
current SQLite source hash still matches (a stale/older worker's activation is rejected).
Activation atomically flips the active generation and retires prior ones — so shrinking
content or changed chunk boundaries never leave orphaned/mixed chunks live. This prevents an
older attempt from marking a note indexed after a newer version was already processed.

### Media & alt-text (normalization)
When normalizing HTML/PDF, meaningful images/diagrams/icons must carry equivalent text:
preserve existing useful `alt`; emit **empty `alt=""`** for decorative images; **meaningful**
images require a reviewed description (Tier-3 gate if auto-generated) before apply; and when
visual content cannot be represented textually the note records that gap explicitly rather
than dropping it silently.

### Retention & deletion
A retention matrix governs each entity class (immutable source notes, normalized copies,
model-call payloads, retrieval results, job attempts, rejected plans, patches, validation
records, obsolete LanceDB generations): system of record, minimum retention, archival/
compaction, soft-vs-hard delete, and FK behavior. Audit-referenced rows preserve tombstones/
immutable ids rather than cascade-deleting; obsolete index generations are compacted after
activation; all cleanup commands are transactional and auditable.

## Change planning, patches, risk

- Typed `ChangePlan` (Zod-validated) with operations: `CreateNote`, `UpdateSection`,
  `AppendSection`, `Add/UpdateFrontmatterField`, `AddAlias`, `Add/RemoveLink`,
  `CreateRelationship`, `CreateClaim`, `AttachEvidence`, `ProposeMerge`, `ProposeRename`
  (title/slug/filename/alias only — never `id`), `ProposeArchive`, `CreateTask`,
  `UpdateTaskState`. Each op carries target, rationale, supporting sourceIds, retrieved
  evidence, confidence, **`proposedRisk`** (model advisory only), reversibility, and an
  optional caller `idempotencyKey`. (`CreateTask`/`UpdateTaskState` and the `task` type are
  **provisional in V1** — carried for schema completeness but exercised by no V1 workflow,
  CLI command, or acceptance criterion; treat as deferred surface, not a shipped feature.)
- **Effective risk has exactly one producer.** The `policies` package deterministically
  derives and persists `effectiveRisk` from operation type + target note type + scope +
  configured policy; the model's `proposedRisk` is never trusted for gating. Git auto-commit
  vs. mandatory-review gating consumes **only** `effectiveRisk`.
- **Caller idempotency.** Every mutating entry point (`ingest`, `enrich`, `reconcile`,
  `maintain`, `jobs retry`, `git approve`, `rollback`) accepts an `--idempotency-key`; the
  key is persisted with a normalized request hash and terminal result. Identical retries
  return the original result; key reuse with different input is rejected; already-completed
  state transitions are no-ops that report the prior outcome.
- Patches are section/AST-level (not whole-file rewrites), preserve unknown frontmatter and
  formatting, fail safely on stale context, produce human-readable diff summaries.
- **Risk tiers** gate git behavior:
  - **Tier 0** read-only (search/answer/inspect) — no git mutation
  - **Tier 1** safe writes (add source, append log, rebuild index, inbox item) — auto-commit
  - **Tier 2** structured updates (update project/person, enrich concept, add sourced
    claims) — auto-commit when confidence + validation thresholds pass
  - **Tier 3** high-risk (merge, delete, archive, resolve contradiction, rewrite
    large synthesis, schema migration) — **review required by default**
  - **Tier 4** external actions — out of V1 scope

## Git workflow
Human work stays on the primary branch; agent operations run in isolated branches/worktrees.
One workflow run → one commit (or small series) carrying a **signed run manifest** (workflow,
run ID, source IDs, changed note IDs, effective risk, validation status, plan hash).

**Audit SSOT.** The git commit run-manifest is the authoritative audit record; SQLite's
`agent_runs`/`change_plans`/`validation_results`/`git_operations` are a one-way index
rebuilt from git (`brain db rebuild --from-git`). `brain git verify` detects and repairs
manifest↔index mismatches after rollback, cleanup, rebuild, or manual git edits.

**Review lifecycle & command semantics:**
- `status` — lists open agent branches/worktrees with run id, risk, validation, base commit.
- `review` — shows the diff + manifest for one run (read-only).
- `approve <runId>` — precondition-checked: re-verifies the approval signature is bound to
  the exact plan **and** commit hash, detects a **stale base** (canonical branch moved since
  the branch was cut) and refuses until rebased/re-validated, integrates via fast-forward or
  rebase-then-merge, is **idempotent** (a second approve of an already-integrated run is a
  no-op reporting the prior result), then removes the worktree and reconciles SQLite+LanceDB.
- `reject <runId>` — records the rejection, deletes the branch + worktree, leaves canonical
  untouched.
- `rollback <runId>` — reverts an **already-integrated canonical** change (creates a revert
  commit; never rewrites shared history) and reconciles projections; a not-yet-approved agent
  branch is discarded via `reject`, not `rollback`.
- `cleanup` — prunes worktrees/branches for terminal (approved/rejected) runs.
- Every outcome (approve/reject/rollback) triggers mandatory SQLite/LanceDB reconciliation.

**Authorization boundary (separation of duties).** Agent workflows have **no approval
capability** — they can create branches and commits but cannot invoke `approve`. Approval
requires either explicit interactive user-presence confirmation or a **separately held
signing key** the agent process cannot read; the signature binds to the exact plan + commit
hash and is verified immediately before integration. This makes the Tier-3 review gate
enforceable, not merely procedural.

Commands: `brain git status/review/approve/reject/rollback/cleanup/verify`.

## Model provider layer
Provider-neutral interface: `generateText`, `generateObject<T>` (Zod-typed), `embed`.
V1 ships one adapter: **Google Gemini** (`gemini-3-5-flash` for generation/extraction/
classification/synthesis; `gemini-embedding-001` for embeddings, dimensions pinned +
versioned in the index). Every call records provider, model, prompt-template id+version,
temperature, token counts, latency, cost estimate, retries, validation errors. Routing is
policy-driven so a `confidential` note-type class can later pin to a local/allowlisted
provider without touching call sites.

## CLI (V1 surface)
```
brain inspect | doctor | status
brain ingest <path> [--dry-run | --apply]
brain query "<question>"
brain enrich <note> [--dry-run | --apply]
brain reconcile
brain maintain
brain validate
brain source add|list|show
brain note show|related|history
brain index status|verify|repair|rebuild
brain db status|verify|migrate|rebuild
brain jobs list|run|retry|cancel
brain git status|review|approve|reject|rollback|cleanup|verify
```
Human + JSON + quiet + verbose modes; stable exit codes
(`0` ok · `1` validation · `2` config/vault · `3` secret-scan · `4` internal · `5` user/usage).

**Mutation default.** For `ingest`/`enrich` the default is a **non-mutating preview**;
`--apply` performs the mutation. `--dry-run` and `--apply` are mutually exclusive (supplying
both is exit `5`). Preview prints the diff summary + effective risk; apply of a Tier-3 op
stops at review-required (exit `1`) rather than committing.

**Job execution entrypoint.** `brain jobs run` claims and drains queued jobs synchronously
(V1 has no daemon): it acquires a lease, heartbeats, runs bounded attempts with backoff,
marks terminal `succeeded`/`failed`/`cancelled`, and honors idempotency keys. Workflow
commands drain their own jobs inline; `jobs run` exists to recover jobs left pending by a
crash, and expired-lease jobs are reclaimable on restart.

**CLI contract (versioned).** Each command defines positional args, flags + defaults +
constraints, side effects, and a typed JSON schema (`--json`) with required fields and enums.
**Target selection** for target-sensitive commands: `git review/approve/reject/rollback`
take a `<runId>`; `jobs run/retry/cancel` take a `<jobId>` (or `--all` where noted);
`note show/related/history` take a note `id` or slug. Collection commands (`source list`,
`jobs list`, `note related/history`, `git status`) use **cursor pagination** (`--limit`
default 50 / max 500, `--cursor`), deterministic sort keys with tie-breakers, emit
`nextCursor` in JSON, and keep the cursor stable when the collection changes between pages
(new items surface on the tail).

**JSON error envelope.** In `--json` mode every failure emits one object
`{ "code": "<stable-command-specific-code>", "message", "hint", "details": {field, path,
location}, "retryable": bool, "runId"|"jobId"? }`; **stdout is reserved for results —
diagnostics go to stderr**. Each `code` maps to one of the process exit categories above (so
validation vs. user/usage failures are distinguishable).

**Accessibility contract (human mode).** All meaning is carried in text — never color or
symbol alone; honor `NO_COLOR` and an explicit `--no-color`; degrade tables to linear
readable text and emit deterministic plain output when stdout is not a TTY (no
cursor-positioned or animated output). Every operation is fully available through
arguments/flags with **no required interactive UI**; where a confirmation prompt or pager
exists it is keyboard-operable and bypassable (`--yes` / `--no-pager`), and the same
information is available via `--json`. Errors always name the affected argument/config
key/file + source location in text.

## Security & privacy
Vault may contain sensitive Evinced + personal content. **V1 is cloud-only (Gemini)** — the
user has accepted that ingested/queried content goes to Google. Mitigations baked in:
secret scanning fails closed, path-traversal + symlink protection, attachment size/type
limits, audit of external transmissions, and a `models.routing.confidential` config hook
(local/allowlist) reserved for V2. Secrets live in env/OS keychain, never in the vault or
SQLite.

**Egress guard (non-bypassable).** Every `generateText`, `generateObject`, and `embed`
request routes through a single egress guard that scans the *exact serialized payload* —
covering ingest, query text, retrieval context, generated prompts, and embedding chunks, not
just ingestion. Detected secrets block or redact the call; failures fail closed and
quarantine; only sanitized metadata (hashes/classifications/destinations, never raw payloads)
is audited. Query, enrichment, indexing, rebuild, and retry paths are all in scope.

**Untrusted-input trust model.** PDF/HTML/Markdown/text sources and retrieved text are
**untrusted data**, isolated from system instructions and tagged with trust labels on their
evidence. Model-selected operations are constrained by capability policy; mutations driven by
newly ingested untrusted content **require review** (cannot auto-commit at Tier 2) until that
content is promoted to trusted. Adversarial indirect-prompt-injection cases are part of the
test plan.

**At-rest & data-minimization.** Local-host threat model assumes full-disk or DB encryption,
restrictive directory/file modes (0700/0600) on vault + SQLite + LanceDB + worktrees + temp
parser dirs, protected backups, controlled temp directories, and verified worktree cleanup.
Audit/run records use an allowlisted schema (identifiers, hashes, classifications,
destinations, metrics) — raw prompts/responses/quotes/retrieved content are **not** logged by
default; PII/secret redaction runs before logging; retention/purge is configurable.

**Erasure workflow.** A human-approved purge inventories and removes all derived and
historical copies of classified content (Markdown history, worktrees, SQLite, LanceDB, logs,
backups), documents when git-history rewrite is required, rebuilds projections afterward, and
records that Google's provider-side retention/deletion terms apply to already-transmitted
content.

## Configuration
One typed config (`brain.config.yaml`), validated at startup, env-overridable. Key sections:
`vault` (path, canonical_branch), `sqlite`, `lancedb`, `indexing` (chunker_version,
embedding_provider=google, embedding_model=gemini-embedding-001, dimensions), `git`
(worktrees_path, auto_commit_risk_levels), `models` (default_provider=google,
gemini config), `policies` (require_sources_for_synthesis, allow_auto_merge=false,
allow_auto_delete=false).

## Phased build plan

Each phase is its own PR, green before the next. Fixture vault throughout; real vault only
at Phase 5.

1. **Skeleton** — pnpm monorepo scaffold + `domain` + `config` + `vault` read/write +
   `sqlite-store` registry + migrations + `brain inspect` / `doctor` / `db rebuild` against
   a hand-built fixture vault.
2. **Ingest loop** — `sources` normalize (md/txt/pdf/html) in a **sandboxed parser worker**
   (no network, read-only input handle, isolated temp dir, CPU/memory/time caps,
   MIME-signature validation, external-resource + script processing disabled) → immutable
   source note → `models` Gemini adapter → typed `ChangePlan` → `markdown` patch gen →
   `validation` → `git` branch → commit → RunReport. Default `brain ingest <file>` is a
   non-mutating preview; `--apply` performs the mutation (see CLI contract for the
   `--dry-run`/`--apply` mutual exclusion + exit codes).
3. **Retrieval** — `lancedb-index` chunk + embed (Gemini) + hybrid search; `retrieval` RRF
   + context packing; `brain query`; `brain index` ops + staleness detection.
4. **Workflows** — `enrich`, `reconcile` (aliases/duplicates), `maintain`
   (orphans/broken-links/stale → proposals, never silent destructive), `validate`; risk
   tiers + review gate wired through `git`.
5. **Graduate to real vault** — first a **read-only bootstrap audit** of the copied
   `main-vault` sandbox: inventory legacy notes missing `id`/`type`/`schema_version`,
   ambiguous aliases, duplicate identities, and incompatible links. Then a **deterministic,
   review-gated bootstrap migration**: assign stable `id`s, infer `type`, quarantine
   identity conflicts, preserve existing links, initialize `schema_version`, with rollback
   and explicit graduation criteria (zero unresolved quarantines; projections rebuild clean)
   **before any real-vault workflow runs**. Then run agent-branch-only; verify git-rollback +
   full derived-state rebuild; retrieval eval on a small labeled set.

## Testing
Fixture vaults: `empty`, `small-valid`, `broken-links`, `duplicate-ids`,
`conflicting-claims`, `source-heavy`, plus one fixture per supported `schema_version`. Layers:
unit (parse/hash/ID-normalize/chunk/patch/risk/schema), integration (sqlite repos, lancedb
indexing, sqlite↔lancedb consistency, git worktrees, job retries, model adapter), e2e (ingest
one source, update existing note, reject duplicate-note creation, require review for
high-risk, recover after index failure, rebuild all derived state, rollback applied change).
Retrieval eval (recall@K, MRR, canonical-note discovery, source-grounding) before claiming
quality.

**Security (negative) tests.** Fail-closed secret scanning on every egress path
(query/enrich/index/rebuild/retry); path-traversal + symlink-escape + symlink-race;
disguised/oversized attachments; representative secret formats; injection-shaped
Markdown/frontmatter; adversarial indirect-prompt-injection sources; assert blocked content is
neither transmitted nor persisted to Markdown/SQLite.

**Gemini adapter tests.** Deterministic doubles/recorded responses by default + opt-in
real-service contract tests; cover malformed/truncated output, schema violations, timeouts,
rate-limit/quota/throttle, transient vs permanent errors, retry limits, partial batch
failures, and embedding-dimension mismatch; assert a model-call audit record exists for every
outcome.

**Crash-recovery failpoints.** Deterministic failpoints at every reconciliation transition
(after SQLite txn, needs-index marker, chunk, embed, partial upsert, verify, final indexed
marker) **and** every mutation-workflow checkpoint (planned/patched/applied/committed/
reindexed/finalized); restart tests assert convergence with no duplicate chunks, lost updates,
falsely-indexed records, orphaned worktrees, or double-commits; include permanent-embedding
failure + repair-command coverage.

**Queue concurrency.** Multi-worker tests with controlled clocks + crash injection: duplicate
delivery, idempotency-key collisions, concurrent claimers, expired leases, worker death,
cancellation races, retry exhaustion → terminal state, recovery of abandoned attempts, and
`jobs run/retry/cancel` CLI behavior.

**Migration compatibility.** Sequential + direct upgrades across schema-version fixtures,
interrupted + rerun (idempotent) migrations, unsupported-future-version rejection,
unknown-frontmatter + provenance preservation, rebuild-after-migration, and rollback/restore
expectations for failed migrations.

**Markdown accessibility.** Deterministic checks + fixtures for one logical top-level heading,
non-skipped heading levels, descriptive link labels, valid list structure, and image alt-text
rules — run during `validate` so a change cannot apply if it degrades navigation.

**Observability assertions.** Integration + e2e assert `model_calls`, `retrieval_runs`,
change plans, validation results, git metadata, RunReport, and external-transmission audit
records are complete, correlated by run id, sanitized (secrets/PII redacted), and emitted on
success, retry, rejection, rollback, and crash-recovery paths.

**CI regression gate.** A required offline (no live Gemini) suite runs on every change plus a
required critical-path e2e set (mutation-safety, review gating, rollback, rebuild, source
immutability); live-Gemini tests are opt-in/nightly; flaky tests quarantined; any
safety-invariant regression is release-blocking.

## Acceptance criteria (V1)
- Markdown authoritative; raw sources immutable; stable IDs; per-type mutation policies.
- SQLite + LanceDB each deletable and rebuildable; stale-chunk detection works; hybrid
  retrieval traceable.
- Raw model output cannot write files; every write is a typed plan producing a git diff;
  Tier-3 requires review; rollback works.
- Retrieval precedes mutation and is logged; eval fixtures exist.
- `brain doctor` reports health; index/db verify work; failed jobs retry; runs inspectable.
- CLI usable without reading source; `--dry-run`/`--apply` exist with a safe non-mutating
  default; JSON output exists; **errors are text-first** (severity, affected
  argument/config-key/file + source location, remediation — never color/symbol alone, same
  association in JSON).
- **Per-command acceptance cases.** Every V1 command/workflow (`ingest`, `query`, `enrich`,
  `reconcile`, `maintain`, `validate`, `jobs run/retry/cancel`, `index verify/repair/rebuild`,
  `db verify/migrate/rebuild`, `git review/approve/reject/rollback/cleanup/verify`) has an
  executable case specifying fixture/setup, invocation, expected stdout or JSON schema, exit
  code, Markdown/SQLite/LanceDB/git effects, prohibited effects, and representative errors.
- **Objective thresholds.** Tier-2 auto-commit pins a numeric confidence floor + max
  patch-size; retrieval eval must hit named recall@K/MRR targets on the labeled fixture set;
  `doctor`/`verify` enumerate their required checks; each failure has a defined exit code +
  JSON result.
