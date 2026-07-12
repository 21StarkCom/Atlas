# Atlas — V1 Design

**Status:** approved-pending-review · **Date:** 2026-07-11 · **Author:** Aryeh Stark
**Repo:** `21StarkCom/Atlas` (new, standalone) · **Language:** TypeScript (strict, ESM, pnpm monorepo)

## Purpose

Atlas is a local-first, agent-maintained knowledge system in the spirit of Karpathy's
"LLM Wiki": Markdown is the memory, an LLM curates it, and every mutation is safe, typed,
provenanced, and git-reversible. Built **from scratch** — it reuses nothing from the existing
`2nd-brain` Go stack (brain-cli/brain-hub/vault-keeper). The only shared thing is the
Obsidian-compatible Markdown vault *format*.

Governing principle:

> Markdown is the memory. SQLite is the operational projection. LanceDB is the retrieval
> projection. Git is the safety/audit mechanism. The LLM is a reasoning component, not the
> database. The **vault-projection** derived state (SQLite projection tables + LanceDB) is
> always rebuildable from canonical Markdown; the **operational/audit ledger** is primary state
> that is backed up, not rebuilt (see *Two classes of state*).

## Scope

V1 is deliberately **heavy and rigorous** on safety, provenance, and auditability — those are
the load-bearing guarantees of an agent-maintained knowledge base and are **in scope**, not
deferred. What V1 excludes is *reach* (network adapters, multi-user, daemon, cloud), never the
correctness machinery.

**In V1 (normative — this is the authoritative capability list):**
- A CLI-driven `brain`-style tool over a vault: `inspect`, `doctor`, `ingest`, `query`,
  `enrich`, `reconcile`, `maintain`, `validate`, plus `source` / `note` / `db` / `index` /
  `git` / `jobs` command groups.
- SQLite operational projection **and** durable operational/audit ledger (two distinct state
  classes — see *Two classes of state*).
- LanceDB hybrid retrieval (id/alias/fts/vector/hybrid + RRF fusion).
- A SQLite-backed single-runner job queue (synchronous, in-process).
- Deterministic + typed mutation safety: typed `ChangePlan` → validate → section-level patch →
  git-branch apply, behind a **privilege-separated integration broker** (see *Authorization
  boundary*).
- A **persisted mutation-workflow state machine** with durable checkpoints and terminal
  `rejected` / `rolled-back` / `failed` / `cancelled` states.
- **Encrypted, tested SQLite ledger backup/restore** as the primary disaster-recovery path for
  the operational/audit ledger (see *Two classes of state* and *Audit SSOT*).
- A **protected, append-only, signed git audit event stream** (`refs/audit/runs`) recording
  every run class as a cross-check of the ledger.
- Separation-of-duties authorization for every privileged canonical/destructive operation
  (approve, rollback, purge, trust promotion/revocation) — signed, non-interactive-capable.
- A sandboxed parser worker for untrusted source normalization on the supported V1 hosts
  (macOS + Linux).
- A human-authorized erasure/purge workflow.

These heavy subsystems (universal signed audit ledger, both native sandbox backends, the
per-command CLI-contract schema system, the provisional task-operation schema surface) are all
**intentionally in V1** by operator directive; wherever an earlier draft implied otherwise the
authoritative rule is: **in scope**, and every section herein is reconciled to agree.

**Out of V1 (explicit non-goals).** This enumerated list is the **single source of truth for
V1 scope** and **supersedes any shorthand** (including a PR description's "everything except
the MCP server and cloud hub"): V1 excludes the MCP server and cloud hub **and also** the
network/adapter, reranking, scheduling, multi-worker/daemon, autonomous-destructive,
local-inference, and task-workflow-behavior items below. Where the PR description and this
section appear to disagree, **this section governs** and the PR description MUST be read as the
shorthand it is; the correctness machinery (broker, audit ledger, ledger backup, purge,
sandboxes, per-command schema contracts) remains fully **in** scope per *In V1* above.
- MCP server (deferred to V2)
- Cloud hub (deferred to V2)
- Slack / email / web-capture / GitHub adapters — V1 sources are **local files only**
  (Markdown, plain text, PDF, HTML)
- Cross-encoder / LLM reranking (RRF fusion only)
- launchd / systemd scheduling (jobs run in-process / on-demand)
- Multi-worker / daemon job execution, lease-expiry reclaim, fencing tokens
- Autonomous delete, merge, rename, or contradiction-erasure — all stay Tier-3
  review-required
- Local model inference (V1 is cloud-only; interface stays provider-neutral for later)
- Task-workflow *behavior* — the task note type and `CreateTask`/`UpdateTaskState` operation
  schemas ship as **reserved, forward-compatible surface** (in scope as schema, exercised by no
  V1 workflow) — see *Change planning*.

## Decisions (this session)

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Matches research prompt; strong LanceDB/Zod/AI-SDK ecosystem. Diverges from the Go-backend default deliberately, since this is a standalone from-scratch system. |
| Repo home | New `21StarkCom/Atlas` | Cleanly separate from the 2nd-brain monorepo. |
| Vault safety | Fixture vault first; sandbox **copy** of `main-vault` only at Phase 5 | Zero risk to live hub-synced notes; deterministic tests. Real vault, when reached, is agent-branch-only — never `main`. |
| V1 breadth | Per the normative **In V1 / Out of V1** lists in *Scope* (authoritative) | User directive: heavy safety/provenance/audit machinery is in scope; only network reach, multi-user, daemon, and cloud are deferred. Delivered as phased milestones, not big-bang. The "everything except cloud hub + MCP" shorthand is superseded by those enumerated lists so breadth and non-goals cannot disagree. |
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
1. Raw model output never writes a file directly, and **no filesystem-level access by any
   agent or parser process can update a canonical (or audit) git ref.** Every canonical write
   passes typed plan → schema + path-policy + provenance validation → section-level patch →
   git-branch apply, and the canonical/audit refs are advanced **only** by a
   privilege-separated integration broker running under separate OS credentials that
   re-verifies the approval signature, CAS preconditions, commit ancestry, and audit events
   (see *Authorization boundary*). Agent processes hold object-write + scoped agent-ref
   capabilities only — never write access to protected refs.
2. **Only the SQLite vault-projection tables are rebuildable from Markdown at any time**
   (`brain db rebuild`); LanceDB is fully rebuildable from Markdown (`brain index rebuild`).
   The **operational/audit ledger tables are NOT rebuildable from Markdown** — they are
   primary state whose disaster-recovery path is the encrypted SQLite ledger backup, with the
   git audit ref as a best-effort partial cross-check. Precisely which tables fall in each
   class is normative in *Two classes of state*. (This is the single, consistent
   rebuildability contract; every other section defers to it.)
3. Retrieval happens **before** any *synthesis* mutation, enforced by orchestration code,
   not prompts. Canonical source capture and the projection updates that follow it are
   explicitly exempt — capturing an immutable source is not a synthesis mutation and does
   not require prior retrieval. (This is why the mutating ingest loop can land in Phase 2
   before retrieval in Phase 3 without violating the invariant.)
4. Raw sources are immutable/append-only; synthesis notes are mutable but source-backed.
5. **End-to-end mutation is a persisted workflow state machine.** Every run advances through
   durable checkpoints; **`agent_runs` is the single authoritative record of the current
   workflow state and checkpoint sequence**, while `change_plans` is immutable/plan-specific and
   referenced by id/hash (any displayed plan status is derived from the authoritative run state,
   and the data dictionary + recovery contract forbid independent state transitions in both
   tables). The **agent-branch commit**
   and the **canonical integration commit** are recorded as separate hashes. A Tier-3 run
   halts at `review-pending` after `agent-committed`; from `review-pending` the **only** legal
   transitions are **approve** (→ `integrated`), **refresh** (→ back to `review-pending` on a
   new commit), and **reject** (→ terminal `rejected`). These are the only **reviewer-initiated**
   transitions; the exceptional **system-failure/abort** transitions `failed@review-pending`
   (validation/broker/internal failure) and `cancelled@review-pending` (the owning agent's abort,
   or trust revocation of the run before integration) are the *only* other legal exits, are
   performed by the system or the owning agent (never a third party), prune the agent branch via
   the normal cleanup path, and each emit their terminal audit event. `rollback` is **not** a legal
   review-pending transition — it applies only to an already-`integrated`/`finalized` run.
   Tier-1/Tier-2 runs transition `agent-committed → integrated` under the concurrent-integration
   CAS. Reindex/finalization run **only** after `integrated`, never off a bare agent-branch
   commit.

   **Normative state set** — success path plus terminals:
   `planned → patched → worktree-applied → agent-committed → [review-pending] → integrated →
   reindexed → finalized`; terminal states `rejected`, `rolled-back`, **`failed`**, and
   **`cancelled`**. Every non-terminal checkpoint may transition to `failed` (validation
   failure, provider permanent failure, broker rejection, internal error) or `cancelled`
   (user abort / `AbortSignal`). `failed`/`cancelled` are recorded with the checkpoint at
   which they occurred (e.g. `failed@patched`, `cancelled@agent-committed`) so recovery is
   deterministic. Their contract:
   - **Before any canonical effect** (`planned`..`agent-committed`, **and `review-pending`** — all
     pre-integration): the agent branch/worktree
     is retained for inspection but **never** auto-integrated; `brain git cleanup` prunes it;
     the run is terminal and **not** auto-resumed (a re-invocation with the same intrinsic
     identifiers starts a fresh run — idempotency keys make that a no-op if already terminal).
   - **`failed`/`cancelled` never leave a half-integrated canonical ref** — the broker is
     atomic, so a failure during integration means the CAS did not apply and the run is
     `failed@integrating` with canonical unchanged.
   - Every `failed`/`cancelled` run appends its terminal event (`run.failed` /
     `run.cancelled`) **exactly once** to the append-only `refs/audit/runs` event stream,
     following whatever lifecycle events (`run.started`, `run.planned`, …) it had already
     emitted. A run's audit footprint is therefore the **one-or-more-event stream** whose
     cardinality is owned solely by *Audit SSOT* — **each terminal event type exactly once
     per run**, never "one event per run". This section defers to that owner.
   Retry/resume eligibility: only jobs (queue layer) retry, per the jobs contract; a terminal
   `failed` **workflow run** does not silently retry — it surfaces in `brain doctor`.

   On startup a reconciler scans for runs left mid-flight: an already-integrated-but-unfinalized
   run is finalized (never re-applied — the integration commit hash is the idempotency anchor),
   a review-pending agent-branch commit is left intact for approval and never auto-integrated,
   an applied-but-uncommitted worktree is committed iff its patch set validates clean against
   the recorded plan hash **and** the base commit is unmoved (otherwise the run is marked
   `failed@worktree-applied` and re-planned as a fresh run), and orphaned worktrees are cleaned.
   Each checkpoint persists — in a single atomic write — the artifacts + hashes that gate its
   next transition (plan hash, patch hash, worktree ref, commit hash), so recovery is a
   deterministic function of the last durable checkpoint; resume is idempotent per checkpoint.
   The full per-state transition table (required artifacts, atomic write, legal next states
   including `failed`/`cancelled` entry conditions, idempotency check, retained artifacts,
   worktree cleanup, audit emission, and recovery action for **every** checkpoint) is a
   normative contract (`docs/specs/recovery-state-machine.md`) landing before Phase 1.
   Ambiguous states fail fast, surface in `brain doctor`, and have a documented operator
   repair flow rather than an automatic guess.

## Repo layout (pnpm monorepo, strict TS)

Two authoritative trees are given so an implementer has no ambiguity: the **physical V1
workspace** (what `pnpm-workspace.yaml` actually declares) and the **logical module map**
(the internal boundaries inside those packages). They are distinct on purpose.

**A. Physical V1 workspace (normative — this is what ships).** V1 declares a small set of
workspace **packages** and keeps everything else as **internal modules** (directories inside
`apps/cli/src/`), because only components with a demonstrated isolation/reuse boundary
(persistence, provider adapters, and the **cross-process contract**) earn a package API in V1:

```
atlas/
  apps/cli/            ← the single CLI application; hosts all internal modules below
    src/
      domain/          CLI-only orchestration types + re-export of `contracts`   (internal module)
      config/          typed config load + startup validation                  (internal module)
      vault/           read/write Markdown, frontmatter, wikilinks             (internal module)
      markdown/        parse + section/AST-level patch generator               (internal module)
      retrieval/       layered retrieve + RRF + context packing                (internal module)
      workflows/       deterministic orchestrator + typed stages               (internal module)
      policies/        note-type mutation policy + risk tiers                  (internal module)
      validation/      deterministic checks (+ optional semantic proposals)    (internal module)
  packages/
    contracts/         stable IDs, ChangePlan + run-manifest Zod schemas, canonical
                       serialization — the leaf cross-process contract (package — no internal deps; Zod only)
    sources/           normalize md/txt/pdf/html in a sandboxed worker   (package — isolation need)
    sqlite-store/      registry, links, runs, plans; DB connection + migration runner
                       (package — persistence; does NOT own the jobs tables)
    lancedb-index/     chunk + embed + hybrid (fts + vector) search      (package — persistence)
    models/            provider-neutral generateText/generateObject/embed (package — adapter)
    git/               branch / worktree / commit / broker client        (package — process seam)
    jobs/              SQLite-backed queue — SOLE owner of jobs/job_attempts schema,
                       repository, txns (retries, backoff, idempotency)  (package — persistence)
    broker/            privilege-separated integration broker (separate OS identity)  (package)
    testing/           fixture-vault helpers                             (package)
  fixtures/  migrations/  prompts/  schemas/  docs/
  AGENTS.md  brain.config.example.yaml  package.json  pnpm-workspace.yaml  tsconfig.base.json
```

**B. Logical module map.** `policies`, `validation`, `workflows`, `vault`, and
`markdown` are first-class *logical* boundaries with the same ownership discipline as
packages, but they live as internal modules of `apps/cli` in V1. They are **promoted to
workspace packages only** when independent reuse/versioning/ownership becomes concrete —
avoiding premature package-API overhead with no V1 consumer.

**The cross-process contract is NOT CLI-internal.** Because the `sqlite-store`, `git`, and **separate-identity `broker`** packages
must all independently produce and verify the **same** stable IDs, `ChangePlan` / run-manifest
schemas, and **canonical serialization** — the broker re-verifies a plan+manifest the CLI
produced, in a different process under a different OS identity — that contract subset lives in
the **leaf `contracts` package** (zero *internal workspace* dependencies; it depends only on Zod
as an external runtime), consumed by both the CLI (`domain`
re-exports it) and the broker. Only CLI-only orchestration types stay in the internal `domain`
module. This guarantees byte-identical canonicalization on both sides of the process seam; the
broker never imports `apps/cli`. Phase deliverables (below) use
the word **"package"** only for the tree-A packages and **"internal module"** for tree-B
boundaries, consistently.

No boundary without a clear owner. Explicit services/adapters/repositories over frameworks.
No cross-boundary "share code via import" hacks that violate the module seam; the
agent-facing code never imports the broker's privileged internals (it calls across the
process seam).

**Jobs in V1.** The `jobs` queue runs **synchronously in the CLI** (no daemon). It persists
job status, attempt count, idempotency key, and retry eligibility. **Single owner of job
persistence.** The **`jobs` package is the sole owner** of the
`jobs` and `job_attempts` tables — their DDL migrations, repository, transactions, and
dependency invariants. `sqlite-store` owns the shared **DB connection + migration runner** and
the *other* operational/projection tables; it exposes the connection/migration harness that
`jobs` registers its own migrations into. **`sqlite-store` does NOT depend on `jobs`** (breaking
any cycle): composition needing a job snapshot for a run (reading job state alongside other
store data) happens in `apps/cli`/`workflows`, which depends on both packages — not inside
`sqlite-store`, which never issues DDL or writes against the jobs tables. There is exactly one owner of the job schema, repository, and
transaction boundary. V1 ships a **persistent single-runner queue**: atomic state transitions, attempt counts,
retry timing/backoff, idempotency keys, transactional recording of side-effect ids (so a
resumed attempt continues rather than repeats — the on-demand path cannot double-commit), and
startup recovery of interrupted jobs. Full lease epochs / fencing tokens / heartbeats /
expiry-based claiming / multi-worker semantics are **deferred** until a daemon or other
concurrent consumer exists; the `lease_epoch` column is **reserved** (written but not
contended in V1) so the schema is forward-compatible, and the concurrent-worker
crash-injection matrix moves to that later milestone. Idempotency keys are unique per
(workflow, key). The **V1 normative jobs contract** (`docs/specs/jobs-contract.md`, landing
with Phase 2) fixes: legal transitions, retry classification + bounded defaults, backoff
schedule, terminal semantics, **process-lock ownership**, and **dead-runner startup recovery**
(a job owned by a crashed runner is reset to `pending` under the process lock). It explicitly
does **NOT** define lease timing: lease duration, renewal/heartbeat, expiry-based reclaim, and
fencing semantics are **deferred in full** to the daemon/multi-worker contract. The
`lease_epoch` column exists (reserved, written, uncontended) purely for forward schema
compatibility — V1 has **no timed lease protocol**, only the process lock plus reserved column.

## Data model

### Note identity & frontmatter
- Human-readable slug filename + **stable frontmatter `id`** (filenames may change, IDs
  never do) + `type` + `schema_version` + `aliases` + `sources` + `created`/`updated` +
  `status`.
