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
   worktree is committed iff its patch set validates clean against the recorded plan hash
   **and** the base commit is unmoved (otherwise it is discarded and the run re-planned), and
   orphaned worktrees are cleaned. Each checkpoint persists — in a single atomic write — the
   artifacts + hashes that gate its next transition (plan hash, patch hash, worktree ref,
   commit hash), so recovery is a deterministic function of the last durable checkpoint;
   resume is idempotent per checkpoint. The full per-state transition table (required
   artifacts, atomic write, legal next states, idempotency check, recovery action) is a
   normative contract (`docs/specs/recovery-state-machine.md`) landing before Phase 2.
   Ambiguous states fail fast, surface in `brain doctor`, and have a documented operator
   repair flow rather than an automatic guess.

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
job status, attempt count, idempotency key, and retry eligibility. V1 ships a **persistent single-runner queue**: atomic state transitions, attempt counts,
retry timing/backoff, idempotency keys, transactional recording of side-effect ids (so a
resumed attempt continues rather than repeats — the on-demand path cannot double-commit), and
startup recovery of interrupted jobs. Full lease epochs / fencing tokens / heartbeats /
expiry-based claiming / multi-worker semantics are **deferred** until a daemon or other
concurrent consumer exists; the `lease_epoch` column is **reserved** (written but not
contended in V1) so the schema is forward-compatible, and the concurrent-worker
crash-injection matrix moves to that later milestone. Idempotency keys are unique per
(workflow, key). Legal transitions, retry classification + bounded defaults, backoff
schedule, lease timing, and terminal semantics are fixed in a normative jobs contract
(`docs/specs/jobs-contract.md`) landing with Phase 2.

## Data model

### Note identity & frontmatter
- Human-readable slug filename + **stable frontmatter `id`** (filenames may change, IDs
  never do) + `type` + `schema_version` + `aliases` + `sources` + `created`/`updated` +
  `status`.
- Duplicate `id` = hard error; unresolved duplicate identity is quarantined.
- **Alias/slug identity:** slugs and aliases are canonicalized (Unicode NFC, case-folded,
  whitespace/punctuation-normalized) into a single identity namespace with a DB uniqueness
  constraint; an alias that would collide with another note's slug or alias is rejected (or
  quarantined during bootstrap) **before commit**. Resolver precedence for target selection
  is deterministic: exact `id` → exact slug → unique normalized alias; a normalized value
  matching multiple notes is an ambiguity error, never a silent pick. `AddAlias`/rename
  validate against this namespace so they cannot introduce post-bootstrap ambiguity.
- **`ProposeRename` never touches `id`** — it renames title, slug, filename, or alias only.
  The frontmatter `id` is immutable for V1; there is no ID-migration operation. (If ID
  migration is ever required it becomes its own documented protocol covering redirects,
  reference rewrites, projection re-key, and audit history — explicitly out of V1.)
- Schema migrations are explicit and versioned. **V1 implements exactly two paths:** a
  deterministic **unversioned-legacy → v1 bootstrap** (Phase 5) and **validation of
  `schema_version: 1`**, refusing any unsupported/newer version (the tool declares a minimum
  supported reader version). A minimal, idempotent, resumable migration *interface* with
  per-note checkpoint + pre-commit validation is retained so a future version slots in, and
  any embedding-dimension or chunk-schema change still opens a new index generation — but
  **generalized multi-version chains, direct-upgrade matrices, and multiple `schema_version`
  compatibility fixtures are deferred until a real second version exists.**

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
Provenance is modeled as **three linked entities** rather than one conflated record:
(1) an immutable **content blob** identified by `contentId` = (`rawContentHash`, `mediaType`)
— the raw bytes, stored once; (2) a **capture event** with its own `captureId` recording each
`origin` (original path snapshot) + `captureTime` that produced that content (so re-seeing the
same bytes from a new path adds a capture, not a duplicate blob); and (3) a **normalized
rendition** with `renditionId` = (`contentId`, `extractorVersion`, `normalizerVersion`),
carrying `normalizedContentHash`, `sizeBytes`, and the per-format `locator` scheme
(byte/char offsets for txt/md, page+span for pdf, DOM anchor for html) — so a
parser/normalizer upgrade produces a **new rendition** under the same content rather than
overwriting locator namespaces. Claim evidence references a **`renditionId`** (not the bare
source), pinning exactly which rendition its `locator`/`quoteHash` were computed against. Each
of the three entities has a canonical Markdown manifest form so all are rebuildable.
(`sourceId` is retained as an alias for `renditionId` where the CLI needs a single handle.) Raw bytes are
**copied into the vault** under `sources/` (immutable) so re-extraction is deterministic.
Re-ingesting the same `rawContentHash` returns the existing source (no duplicate); a path
whose content changed produces a **new immutable source version** rather than mutating the
old one. Parser/normalizer version bumps that change `normalizedContentHash` invalidate
dependent `quoteHash`/`locator` values and mark affected claims for re-verification.