- Duplicate `id` = hard error; unresolved duplicate identity is quarantined.
- **Alias/slug identity:** slugs and aliases are canonicalized (Unicode NFC, case-folded,
  whitespace/punctuation-normalized) — by the **single versioned normalization algorithm owned by
  the dependency-free `contracts` package** (with a version id + conformance vectors), consumed
  byte-identically by the CLI vault/validation modules, the projection-rebuild path, and the
  separate broker (unsupported normalization versions rejected) — into a single identity namespace modeled as one table
  `note_identity_keys(normalized_key PRIMARY KEY, note_id, kind ∈ {slug,alias})` with
  `normalized_key` **globally unique** across slugs and aliases (rebuilt before any mutation
  is accepted; each note validated to own exactly one `slug` key); an alias that would collide
  with another note's slug or alias is rejected (or quarantined during bootstrap) **before
  commit**. Resolver precedence for target selection
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
— the raw bytes, stored once; (2) an **origin observation** (a mutable aggregate, not a per-ingest event) with its own
`captureId` recording each distinct `origin` (original path snapshot) plus
`first_seen_at`/`last_seen_at`/`observation_count` (so re-seeing the
same bytes from a new path adds a capture row, not a duplicate blob, while repeat observations of
the same path update counters rather than adding rows; individual observation timestamps are not
retained); and (3) a **normalized
rendition** with `renditionId` = (`contentId`, `extractorVersion`, `normalizerVersion`),
carrying `normalizedContentHash`, `sizeBytes`, and the per-format `locator` scheme
(byte/char offsets for txt/md, page+span for pdf, DOM anchor for html) — so a
parser/normalizer upgrade produces a **new rendition** under the same content rather than
overwriting locator namespaces. Claim evidence references a **`renditionId`** (not the bare
source), pinning exactly which rendition its `locator`/`quoteHash` were computed against. Each
of the three entities has a canonical Markdown manifest form so all are rebuildable.
(`sourceId` is retained as an alias for `renditionId` where the CLI needs a single handle.) Raw bytes are
**copied into the vault** under `sources/` (immutable) so re-extraction is deterministic.
**Deduplication & handle resolution (normative).** Blob identity is
`contentId = (rawContentHash, canonicalMediaType)`. `canonicalMediaType` is the output of a
deterministic media-type normalization step (sniffed MIME signature → a fixed canonical token,
per the normalization contract), so identical bytes that some callers label differently
deduplicate **iff** they normalize to the same canonical media type; media-type normalization applies a **deterministic precedence rule** that maps such polyglot
bytes (e.g. a file that is both valid text and valid HTML) to **exactly one** canonical media
token from bytes alone, so identity is never caller-dependent; any distinct interpretation must
be a validated, explicitly-requested interpretation folded into content identity, and polyglot
conformance fixtures assert ingestion cannot assign divergent identities accidentally. Re-ingesting an existing `contentId` from the **same** `origin` is an idempotent **recapture**
that does not add a row; the `(contentId, origin)` capture row is an **observation record**
carrying `first_seen_at`, `last_seen_at`, and `observation_count` (updated on each re-observation)
rather than one row per physical ingest — so repeated captures of the unchanged file at the same
path are represented without unbounded duplication, while a genuinely **new** `origin` adds a
distinct capture row. A per-ingest idempotency key deduplicates retries from genuine later
observations when updating the counters. A path whose content changed produces a
**new `contentId`** (new immutable blob), never mutating the old one. Handles are unambiguous:
the CLI returns `contentId`, `captureId`, and `renditionId` **separately**; the `sourceId`
alias for `renditionId` resolves to the **active rendition** (the highest
`(extractorVersion, normalizerVersion)` for that `contentId`, recorded in a persisted
`active_rendition_id` on `content_blobs` so lookups are deterministic and stable across
extractor upgrades until an upgrade explicitly re-points it). Parser/normalizer version bumps
that change `normalizedContentHash` produce a new rendition, re-point `active_rendition_id`,
and mark dependent evidence `stale` (see *Claims & provenance*).

**Supported source-format envelope (normative — `docs/specs/normalization-contract.md`,
landing before Phase 2).** Per format (Markdown, plain text, PDF, HTML), the contract fixes:
accepted MIME signatures + canonical media token; accepted text encodings (UTF-8 required;
UTF-16 with BOM accepted; others → deterministic `unsupported-encoding` rejection, never lossy
guess); unsupported feature boundaries (encrypted PDFs → rejected `encrypted-source`; scanned
image-only PDFs with no text layer → rejected `no-extractable-text` (OCR is **out of V1**);
embedded attachments → not extracted, recorded as a represented gap; dynamic/script-driven
HTML → static DOM only, scripts never executed); partial-extraction policy (a document that
extracts cleanly up to a hard parse error yields a **rejected** rendition, never a silently
truncated one — partial success is not "success"); deterministic-output requirement (same bytes
+ same extractor/normalizer versions ⇒ byte-identical `normalizedContentHash` and locator
namespace); per-format size limits; a stable error-code set; and representative conformance
fixtures (malformed, encrypted, scanned, mixed-encoding, oversized, script-bearing). A
"successful normalization" is defined solely as a deterministic, complete extraction meeting
these rules; everything else is a typed rejection the sandbox surfaces to the trusted process.

**Schema:** these three entities map to
`content_blobs` (PK `contentId` = (`rawContentHash`,`canonicalMediaType`); the active-rendition
pointer is **not** a single-column `renditionId` FK but the rendition's **component columns**
(`active_extractor_version`,`active_normalizer_version`) forming — together with the content-key
columns — a composite FK → `source_renditions`, **nullable**, inserted via a two-step
transaction (blob row first with a null pointer, then a validated pointer update after the
rendition exists, or a `DEFERRABLE INITIALLY DEFERRED` composite constraint), with a CHECK that
the active rendition belongs to the same content blob and exactly one is selected) —1─n→ `source_captures`
(PK `captureId` = a deterministic hash of (`contentId`,`origin`); FK `contentId`; `origin`;
**`first_seen_at`, `last_seen_at`, `observation_count`** — a **mutable origin-observation aggregate**,
one row per (`contentId`,`origin`), **UNIQUE(`contentId`,`origin`)**; individual per-observation
timestamps are intentionally **not** retained, `captureTime` is replaced by
`first_seen_at`/`last_seen_at`, and a per-ingest idempotency key prevents retry-driven counter
increments) and
—1─n→ `source_renditions`
(PK `renditionId` = (`contentId`,`extractorVersion`,`normalizerVersion`),
`normalizedContentHash`, `sizeBytes`, `locatorScheme`); `claim_evidence.renditionId` FKs
`source_renditions`, and the `sourceId` CLI alias resolves to `content_blobs.active_rendition_id`.
Each table has a canonical Markdown manifest form that `brain db rebuild` folds back (the
active-rendition pointer is derivable from the manifests, so it too rebuilds deterministically).
**The canonical Markdown serialization for every rebuildable entity (content blobs, captures,
renditions, claims, evidence + verification, `note_sources` links, and vault migrations) is fixed
by a normative vault-format contract (`docs/specs/vault-format.md`, landing before the first
rebuild/ingest implementation in Phase 1): paths, filenames, per-entity document schema, canonical
ordering + escaping, composite-ID encoding, `claims:`/evidence block syntax, unknown-field
preservation, duplicate/conflict handling, validation errors, schema evolution, and atomic
multi-manifest invariants — with round-trip fixtures so independent implementations produce
byte-compatible manifests and a deterministic rebuild.**

### Claims & provenance
Claims carry evidence pinned to a **stable `renditionId`** (+ optional `locator` +
`quoteHash`) and a status (`active` / `disputed` / `superseded`). **Evidence never persists
the mutable `sourceId` alias:** `sourceId` is a CLI-input convenience only — it resolves
through `content_blobs.active_rendition_id`, which a later extractor/normalizer upgrade
re-points, so persisting it would silently change an evidence payload's meaning after a
rendition upgrade. Therefore **`AttachEvidence` accepts either an explicit `renditionId` or a
`sourceId`, resolves the `sourceId` to its concrete active `renditionId` at the command
boundary, and persists only the pinned `renditionId` components** (the `source_renditions`
composite key). The stored evidence row is thus immutable in meaning; a rendition bump does
not silently re-point it — it flows through the explicit staleness/re-verification protocol
below, which re-pins evidence to a new `renditionId` only via a validated ChangePlan. An LLM-generated synthesis must never become an
unmarked source. **Canonical schema (V1):** each claim has a stable `claimId`, an `owningNoteId`, `text`, and a
`status` (V1 exercises only `active`), serialized canonically into its owning note's Markdown
(a `claims:` block) so it is deterministically rebuildable into the `claims`/`claim_evidence`
tables. **Evidence verification state** is modeled separately from claim `status`: each
evidence row carries `verification ∈ {valid, stale, pending, failed}`. **Canonical Markdown is
the single source of truth for `verification`** — it is serialized in the owning note and
rebuilt into `claim_evidence`; SQLite never carries an authoritative verification value that
Markdown lacks (a bare SQLite write would be lost on `brain db rebuild`, so it is prohibited).
All verification-state changes therefore flow through the **normal validated
ChangePlan → patch → git-branch** path, never a direct table update.

**Rendition-upgrade / evidence-staleness protocol (normative).** When a normalizer/extractor
bump produces a new rendition with a changed `normalizedContentHash` and re-points
`content_blobs.active_rendition_id`:
1. The set of affected evidence rows is **deterministically enumerated** = every **current
   (non-tombstoned) evidence head** whose `renditionId` belongs to the superseded `contentId`
   (tombstoned/superseded rows are excluded — each evidence lineage has exactly one current head,
   enforced by a `tombstoned_at`/`current` marker and an invariant query, so a later upgrade never
   re-selects historical evidence or branches supersession chains).
2. **Activation is a durable transaction:** re-pointing `active_rendition_id` and recording the
   **complete expected owning-note job set** commit atomically (or via a broker-owned outbox); a
   startup reconciler deterministically re-derives the expected set (every current stale evidence's
   owning note) and inserts any missing idempotency key, so a crash between activation and enqueue
   can never leave a note permanently stale with its job uncreated (crash tests cover each
   activation/enqueue boundary). A single **re-verification job** is enqueued per affected owning-note (batched per note so
   one note's evidence is patched in one workflow run, avoiding partial multi-note drift). The
   job's idempotency key = (`contentId`, new `renditionId`, **`owningNoteId`**) — the
   `owningNoteId` component is **required** so that the per-`(workflow, key)` uniqueness
   constraint admits **one job per affected owning-note**, not just the first note touched by a
   rendition bump. (A rendition upgrade affecting N notes therefore enqueues N distinct jobs,
   each idempotent on retry, and none suppresses another; no affected note is left with stale
   evidence because its job collided with a sibling note's key.)
3. The job runs a **deterministic re-anchoring** of each affected evidence to the new
   rendition's locator namespace: it re-locates the recorded `quoteHash` in the new normalized
   text. **Only evidence carrying both a `locator` and a `quoteHash`** (plus enough retained
   canonical normalized text from the pinned old rendition to recover the exact quoted span) is
   eligible for automatic re-anchoring; **evidence lacking that data (legacy or location-free)
   is routed deterministically to `pending`** (operator resolution) and never auto-matched — a
   `locator` + `quoteHash` is required for any evidence that may become `valid`. Outcomes are
   transactional per owning note, applied as one validated ChangePlan
   (`UpdateEvidenceVerification` operations) committed on an agent branch:
   - **exact re-match** → `valid`; re-anchoring is an **atomic supersede** that inserts a new
     evidence record (new immutable `evidenceId`, new `renditionId`/`locator`, new payload-hash)
     and **tombstones the old one** linked by `supersedesEvidenceId`, so the derived-payload
     UNIQUE index never collides and ledger references to the former `evidenceId` stay
     interpretable via the tombstone;
   - **ambiguous / moved** (quote found but relocated, or multiple matches) → `pending`,
     escalated to Tier-3 review (never auto-committed);
   - **not found** → `failed`.
4. Until re-verification completes, affected evidence is marked `stale` (the transitional
   state that triggered the job).

**Effective staleness is computed, not awaited:** any evidence whose pinned `renditionId`
differs from its content blob's current `active_rendition_id` is treated as **stale for gating
immediately upon activation**, independent of (and ahead of) the asynchronously patched Markdown
`verification` status — so re-pointing `active_rendition_id` atomically renders all old-rendition
evidence non-`valid` before any ordinary workflow resumes, closing the activation↔invalidation
window. **Gating by verification state (normative):** evidence that is (computed- or persisted-)
`stale`, `pending`, or `failed`
**MUST NOT** support Tier-2 auto-commit and **MUST NOT** be presented to synthesis as trusted
grounding; retrieval MAY surface such evidence but **only flagged as unverified**. A claim all
of whose evidence is non-`valid` is treated as unsupported for auto-commit purposes. This
prevents silent accumulation of permanently stale claims from changing gating behavior. Retry
limits, the `pending`/`failed` operator-resolution commands, and successful/ambiguous/failed
re-verification acceptance cases are in the retention + acceptance contracts.

**Deferred** until a concrete contradiction-resolution workflow is designed +
accepted: structured predicates, the `active → disputed → superseded` transitions, and
`supersedes`/`disputes` inter-claim references (columns may exist for forward-compatibility
but no V1 workflow drives them — contradiction erasure is explicitly Tier-3/review-only). Evidence identity uses an **immutable surrogate `evidenceId`** (assigned once, never derived
from mutable fields), with idempotency enforced by a **separate UNIQUE index over the derived
payload hash** of tagged (`claimId`,`renditionId`,`locator`,`quoteHash`) values (absent `locator`/`quoteHash` encoded
as explicit sentinels, never SQL NULL — so a unique index cannot be bypassed by
NULL-distinctness), with checks defining the valid `locator`/`quoteHash` combinations —
making `AttachEvidence` idempotent.
`CreateRelationship` writes a typed relationship (predicate + source/target `noteId`) as a
canonical typed wikilink in frontmatter, rebuilt into `note_links`. Validation rejects
dangling `sourceId`/`noteId`/`claimId` references and duplicate evidence. **Note-level provenance
(`note_sources` + frontmatter `sources`) pins the immutable `contentId`** (composite
raw-hash + canonical-media-type components) when a note cites a raw source generally, or the
**`renditionId` composite components** when it must cite a specific extraction — **never the
mutable `sourceId` alias**, whose meaning a rendition upgrade would silently change. The data
dictionary fixes cardinality, the composite FK, uniqueness, upgrade behavior, and the rebuild
rule for `note_sources`.

### SQLite tables (V1 subset)
`notes, note_identity_keys, note_links, content_blobs, source_captures, source_renditions,
note_sources, claims, claim_evidence, vault_schema_migrations,
jobs, job_attempts, agent_runs, model_calls, retrieval_runs, retrieval_results, change_plans,
patches, patch_operations, validation_results, git_operations, db_schema_migrations,
audit_events, audit_outbox, egress_outbox, audit_seq`. The two durable outboxes (`audit_outbox`
for integration-audit events, `egress_outbox` for egress audit-record submissions) and the
monotonic `audit_seq` allocator are **broker-owned** (broker-only writes via authenticated IPC),
reside in the broker-owned security database (see *Two classes of state*), and carry `eventId`
UNIQUE + delivery-state columns; their PK/uniqueness, sequence allocation, delivery/retry
transitions, backup/restore, retention, and purge treatment are fixed in the data dictionary +
state inventory.
FKs on, WAL considered, content-hash change detection, idempotent upserts. A **versioned index
contract** (Phase 0) maps concrete access patterns to composite indexes — job eligibility by
(`state`,`next_run_at`), bidirectional `note_links` traversal, run lookup by `status`,
identity resolution on `note_identity_keys(normalized_key)`, notes-needing-index scans by
(`active_generation`,`contentHash`), and audit lookup by `run_id` — verified with query-plan
assertions at the **evidence-based V1 vault profile plus its growth margin only** (maximum-scale
profiles are deferred until measured usage establishes a concrete larger target).

**Two migration ledgers, never conflated:**
- **`db_schema_migrations`** — the operational ledger of applied **SQLite DDL** migrations
  (id, applied_at, checksum). It is an **operational ledger table**, NOT a vault projection —
  `brain db rebuild` **never** touches it, because rebuilding a projection must not forget
  which DDL is live. `brain db migrate` (running before any rebuild) is the sole writer.
- **`vault_schema_migrations`** — the canonical **note content-schema** history (which
  `schema_version` upgrades have been applied to vault Markdown). This *is* a vault projection,
  rebuilt from Markdown. It has no bearing on SQLite DDL.
- **Ordering invariant:** `brain db migrate` (DDL) runs to completion before any
  `brain db rebuild` (projection repopulation); both are crash-idempotent (checksum-guarded
  DDL steps; transactional projection replacement).

**Normative schema (data dictionary).** The complete per-table DDL — every column, SQL type,
PK/FK, nullability, uniqueness, CHECK constraints, cardinalities, ON DELETE behavior, and the
conflict target for every upsert — is a **versioned normative contract**
(`docs/specs/sqlite-data-dictionary.md`, landing in Phase 0, before any persistence code).
It is authoritative; this section states the binding rules the dictionary MUST satisfy:
- **Composite identifiers are represented as their component scalar columns** (never a packed
  string). `content_blobs` PK = (`raw_content_hash`, `canonical_media_type`);
  `source_renditions` PK = (`raw_content_hash`, `canonical_media_type`, `extractor_version`,
  `normalizer_version`). Dependent tables that "reference a `renditionId`" carry the **same
  component columns** as a composite FK — there is no single-column `renditionId`/`contentId`
  FK; the CLI-facing single "handle" is a serialized convenience only, resolved to components
  at the boundary.
- `claim_evidence` has a **non-null immutable surrogate `evidence_id`** (generated once, never
  derived from mutable fields — stable across re-anchor/tombstone) **plus a separate non-null
  `payload_hash` column** (hash over tagged `claimId,renditionId,locator,quoteHash` with explicit
  sentinels for absent locator/quoteHash) carrying the **UNIQUE index** that makes `AttachEvidence`
  idempotent; a retry recreating a tombstoned payload resolves to the existing tombstone rather
  than colliding; `verification` is a CHECK-constrained enum `{valid,stale,pending,failed}`.
- Every table that participates in an upsert declares its **conflict target** and merge
  behavior in the dictionary; ownership/`ON DELETE` (cascade vs restrict vs tombstone) is
  specified per FK per the retention matrix (audit-referenced rows tombstone, never cascade).
- The dictionary ships with **invariant-validation queries** (e.g. exactly one `slug` key per
  note; no dangling evidence FK; active-generation consistency) that `brain db verify` runs.

**Two classes of state — only one is a vault projection:**
- **Vault projections** (`notes, note_identity_keys, note_links, content_blobs,
  source_captures, source_renditions, note_sources, claims, claim_evidence,
  vault_schema_migrations`) are deterministically rebuildable from canonical Markdown.
  `brain db rebuild` rebuilds *only* these, replacing them inside one transaction.
- **Operational/audit ledger — PRIMARY state, not rebuildable from Markdown**
  (`jobs, job_attempts, agent_runs, model_calls, retrieval_runs, retrieval_results,
  change_plans, patches, patch_operations, validation_results, git_operations,
  db_schema_migrations, audit_events`). It has **no Markdown representation**; it is durable
  primary state that **MUST be backed up**. **Security-authoritative tables (`audit_events`,
  `audit_outbox`, `egress_outbox`, `audit_seq`, the authorization nonce/replay state, and the
  backup watermark) live in a SEPARATE broker-owned SQLite database that agent OS identities
  cannot open or write** — SQLite file permissions cannot enforce table-level ownership, so these
  are physically isolated from the agent-writable operational DB, all writes flow through
  authenticated broker IPC, and the CLI sees only sanitized read models. `brain db rebuild` preserves it untouched (it
  replaces projection tables in one transaction, never reads or truncates ledger tables).
  **Ledger tables reference notes/sources/claims only by immutable scalar historical identifiers
  (no SQL FK from ledger into the replaceable projections)**; stable identity/tombstone rows
  survive a rebuild, so delete-and-reinsert of projections can never violate a restrictive FK or
  invalidate ledger history (the data dictionary fixes this cross-class reference model and
  rebuild tests retain ledger references to deleted/quarantined entities). Its
  authoritative disaster-recovery path is the **required, tested, encrypted SQLite ledger
  backup/restore** (see *Ledger backup subsystem* and *Audit SSOT*). The git audit ref is a
  **best-effort partial** cross-check only, never the ledger's DR system of record.

**Complete state inventory (normative — `docs/specs/state-inventory.md`).** The two-class model
above is not the full set of primary state: the **broker-owned trust-ledger ref**, the **backup
watermark + backup catalog**, the **external WORM audit-head anchor**, the **authorization
nonce/replay state**, and the **encrypted quarantine store** are each additional primary state.
The state-inventory contract enumerates every persistent store with its authority, owner,
rebuildability, backup source, restore ordering, consistency checks, retention, purge behavior,
corruption response, and fail-closed behavior — and explicitly defines how trust state,
watermarks, anchors, nonces, and quarantine are reconciled (forced fail-closed on disagreement)
after any restore. **A single machine-readable persistent-store registry** (owning every store's
authority, owner, sensitivity, rebuildability, retention, backup, restore ordering, and purge
behavior) is the sole owner of persistent-store membership; the state inventory, retention matrix,
backup coverage, and the purge storage-class inventory are all **generated from / validated against
that one registry** (a CI check fails on any divergence), so adding a store cannot leave one
inventory stale. Losing the trust ledger forces all affected content to untrusted until an
authorized repair completes (see *Untrusted-input trust model*).

**Three DR guarantees, stated separately:**
1. **Projection rebuild** — `brain db rebuild` + `brain index rebuild` reconstruct SQLite
   vault-projection tables and all of LanceDB, deterministically, from Markdown alone. This is
   complete and lossless for projections.
2. **Ledger restore** — the operational/audit ledger is recovered **only** by restoring the
   encrypted `sqlite.ledger_backup` (see *Ledger backup subsystem*). It cannot be rebuilt from
   Markdown. Data-minimized raw fields (never in the git audit ref) are recoverable **only**
   from this backup — subject to the retention policy that governs whether they exist at all
   (see *raw-payload retention*, below and in *At-rest & data-minimization*).
3. **Partial git-audit fallback** — `brain db rebuild --from-git` folds `refs/audit/runs`
   events to reconstruct **mutating-run** ledger rows **best-effort** when both SQLite and its
   backup are lost; read-only/projection-only/failed/cancelled events are recorded for
   cross-check but reconstruct only the metadata the event carries, and missing/orphaned
   commits surface as explicit gaps. This is a degraded audit reconstruction, never equivalent
   to (1) or (2).

Retention/backup is a config concern (`sqlite.ledger_retention` default keep-forever;
`sqlite.ledger_backup.*`). This is what keeps runs inspectable and external transmissions
audited across a projection rebuild.

**Raw-payload retention — one policy, applied everywhere.**
Raw prompts, model responses, quotes, and retrieved content are **NOT persisted anywhere by
default** — the audit event, the ledger, logs, and the git ref all carry only the allowlisted
metadata schema (identifiers, hashes, classifications, destinations, metrics). Therefore, by
default, **raw payloads are not recoverable from any backup** — there is nothing to recover.
An **optional, opt-in encrypted payload store** (`sqlite.raw_payload_store`, default **off**) is
**deferred out of V1 as a later isolated feature** — V1 persists only metadata + payload hashes
and has no raw-payload recovery. Its specified behavior is retained here as forward design: when on, raw payloads live in a **separate, AEAD-encrypted,
non-audit store** (its own table + key, minimized filenames, bounded retention, included in the
ledger backup) — never inline in the audit event or the allowlisted ledger rows. Every section
that mentions raw-payload recoverability defers to this rule: default = never stored, never
recoverable; opt-in = recoverable only from the dedicated encrypted store's backup.

**Ledger backup subsystem (normative — finding: no delivery mechanism).** The primary DR path
is delivered by a concrete V1 subsystem, not just a config key:
- **Snapshot method:** a **versioned, AEAD-encrypted backup bundle** taken at a shared **cut
  identifier**: the SQLite Online Backup API snapshot (consistent, no reader/writer stall) **plus
  every required broker-owned primary-state artifact** — the trust-ledger ref object graph (or its
  broker-owned SQLite trust journal, from which the ref is deterministically restored), the backup
  catalog, the authorization nonce/replay state, and the encrypted quarantine metadata — each with
  its own content hash, a defined restore ordering, and fail-closed reconciliation on mismatch.
  Externally durable state such as the WORM audit/trust-head anchor is **verified against**, not
  restored from, the bundle. Per-component packaging, the cut protocol, and restore/reconciliation
  order are normative in the state-inventory + backup contracts.
- **Trigger policy (V1, no scheduler):** a backup is taken (a) automatically after **every run
  that writes ledger rows** (post-commit) and (b) on demand via **`brain db backup`**. This
  gives an effective **RPO of one run**. **Backups are non-recursive:** each snapshot covers a
  fixed **ledger sequence cut** taken at snapshot start, and the backup's own
  completion/watermark-advance writes are **exempt from triggering another post-run backup** —
  they fold into the next externally triggered snapshot. Crash recovery treats ledger rows
  committed after the cut as covered by the next snapshot, never a lost gap.
- **Backup failure fails CLOSED.** The post-run
  backup is the ledger's sole authoritative DR path, so its failure MUST NOT be silently
  best-effort. A durable **backup watermark** records the highest ledger sequence covered by a
  verified backup (`backup_watermark_seq`, its own ledger-adjacent row). After a ledger-writing
  run the broker attempts the backup with **bounded durable retries + backoff**; on success it
  advances the watermark to the run's ledger sequence. If the backup cannot be verified,
  `brain doctor` and the `--json` health surface report a **degraded** state, and the system
  **blocks further ledger-writing runs** — mutating workflows, `approve`, `rollback`, `purge`,
  **and any audited/model-backed read-only run** (per the preview rule above, since it too
  writes ledger rows) — with a stable **`backup-unhealthy`** error (exit `2`) **until a verified
  backup covers the latest ledger sequence** (watermark caught up). **Only genuinely
  non-persisting diagnostics** (pure `inspect`/`status`/`doctor`/`--json` health that write no
  ledger row) stay available; audited/model-backed reads are blocked precisely because they
  would advance the ledger past the failed watermark. **`db restore` is explicitly NOT
  blocked:** restoring a verified prior backup is the recovery path when the live DB cannot
  itself produce a new verified backup, so it runs via a broker-authorized **emergency restore**
  that verifies the selected backup, restores it atomically, establishes a fresh watermark, and
  records the accepted loss window — without first requiring a backup of the unusable database.
  A per-command **degraded-mode matrix** (blocked vs. non-persisting-allowed vs. emergency-restore)
  is normative in the CLI contract. An operator may proceed only via an explicit, audited **privileged override**
  (`brain db backup --force-unblock`, under the separation-of-duties boundary) that records the
  accepted-RPO-gap in the audit stream; there is no path in which repeated backup failures
  silently accumulate unrecoverable ledger rows.
- **Failure model (normative — what V1 promises to survive):** the default beside-the-DB
  destination covers **logical corruption, accidental deletion, and process crashes** (RPO one
  run); it does **not** by itself survive filesystem/device/host loss. V1 therefore either
  requires a configured destination on an **independent failure domain** (validated by
  `db verify --backup`) or, if left local, **narrows the guarantee to local logical recovery**
  and documents an operator-owned off-device replication procedure with its RPO/RTO.
- **Destination / key handling:** configurable local path (default beside the DB, mode 0600);
  AEAD key in the OS keychain / hardware-backed store (never in the vault or env), with defined
  rotation/revocation — same key custody rules as quarantine.
- **Atomicity:** write-temp-then-atomic-rename; a partially written backup is never selectable.
- **Retention:** `sqlite.ledger_backup.keep` (default keep-N + keep-forever latest).
- **Integrity:** each backup carries a stored content hash + schema-version stamp; **`brain db
  verify --backup`** validates decryptability, hash, and schema compatibility.
- **Restore:** **`brain db restore <backupRef>`** — a **privileged, destructive** operation
  under the separation-of-duties boundary (user-presence / signed authorization), acquiring the
  exclusive vault-maintenance lock; it verifies integrity + schema, restores the ledger tables
  transactionally, then triggers a projection rebuild + index rebuild so projections re-derive
  from Markdown around the restored ledger. Interrupted restore is atomic (all-or-nothing).
Phase ownership: the backup/restore subsystem lands in **Phase 1** alongside `sqlite-store`
(the ledger exists from Phase 1); destructive restore + corruption tests are Phase-1 exit
criteria. Backup/restore CLI: `brain db backup|restore`, plus `db verify --backup`.

**Job lifecycle** — `jobs` rows carry a state enum (`pending → claimed → running →
succeeded | failed | cancelled`), `attempt`/`max_attempts`, `lease_epoch`, `next_run_at`
(backoff), `idempotency_key` (unique per workflow+key), and a `result`/`error` JSON payload.
Legal transitions, startup ownership/lock-based recovery of interrupted jobs (no lease-expiry
reclaim in V1 — the `lease_epoch` column is reserved but uncontended), terminal states,
cancellation-of-queued-vs-running, and deterministic responses for
terminal/concurrently-changing jobs are defined in the jobs package contract; see CLI
`brain jobs`.

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
(`noteId`, `contentHash`, `chunkerVersion`, `chunkerImplVersion`, `embeddingProvider`,
`embeddingModel`, **immutable model revision / capability fingerprint**, `embeddingRequestParams`,
`embeddingDimensions`) — if the provider exposes no stable revision, an observed model
fingerprint change **mints a new generation** and writes are never merged across fingerprints. Chunks
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
When normalizing HTML/PDF, the `normalization-contract.md` fixes **per-format semantic mapping
rules** — deterministic preservation/conversion of heading hierarchy, lists, descriptive link
labels, tables (with headers + captions), and textual summaries for visual data — and normalized
renditions are validated against the Markdown accessibility rules before acceptance. In addition,
meaningful images/diagrams/icons must carry equivalent text:
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
  `CreateRelationship`, `CreateClaim`, `AttachEvidence`, `UpdateEvidenceVerification`,
  `ProposeMerge`, `ProposeRename`
  (title/slug/filename/alias only — never `id`), `ProposeArchive`, `ProposeDelete` (Tier-3-only, dependency-checked note-deletion proposal — the review-gated deletion `maintain`/`reconcile` emit, distinct from selector-based `brain purge` erasure), `PromoteTrust`, `RevokeTrust`,
  `CreateTask`, `UpdateTaskState`, and the **`CaptureSource` operation family** (versioned
  operations for raw-blob creation, capture-event + rendition manifest creation, destination
  paths, content/normalized hashes, expected-absence/idempotency preconditions, and atomic
  multi-file commit of the linked content-blob/capture/rendition set — the sole canonical
  mutation permitted in Phase 2, enumerated in the Phase-2 allowlist and recovery-state-machine
  artifacts). **Each operation has its own versioned, discriminated-union
  payload schema** (required/optional fields, constraints, precondition tokens — e.g. section
  selector + expected content hash, frontmatter value types, relationship-predicate enum,
  rename destination fields, task-transition guards — canonical serialization, and
  per-operation result + error codes), defined in the per-operation ChangePlan schema — the
  **ChangePlan envelope + run-manifest schema lands in Phase 1** (in the `contracts` package),
  while the **per-operation payload schemas are phase-gated with the phase that first exercises
  each operation** (source-capture ops before Phase 2, synthesis ops before their phase), per
  the contract-to-phase matrix; "Phase 0" denotes the design-contract tier, not an
  all-before-Phase-1 gate. Common envelope: each op carries target, rationale, **supporting
  provenance as pinned `contentId`/`renditionId` component references** (never the mutable
  `sourceId` alias), **retrieved-evidence references as identifiers + hashes only** (never raw
  quotes or retrieved content — any optional raw material lives exclusively in the deferred
  encrypted payload store), confidence, **`proposedRisk`** (model advisory only), reversibility,
  and an optional caller `idempotencyKey`. **`CreateTask`/`UpdateTaskState` and the `task` note
  type are reserved forward-compatible surface (per the *Scope* non-goals):** their schemas
  ship and validate so a future task workflow slots in without a schema break, but **no V1
  workflow, CLI command, or acceptance criterion exercises them**, and the validation layer
  **rejects any ChangePlan containing a task operation** in V1 (a fail-closed guard, so the
  reserved surface cannot be driven accidentally). This is deliberate in-scope schema, not a
  shipped task capability — the *Scope* list and this section agree on that classification.
- **Effective risk has exactly one *authoritative* producer — the broker.** The deterministic
  policy definitions + canonical configuration live in one shared versioned contract consumed by
  both the CLI `policies` package and the broker; the CLI's `effectiveRisk`/`effectiveSensitivity`
  computation is **non-persisted preview output only**, while the **broker's independent
  recomputation at the privilege boundary is the sole authoritative, persisted value** that gates
  integration and egress. The model's `proposedRisk` is never trusted. Because both sides derive
  from the same versioned contract they cannot drift, and only the broker result is
  gating-authoritative (any CLI value that disagrees is discarded in favor of the broker's).
- **Caller idempotency.** **Every state-changing command is classified** as either
  *key-accepting* or *intrinsically idempotent* — with **no command left unclassified**.
  Key-accepting (accept `--idempotency-key`,
  persisting a normalized request hash + terminal result): `ingest`, `enrich`, `reconcile`,
  `maintain`, `source add`, `source trust promote`, `source trust revoke`, `jobs run`,
  `jobs retry`, `jobs cancel`, `git approve`, `git refresh`, `rollback`, `db backup`,
  `db restore`, `purge`, `bootstrap resolve` (operation identity = (quarantine-category selector digest, resolved-inventory digest, canonical base hash); a safe retry returns the prior resolution, a concurrent duplicate blocks on the persisted key, and it checkpoints per resolved quarantine so a rerun never re-applies a completed one). Intrinsically idempotent (converge on repeat, no key needed): `git reject`,
  `git cleanup`, `git verify`, `index repair`, `index rebuild`, `db migrate`, `db rebuild` —
  each a no-op or deterministic convergence when already in the target state.
  - **`git refresh` is key-accepting** because it *creates* a new agent commit + manifest +
    supersession record. Its **operation identity** = (`runId`, superseded-commit hash, current
    canonical base hash); a retry after a lost response with the same identity returns the
    already-created refreshed commit rather than producing a second one. If canonical moved
    since (base hash differs), the request hash differs → it is a **new** refresh, correctly.
    A crash after creating the new commit but before persisting is reconciled by the state
    machine (the supersession + new-commit hashes are written in one atomic checkpoint).
  - **`git verify` is intrinsically idempotent (convergent repair):** it computes the target
    consistent state (manifest↔index reconciliation) and applies **only** the delta needed to
    reach it; on a already-consistent store it is a pure no-op. Repeated runs converge to the
    same state and never stack repairs, because each run re-derives the target from current
    state rather than replaying a log. Repairs it performs are themselves audited but carry no
    caller key.
  For key-accepting commands:
  identical retries return the original result; key reuse with different input is rejected;
  concurrent duplicate invocation blocks on the persisted key rather than double-executing;
  already-completed state transitions are no-ops that report the prior outcome. Request-hash
  inputs + key scope per command are enumerated in the CLI contract. **V1 scoping:** with no
  daemon/MCP/cloud caller, correctness relies first on **intrinsic identifiers** — content
  hashes for source ingestion, `jobId` for queue ops, `runId` + terminal-state checks for git
  ops, and the persisted workflow state machine; the caller `--idempotency-key` +
  cross-command request-hash layer is retained only for the demonstrated repeatable-automation
  path and stays minimal until an MCP/cloud client exists.
- Patches are section/AST-level (not whole-file rewrites), preserve unknown frontmatter and
  formatting, fail safely on stale context, produce human-readable diff summaries.
- **Risk tiers** gate git behavior:
  - **Tier 0** read-only (search/answer/inspect) — **no mutation of the canonical branch or
    the vault working tree.** The one stated exception is that an *executed* Tier-0 command
    causes the broker to append a single terminal `run.readonly` event to the broker-owned,
    append-only `refs/audit/runs` audit ref (see *Audit SSOT* / *Tier-0 audit exception*
    below). That audit-ref append is **not** a canonical or vault mutation and does not create
    a canonical commit; it is the explicit, enumerated exception to "no git mutation," and it
    is performed only by the broker, never by an agent or read path directly.
  - **Tier 1** safe writes (add source, append log, inbox item) — auto-commit.
    *Projection-only* operations (index rebuild/repair, db rebuild) mutate no Markdown, so
    they create **no canonical git commit** and are not git-tier-gated. Like Tier-0 they are
    the enumerated audit exception: an executed projection-only command causes the broker to
    append exactly one terminal `run.projection` event to the append-only `refs/audit/runs`
    ref (never a canonical commit or working-tree change) in addition to the ledger record —
    see *Tier-0 / preview audit exception*
  - **Tier 2** structured updates (update project/person, enrich concept, add sourced
    claims) — auto-commit when confidence + validation thresholds pass
  - **Tier 3** high-risk (merge, delete, archive, resolve contradiction, rewrite
    large synthesis, schema migration) — **review required by default**
  - **Tier 4** external actions — out of V1 scope

  **Concurrent integration.** *Every* canonical integration performs a transactional
  compare-and-swap against current canonical state: it re-checks the recorded base commit and
  the target notes' content hashes before committing. On mismatch (canonical moved since the
  run's base) the behavior is **tier-dependent**:
  - **Tier-1/Tier-2 (auto-commit):** rebase, regenerate/reapply the section patches, repeat
    retrieval + validation for any input that changed, and only then commit under the CAS; it
    never fast-forwards a patch computed against stale note state.
  - **Tier-3 (review-required):** a stale base is **never** silently rebased into an approved
    commit — rebasing produces a new commit and voids the approval signature bound to the
    exact commit. Instead the run is refreshed via `brain git refresh` (rebase + regenerate +
    re-validate → new agent commit + manifest, old review artifact marked superseded) and
    transitions **back to `review-pending`, requiring a fresh approval signature over the new
    commit**. `approve` refuses any operation that would alter the signed commit.

## Git workflow
Human work stays on the primary branch; agent operations run in isolated branches/worktrees.
One workflow run → one commit (or small series) carrying a **signed run manifest** (workflow,
run ID, source IDs, changed note IDs, effective risk, validation status, plan hash). The
manifest's effective-risk/sensitivity are the CLI's non-authoritative **proposed** values; the
broker independently recomputes and persists the sole gating-authoritative values at
integration (deterministic policy lives in one shared versioned contract consumed by both the
CLI and the broker, so the two cannot drift).

**Audit SSOT.** The SQLite operational ledger is the **system of record** for audit and
external-transmission history; a **required, tested, encrypted backup/restore path**
(`sqlite.ledger_backup`) is its primary disaster-recovery mechanism (see *Ledger backup
subsystem*). In addition, a **protected append-only git audit ref** (`refs/audit/runs`, never
rebased or force-updated, broker-owned) records a **signed lifecycle event stream**. This
universal signed audit stream is **intentionally in V1 scope** (operator directive): the value
is a tamper-evident, SQLite-independent cross-check for every command, and the *Scope* list
names it as an in-V1 capability. It is a **cross-check**, not a second DR system of record —
the ledger + encrypted backup remain the ledger's authoritative DR path; the git ref folds
back only **best-effort**.

**Tier-0 / preview audit exception.**
Advancing the append-only `refs/audit/runs` ref is defined to be **neither a canonical-branch
mutation nor a vault-working-tree mutation** — it is a broker-owned write to a dedicated audit
ref that never touches the canonical branch, note files, or working tree, and never creates a
canonical commit. This is the single, explicitly enumerated exception to the Tier-0 "no git
mutation" guarantee and to the "no commit" guarantee: an **executed** Tier-0 read-only command
(`query`/`inspect`/`status`) and an executed projection-only command emit exactly one terminal
`run.readonly` / `run.projection` event to the audit ref, and nothing else in git changes.
**A preview that makes no model/egress call is a pure computation and emits NO audit-ref event
at all** — it has no run to record, so the "no side effects, no commit" contract holds
literally. **A preview that DOES make a model/egress call (e.g. Phase-2 extraction/classification
or later synthesis previews) is instead an audited read-only run:** it records `model_calls`/
`retrieval_runs` in the ledger, the egress broker's per-call records are referenced from it, and
it emits **exactly one terminal `run.readonly` event** on `refs/audit/runs` (still no branch,
worktree, commit, or canonical/vault mutation). Such model-backed previews are ledger-writing
runs and are therefore subject to backup-health gating like any other ledger writer. The
git-rebuild requirements consume these `run.readonly`/`run.projection` events for cross-check
only; they reconstruct no canonical content, consistent with the audit ref being a
non-canonical cross-check rather than vault state.

**Event-stream model.** This section is the **sole
normative owner of audit-event cardinality**; every other section (the state-machine
invariant, the observability matrix, acceptance) defers to it and MUST NOT assert a
different count. The governing rule is **each terminal event type exactly once per run**,
preceded by the lifecycle events that run passed through — **never** "exactly one event per
run". A run is **not** one mutable event —
`refs/audit/runs` is an **append-only stream of one-or-more lifecycle events per run**,
correlated by `runId` and ordered by a per-ref monotonic `seq`. **Every event carries a
producer-stable `eventId`** (a deterministic hash over run id, checkpoint occurrence, and event
type — so a repeatable checkpoint such as a `refresh`-produced lifecycle event has a distinct,
stable occurrence identity) used as the broker's uniqueness/deduplication key; the durable outbox
acknowledges by `eventId` and retries are idempotent against it, so `(runId, type)` collisions
from legitimate repeats never double-append. **Ledger↔ref dual-write protocol (normative):** the
broker persists the event payload **and its allocated `seq`** in a broker-owned outbox
transaction (SQLite), appends idempotently to `refs/audit/runs` keyed by `eventId`, then marks
the outbox row delivered; recovery replays undelivered outbox rows on startup and `git verify`,
and every crash point — SQLite-committed/Git-missing and Git-appended/SQLite-outbox-unmarked — is
reconciled deterministically (no ledger-only event, no Git-only event, no reused or gapped `seq`)
rather than claimed atomic. Defined event types (a **versioned discriminated union** with required + optional fields **per
type** — early events such as `run.started` carry no agent/integration hash, so those hash
fields are optional and populated only on the events whose checkpoint has produced them):
`run.started`, `run.planned`, `run.agent_committed`, `run.review_pending`, `run.integrated`
(carries the integration commit hash — appended as a **new event** after the commit exists,
never mutating an earlier event on the append-only ref), `run.reindexed`, `run.finalized`,
`run.rejected`, `run.rolled_back`, `run.failed`, `run.cancelled`, and the read-only /
projection-only `run.readonly` / `run.projection` terminal events. Per-provider-call auditing adds versioned **`egress.request`** and **`egress.result`** event
types (stable `callId`, `runId`, destination, payload hash, `effectiveSensitivity`, outcome,
idempotency key) so a run that makes multiple model calls records each; fold rules define
ordering for a crash between dispatch, response receipt, ledger persistence, and terminal run
emission. Deterministic fold rules are
defined for every valid sequence. Each event carries `runId`, `seq`, `type` (always), plus the **type-appropriate optional
fields** — base/agent/integration commit hashes, plan/patch hashes, changed note/source IDs,
effective risk, validation outcome, job snapshot + attempt outcomes, and references (ids/hashes)
to model-call and retrieval records — present only once the emitting checkpoint has produced
them, **allowlisted metadata only** (never raw payloads).
**Fold rules:** `brain db rebuild --from-git` reconstructs mutating-run ledger rows by folding
a run's event sequence — `run.integrated` supersedes the prior review-pending projection,
`run.rejected` marks the run terminal-rejected, `run.rolled_back` appends a revert record
(never rewriting the reverted run's events), and missing/orphaned/rewritten commits and `seq`
**gaps** surface explicitly rather than being silently dropped. It is **not the sole DR path**:
records whose payloads live only in the (optional, opt-in) encrypted store are recovered from
its backup, not from git; by default raw payloads are absent everywhere (see *Raw-payload
retention*). `brain git verify` detects and repairs manifest↔index mismatches after rollback,
cleanup, rebuild, or manual git edits, and validates the audit-head external anchor.

**Audit attestation (distinct from approval).** Every audit event on `refs/audit/runs` is
signed with a dedicated **audit-attestation key** whose only capability is signing audit
events — it grants no approval or integration authority and is a separate trust root from the
human-approval signing key. For automatic Tier-1/Tier-2 runs the agent process may hold the
attestation key to **sign only explicitly-labeled agent claims**, which are never treated as an
independent security cross-check. **Every security-relevant event field** (model-call,
retrieval, validation, risk, commit hashes, sequence) is **constructed or independently
re-verified by a broker from observed IPC, git objects, trusted policy results, and broker-owned
sequence state, and signed with a broker-held key**; ledger writes recording security-critical
actions are appended through authenticated broker APIs, not written directly by the agent. The
approval key stays unreadable to agents. **The signed event payload is still handed to the
broker, which is the sole writer of the `refs/audit/runs` ref** — the attestation key signs
content, it does not grant permission to advance the protected audit ref (that stays a broker
capability, so a compromised agent still cannot truncate or forge the ref). The signature
envelope (Ed25519 over a canonicalized event), signer identity, protected OS-keychain key
storage, rotation, revocation, and rebuild-time verification (revoked/missing signatures
surface as gaps, never silently trusted) are defined in the git/broker package contract. Audit
attestation is never conflated with Tier-3 approval authorization.

**Review lifecycle & command semantics:**
- `status` — lists open agent branches/worktrees with run id, risk, validation, base commit.
- `review` — shows the diff + manifest for one run (read-only).
- `approve <runId>` — precondition-checked: re-verifies the approval signature is bound to
  the exact plan **and** commit hash. It integrates **only the exact signed commit, and only
  by fast-forward** (the broker performs a CAS advancing canonical to the signed commit iff
  canonical is still at the recorded base). **`approve` never rebases, never regenerates a
  patch, and never creates a new commit** — any operation that would alter the signed commit
  is prohibited (rebasing would produce a different commit and void the signature). On a
  **stale base / non-fast-forward** condition it does **not** integrate: it returns a stable
  **`refresh-required`** error (exit `6`, action-required) directing the operator to
  `brain git refresh` (which produces a new commit) followed by a **fresh approval signature**
  over that new commit. `approve` is **idempotent** (a second approve of an already-integrated
  run is a no-op reporting the prior result). On success the broker removes the worktree and
  reconciles SQLite+LanceDB.
- `refresh <runId>` — the authoritative recovery for a **stale-base review-pending run**:
  rebases onto current canonical, regenerates + re-validates the section patches (re-running
  retrieval for any changed input), creates a **new** agent commit + signed manifest, records
  supersession of the prior review artifact, and returns the run to `review-pending`
  **requiring a fresh approval signature** over the new commit. It never integrates. **`refresh`
  itself is NOT a privileged/broker-authorized operation** — it writes only an agent-owned
  `refs/agent/*` commit and needs no approval signature or protected-ref access; every mention
  of "`refresh`-integration" in the authorization lists denotes the **subsequent `approve`** of
  the refreshed commit, not `refresh`. There is no separate refresh-integration command.
- `reject <runId>` — records the rejection, deletes the branch + worktree, leaves canonical
  untouched. **Terminal rejection of a review-pending run is a broker-authorized privileged
  operation** (a broker-verifiable reviewer/operator authorization is required); immutable
  plan/commit/diff artifacts are retained per policy. An agent may only `cancel` a run **it owns and before integration** (including its own
  review-pending run, which exits via `cancelled@review-pending`) — it can never reject or cancel
  another party's pending review, so it cannot destroy review artifacts or deny service.
- `rollback <runId>` — reverts an **already-`integrated`/`finalized`** canonical change
  (creates a revert commit; never rewrites shared history) and reconciles projections.
  **`rollback` is illegal from `review-pending`** (and any pre-integration state): a
  not-yet-integrated agent branch is discarded via `reject`, never `rollback` — this matches
  the normative transition table exactly. **`rollback` spawns a distinct rollback/remediation run** with its own `runId` and a
  `targetRunId` pointing at the integrated run being reverted; the target run stays
  `finalized`/`integrated` and immutable, and the **new** run owns the `rolled-back` terminal
  state and the single `run.rolled_back` audit event (the target run's events are never
  rewritten). **`rollback` is a privileged canonical mutation**
  under the same separation-of-duties boundary as `approve`: it requires user-presence or a
  separately held signing-key authorization bound to the target run, the current canonical
  commit, the intended revert commit, and a replay-protection nonce, verified by the broker
  immediately before the revert — an agent workflow can never invoke it.

  **Operation-specific rollback semantics + dependency checks.** Before reverting, `rollback` computes the **downstream reference set** of the
  run's changed entities and branches on operation class:
  - **Immutable source capture** (a run that only captured a source): a plain revert would
    delete a source the design keeps forever and could dangle provenance. Instead, rollback
    **tombstones/deactivates** the capture (marks the rendition/capture inactive, excludes it
    from retrieval and new evidence) while **retaining the immutable blob + manifests** — it
    does not remove source bytes. If any active claim/evidence references the source, see the
    dependency rule below.
  - **Run with downstream references** (later claims, evidence, notes, or links depend on the
    run's output): a bare revert would create dangling provenance, so rollback **refuses by
    default** with a stable `has-dependents` error listing the dependents, and requires the
    operator to either (a) accept a **validated compensating ChangePlan** that updates all
    dependents atomically in the same revert commit series, or (b) roll back the dependents
    first. Rollback never leaves the vault with dangling references.
  - **Self-contained mutation** (no downstream refs): a direct validated revert commit.
  Every rollback path ends with mandatory projection reconciliation and its single
  `run.rolled_back` terminal audit event (per the *Audit SSOT* event-stream contract); these
  outcomes are enumerated in the rollback contract + tests.
- `cleanup` — prunes worktrees/branches for terminal runs (`integrated`/`finalized`, `rejected`,
  `failed`, `cancelled`) and `rolled-back` runs, using only the normative state names.
- Every outcome (approve/reject/rollback) triggers mandatory SQLite/LanceDB reconciliation.

**Authorization boundary (separation of duties) — enforced by a privilege-separated
integration broker.** The separation-of-duties
guarantee is **not** merely CLI behavior plus an unavailable signing key. It is enforced by an
OS-level privilege boundary so that **no filesystem access available to an agent or parser
process can advance a protected ref**, even with direct git plumbing:

- **Protected refs** = the canonical branch ref, `refs/audit/runs`, and the trust ledger ref.
  These are owned by a dedicated **broker OS user** (separate uid/credential). **Agents write
  into a separate agent-owned quarantine object store (or per-agent repository), never the
  canonical object store;** the broker **imports and validates** objects (object integrity +
  tree modes) into its own **broker-owned append-only object store** before integration.
  Canonical objects/packs, git config, hooks, alternates, and ref-transaction metadata are
  **not writable by agents** (so agents cannot unlink/rename loose objects or packs, nor plant
  hooks/config as a broker code-execution surface); broker git operations run with hooks and
  unsafe config disabled. The **protected refs and the reflog/ref storage backing them are
  writable only by the broker uid** (enforced by filesystem ownership/mode and, where
  available, an OS-level ref-update guard); the agent process has **no OS permission** to
  update them, so `update-ref`, index writes against canonical, or a raw ref-file rewrite from
  the agent simply fail with EACCES.
- **Agent capability = object-write + `refs/agent/*` only.** Agents create blobs/trees/commits
  and their own agent-branch refs; they **cannot** fast-forward canonical, write the audit ref,
  or truncate it.
- **The broker is the sole mutator of protected refs.** It runs as its own process/uid and, on
  every request, **re-verifies from scratch**: the approval (or privileged-op) signature against
  the exact plan+commit, the CAS precondition (canonical still at recorded base), commit
  **ancestry** (the target commit descends from the recorded base and contains only the
  approved tree), and that a **pre-integration authorization record** for the run is present — then, in strict order, **reserves the `run.integrated` outbox event without a commit hash**, advances the protected ref via the CAS, and only then **materializes `run.integrated` with the resulting integration commit hash**, appending it via the normative ledger↔ref
  dual-write protocol (outbox + `eventId`, see *Event-stream model*), with deterministic crash
  recovery at every point rather than a claimed cross-store atomic write. The pre-integration authorization record is distinct from the post-integration `run.integrated` lifecycle event, so both required orderings hold.
  **For every integration — including Tier-1/Tier-2 auto-commit — the broker (in broker-trusted
  code, from broker-owned configuration) parses the candidate tree + diff, validates it exactly
  implements the canonical `ChangePlan`, independently applies path/note-type/provenance/taint/
  operation policy, and recomputes `effectiveRisk`; it refuses the advance and requires a human
  approval signature whenever its recomputed result is Tier-3 or validation is indeterminate.**
  The agent-supplied `effectiveRisk` label is never trusted for gating.
  A compromised agent cannot integrate a Tier-3 change without a valid signature the broker
  verifies, because the agent physically cannot write the ref.
- **Purge history-rewrite exception (broker-only).** Canonical Git-history rewrite required by
  `brain purge` is the single defined exception to the descend-from-base and
  append-only-object-store rules: it runs as a distinct **broker-authorized signed
  non-fast-forward canonical-ref replacement** (Tier-3-equivalent authorization bound to
  op=`purge`, the old head, and the deterministically derived replacement head), after which the
  broker **securely garbage-collects the superseded objects** (moved out of the append-only class
  into an erasable storage class for this operation), **externally checkpoints both the old and
  replacement heads** in the WORM anchor, and runs post-purge verification that no erased object
  remains reachable. Ordinary (non-purge) integration retains the strict descend-from-base +
  append-only guarantees.
- **Audit-head anchoring / anti-truncation.** The broker records the `refs/audit/runs` head
  (hash + monotonically increasing event count, signed by the broker) into an **append-only /
  WORM location outside the agent-writable repository** (a broker-owned, agent-unreadable
  append-only file, plus the encrypted ledger backup). On startup and in `brain doctor`/`git
  verify`, the current audit head is checked against that external anchor: **any truncation or
  rewrite of a valid audit suffix is detectable** even after SQLite loss, because the anchor's
  event count exceeds what a truncated ref carries. Agents cannot write the anchor.

**Broker deployment & lifecycle contract (normative — `docs/specs/broker-deployment.md`, a
Phase-1 installation gate).** Because the entire safety boundary depends on the integration and
egress brokers running as separate privileged OS identities, a supported-host deployment contract
defines: user/group provisioning; privileged installation; broker process supervision (launchd on
macOS / systemd on Linux); socket ownership + peer authentication; repository/object-store
permissions + modes; hardware-backed key enrollment; startup ordering; broker↔CLI version
compatibility; health checks; upgrade/rollback; crash recovery; and uninstall. **Successful
privilege-boundary verification is split by broker: **integration-broker verification is a
Phase-1 installation gate; egress-broker verification is a Phase-2 gate** (the egress broker
first lands in Phase 2 with the first provider call) — `brain doctor` refuses each broker's
privileged operations until that broker's deployment contract is satisfied on the host.

**What "user presence" actually proves.** A plain stdin/PTY confirmation is **not** a proof of human presence — an agent
that can launch the CLI can synthesize stdin or allocate a PTY and answer the prompt.
Therefore a typed "yes" / `--yes` is treated as a **cosmetic prompt bypass only and NEVER as
authorization**. Privileged operations (`approve`, `refresh`-integration, `rollback`, `purge`,
`db restore`, trust `promote`/`revoke`) are authorized by **exactly one of two broker-verifiable
mechanisms, and nothing else**:
1. **An OS-mediated presence assertion bound to the exact broker challenge** — a
   Secure-Enclave / TPM / platform-authenticator (Touch ID / WebAuthn-class / hardware
   security key) signature, or an OS keychain unlock gated by such an authenticator, produced
   over the broker's `signingPayload` (op + targetCommit + canonicalBaseCommit + nonce). The
   assertion is minted by the OS on hardware the agent cannot drive programmatically and is
   verified by the broker against the concrete challenge; a synthesized stdin/PTY cannot
   produce it. Because ordinary platform authenticators prove presence but not *informed
   approval*, the broker MUST first display the exact operation, target, and commit/inventory
   digest through a **broker-owned trusted transaction UI** (or, where the platform cannot provide
   a trusted display, an **external signing device / separate approval app** that shows and
   verifies those fields) before invoking the authenticator; bare biometric user-verification
   counts as presence only, never as approval of an unseen effect. This is the "interactive" path.
2. **The non-interactive external signing flow** (`--export-challenge` → sign with a
   separately held key the agent process cannot read → `--authorization`), below.
There is **no path in which a bare terminal confirmation authorizes a privileged op.** Approval
itself therefore requires either the **OS-mediated presence assertion** or a **separately held
signing key** the agent process cannot read; **`--yes` alone can never
authorize Tier-3 integration or any privileged op** — it only bypasses cosmetic confirmation
prompts. Key provisioning, storage (OS keychain / hardware-backed, never in the vault or in env
visible to the agent), rotation, revocation, signer identity, signature algorithm (Ed25519),
and per-approval nonce replay-protection are defined in the git/broker package contract. The
same broker boundary governs **every privileged canonical or destructive operation** —
`approve`, `refresh`-integration, `rollback`, erasure/`purge`, `db restore`, trust
`promote`/`revoke`, **terminal `git reject` of a review-pending run, and the `db backup
--force-unblock` backup-health override** — each requiring user-presence or a separately held signature bound to
(target run, canonical commit, intended effect, replay nonce); none is invocable by an agent
workflow.

**Non-interactive authorization CLI contract (challenge/response — finding: no usable
contract).** Every privileged command supports a two-step, fully non-interactive protocol with
JSON schemas (in `cli-contract/`). The privileged subset is **derived from the single canonical command registry (`commands.json`),
which is the sole authority for command and operation-variant privilege classification** (including
pseudo-variants such as `backup-force-unblock`); from that one source are generated each privileged
variant — `approve`, `rollback`, `purge`, `db restore`, trust `promote`/`revoke`, **`git reject`,
and `db backup --force-unblock`** (there is no `refresh-integration` command — integration is
ordinary `approve` of the refreshed commit) — together with each one's broker policy, challenge
fields (op-specific `intendedEffect`), permitted signers, nonce/replay + drift checks, stable
authorization errors, and idempotency behavior; a `--force-unblock`
challenge is bound to (op=`backup-force-unblock`, latest ledger sequence, accepted-RPO-gap,
nonce):
1. **Challenge / export** — `brain <cmd> --export-challenge <target>` emits a JSON
   **authorization challenge**: `{ op, runId?, targetCommit?, canonicalBaseCommit,
   intendedEffect, nonce, expiresAt, payloadCanonicalization, signingPayload }` where
   `signingPayload` is the exact canonical byte string to sign. For `rollback` the challenge
   **includes the deterministically derived intended revert commit** (the broker computes it
   from the target run + current canonical via a fixed revert-construction protocol, so the
   signer authorizes a concrete commit, not an abstraction). For `db restore` it includes the
   backup ref + its content hash.
2. **Execute / import** — `brain <cmd> --authorization <file.json>` submits
   `{ challenge, signature, signerId }`. The execute step **re-derives the challenge from
   current state and rejects any drift** (canonical moved, nonce expired/replayed, target
   commit differs, signer not permitted) with stable error codes before the broker acts.
The interactive path (**OS-mediated presence assertion bound to the broker challenge** — not a
bare `--yes`, which only bypasses cosmetic prompts) and the non-interactive path
(`--authorization`) are the only two ways to authorize; there is no third. Signer selection, expiry, verification
error catalog, and JSON schemas are normative in the broker/git contract.

Commands: `brain git status/review/refresh/approve/reject/rollback/cleanup/verify`
(privileged ones additionally accept `--export-challenge` / `--authorization`).

## Model provider layer
Provider-neutral interface: `generateText`, `generateObject<T>` (Zod-typed), `embed`, each
with **versioned request/result types**, explicit timeout + cancellation (`AbortSignal`)
semantics, defined batch semantics for `embed`, and adapter-owned retry. Failures surface as a
**common discriminated provider-error union** — `validation`, `authentication`, `quota`,
`rate_limit`, `timeout`, `transport`, `cancelled`, `partial_batch`, `model_incompatible`
(incl. embedding-dimension mismatch) — each carrying `retryable` + optional `retryAfter`, so
workflows decide retry/persist deterministically (a `partial_batch` result names which items
succeeded and is never persisted as complete). The full types + taxonomy live in the
provider-interface contract (Phase 0).
V1 ships one adapter: **Google Gemini** (`gemini-3-5-flash` for generation/extraction/
classification/synthesis; `gemini-embedding-001` for embeddings, dimensions pinned +
versioned in the index). Every call records provider, model, prompt-template id+version,
temperature, token counts, latency, cost estimate, retries, validation errors. Routing is
policy-driven so a `confidential` note-type class can later pin to a local/allowlisted
provider without touching call sites.
**Credential + network custody:** the `models` adapter's outbound calls execute **inside the
privilege-separated egress broker** (see *Egress guard*), which is the sole holder of the
provider credential and the sole process with outbound network. The agent-facing `models`
API is a typed IPC client to that broker; no provider key is ever loaded into an agent,
parser, or workflow process. The egress broker lands with the first provider call (**Phase
2**, non-mutating extraction/classification) and is exercised for embeddings from **Phase 3**.

## CLI (V1 surface)
```
brain inspect | doctor | status
brain ingest <path> [--dry-run | --apply]
brain query "<question>"
brain enrich <note> [--dry-run | --apply]
brain reconcile [--dry-run | --apply]
brain maintain [--dry-run | --apply]
brain validate
brain source add|list|show|trust
brain note show|related|history
brain evidence review|resolve|retry
brain index status|verify|repair|rebuild
brain db status|verify|migrate|rebuild|backup|restore
brain jobs list|run|retry|cancel
brain bootstrap inspect|resolve
brain git status|review|refresh|approve|reject|rollback|cleanup|verify
brain purge (--note <id> | --source <contentId> | --data-category <label>) [--dry-run | --apply] [--authorization <file> | --export-challenge] [--yes]
```
Human + JSON + quiet + verbose modes; stable exit codes
(`0` ok · `1` validation · `2` config/vault · `3` secret-scan · `4` internal · `5` user/usage ·
`6` action-required, e.g. an accepted-but-not-integrated review-pending run · `7`
provider-retryable, e.g. a `rate_limit`/`quota`/transient-transport failure the caller may
retry).

**Mutation default.** For **all four state-changing workflow commands** — `ingest`, `enrich`,
`reconcile`, `maintain` — the default is a **non-mutating preview**; `--apply` performs the
mutation. `--dry-run` and `--apply` are mutually exclusive (supplying both is exit `5`). This
is a single uniform contract:
- **Preview (default / `--dry-run`)** MUST create **no** plan-persistence side effects, no
  branch, no worktree, no commit, no canonical change — it computes and prints the diff summary
  + per-op effective risk and exits `0` (or `6` if it *would* require review), and MUST NOT
  perform any prohibited mutating effect.
- **`--apply`** materializes plans/branches/commits per risk tier: Tier-1/Tier-2 ops
  auto-commit-and-integrate under the CAS; **any Tier-3 op stops at `review-pending`** (durable
  plan/branch/worktree/commit + `runId`, exit `6`), never integrating without `git approve`.
`reconcile` (alias/duplicate resolution) and `maintain` (orphans/broken-links/stale) follow
exactly this: bare invocation = preview, `--apply` = tiered application, review-pending output
carries `runId` + exit `6`, and destructive proposals (merge/delete/archive) are always Tier-3.
Preview prints the diff summary + effective risk; apply of a Tier-3 op
creates the isolated agent branch + signed-manifest commit and records a **review-pending**
run (a **success-shaped** result with status `review_pending` + its `runId`, exit `6`
action-required — never exit `1`, which is reserved for validation failure), but **stops
before canonical integration** — only
`brain git approve` integrates that exact reviewed commit. Tier-3 apply therefore always
produces a durable plan, branch, worktree, commit, and `runId`; it never fast-forwards into
the canonical branch.

**Job execution entrypoint.** `brain jobs run` claims and drains queued jobs synchronously
(V1 has no daemon): it takes a **single-runner process lock** (no lease epochs or heartbeats
in V1), runs bounded attempts with backoff, marks terminal `succeeded`/`failed`/`cancelled`,
and honors idempotency keys. Workflow commands drain their own jobs inline; `jobs run` exists
to recover jobs left pending/running by a crash via **startup state repair** (a job owned by a
dead runner is reset to `pending` under the process lock), not via lease expiry.

**Administrative-command concurrency (normative — finding: unspecified).** SQLite transactions
and generation fencing alone do not stop destructive maintenance from racing Git/ledger
mutations, so V1 defines a **process-level concurrency contract** with named lock scopes:
- **`vault-maintenance` (exclusive):** `db migrate`, `db rebuild`, `db restore`, `index rebuild`,
  `purge`, and the Phase-5 bootstrap migration. Only one may run, and **no ordinary workflow
  run may hold a canonical mutation while it runs.**
- **`ledger-maintenance` (exclusive):** `db backup`/`db restore` vs ledger writers.
- **`canonical-integration` (exclusive, held by the broker):** serializes canonical ref
  advances (already the CAS point); ordinary Tier-1/Tier-2 auto-commits and `approve` contend
  here.
- **`shared` (concurrent):** read-only commands (`inspect`, `query`, `status`, `list/show`) and
  independent per-note workflow planning.
Lock acquisition is **globally ordered** `vault-maintenance ⊐ ledger-maintenance ⊐
canonical-integration` (a command needing several acquires outer-first) to prevent deadlock; a
command that cannot acquire its lock fails fast with a stable **`locked:<scope>`** code (exit
`2`) naming the holder. **Stale-lock recovery:** locks carry the owner pid + start time; a lock
held by a dead pid is reclaimable under a documented `brain doctor --reclaim-locks` step, never
silently stolen mid-operation. A **command conflict matrix** (which pairs may coexist) is
normative in the CLI contract and exercised by the important-race integration tests
(`db rebuild` vs a workflow commit, `purge` vs `ingest`, `db restore` vs `jobs run`, etc.).

**CLI contract (versioned).** Each command defines positional args, flags + defaults +
constraints, side effects, prohibited effects, exit codes, and a typed JSON schema (`--json`)
with required fields and enums — enumerated per command in a **single canonical machine-readable JSON Schema per command**
(`docs/specs/cli-contract/<command>.schema.json`) that captures args, flags, defaults,
effects, exit codes, error codes, and output shapes and must land before that command is
implemented; the human-readable `docs/specs/cli-contract/<command>.md` reference **and**
contract-test fixtures are **generated from that schema** (the schema is authoritative; the
Markdown is non-normative derived output), so the two cannot drift. **This per-command schema
system is intentionally in V1 scope** (operator directive: the rigor pays for itself as the
single source that generates docs *and* contract-test fixtures *and* the acceptance inventory,
guaranteeing no drift and no missing command). It is not an external API framework — there is
no V1 network/MCP consumer — so it stays a **docs+test generation contract**, not a runtime
API surface; the *Scope* list names it in-V1 and this section agrees. This document is the
overview.

**Single canonical command registry (normative — finding: duplicated CLI inventories drift).**
Command **membership** has exactly one owner: a machine-readable registry
(`docs/specs/cli-contract/commands.json`) enumerating every command + subcommand (including the
safety-critical `db backup`, `db restore`, `db verify --backup`, and `purge`) with its schema
reference, phase, idempotency class, privilege tier, and an **execution class**
(`pure` | `audited-read` | `projection-write` | `ledger-write`) from which audit-event emission,
backup-health (`backup-unhealthy`) gating, and documented side effects are derived — so no command
is simultaneously audited and non-persisting. A genuinely `pure` health variant
(`inspect`/`status`/`doctor` writing no ledger row) stays available in degraded mode, while any
`audited-read`/`ledger-write` invocation is blocked; `db backup` is additionally classified as a
degraded-mode **recovery** operation with narrowly permitted writes (only its own
watermark-advancing backup) so a catch-up backup can clear the unhealthy watermark. The prose **CLI (V1 surface)**
overview, the per-command `<command>.schema.json` set, the idempotency classification, and the
**exhaustive per-command acceptance inventory** are all **generated from / validated against
this one registry** — a CI check fails if any hand-written inventory in this spec omits or adds
a command the registry does not list. No inventory in this document is authoritative on its own;
the registry is. This closes the class of defect where a command present in one list (e.g.
`db backup`/`db restore` in the CLI surface) is missing from another (the acceptance inventory).
**Target selection** for target-sensitive commands: `git review/approve/reject/rollback`
take a `<runId>`; `note show/related/history` take a note `id` or slug. **Jobs bulk-selection
(normative — finding: unresolved `--all`):**
- `jobs run [<jobId> | --all]` — `--all` (default when neither given) drains all queued jobs.
- `jobs retry [<jobId> | --all]` — `--all` retries all jobs currently in `failed`.
- `jobs cancel [<jobId> | --all]` — `--all` cancels all jobs in `pending`/`claimed`/`running`.
For every one of them `<jobId>` and `--all` are **mutually exclusive** (both ⇒ exit `5`); with
neither, `run` defaults to `--all` while `retry`/`cancel` **require** an explicit selector
(bare `retry`/`cancel` ⇒ exit `5`, no implicit bulk mutation). Bulk selection is **deterministic**
(ordered by `(next_run_at, jobId)`), processes each job independently, returns a **per-job
result array** plus an **aggregate exit status** chosen by a **deterministic precedence table**
over mixed per-job outcomes (`0` only if all succeeded; a per-job **`action_required`** outcome —
e.g. a job whose run escalated to a Tier-3 `review-pending`, carrying its `runId` — raises the
aggregate to **exit `6`** and is counted in the **`actionRequired`** aggregate field unless a
higher-precedence failure is present; otherwise the highest-precedence failure category wins in the
fixed order `4` internal ⊐ `2` config/vault/lock ⊐ `1` validation ⊐ `7` provider-retryable ⊐ `6`
action-required ⊐ `5` usage, with `skipped`/`cancelled` outcomes not raising the aggregate above
`0` on their own — the JSON body always distinguishes per-job outcomes), encoded in the
jobs command schemas + contract fixtures, and a job that changes state
mid-batch (e.g. becomes terminal) is skipped with a `skipped:state-changed` per-job note rather
than erroring the whole batch. Collection commands (`source list`,
`jobs list`, `note related/history`, `git status`) use a **simple deterministic `--limit`
(default 50 / max 500) + `--offset`** contract for V1, each with a defined sort key + unique
tie-breaker (so ordering is stable) and `total`/`hasMore` in JSON. Under concurrent inserts/deletes this offset contract is
explicitly **best-effort** — rows changing before the current offset may cause a bounded skip
or duplicate, and `total`/`hasMore` reflect a live (non-snapshot) count — with the allowed
anomalies documented per command. Opaque snapshot-stable
cursors are **deferred** until measured collection sizes or an API/MCP consumer demonstrates
the need.

**JSON error envelope.** In `--json` mode every failure emits one **discriminated** object
`{ "code": "<stable-command-specific-code>", "message": string, "hint": string, "details":
{ "field"?: string, "path"?: string, "location"?: {file, line?, span?} }, "errors"?:
[<same shape>] (multiple validation failures), "retryable": bool, "retryAfterMs"?: number,
"runId"?: string, "jobId"?: string }`; `details` is a **discriminated, code-specific typed schema** keyed by `code`: beyond the common
`field`/`path`/`location` it carries the structured remediation data each error needs — e.g.
`dependents[]` for `has-dependents`, lock-holder pid/scope/start-time for `locked:<scope>`,
expected-vs-actual commit for `refresh-required`, `backup_watermark_seq`/`latest_ledger_seq` for
`backup-unhealthy`, and drift-reason fields for authorization drift — so programmatic remediation
never has to parse `message`/`hint`; multiple failures are carried in `errors[]`, and `runId`/`jobId` are included whenever the failing
command operates on one. **Provider retry timing is preserved end-to-end:** when a failure originates from a provider `rate_limit`/`quota` error carrying
`retryAfter`, the workflow normalizes it into **`retryAfterMs`** (integer milliseconds) on this
envelope and on the corresponding `jobs`/workflow result, so rate-limit consumers can honor
provider-directed timing programmatically. `retryAfterMs` is present iff the provider supplied
timing; `retryable` remains the boolean gate. The stable per-command `code` catalog (each mapped to an exit category) is enumerated
in the per-command contract files. **stdout is reserved for results — diagnostics go to
stderr.** Each `code` maps to one of the process exit categories above (so validation vs.
user/usage failures are distinguishable). **Batch commands** (`jobs run/retry/cancel` with
`--all` or multiple targets) do **not** use the single-error envelope; they emit one canonical
**batch-result object** `{ "items": [<per-job result-or-error>], "aggregate": { "exitCode":
<number>, "succeeded": n, "failed": n, "skipped": n, "actionRequired": n }, "error"?: <top-level envelope for a
whole-batch failure> }`. Per-item failures use the standard error-envelope shape inside
`items[]`; the top-level `error` is present only when the batch could not run at all. This is the
sole exception to the one-envelope-per-failure rule and is encoded in the jobs command schemas +
contract fixtures.

**Accessibility contract (human mode).** **V1 core (load-bearing):** deterministic plain-text
output, safe non-TTY behavior, `NO_COLOR`/`--no-color`, `--plain`, and no required interactive UI.
**Deferred to a later usability milestone:** multi-theme high-contrast *certification*, adaptive
table/diff *layout switching*, and the narrow-width/200%-scaling profile matrix (their mechanisms
are described below as forward design). Within that scope: all meaning is carried in text — never
color or symbol alone; **colored output uses a high-contrast palette policy meeting a defined minimum contrast ratio
(WCAG AA — 4.5:1 for normal text) against the detected or configured background, evaluating each
ANSI color accordingly and automatically falling back to uncolored text when compliance cannot be
established (unknown terminal colors), with no dim text for required information** (theme
*certification* across representative light/dark/high-contrast themes is the deferred milestone
above); honor
`NO_COLOR` and an explicit `--no-color`; degrade tables to linear
readable text and emit deterministic plain output when stdout is not a TTY (no
cursor-positioned or animated output). Every operation is fully available through
arguments/flags with **no required interactive UI**; where a confirmation prompt or pager
exists it is keyboard-operable and bypassable (`--yes` / `--no-pager`), and the same
information is available via `--json`. Errors always name the affected argument/config
key/file + source location in text.

**Reduced-motion & screen-reader behavior.** Animation/spinners/
in-place cursor updates are permitted **only** on an interactive TTY **and** when not
suppressed. A **`--plain`** flag (auto-enabled, with a defined precedence, by `NO_COLOR`, a non-TTY stdout,
`TERM=dumb`, and the `NO_MOTION`/reduced-motion environment signal — each named in every command
schema; `NO_COLOR` alone suppresses color but a motion/`--plain` signal is required to disable
cursor updates, and detected assistive/reduced-motion configs never receive cursor-positioned
output) **disables all animation, spinners, cursor movement, and
in-place updates even on a TTY**, replacing them with **concise append-only textual progress**
lines and explicit terminal-state messages (`started…`, `progress: N/M`, `done`, `failed: …`)
so a direct-terminal screen-reader user receives announced, non-overwritten state changes for
every long-running command (loading, progress, completion, failure). **`--plain` additionally
linearizes tables, box drawing, and alignment-dependent layouts into labeled record-by-record
text even on an interactive TTY**, and screen-reader-oriented tests cover collection, status,
review, and diagnostic commands in a TTY under `--plain`. Contract tests exercise
long-running commands in `--plain` mode and assert append-only, non-duplicated announcements.
**Narrow-width / enlarged-text profiles (equivalent to 200% scaling)** are defined test profiles:
at those widths output MUST wrap without content loss and **automatically switch
alignment-dependent layouts (tables, diffs, status views) to the linear representation** when
available width is insufficient, verified by contract tests.

**Terminal-safe rendering.** Human-mode commands display
attacker-influenced text (normalized sources, model answers, note content, diffs, paths,
errors). **All** human-mode output routes through a single **terminal-safe renderer** that
strips or visibly escapes ANSI/CSI, OSC (incl. OSC 8 hyperlinks and OSC 52 clipboard), C0/C1
control bytes, and carriage-return-overwrite sequences, and **isolates bidirectional-control
characters** (LRO/RLO/PDF/isolates) while preserving intentional newlines and tabs — so a
malicious local HTML/PDF/Markdown/text source cannot alter the terminal, forge links,
manipulate the clipboard, or spoof review output. In `--json` mode the raw values are safely
JSON-string-encoded (control bytes escaped) rather than emitted raw. Adversarial fixtures for
ANSI, OSC 8, OSC 52, CR-overwrite, and bidi-spoofing payloads are in the test plan.

## Security & privacy
Vault may contain sensitive Evinced + personal content. **V1 is cloud-only (Gemini)** — the
user has accepted that ingested/queried content goes to Google. Mitigations baked in:
**pre-persistence secret scanning** (raw bytes + normalized output are scanned fail-closed
**before** any vault, SQLite, worktree, or git write — not only at egress — so a
secret-bearing source never reaches the vault or git history; **capture is atomic against a
single byte snapshot**: the source is opened once with no-follow (`O_NOFOLLOW`) semantics, the
descriptor + file type validated (special files, hard-link anomalies, and any post-validation
path re-resolution rejected), and that **same descriptor (or a sealed staging snapshot)** is
consumed for scanning, parsing, hashing, and vault-copying, with the final stored
`rawContentHash` verified against the scanned snapshot — so a file/symlink swapped between steps
cannot slip unscanned bytes into the vault, git, or parser; blocked content is quarantined
outside the repository in a mode-0700 dir under **authenticated encryption (AEAD) whose key
lives in the OS keychain / hardware-backed store — never in the vault, env, or readable by the
model/parser processes — with defined rotation/revocation, encrypted-or-minimized filenames,
bounded retention, crash-safe purge, and `brain doctor` quarantine-security checks), the egress guard below, path-traversal + symlink protection, attachment
size/type limits, audit of external transmissions, and a `models.routing.confidential` config
hook (local/allowlist) reserved for V2. **Sensitivity is a first-class canonical field, split into declared vs effective:** each note/source carries a canonical
**`declaredSensitivity`** from a fixed taxonomy (`public | internal | confidential |
restricted`) plus optional `data_categories` — this is the **only** authored/persisted
classification input, written in frontmatter. The **`effectiveSensitivity`** is a **computed
value with exactly one owner**: the `policies` package deterministically derives it as the
most-restrictive label over the note's own `declaredSensitivity` and the effective sensitivity
of its inputs (source → claim → note → retrieval-context → backup). `effectiveSensitivity` is
**computed on read** by default; if persisted for query performance it is stored **only as a
projection** (rebuildable, never authored) with explicit invalidation when any dependency's
declared label changes and rebuild via `brain db rebuild`. The inheritance engine never writes
back onto `declaredSensitivity`, so the authored classification and the computed classification
can never be conflated or silently diverge. Unlabeled content defaults to
`declaredSensitivity: internal`; per-class handling rules (provider/region allowlist,
loggability, retention) consume **`effectiveSensitivity`**; legacy-note classification during
bootstrap sets `declaredSensitivity` only. These rules are normative in the security contract. Secrets live in env/OS keychain, never in the vault or
SQLite.

**Egress guard (non-bypassable — enforced by a privilege-separated egress broker, finding:
agent-held credentials bypass the guard).** A guard that is merely a shared provider-library
function is **not** sufficient: if the agent process can hold the Gemini credential and open
sockets, a compromised agent or a malicious transitive dependency can transmit vault content
directly, skipping the scanner and the audit entirely. V1 therefore enforces egress the same
way it enforces canonical writes — with an **OS-level privilege boundary**:
- **Agent/parser/workflow processes have NO outbound network capability and NO provider
  credential.** The Gemini API key (and any future provider credential) lives **only** in the
  **egress broker's** process, under a separate OS identity, in the OS keychain / hardware-backed
  store — never readable by, inherited by, or present in the environment of an agent, parser,
  or workflow process. On the supported hosts the agent processes run with **outbound network
  denied** (Linux: network-isolated netns / seccomp; macOS: Seatbelt profile denying network),
  so a direct provider call from agent code fails at the OS layer, not merely by convention.
- **All `generateText` / `generateObject` / `embed` calls are IPC requests to the egress
  broker.** The broker is the **sole holder of credentials and the sole process permitted
  outbound network**. On every request it scans the *exact serialized payload* — ingest, query
  text, retrieval context, generated prompts, and embedding chunks — **inside the broker,
  where the caller cannot skip it**, before any byte leaves the host.
- **Authenticated local IPC + pinned destinations.** The IPC transport is a
  restrictive-permission Unix socket with **peer-credential verification** (only permitted local
  uids); the broker accepts **only fixed operation schemas**, derives `effectiveSensitivity`
  independently and enforces provider/region policy, **pins an allowlist of HTTPS destinations**,
  and **rejects any caller-supplied URL, endpoint, header, or credential**. **Per-request egress capability (content authorization, not just caller authentication):** peer-credential checks alone do not authorize *what* is sent, so every egress request additionally carries a **short-lived, single-use capability** minted by a **broker-trusted capability issuer** (broker-trusted code under broker identity) that derives the permitted content set from **canonical git objects, persisted run state, approved retrieval results, and broker-recomputed policy — never caller-asserted hashes** — and signs it bound to run ID, operation, approved prompt-template id+version, the exact payload/object hashes, `effectiveSensitivity`, destination, token budget, expiry, and nonce; the egress broker **rejects any agent-issued or self-minted capability** and any request whose payload hashes or sensitivity do not match its capability, and where feasible **assembles the payload itself from broker-verified authorized objects** rather than transmitting arbitrary agent-supplied prompt bytes, so a compromised process under an allowed uid cannot exfiltrate arbitrary readable content. It constrains
  headers, proxy, DNS resolution, and redirect handling to the pinned provider, and applies
  request size, rate, and operation-scope limits — so no local process can use it as a
  credentialed network oracle and no caller-controlled routing can leave the Google-only
  destination.
- **The IPC channel is itself independently scanned and audited:** the egress broker
  secret-scans each request/response and produces a **sanitized, signed audit-record request**
  (hashes/classifications/destinations, never raw payloads), which it submits through a **durable
  outbox** to the **integration broker — the sole owner of audit sequence allocation and
  `refs/audit/runs` appends** (see *Audit SSOT* / *Two brokers*). That sole audit writer
  records the request in the operational ledger and appends it to the audit ref via the normative ledger↔ref dual-write protocol (outbox + `eventId` idempotency, see *Event-stream model*) — never a claimed cross-store atomic write — with
  idempotent dedup on retry. The egress broker never writes the audit ref or allocates sequence
  numbers directly, so an agent can neither bypass the scan nor suppress the audit record, and
  there is exactly one audit writer with no split-brain ordering.
Detected secrets block or redact the call; failures fail closed and quarantine. Query,
enrichment, indexing, rebuild, and retry paths are all in scope. This egress broker is the same
privilege-separation pattern as the integration broker (*Authorization boundary*) applied to
the outbound-network seam; the two run under **separate OS identities** with separate keychain ACLs, sockets, files, and
sandbox profiles: the egress identity is **denied all protected-ref/object-store access**, and
the integration identity is **denied outbound network and the provider credential**, and
cross-process inspection/tracing between them is prevented — so compromising the network-facing
egress broker cannot reach canonical or audit state (egress-network vs protected-ref-write are
distinct capabilities that are never collapsed onto one uid).

**Generated-artifact persistence guard (non-bypassable — finding: model output can bypass
no-secrets-at-rest).** Schema + provenance validation do not stop a model from emitting
credential-shaped content, so a **single centralized fail-closed persistence guard** scans the
**exact serialized representation** of **every model response and every derived textual
artifact immediately before it is recorded** — model responses, typed `ChangePlan`s, generated
section patches, diffs, worktree file contents, manifests, diagnostics, and **commit
messages** — before it enters SQLite, a worktree, a git object, LanceDB, or a log. A detection
**quarantines or rejects** (fail-closed) the artifact and aborts the run at that checkpoint;
nothing secret-bearing reaches at-rest storage. This is the same scanner used for raw
bytes/normalized output, applied to the generation side of the loop, so the no-secrets-at-rest
invariant holds for model-originated content too. Negative tests inject a provider response
that itself introduces or echoes a secret and assert it never persists to any sink.

**Untrusted-input trust model.** PDF/HTML/Markdown/text sources and retrieved text are
**untrusted data**, isolated from system instructions and tagged with trust labels on their
evidence. Model-selected operations are constrained by capability policy; mutations driven by
newly ingested untrusted content **require review** (cannot auto-commit at Tier 2) until that
content is promoted to trusted. **Taint is transitive:** any claim, retrieved context, or
synthesis derived from untrusted evidence is itself untrusted, and a note stays untrusted
while any supporting evidence is untrusted — copying or summarizing untrusted material never
launders it. **Promotion is an explicit human-authorized operation**, exposed as
`brain source trust show|promote|revoke <sourceId>` (and a `PromoteTrust` ChangePlan op).
**Trust is bound to the immutable `contentId` *plus the reviewed rendition identity* (its
`normalizedContentHash`)** — never the mutable `sourceId`/active-rendition alias. A `sourceId`
handle is resolved to its `contentId` at the command boundary and only the `(contentId, reviewed
renditionId/normalizedContentHash)` pair is persisted. Prior trust stays valid **only for the
previously reviewed rendition**: when an extractor/normalizer upgrade activates a new rendition
with a changed `normalizedContentHash`, trust for that new rendition is **automatically suspended
(content re-taints to untrusted)** until deterministic equivalence to the reviewed rendition is
established or a privileged re-promotion approves the new rendition — so a parser upgrade that
surfaces previously hidden instructions or reinterprets polyglot bytes can never inherit trust
without review. **The broker-owned
trust-ledger ref is the single authoritative store of current promotion/revocation state;**
policy evaluation and taint propagation consume it, and canonical Markdown + audit records are
derived views reconciled from it. **The trust ledger is append-only, its head + sequence are
externally anchored in the same WORM store as the audit head, and its authoritative state is
included in the encrypted recovery backup and verified on every startup / `git verify`.** A
missing, truncated, or rolled-back-past-a-revocation trust history **forces all affected content
to untrusted** (fail-closed) until an authorized repair completes — a stale trust ref can never
silently re-trust previously revoked content. Only a user-presence /
signing-key-authorized caller (same boundary as `git approve` — never an agent workflow) may
promote or revoke. Each promotion/revocation writes an immutable audit record; revocation
re-taints dependent claims/syntheses and re-opens the plans that relied on the now-untrusted
content.

**Revocation "re-open" is a defined workflow transition, not an illegal reverse edge.** The normative state machine has **no**
edge out of a terminal `integrated`/`finalized` state, and revocation does **not** invent one.
Instead revocation branches on the affected run's state:
- **Pre-integration run** (`planned`..`review-pending`, not yet integrated): revocation marks
  it `failed@<checkpoint>` with reason `trust-revoked` (a legal terminal transition that
  already exists) and discards its agent branch via the normal cleanup path — the run never
  integrates untrusted-derived content.
- **Already-`integrated`/`finalized` run** (e.g. a Tier-2 auto-commit that relied on the
  now-untrusted source): the terminal run is **left intact and immutable**; revocation instead
  **spawns a new Tier-3 remediation run** (its own `runId`, plan, branch, review artifacts,
  and audit event) that references the revoked source + the affected run and proposes the
  correcting change (rollback of the affected commit and/or a re-verified re-synthesis). That
  remediation run is **review-required** and integrates only through `git approve` / the
  broker like any other Tier-3 run; if it rolls back an integrated commit it uses the standard
  `rollback` path with its dependency checks. Revocation therefore produces a **forward
  remediation run**, never an undefined backward transition on the original run. This is the
  sole defined mechanism; the affected content is re-taint-gated (cannot auto-commit) until the
  remediation run resolves. Adversarial indirect-prompt-injection cases
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

**Erasure workflow.** A human-approved `brain purge` (privileged, broker-authorized under the
separation-of-duties boundary; holds the exclusive vault-maintenance lock) inventories and
removes all derived and historical copies of classified content (Markdown history, worktrees,
SQLite, LanceDB, logs, backups), documents when git-history rewrite is required, rebuilds
projections afterward, and records that Google's provider-side retention/deletion terms apply
to already-transmitted content.

**`brain purge` command contract (normative — finding: purge has no public CLI contract).**
- **Authorization tier:** privileged **Tier-3-equivalent, broker-authorized**. It is invocable
  **only** through the same separation-of-duties boundary as `approve`/`rollback`/`db restore`:
  an **OS-mediated presence assertion** or the non-interactive `--export-challenge` →
  sign → `--authorization` flow, each bound to (op=`purge`, selector digest, canonical commit,
  replay nonce). **No agent workflow may invoke it**; `--yes` alone never authorizes it.
- **Selector:** a required `<selector>` naming the content to erase — one of `--note <id>`,
  `--source <contentId>`, or `--data-category <label>` (from the `data_categories` taxonomy).
  Selectors are resolved to a concrete **immutable erasure-inventory snapshot** (assigned an
  `inventoryId` + digest) before any authorization challenge is minted, so the signer authorizes an
  exact set, not an abstraction; the inventory is retrieved via **snapshot-stable cursor pagination
  / streaming** (not the live-offset collection contract), and both the authorization challenge and
  the `--apply` request are bound to that `inventoryId` + digest.
- **Flags:** `--dry-run` (default-safe **preview** — computes and prints the full inventory +
  the storage classes each item touches + whether git-history rewrite is required, with **no
  mutation and no audit-ref event**); `--apply` performs the erasure; the two are mutually
  exclusive (both ⇒ exit `5`). Authorization flags as above. `--dry-run` and `--apply` follow
  the same uniform preview/apply contract as the workflow commands.
- **Storage classes touched (complete):** canonical Markdown + **git history** (rewrite when
  required, per the documented protocol), worktrees, the SQLite **projection and ledger**,
  LanceDB, diagnostics/logs, quarantine store, **every encrypted ledger backup** containing the
  redacted rows, and the **`refs/audit/runs` audit ref** (via the *Audit-ref reconciliation for
  erasure* protocol below — opaque-ID unlink or signed tombstone + external checkpoint).
- **Concurrency:** acquires the exclusive **`vault-maintenance`** lock (see *Administrative-command
  concurrency*) so it cannot race workflows, `db` maintenance, or index rebuilds.
- **Idempotency:** **key-accepting** (`--idempotency-key`); operation identity =
  (selector digest, resolved-inventory digest, canonical base commit). A retried purge with the
  same identity is a **no-op reporting the prior outcome** rather than a second erasure; a purge
  whose inventory is already fully absent converges to success. Interrupted purge is
  **resumable** from a persisted per-storage-class progress checkpoint (never restarting a
  completed class).
- **Audit behavior:** each purge run emits its lifecycle + terminal events on `refs/audit/runs`
  per the *Audit SSOT* event-stream contract, and writes an immutable ledger erasure record
  (selector digest, inventory digest, per-class outcome, git-rewrite performed, backups
  re-minimized/expired) — carrying **allowlisted metadata only**, never the erased content.
- **Effects / post-conditions:** rebuilds SQLite projections + LanceDB afterward; **post-purge
  verification asserts no prohibited copy — including no re-linkable audit identifier —
  remains across every storage class**; records that Google's provider-side retention/deletion
  terms apply to already-transmitted content.
- **Exit codes:** `0` success; `5` usage (missing selector, mutually exclusive flags); `2`
  config/vault/lock (`locked:vault-maintenance`); the broker authorization/drift codes on a
  failed/expired/replayed challenge; `4` internal.
- **JSON schema:** governed by `docs/specs/cli-contract/purge.schema.json`, from which its
  Markdown reference, contract-test fixtures, and acceptance cases are generated (same
  per-command schema system as every other command).

**Audit-ref reconciliation for erasure.**
The audit ref is normally append-only, but erasure of personal/classified data can require
removing linkable identifiers it retains. The two requirements are reconciled by an explicit
protocol, not left to chance:
1. **Minimize by construction:** audit events store **opaque, unlinkable IDs and salted
   hashes** for note/source identifiers — chosen so that, absent the ledger's mapping table
   (itself in the erasable ledger), an event cannot be re-linked to content. Ordinary erasure
   therefore needs **no** audit-ref rewrite: deleting the ledger mapping renders the audit
   event's opaque IDs non-identifying while preserving the integrity chain.
2. **When true removal from the audit ref is legally required**, the erasable identifiers are
   never in immutable audit objects in the first place: audit events reference subjects **only
   via opaque IDs backed by per-subject envelope-encryption keys**, so cryptographically
   destroying a subject's key renders every retained audit object permanently non-relinkable
   without physically rewriting the ref. Where physical event removal is nonetheless required, a
   **privileged signed audit-ref replacement** is performed by the broker: it writes **signed
   tombstone events** for the redacted `seq` range, produces a new audit head, and moves the
   **superseded objects into an erasable storage class** (securely garbage-collected, not
   retained in the append-only class). The WORM anchor records **only a non-relinkable
   attestation of the rewrite** (the new head + a signed proof a redaction occurred) — it does
   **not** retain a usable reference to the old object graph. Integrity is preserved: the
   replacement is signed, the prior head is attested as superseded, and `git verify` validates
   the chain against the external checkpoint.
3. **Backups:** the erasure inventory includes every encrypted ledger backup containing the
   redacted rows; erasure either re-writes a minimized backup or expires the affected backups
   per a defined expiration + verification criterion. Post-purge verification asserts no
   prohibited copy — including no re-linkable audit identifier — remains.
The purge acquires vault-maintenance mode so it cannot race concurrent workflows (see
*Administrative-command concurrency*).

## Configuration
One typed config (`brain.config.yaml`), validated at startup, env-overridable. Key sections:
`vault` (path, canonical_branch), `sqlite`, `lancedb`, `indexing` (chunker_version,
embedding_provider=google, embedding_model=gemini-embedding-001, dimensions), `git`
(worktrees_path, auto_commit_risk_levels), `models` (default_provider=google,
gemini config), `policies` (require_sources_for_synthesis, allow_auto_merge=false,
allow_auto_delete=false).

**Normative configuration contract (versioned — `docs/specs/config-schema.md`, phase-gated with
Phase 1).** The keys above are illustrative, not exhaustive. The config schema defines **every**
key — including broker endpoints/identities, backup paths + retention, lock-file locations,
sandbox resource limits, egress policy + provider regions, key references, quarantine,
`raw_payload_store`, logging, and all retention bounds — with type, default, bounds, cross-field
constraints, secret-vs-non-secret classification, the **explicit allowlist of permitted
environment overrides** (provider credentials are never overridable into an agent-visible env),
path resolution, unknown/deprecated-key handling, version migration, and sanitized `doctor`
diagnostics.

## Phased build plan

Each phase is its own PR, green before the next. Fixture vault throughout; real vault only
at Phase 5.

0. **Normative contracts — phase-gated, not one big-bang gate.** To honor "phased milestones, not big-bang," contracts are
   approved **per phase**, not all before any code:
   - **Before Phase 1 (up-front gate):** the **cross-cutting safety invariants** and Phase-1
     contracts only — `recovery-state-machine.md`, `sqlite-data-dictionary.md`,
     **`config-schema.md`**, **`vault-format.md`** (required by the first Phase-1 `db rebuild`),
     **`state-inventory.md`** (required by Phase-1 backup/restore), the `sqlite.ledger_backup`
     subsystem contract, the security/authorization+broker contract, `retention-matrix.md`, and
     `cli-contract/*` **for the Phase-1 commands** (`inspect`/`doctor`/`db …`). A single normative
     **contract-to-phase matrix** places every contract before its first consumer and is the sole
     authority on delivery phase. These gate Phase 1.
   - **Each later phase gates its own contracts:** Phase 2 approves `jobs-contract.md`,
     `sandbox-contract.md`, `normalization-contract.md`, the per-operation ChangePlan schema,
     the provider-interface + error-taxonomy contract, and its `cli-contract/*` **before Phase 2
     code**; Phase 3 approves retrieval/index contracts before Phase 3; Phase 4 its workflow +
     risk contracts; Phase 5 `bootstrap-migration.md` + `acceptance-thresholds.md`.
   Every contract still ships and is still required **before the implementation it governs** —
   the rigor is preserved — but earlier working slices can validate assumptions before later
   interfaces are frozen, so this is not a second design project ahead of all coding. All
   `cli-contract/*` schemas are complete before their command's implementation; none blocks an
   unrelated earlier phase.
1. **Skeleton** — pnpm monorepo scaffold + the shared **`contracts`** leaf package (stable IDs,
   ChangePlan / run-manifest schemas, canonical serialization — see *Repo layout*) + `config` +
   `vault` read/write + `sqlite-store` registry + migrations + `brain inspect` / `doctor` /
   `db rebuild` against a hand-built fixture vault. **Because Phase 1 also delivers the encrypted
   ledger backup subsystem and the privileged `db restore` (with release-blocking restore +
   corruption tests as Phase-1 exit criteria), Phase 1 additionally delivers the *minimal
   privilege-separation seam* those depend on:** the **`git`** package (repo/ref plumbing) and
   the separate-identity **`broker`** package sufficient to authorize and execute `db restore`
   and `db backup` under the separation-of-duties boundary (challenge/response +
   OS-presence/`--authorization`, protected-ref/credential custody, audit-event append). The
   broker's full canonical-integration surface (`approve`/`refresh`/`rollback`) is wired in
   Phase 4, and its **Tier-1 source-capture integration primitive** (CAS advance + broker-side
   policy re-verification + audit append for the deterministic source-capture commit) is
   delivered in **Phase 2** so that phase's canonical captures advance canonical through the
   broker like every other canonical write; its authorization core and the
   protected-ref/audit-ref ownership exist from
   Phase 1, so no phase depends on a broker capability delivered later than the phase needs it.
   `brain db backup` / `db restore` / `db verify --backup` ship here.
2. **Ingest loop** — `sources` normalize (md/txt/pdf/html) in a **sandboxed parser worker**
   (dedicated low-privilege identity, **allowlisted empty environment** — no inherited
   provider credentials/keychain/file descriptors, no network, isolated filesystem namespace
   exposing only the read-only input handle + a disposable output dir, isolated temp dir,
   CPU/memory/time caps, syscall restrictions, MIME-signature validation, external-resource +
   script processing disabled; output is validated + secret-scanned before re-entering the
   trusted process; the **supported V1 host, concrete isolation primitive per guarantee, and
   startup capability checks that fail fast when the host cannot enforce them** are named in
   `docs/specs/sandbox-contract.md` — V1 targets **macOS (Apple-silicon, current major) and
   Linux**, using OS-native primitives (macOS: `sandbox-exec`/Seatbelt profile +
   unprivileged spawn; Linux: user namespaces + seccomp-bpf + network-isolated netns +
   rlimits), and `brain doctor` verifies sandbox availability at startup. **Both native
   backends are intentionally in V1 scope** (operator directive — the initial environment spans
   both macOS and Linux; the *Scope* list names both); the sandbox contract keeps the
   guarantee set platform-neutral while certifying two isolation backends) → immutable
   source note → deterministic source-capture commit → RunReport. Default `brain ingest <file>`
   is a non-mutating preview; `--apply` performs the mutation (see CLI contract for the
   `--dry-run`/`--apply` mutual exclusion + exit codes). **This phase also delivers the
   `jobs` subsystem**: queue schema + repository, synchronous single-runner execution with
   atomic transitions/retry/backoff/idempotency keys, `brain jobs list|run|retry|cancel`, and
   startup recovery of interrupted jobs — with the single-runner queue tests as its exit
   criteria.

   **Phase 2 model activity is restricted to satisfy hard invariant 3.** Because retrieval does not exist until Phase 3, hard invariant
   3 forbids **creating even a `ChangePlan`** for a synthesis mutation here. Therefore in Phase
   2 the Gemini adapter is used **only for non-mutating extraction/classification** (e.g.
   proposing note `type`, extracting candidate metadata for *preview display*) — it **MUST NOT
   emit a synthesis `ChangePlan` at all.** The only artifact that may commit is **deterministic,
   model-free immutable source capture**. Synthesis ChangePlan *creation* moves to Phase 3+
   (after retrieval). An explicit **Phase 2 operation allowlist** (source-capture +
   projection-update operations only; synthesis operations forbidden) is enforced in code and by
   a release-blocking test. Risk-tier **gating** and untrusted-content **taint enforcement** land
   in Phase 4; until then, even the deterministic source-capture path never auto-integrates a
   *model-derived* artifact (there are none in Phase 2), and canonical HEAD / canonical Markdown
   provably change only via deterministic source capture. This makes the invariant genuinely
   satisfied (no forbidden plan is created), not merely rendered non-integrable.
3. **Retrieval** — `lancedb-index` chunk + embed (Gemini) + hybrid search; `retrieval` RRF
   + context packing; `brain query`; `brain index` ops + staleness detection.
4. **Workflows** — `enrich`, `reconcile` (aliases/duplicates), `maintain`
   (orphans/broken-links/stale → proposals, never silent destructive), `validate`; risk
   tiers + review gate wired through `git`. **Also delivers the human-authorized erasure
   workflow `brain purge`** (broker-authorized, `vault-maintenance`-locked, all-storage-class
   inventory + audit-ref reconciliation + post-purge verification, per its command contract in
   *Erasure workflow*) — every storage class it touches (git history, projection + ledger,
   LanceDB, logs, quarantine, backups, audit ref) exists by this phase; its privileged-E2E
   erasure test is a Phase-4 exit criterion. Purge is then **exercised against the copied
   real-vault sandbox in Phase 5** (uniquely-identifiable classified content in every class),
   not first introduced there.
5. **Graduate to real vault** — first a **fail-closed, full-vault secret + sensitive-data
   scan** of the copied `main-vault` sandbox (before any db rebuild, indexing, migration, or
   model call); findings block graduation and route to the reviewed-remediation /
   encrypted-quarantine workflow (which accounts for pre-existing git history). Then a
   **read-only bootstrap audit**: inventory legacy notes missing `id`/`type`/`schema_version`,
   ambiguous aliases, duplicate identities, and incompatible links. Then a **deterministic,
   review-gated bootstrap migration** governed by the normative
   `docs/specs/bootstrap-migration.md` contract (ID-derivation + collision rules,
   `type`-inference precedence, link-rewrite/preservation algorithm, per-note checkpoints,
   review artifacts, rollback, and the per-quarantine-category operator commands **`brain
   bootstrap inspect`/`brain bootstrap resolve`** — each enumerated in the canonical command
   registry (`commands.json`) with its selector (per-quarantine-category), request/result JSON
   schema, authorization tier, idempotency class, stable error codes, and per-command acceptance
   cases, and exercised by executable migration fixtures): assign stable `id`s, infer `type`, quarantine
   identity conflicts, preserve existing links, initialize `schema_version`, with rollback
   and explicit graduation criteria (zero unresolved quarantines; projections rebuild clean)
   **before any real-vault workflow runs**. Then run agent-branch-only; verify git-rollback +
   full derived-state rebuild; retrieval eval on a small labeled set.

## Testing
Fixture vaults: `empty`, `small-valid`, `broken-links`, `duplicate-ids`,
`conflicting-claims`, `source-heavy`, plus one fixture per supported `schema_version`. Layers:
unit (parse/hash/ID-normalize/chunk/patch/risk/schema), a **generated table-driven
mutation-policy matrix** (**every** ChangePlan operation × target note type × trust/verification
state — asserting allowed/rejected status, effective risk, review requirement, and canonical
side effects, including explicit V1 rejection of `CreateTask`/`UpdateTaskState`), integration (sqlite repos, lancedb
indexing, sqlite↔lancedb consistency, git worktrees, job retries, model adapter), e2e (ingest
one source, update existing note, reject duplicate-note creation, require review for
high-risk, recover after index failure, rebuild all derived state, rollback applied change).
Retrieval eval (recall@K, MRR, canonical-note discovery, source-grounding) before claiming
quality.

**Security (negative) tests.** Fail-closed secret scanning on every egress path
(**Phase-2 ingest preview/apply extraction+classification**/query/enrich/index/rebuild/retry) —
including secret-bearing and prompt-injection-shaped ingest inputs asserted blocked before any
provider request, with the expected sanitized ledger/audit outcome recorded; path-traversal + symlink-escape + symlink-race;
disguised/oversized attachments; representative secret formats; injection-shaped
Markdown/frontmatter; adversarial indirect-prompt-injection sources; **plus a provider response
that itself introduces/echoes a secret** (generated-artifact persistence guard). For blocked
input, assert the content is neither transmitted nor persisted to **any sink** — inspecting
**raw-source storage, worktrees, git objects + refs, LanceDB, temp/parser output, diagnostics,
audit records, and every ledger backup** (not just Markdown + SQLite). **Quarantine tests:**
assert quarantine contains only **authenticated ciphertext (AEAD integrity)**, the key is
**inaccessible to parser/model processes**, filenames are minimized, key rotation/revocation
works, retention expiry purges, and a **crash mid-quarantine leaves no plaintext** behind.

**Optional raw-payload store.** Tests assert that with `sqlite.raw_payload_store` **off** raw
payloads are absent from **every** sink; when **on**, payloads exist **only as AEAD ciphertext**
in the dedicated store with a **separate key** — covering key separation + revocation,
bounded-retention expiry, inclusion in + recovery from the ledger backup, corruption handling,
and purge removal.

**Parser-sandbox containment (adversarial).** Probe parsers run inside the real sandbox
launcher assert that network access, environment variables, keychain/credential access,
inherited file descriptors, out-of-scope paths, subprocess spawning, and forbidden syscalls
all fail, and that CPU/memory/output-size/timeout caps enforce (including cleanup after forced
termination).

**Normalization conformance (per format — finding: source-format envelope).** Fixture-driven
tests per format (md/txt/pdf/html) exercising the `normalization-contract.md` envelope: accepted
MIME signatures + canonical media token; UTF-8 / UTF-16-BOM accepted vs `unsupported-encoding`
rejection (no lossy guess); **encrypted PDF → `encrypted-source`**, **scanned/no-text-layer PDF
→ `no-extractable-text`** (OCR out of V1), embedded attachments recorded as gaps, script-bearing
HTML → static DOM only (scripts never executed); **partial extraction is a typed rejection, never
a silent truncation**; deterministic byte-identical output for identical bytes+versions; and
per-format size limits + the stable error-code set.

**Trust promotion/revocation lifecycle.** Unit/integration/e2e: forged or agent-initiated
promotion refused; promotion bound to the immutable `contentId` (a raw-content change mints a new `contentId`, so
an authorization can never silently re-target); promotion replay rejected; multi-hop transitive taint
propagation; mixed trusted/untrusted evidence keeps a note untrusted; no laundering via
summary; revocation during a pending run marks it `failed@<checkpoint>` (`trust-revoked`) while
revocation after a Tier-2 auto-commit leaves the terminal run intact and **spawns a new
Tier-3 remediation run** (its own `runId` + review artifacts + audit event, integrating only
via `git approve`/`rollback`); assert audit records, risk escalation, and refusal of
unauthorized mutations.

**Gemini adapter tests.** Deterministic doubles/recorded responses by default + opt-in
real-service contract tests; a **minimal pre-release Gemini smoke/contract suite is release-gating**
(verifying configured model availability, structured-output schema handling, cancellation + error
mapping, embedding dimensions, immutable model-fingerprint capture, and egress-broker destination
policy against sanitized fixtures) while broader/costly provider tests stay nightly; cover malformed/truncated output, schema violations, timeouts,
rate-limit/quota/throttle (asserting `retryAfter` → `retryAfterMs` propagation), transient vs
permanent errors, retry limits, partial batch failures, and embedding-dimension mismatch;
assert a model-call audit record exists for every outcome. **Cancellation (explicit):**
`AbortSignal` cancellation **before dispatch** and **during generation and mid-embed-batch**
(asserting a `cancelled` error, partial-batch naming of completed items, no persistence as
complete, and correct `run.cancelled` audit state). **Authentication (explicit):** invalid,
missing, and revoked credential cases asserting the stable `authentication` mapping,
`retryable: false`, **no retries attempted**, and sanitized diagnostics (no key material).

**Provenance versioning.** Table-driven integration tests across every supported format: same
bytes captured from different paths (adds a capture, not a blob), changed bytes at the same
path (new immutable source version), extractor/normalizer upgrades (new rendition, old
retained), locator-namespace stability, rendition dedup, canonical-Markdown rebuild of all
three provenance entities, raw-byte immutability, marking dependent evidence `stale` after
`normalizedContentHash` changes, and **capture-event idempotency independent of blob dedup**
(retried same-path ingest adds no capture; new path adds one). **Evidence re-verification
end-to-end:** after a rendition bump, assert the deterministic
affected-evidence enumeration, the per-owning-note re-verification job (idempotent by
`(contentId, newRenditionId, owningNoteId)` — **asserting a rendition bump spanning multiple
owning notes enqueues one non-colliding job per note, so no note is left stale**), and the
three outcomes — **exact re-match → `valid` re-pinned**,
**ambiguous/moved → `pending` escalated to Tier-3 (never auto-committed)**, **not-found →
`failed`** — plus the gating assertion that `stale`/`pending`/`failed` evidence cannot support
Tier-2 auto-commit or trusted synthesis grounding, and that all verification-state changes flow
through validated ChangePlans + git (a bare SQLite write would be lost on `db rebuild`).

**Crash-recovery failpoints (generated from the normative transition table — finding: matrix
omits critical states).** Failpoint tests are **generated directly from
`recovery-state-machine.md`**, injecting a crash **immediately before and after every external
git effect and every checkpoint write** — not collapsed generic `applied`/`committed`. The
matrix MUST include: `planned`, `patched`, `worktree-applied`, **`agent-committed`**,
**`review-pending` persistence**, **approval/integration commit**, **integration-hash
persistence** (the idempotency anchor — a crash both before and after writing it, asserting no
reapplication), `rejected`, `rolled-back`, **`failed@<checkpoint>`**, **`cancelled@<checkpoint>`**,
`reindexed`, and `finalized`, **plus** every reconciliation transition (after SQLite txn,
needs-index marker, chunk, embed, partial upsert, verify, final indexed marker). Restart tests
assert convergence with no duplicate chunks, lost updates, falsely-indexed records, orphaned
worktrees, double-commits, or half-integrated canonical refs; include permanent-embedding
failure + repair-command coverage and failed/cancelled-run artifact-retention + cleanup
assertions.

**Command idempotency (registry-generated — finding: no exhaustive matrix).** An idempotency suite
is **generated from the canonical command registry for every state-changing command**: for
**key-accepting** commands (backup, restore, trust ops, rollback, ingest, enrich, reconcile,
maintain, and the rest) it exercises identical retry, key reuse with different input (rejected),
concurrent duplicate invocation (blocks on the persisted key), crash/lost-response replay at **each
durable checkpoint**, and terminal-result replay; for **intrinsically idempotent** commands it runs
them repeatedly and after interruption asserting convergence with no additional side effects. No
state-changing command is exempt.

**Queue (single-runner V1).** Idempotency-key collisions, retry exhaustion → terminal state,
startup recovery of interrupted/abandoned attempts, cancellation of queued-vs-running, and
`jobs run/retry/cancel` CLI behavior, under controlled clocks + crash injection. **Cross-process
single-runner exclusion:** a required test
**starts two `jobs run` processes concurrently** against the same queue and asserts **one
process acquires the single-runner process lock and drains the jobs, the other fails fast with
the stable `locked:<scope>` lock error (exit `2`) and claims nothing, and every job executes
exactly once** (no duplicate claim, no duplicate side effect) — proving a broken process lock
cannot pass the suite silently. The
multi-worker matrix (duplicate delivery, concurrent claimers, expired leases, worker-death
races) is **deferred** with the leasing/daemon milestone.

**Migration compatibility (V1 scope).** Legacy-unversioned → v1 bootstrap and
`schema_version: 1` validation, interrupted + rerun (idempotent) bootstrap, unsupported/
future-version rejection, unknown-frontmatter + provenance preservation, rebuild-after-
migration, and rollback/restore of a failed bootstrap. (Multi-version sequential/direct-
upgrade matrices are deferred with the generalized migration framework.) **SQLite DDL migration
failpoints (Phase 1):** checksum-mismatch/tamper detection, crash between DDL application and
`db_schema_migrations` recording, partial multi-step migrations, unsupported newer database
versions, interrupted `brain db migrate` reruns, and concurrent migrate attempts — asserting
either complete migration or deterministic recovery with **no falsely recorded schema version**.

**Markdown accessibility.** Deterministic checks + fixtures for one logical top-level heading,
non-skipped heading levels, descriptive link labels, valid list structure, image alt-text
rules, **identifiable table headers + captions-or-surrounding-description, and equivalent
text/tabular data for every chart or other visual-data representation** — run during `validate` so a change cannot apply if it degrades navigation.

**Diagnostic logging.** Structured runtime diagnostics (CLI, parser-worker, recovery,
reconciliation) write to a configured destination separate from the audit ledger, correlated
by run/job id, with a redaction boundary (never raw prompts/quotes/secrets), rotation +
retention (`logs.*`), captured worker logs, and defined crash-before-checkpoint behavior; a
`doctor` check and an e2e self-debugging test for a failed run assert diagnostics survive and
are recoverable.

**Observability assertions — table-driven run-outcome matrix.**
A single table-driven suite enumerates **every run class and terminal state**: mutating
(Tier-1/2 auto-commit, Tier-3 review-pending → approved / rejected / rolled-back),
**read-only/Tier-0**, **projection-only**, **failed@<checkpoint>**, and **cancelled@<checkpoint>**.
For **each** case it asserts: `model_calls`/`retrieval_runs`/change plans/validation results/git
metadata/RunReport are complete and correlated by run id and sanitized (secrets/PII redacted);
the run's **audit footprint on `refs/audit/runs` matches the *Audit SSOT* event-stream
cardinality** — i.e. the lifecycle events the run passed through (`run.started`, `run.planned`,
…) plus **each applicable terminal event type exactly once** (`run.integrated` /
`run.rejected` / `run.rolled_back` / `run.failed` / `run.cancelled`, or the `run.readonly` /
`run.projection` terminal) — each correctly correlated, signed, and sanitized (the suite never
asserts "one event per run"); and after **SQLite loss** the `--from-git` rebuild reproduces the expected
per-class events (or explicit gaps) deterministically. The git-rebuild test explicitly requires
read-only, projection-only, failed, and cancelled events so no run class can silently gap.

**Retrieval-before-synthesis ordering.** A dedicated invariant test inspects persisted
checkpoints + event sequence, injects retrieval failure and empty-result cases, and asserts
that **no** `ChangePlan`, patch, worktree mutation, or commit is produced for a synthesis
mutation before a successful retrieval (source capture + its projection updates are exempt).
In the required safety-invariant CI gate.

**Approval-boundary + broker (adversarial).** Negative integration + e2e tests: an agent
workflow attempting `approve` (signing material absent from its environment); **an agent
process attempting to advance a protected ref directly via git plumbing** (`update-ref`, raw
ref-file write, index write against canonical, audit-ref truncation) — each must fail with
EACCES because the ref is broker-owned; absent/forged/replayed signatures; a signature copied
between plans or between commits; commit mutation after signing; `--yes` alone attempting
Tier-3 integration; **`approve` on a stale base returns `refresh-required` and never
rebases/creates a new commit**; stale-base races; and a canonical-branch move / TOCTOU change
immediately before merge — each refused by the broker's re-verification. **Broker-side risk/policy recomputation (adversarial):** submit a candidate whose manifest
falsely labels a Tier-3 or untrusted-derived change as Tier-1/Tier-2 (tampered `effectiveRisk`,
validation results, trust labels, plan payload, and candidate tree) and assert the broker
**independently** re-derives the higher risk/taint, refuses the protected-ref advance, and
requires a valid human approval where applicable. **Non-interactive
authorization:** the matrix is **generated from the canonical privileged-command registry** and
covers `approve`/`rollback`/`purge`/`db restore`/trust ops **plus broker-authorized `git reject`
and the `db backup --force-unblock` override** — each tested for unauthorized-agent invocation,
wrong signer, drift, expiry, replay, cancellation, and successful authorized execution with the
required audit record — via `--export-challenge` → sign → `--authorization`
round trip, asserting the execute step
**rejects any drift** from the exported challenge (canonical moved, nonce expired/replayed,
target commit changed, wrong signer) and that `rollback`'s challenge carries the deterministically
derived revert commit. **Audit-head anti-truncation:** truncate/rewrite the audit suffix and
assert the external WORM anchor detects it on startup / `git verify`. **OS-mediated presence
assertion:** using a controllable platform-authenticator double, cover valid, wrong-challenge,
expired, replayed, cancelled, and unavailable assertions, plus supported-host integration tests
proving the real macOS/Linux presence adapter either authorizes correctly or **fails closed with
a stable diagnostic**.

**Concurrent auto-integration (Tier-1/Tier-2).** Deterministic concurrency tests for
simultaneous auto-commit runs targeting the same and different notes: move the canonical
branch between validation and commit, assert the CAS fails and patches regenerate, retrieval +
validation rerun when inputs changed, and no lost update, stale-evidence commit, duplicate
commit, or unintended cross-note conflict occurs.

**Ledger backup/restore (primary DR path — finding: not tested).** Automated tests for the
`sqlite.ledger_backup` subsystem, **plus a full-system DR matrix that destroys and restores every
state-inventory store in the specified order** (SQLite ledger, trust-ledger ref/journal, backup
catalog + watermark, WORM anchors, authorization nonce/replay state, encrypted quarantine metadata)
— testing missing, stale, corrupt, and mutually inconsistent trust heads/anchors/nonces/catalogs/
watermarks and asserting startup + privileged ops **fail closed until an authorized repair**, and
that **revoked trust and consumed authorization nonces cannot reappear after restore**: a
**complete ledger round trip** (backup → wipe → `brain db
restore` → assert every ledger-only row, including data the git ref never carried, is
recovered); AEAD encryption + file-mode (0600) assertions; **wrong / revoked key** rejection;
**truncated / corrupt backup** rejection; **interrupted-restore atomicity** (all-or-nothing);
**schema-version compatibility** gate; and post-restore projection rebuild consistency. **Plus
the fail-closed backup contract:** inject a failing/unverifiable post-run backup and assert the
**watermark does not advance**, the health surface goes **degraded**, and a **table-driven
degraded-mode matrix per command class** holds: ledger-writing runs **and audited/model-backed
reads (e.g. `query`)** are blocked with the stable `backup-unhealthy` (exit `2`), while **only
genuinely non-persisting diagnostics** (pure `inspect`/`status`/`doctor`/`--json` health) remain
available; **`db restore` remains broker-authorizable and completes atomically even while backup
health is degraded** (the emergency-restore path), establishing a fresh watermark and recording
the accepted loss window; a subsequent successful+verified backup **unblocks** by advancing the
watermark to the latest ledger sequence, and the audited `--force-unblock` privileged override records the
accepted RPO gap. **Post-commit crash-window failpoints** inject abrupt process death after the
ledger commit, during Online-Backup snapshotting, after the encrypted-file rename, after
verification, and before/after watermark advancement; on restart the suite asserts watermark lag
is detected, further ledger-writing commands are blocked, incomplete temporary backups are
ignored, and a verified catch-up backup safely unblocks. This is
a **required, release-blocking** suite because this backup is the ledger's authoritative DR
path.

**Dual-outbox crash boundaries (generated failpoints — finding: not explicitly tested).** Generated
failpoint tests inject crashes at every boundary of **both** durable outboxes (integration-audit and
egress): request persistence, pre/post provider dispatch, response receipt, audit submission,
sequence allocation, Git append, and acknowledgement. After restart the suite asserts `eventId`-based
deduplication, monotonic gap-free `seq` allocation, deterministic request/result folding, correct
handling of an **indeterminate provider outcome**, and **no permanent ledger-only or Git-only event**
(and no duplicate provider dispatch).

**Audit disaster-recovery (partial git fallback).** Delete SQLite **and** its backup, then
rebuild mutating-run ledger rows from a multi-run git history via `brain db rebuild --from-git`;
compare reconstructed audit records to expected runs. Cover signature verification, reverts,
rejected/orphaned branches, duplicate manifests, tampered/partial history, and **audit-head
external-anchor / truncation detection** — asserting deterministic repair or explicit failure
(gaps surfaced, never silently dropped).

**Phase 2 non-integration exit test (release-blocking — finding: missing exit test).** A
Phase-2 E2E test submits **model-derived operations at every proposed risk level** (and
prompt-injection-shaped inputs) and asserts: canonical HEAD and canonical Markdown **never
change**; **no synthesis `ChangePlan` is even created** (the Phase-2 operation allowlist rejects
synthesis ops); **no approval path can integrate** a model-derived artifact; and **only
deterministic immutable source capture** may commit. This proves the temporary Phase-2
restriction, not merely single-runner queue behavior.

**Erasure / purge (privileged E2E — finding: no end-to-end strategy).** Seed **uniquely
identifiable** content in **every storage class** (Markdown + git history, worktrees, SQLite
projection + ledger, LanceDB, logs, diagnostics, quarantine, every ledger backup, the audit
ref). Then: assert **authorization denial + replay protection** for an unauthorized/agent
caller; run `brain purge` and verify **complete inventory**, required git-history handling,
**purge ordering + tombstones**, audit-ref reconciliation (opaque-ID unlink or signed
tombstone + external checkpoint), **backup treatment/expiration**, **interruption/resume**,
projection rebuild, audit output, and **post-purge searches across every storage class proving
no prohibited copy (including no re-linkable audit identifier) remains.**

**Performance & scale.** **One evidence-based V1 vault profile** — seeded from a **provisional fixture-based profile
before Phase 5** and revised from **read-only, sanitized vault-statistics** collected when the
`main-vault` copy is scanned at the start of Phase 5 (the copy+scan is explicitly sequenced
*before* the Phase-5 threshold contract is finalized) plus a
modest near-term growth margin (defined in `docs/specs/acceptance-thresholds.md`) — drives
automated benchmarks for ingest, query, indexing, reconciliation, migration, and rebuild with
latency/throughput/memory/disk-growth/recovery-time thresholds. **Only the critical interactive
and rebuild paths are release-gated at that profile**; broader maximum-scale benchmarking is
**deferred** until measured usage establishes a larger target. A stable subset runs as a
regression gate.

**CLI pagination & terminal accessibility.** Contract tests for pagination under concurrent
inserts/deletes, deterministic tie-breaking, invalid/out-of-range offset + limit bounds,
byte-stable JSON schemas, stdout/stderr separation, TTY vs non-TTY rendering, `NO_COLOR` /
`--no-color` / `--no-pager`, and keyboard-independent (no-required-UI) execution.

**CI regression gate.** A required offline (no live Gemini) suite runs on every change plus a
required critical-path e2e set (mutation-safety, review gating, rollback, rebuild, source
immutability); live-Gemini tests are opt-in/nightly; flaky tests quarantined; any
safety-invariant regression is release-blocking.

**Execution-environment matrix.** The supported OS/filesystem/Git/SQLite matrix (see
`docs/specs/sandbox-contract.md` + the testing-env doc) drives platform-specific integration
suites — sandbox availability, permission-mode enforcement, symlink behavior/races, git
worktrees, SQLite WAL + locking, encrypted-volume detection — with per-platform installation
smoke tests and documented parity gaps; a green CI run must represent a supported local
install.

## Acceptance criteria (V1)
- Markdown authoritative; raw sources immutable; stable IDs; per-type mutation policies.
- **Three separate disaster-recovery guarantees hold (matching *Two classes of state*):**
  (1) **Projection rebuild** — the SQLite **vault-projection tables** and all of LanceDB can
  be deleted and are deterministically, losslessly rebuilt from Markdown (`brain db rebuild` +
  `brain index rebuild`); stale-chunk detection works; hybrid retrieval traceable.
  (2) **Ledger restore** — the operational/audit ledger (primary, NOT rebuildable from
  Markdown) is recoverable **only** by restoring the encrypted `sqlite.ledger_backup`
  (`brain db restore`), verified by a destructive round-trip test.
  (3) **Partial git-audit fallback** — with both SQLite and its backup lost,
  `brain db rebuild --from-git` reconstructs mutating-run ledger rows **best-effort** and
  surfaces gaps. These three are distinct and never conflated: no single mechanism claims to
  rebuild the whole database from Markdown.
- Raw model output cannot write files, **and no agent/parser filesystem access can advance a
  protected ref** (broker-enforced); every canonical write is a typed plan producing a git
  diff; Tier-3 requires review; rollback works.
- Retrieval precedes every **synthesis** mutation and is logged; immutable source capture
  and its deterministic projection updates are exempt (hard invariant 3, Phase 2 ordering).
  Eval fixtures exist.
- `brain doctor` reports health; index/db verify work; failed jobs retry; runs inspectable.
- CLI usable without reading source; `--dry-run`/`--apply` exist with a safe non-mutating
  default; JSON output exists; **errors are text-first** (severity, affected
  argument/config-key/file + source location, remediation — never color/symbol alone, same
  association in JSON).
- **Per-command acceptance cases.** The acceptance-case inventory is **generated from the
  single canonical command registry** (see *CLI contract* — the machine-readable registry that
  owns command membership and generates the CLI overview, the per-command schema inventory, and
  these acceptance cases from one source, so no list can drift or omit a safety-critical
  command). It covers **every** command and subcommand with no gaps —
  including `inspect`, `doctor`, `status`, `source add/list/show/trust (show/promote/revoke)`,
  `note show/related/history`, `evidence review/resolve/retry`, `jobs list`, `index status`, `db status`, `git status/refresh`,
  `bootstrap inspect/resolve` alongside `ingest`, `query`, `enrich`, `reconcile`, `maintain`, `validate`,
  `jobs run/retry/cancel`, `index verify/repair/rebuild`,
  `db verify/migrate/rebuild`, **`db backup`, `db restore`, `db verify --backup`**, **`purge`**,
  `git review/approve/reject/rollback/cleanup/verify`. Each gets at least one **success,
  zero-state, invalid-input, and representative-failure** case specifying fixture/setup,
  invocation, expected stdout or JSON schema, exit code, Markdown/SQLite/LanceDB/git effects,
  prohibited effects, and representative errors.
- **Objective thresholds.** These are fixed in a version-controlled normative contract
  (`docs/specs/acceptance-thresholds.md`) that must land **before the phase whose behavior it
  gates** (workflow thresholds before Phase 4; retrieval-eval + scale profiles before Phase 5)
  — per the phase-gated contract rule, not all before Phase 1. V1 seeds it with concrete
  defaults: Tier-2 auto-commit requires **two separately typed confidence inputs — model confidence
  (from the provider adapter) and validation confidence (from the deterministic `validation`
  layer), each independently ≥ 0.8**, reduced across the plan's operations + evidence by
  **minimum** (a missing/malformed/conflicting value **fails closed to Tier-3**, and the broker
  re-verifies the gate; calibration fixtures fix rounding + missing-value behavior) **and** patch
  size ≤ 50 changed lines across ≤ 3 sections of a single note (larger
  ⇒ Tier-3); retrieval eval on the versioned labeled fixture set must hit recall@10 ≥ 0.85
  and MRR ≥ 0.7 for canonical-note discovery; a **versioned labeled source-grounding set** must
  hit release-blocking thresholds for evidence-source recall, locator/quote accuracy, citation
  precision, unsupported-answer rate, and correct abstention when no valid evidence exists; `doctor`/`verify` enumerate their required
  checks in the same contract; the representative V1 vault profile + growth margin lives there
  too (maximum-scale profiles deferred until measured usage sets a larger target). Each failure has a defined exit code + JSON result. The per-command executable cases
  + JSON schemas (above) live alongside it as `docs/specs/cli-contract/*` and each is required
  **before its own command's implementation** (phase-gated), not before all coding.