### Claims & provenance
Claims carry evidence (`sourceId` + optional `locator` + `quoteHash`) and a status
(`active` / `disputed` / `superseded`). An LLM-generated synthesis must never become an
unmarked source. **Canonical schema (V1):** each claim has a stable `claimId`, an `owningNoteId`, `text`, and a
`status` (V1 exercises only `active`), serialized canonically into its owning note's Markdown
(a `claims:` block) so it is deterministically rebuildable into the `claims`/`claim_evidence`
tables. **Deferred** until a concrete contradiction-resolution workflow is designed +
accepted: structured predicates, the `active → disputed → superseded` transitions, and
`supersedes`/`disputes` inter-claim references (columns may exist for forward-compatibility
but no V1 workflow drives them — contradiction erasure is explicitly Tier-3/review-only). Evidence is
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
  `brain db rebuild --from-git`. The manifest is a **versioned append-only audit-event
  schema** carrying the complete per-run ledger payload — change plan, patches +
  patch_operations, validation_results, model_calls, retrieval_runs/results, job_attempt
  outcomes, and side-effect ids — i.e. exactly the fields needed to rebuild every ledger
  table. Data-minimized fields excluded from logs by policy (raw prompts/responses/quotes)
  are never in the manifest and are backup-only, not reconstructable. Retention/backup is a
  config concern
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
are written tagged with that generation. **SQLite is the single activation authority** (no
cross-store transaction is attempted): activation is a transactional compare-and-swap in
SQLite that flips `notes.active_generation` to the new id **iff** the row's `contentHash`
still matches the generation (a stale/older worker's CAS fails). Retrieval always filters
LanceDB chunks by the SQLite-authoritative active generation, so an incorrect or half-written
generation is never queryable even between store updates. LanceDB retirement of superseded
generations and the SQLite `indexed`-status marker are then **independently retryable
reconciliation steps** — crash-safe because they only ever converge toward the committed
active generation; orphaned/mixed chunks are inert (filtered out) and compacted later. This
prevents an older attempt from making a note's chunks live after a newer version was already
activated.

### Media & alt-text (normalization)
When normalizing HTML/PDF, meaningful images/diagrams/icons must carry equivalent text:
preserve existing useful `alt`; emit **empty `alt=""`** for decorative images; **meaningful**
images require a reviewed description (Tier-3 gate if auto-generated) before apply; and when
visual content cannot be represented textually the note records that gap explicitly rather
than dropping it silently.

### Retention & deletion
A concrete, versioned retention matrix (`docs/specs/retention-matrix.md`, landing before
Phase 2) governs each entity class (immutable source notes, normalized copies, model-call
payloads, retrieval results, job attempts, rejected plans, patches, validation records, git
manifests/history, worktrees, logs, backups, obsolete LanceDB generations) with, per class:
system of record, minimum retention (or explicit keep-forever), archival/compaction trigger,
soft-vs-hard delete + tombstone fields/duration, `ON DELETE` behavior, purge ordering, and
config key + bounds. V1 defaults: canonical Markdown + immutable sources = keep-forever; the
operational ledger = keep-forever (`sqlite.ledger_retention`); obsolete LanceDB generations
compacted after activation; model-call/retrieval payloads are metadata-only by policy (no raw
content) with a configurable window. Audit-referenced rows preserve tombstones/
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
- **Caller idempotency.** Every state-changing command is classified as either
  *key-accepting* or *intrinsically idempotent*. Key-accepting (accept `--idempotency-key`,
  persisting a normalized request hash + terminal result): `ingest`, `enrich`, `reconcile`,
  `maintain`, `source add`, `jobs run`, `jobs retry`, `jobs cancel`, `git approve`,
  `rollback`. Intrinsically idempotent (converge on repeat, no key needed): `git reject`,
  `git cleanup`, `index repair`, `index rebuild`, `db migrate`, `db rebuild` — each a no-op
  or deterministic convergence when already in the target state. For key-accepting commands:
  identical retries return the original result; key reuse with different input is rejected;
  concurrent duplicate invocation blocks on the persisted key rather than double-executing;
  already-completed state transitions are no-ops that report the prior outcome. Request-hash
  inputs + key scope per command are enumerated in the CLI contract.
- Patches are section/AST-level (not whole-file rewrites), preserve unknown frontmatter and
  formatting, fail safely on stale context, produce human-readable diff summaries.
- **Risk tiers** gate git behavior:
  - **Tier 0** read-only (search/answer/inspect) — no git mutation
  - **Tier 1** safe writes (add source, append log, inbox item) — auto-commit.
    *Projection-only* operations (index rebuild/repair, db rebuild) mutate no Markdown, so
    they create **no git commit** — they are operationally audited in the ledger only, not
    git-tier-gated
  - **Tier 2** structured updates (update project/person, enrich concept, add sourced
    claims) — auto-commit when confidence + validation thresholds pass
  - **Tier 3** high-risk (merge, delete, archive, resolve contradiction, rewrite
    large synthesis, schema migration) — **review required by default**
  - **Tier 4** external actions — out of V1 scope

  **Concurrent integration (all tiers).** *Every* canonical integration — including automatic
  Tier-1/Tier-2 commits, not just `git approve` — performs a transactional compare-and-swap
  against current canonical state: it re-checks the recorded base commit and the target
  notes' content hashes before committing. On mismatch (canonical moved since the run's base)
  it rebases, regenerates/reapplies the section patches, repeats retrieval + validation for
  any input that changed, and only then commits under the CAS; it never fast-forwards a patch
  computed against stale note state.

## Git workflow
Human work stays on the primary branch; agent operations run in isolated branches/worktrees.
One workflow run → one commit (or small series) carrying a **signed run manifest** (workflow,
run ID, source IDs, changed note IDs, effective risk, validation status, plan hash).

**Audit SSOT.** The versioned run-manifest committed with each run (schema above, under the
ledger) is the authoritative audit record; the SQLite ledger tables (`agent_runs`,
`change_plans`, `patches`, `patch_operations`, `validation_results`, `model_calls`,
`retrieval_runs`, `retrieval_results`, `job_attempts`, `git_operations`) are a one-way index
rebuilt from the manifests (`brain db rebuild --from-git`). Rebuild folds history
deterministically: an approve/integration manifest supersedes its plan's prior review-pending
record, a reject marks the run terminal-rejected, a rollback appends a revert event (never
rewriting the reverted run's records), and missing/orphaned/rewritten commits surface as gaps
rather than being silently dropped. `brain git verify` detects and repairs manifest↔index
mismatches after rollback, cleanup, rebuild, or manual git edits.

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
hash and is verified immediately before integration. **`--yes` alone can never authorize
Tier-3 integration** — it only bypasses cosmetic confirmation prompts; non-interactive
approval demands a valid signature from the separately protected key, and interactive approval
uses an authenticated user-presence mechanism unavailable to agent workflows. Key
provisioning, storage (OS keychain, never in the vault or in env visible to the agent),
rotation, revocation, signer identity, signature algorithm (Ed25519), and per-approval nonce
replay-protection are defined in the git package contract. This makes the Tier-3 review gate
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
brain source add|list|show|trust
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
creates the isolated agent branch + signed-manifest commit and records a **review-pending**
run (returning its `runId`, exit `1`), but **stops before canonical integration** — only
`brain git approve` integrates that exact reviewed commit. Tier-3 apply therefore always
produces a durable plan, branch, worktree, commit, and `runId`; it never fast-forwards into
the canonical branch.

**Job execution entrypoint.** `brain jobs run` claims and drains queued jobs synchronously
(V1 has no daemon): it acquires a lease, heartbeats, runs bounded attempts with backoff,
marks terminal `succeeded`/`failed`/`cancelled`, and honors idempotency keys. Workflow
commands drain their own jobs inline; `jobs run` exists to recover jobs left pending by a
crash, and expired-lease jobs are reclaimable on restart.

**CLI contract (versioned).** Each command defines positional args, flags + defaults +
constraints, side effects, prohibited effects, exit codes, and a typed JSON schema (`--json`)
with required fields and enums — enumerated per command in version-controlled schema files
(`docs/specs/cli-contract/<command>.md` + machine-readable JSON Schema) that must land before
that command is implemented; this document is the overview, those files are normative.
**Target selection** for target-sensitive commands: `git review/approve/reject/rollback`
take a `<runId>`; `jobs run [<jobId> | --all]` **defaults to draining all queued jobs** when neither is given (`<jobId>` and `--all` are mutually exclusive); `jobs retry`/`cancel` take a `<jobId>` (or `--all` where noted);
`note show/related/history` take a note `id` or slug. Collection commands (`source list`,
`jobs list`, `note related/history`, `git status`) use a **simple deterministic `--limit`
(default 50 / max 500) + `--offset`** contract for V1, each with a defined sort key + unique
tie-breaker (so ordering is stable) and `total`/`hasMore` in JSON. Opaque snapshot-stable
cursors are **deferred** until measured collection sizes or an API/MCP consumer demonstrates
the need.

**JSON error envelope.** In `--json` mode every failure emits one **discriminated** object
`{ "code": "<stable-command-specific-code>", "message": string, "hint": string, "details":
{ "field"?: string, "path"?: string, "location"?: {file, line?, span?} }, "errors"?:
[<same shape>] (multiple validation failures), "retryable": bool, "runId"?: string,
"jobId"?: string }`; `details.*` are optional and typed as shown, multiple failures are
carried in `errors[]`, and `runId`/`jobId` are included whenever the failing command operates
on one. The stable per-command `code` catalog (each mapped to an exit category) is enumerated
in the per-command contract files. **stdout is reserved for results — diagnostics go to
stderr.** Each `code` maps to one of the process exit categories above (so validation vs.
user/usage failures are distinguishable).

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
**pre-persistence secret scanning** (raw bytes + normalized output are scanned fail-closed
**before** any vault, SQLite, worktree, or git write — not only at egress — so a
secret-bearing source never reaches the vault or git history; blocked content is quarantined
outside the repository in a mode-0700 dir with encryption-at-rest, bounded retention, and an
auditable purge), the egress guard below, path-traversal + symlink protection, attachment
size/type limits, audit of external transmissions, and a `models.routing.confidential` config
hook (local/allowlist) reserved for V2. Secrets live in env/OS keychain, never in the vault or
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
content is promoted to trusted. **Taint is transitive:** any claim, retrieved context, or
synthesis derived from untrusted evidence is itself untrusted, and a note stays untrusted
while any supporting evidence is untrusted — copying or summarizing untrusted material never
launders it. **Promotion is an explicit human-authorized operation**, exposed as
`brain source trust show|promote|revoke <sourceId>` (and a `PromoteTrust` ChangePlan op),
bound to a specific `sourceId` + `rawContentHash`; only a user-presence /
signing-key-authorized caller (same boundary as `git approve` — never an agent workflow) may
promote or revoke. Each promotion/revocation writes an immutable audit record; revocation
re-taints dependent claims/syntheses and re-opens any pending or auto-committed-at-Tier-2
plans that relied on the now-untrusted content. Adversarial indirect-prompt-injection cases
are part of the test plan.

**At-rest & data-minimization.** The accepted local-host threat model and its deployment
prerequisites are **explicit and checked**: full-disk or DB encryption is a documented
operator prerequisite, and `brain doctor` verifies what it can (directory/file modes
0700/0600 on vault + SQLite + LanceDB + worktrees + temp parser dirs, worktree cleanup,
presence of an encrypted-volume marker where detectable) and fails loud when a checkable
prerequisite is absent. Encryption coverage spans every storage location (vault, SQLite,
LanceDB, git history, worktrees, temp dirs, backups); key ownership/rotation and backup
encryption are operator responsibilities named in the deployment doc; controls that cannot be
technically enforced are flagged as operator responsibilities rather than silently assumed.
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
   (dedicated low-privilege identity, **allowlisted empty environment** — no inherited
   provider credentials/keychain/file descriptors, no network, isolated filesystem namespace
   exposing only the read-only input handle + a disposable output dir, isolated temp dir,
   CPU/memory/time caps, syscall restrictions, MIME-signature validation, external-resource +
   script processing disabled; output is validated + secret-scanned before re-entering the
   trusted process) → immutable
   source note → `models` Gemini adapter → typed `ChangePlan` → `markdown` patch gen →
   `validation` → `git` branch → commit → RunReport. Default `brain ingest <file>` is a
   non-mutating preview; `--apply` performs the mutation (see CLI contract for the
   `--dry-run`/`--apply` mutual exclusion + exit codes). **This phase also delivers the
   `jobs` subsystem**: queue schema + repository, synchronous single-runner execution with
   atomic transitions/retry/backoff/idempotency keys, `brain jobs list|run|retry|cancel`, and
   startup recovery of interrupted jobs — with the single-runner queue tests as its exit
   criteria. Risk-tier **gating** lands in Phase 4.
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

**Queue (single-runner V1).** Idempotency-key collisions, retry exhaustion → terminal state,
startup recovery of interrupted/abandoned attempts, cancellation of queued-vs-running, and
`jobs run/retry/cancel` CLI behavior, under controlled clocks + crash injection. The
multi-worker matrix (duplicate delivery, concurrent claimers, expired leases, worker-death
races) is **deferred** with the leasing/daemon milestone.

**Migration compatibility (V1 scope).** Legacy-unversioned → v1 bootstrap and
`schema_version: 1` validation, interrupted + rerun (idempotent) bootstrap, unsupported/
future-version rejection, unknown-frontmatter + provenance preservation, rebuild-after-
migration, and rollback/restore of a failed bootstrap. (Multi-version sequential/direct-
upgrade matrices are deferred with the generalized migration framework.)

**Markdown accessibility.** Deterministic checks + fixtures for one logical top-level heading,
non-skipped heading levels, descriptive link labels, valid list structure, and image alt-text
rules — run during `validate` so a change cannot apply if it degrades navigation.

**Observability assertions.** Integration + e2e assert `model_calls`, `retrieval_runs`,
change plans, validation results, git metadata, RunReport, and external-transmission audit
records are complete, correlated by run id, sanitized (secrets/PII redacted), and emitted on
success, retry, rejection, rollback, and crash-recovery paths.

**Retrieval-before-synthesis ordering.** A dedicated invariant test inspects persisted
checkpoints + event sequence, injects retrieval failure and empty-result cases, and asserts
that **no** `ChangePlan`, patch, worktree mutation, or commit is produced for a synthesis
mutation before a successful retrieval (source capture + its projection updates are exempt).
In the required safety-invariant CI gate.

**Approval-boundary (adversarial).** Negative integration + e2e tests: an agent workflow
attempting `approve` (signing material absent from its environment), absent/forged/replayed
signatures, a signature copied between plans or between commits, commit mutation after
signing, `--yes` alone attempting Tier-3 integration, stale-base races, and a
canonical-branch move / TOCTOU change immediately before merge — each must be refused.

**Audit disaster-recovery.** Delete SQLite entirely and rebuild the ledger from a multi-run
git history via `brain db rebuild --from-git`; compare reconstructed audit records to
expected runs. Cover signature verification, reverts, rejected/orphaned branches, duplicate
manifests, tampered/partial history — asserting deterministic repair or explicit failure.

**Performance & scale.** Representative and maximum-scale vault profiles (defined in
`docs/specs/acceptance-thresholds.md`) drive automated benchmarks for ingest, query,
indexing, reconciliation, migration, and rebuild with latency/throughput/memory/disk-growth/
recovery-time thresholds; a stable subset runs as a regression gate and the max-supported
vault size is asserted.

**CLI pagination & terminal accessibility.** Contract tests for pagination under concurrent
inserts/deletes, deterministic tie-breaking, invalid/out-of-range offset + limit bounds,
byte-stable JSON schemas, stdout/stderr separation, TTY vs non-TTY rendering, `NO_COLOR` /
`--no-color` / `--no-pager`, and keyboard-independent (no-required-UI) execution.

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
- Retrieval precedes every **synthesis** mutation and is logged; immutable source capture
  and its deterministic projection updates are exempt (hard invariant 3, Phase 2 ordering).
  Eval fixtures exist.
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
- **Objective thresholds.** These are fixed in a version-controlled normative contract
  (`docs/specs/acceptance-thresholds.md`) that must land before implementation begins; V1
  seeds it with concrete defaults: Tier-2 auto-commit requires model+validation confidence
  ≥ 0.8 **and** patch size ≤ 50 changed lines across ≤ 3 sections of a single note (larger
  ⇒ Tier-3); retrieval eval on the versioned labeled fixture set must hit recall@10 ≥ 0.85
  and MRR ≥ 0.7 for canonical-note discovery; `doctor`/`verify` enumerate their required
  checks in the same contract; representative and maximum-scale vault profiles live there
  too. Each failure has a defined exit code + JSON result. The per-command executable cases
  + JSON schemas (above) live alongside it as `docs/specs/cli-contract/*` and are likewise
  required-before-implementation.
