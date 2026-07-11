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

**Out of V1 (explicit non-goals):**
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
   durable checkpoints recorded in `agent_runs`/`change_plans`. The **agent-branch commit**
   and the **canonical integration commit** are recorded as separate hashes. A Tier-3 run
   halts at `review-pending` after `agent-committed`; from `review-pending` the **only** legal
   transitions are **approve** (→ `integrated`), **refresh** (→ back to `review-pending` on a
   new commit), and **reject** (→ terminal `rejected`). `rollback` is **not** a legal
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
   - **Before any canonical effect** (`planned`..`agent-committed`): the agent branch/worktree
     is retained for inspection but **never** auto-integrated; `brain git cleanup` prunes it;
     the run is terminal and **not** auto-resumed (a re-invocation with the same intrinsic
     identifiers starts a fresh run — idempotency keys make that a no-op if already terminal).
   - **`failed`/`cancelled` never leave a half-integrated canonical ref** — the broker is
     atomic, so a failure during integration means the CAS did not apply and the run is
     `failed@integrating` with canonical unchanged.
   - Every `failed`/`cancelled` run emits exactly one audit event (see *Audit SSOT*).
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
   normative contract (`docs/specs/recovery-state-machine.md`) landing before Phase 2.
   Ambiguous states fail fast, surface in `brain doctor`, and have a documented operator
   repair flow rather than an automatic guess.

## Repo layout (pnpm monorepo, strict TS)

Two authoritative trees are given so an implementer has no ambiguity: the **physical V1
workspace** (what `pnpm-workspace.yaml` actually declares) and the **logical module map**
(the internal boundaries inside those packages). They are distinct on purpose.

**A. Physical V1 workspace (normative — this is what ships).** V1 declares a small set of
workspace **packages** and keeps everything else as **internal modules** (directories inside
`apps/cli/src/`), because only components with a demonstrated isolation/reuse boundary
(persistence and provider adapters) earn a package API in V1:

```
atlas/
  apps/cli/            ← the single CLI application; hosts all internal modules below
    src/
      domain/          types, stable IDs, Zod schemas, ChangePlan operations   (internal module)
      config/          typed config load + startup validation                  (internal module)
      vault/           read/write Markdown, frontmatter, wikilinks             (internal module)
      markdown/        parse + section/AST-level patch generator               (internal module)
      retrieval/       layered retrieve + RRF + context packing                (internal module)
      workflows/       deterministic orchestrator + typed stages               (internal module)
      policies/        note-type mutation policy + risk tiers                  (internal module)
      validation/      deterministic checks (+ optional semantic proposals)    (internal module)
  packages/
    sources/           normalize md/txt/pdf/html in a sandboxed worker   (package — isolation need)
    sqlite-store/      registry, links, jobs, runs, plans; migrations    (package — persistence)
    lancedb-index/     chunk + embed + hybrid (fts + vector) search      (package — persistence)
    models/            provider-neutral generateText/generateObject/embed (package — adapter)
    git/               branch / worktree / commit / broker client        (package — process seam)
    jobs/              SQLite-backed queue (retries, backoff, idempotency) (package — persistence)
    broker/            privilege-separated integration broker (separate OS identity)  (package)
    testing/           fixture-vault helpers                             (package)
  fixtures/  migrations/  prompts/  schemas/  docs/
  AGENTS.md  brain.config.example.yaml  package.json  pnpm-workspace.yaml  tsconfig.base.json
```

**B. Logical module map.** `domain`, `policies`, `validation`, `workflows`, `vault`, and
`markdown` are first-class *logical* boundaries with the same ownership discipline as
packages, but they live as internal modules of `apps/cli` in V1. They are **promoted to
workspace packages only** when independent reuse/versioning/ownership becomes concrete —
avoiding premature package-API overhead with no V1 consumer. Phase deliverables (below) use
the word **"package"** only for the tree-A packages and **"internal module"** for tree-B
boundaries, consistently.

No boundary without a clear owner. Explicit services/adapters/repositories over frameworks.
No cross-boundary "share code via import" hacks that violate the module seam; the
agent-facing code never imports the broker's privileged internals (it calls across the
process seam).

**Jobs in V1.** The `jobs` queue runs **synchronously in the CLI** (no daemon). It persists
job status, attempt count, idempotency key, and retry eligibility. V1 ships a **persistent single-runner queue**: atomic state transitions, attempt counts,
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
  whitespace/punctuation-normalized) into a single identity namespace modeled as one table
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
**Deduplication & handle resolution (normative).** Blob identity is
`contentId = (rawContentHash, canonicalMediaType)`. `canonicalMediaType` is the output of a
deterministic media-type normalization step (sniffed MIME signature → a fixed canonical token,
per the normalization contract), so identical bytes that some callers label differently
deduplicate **iff** they normalize to the same canonical media type; identical bytes that
genuinely decode as different formats (e.g. a file that is both valid text and valid HTML) are
**distinct** `contentId`s by design. Re-ingesting an existing `contentId` records a **new
capture event** (a legitimate recapture) but reuses the blob — capture-event idempotency is
keyed on `(contentId, origin)` so a retried ingest of the same path does **not** add a
duplicate capture, while a genuinely new path does. A path whose content changed produces a
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
`content_blobs` (PK `contentId` = (`rawContentHash`,`canonicalMediaType`), plus
`active_rendition_id` FK → `source_renditions`) —1─n→ `source_captures`
(PK `captureId`, FK `contentId`, `origin`, `captureTime`, **UNIQUE(`contentId`,`origin`)**) and
—1─n→ `source_renditions`
(PK `renditionId` = (`contentId`,`extractorVersion`,`normalizerVersion`),
`normalizedContentHash`, `sizeBytes`, `locatorScheme`); `claim_evidence.renditionId` FKs
`source_renditions`, and the `sourceId` CLI alias resolves to `content_blobs.active_rendition_id`.
Each table has a canonical Markdown manifest form that `brain db rebuild` folds back (the
active-rendition pointer is derivable from the manifests, so it too rebuilds deterministically).

### Claims & provenance
Claims carry evidence (`sourceId` + optional `locator` + `quoteHash`) and a status
(`active` / `disputed` / `superseded`). An LLM-generated synthesis must never become an
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
1. The set of affected evidence rows is **deterministically enumerated** = every
   `claim_evidence` whose `renditionId` belongs to the superseded `contentId`.
2. A single **re-verification job** is enqueued per affected owning-note (batched per note so
   one note's evidence is patched in one workflow run, avoiding partial multi-note drift). The
   job's idempotency key = (`contentId`, new `renditionId`).
3. The job runs a **deterministic re-anchoring** of each affected evidence to the new
   rendition's locator namespace: it re-locates the recorded `quoteHash` in the new normalized
   text. Outcomes are transactional per owning note, applied as one validated ChangePlan
   (`UpdateEvidenceVerification` operations) committed on an agent branch:
   - **exact re-match** → `valid`, `renditionId`/`locator` re-pinned to the new rendition;
   - **ambiguous / moved** (quote found but relocated, or multiple matches) → `pending`,
     escalated to Tier-3 review (never auto-committed);
   - **not found** → `failed`.
4. Until re-verification completes, affected evidence is marked `stale` (the transitional
   state that triggered the job).

**Gating by verification state (normative):** evidence that is `stale`, `pending`, or `failed`
**MUST NOT** support Tier-2 auto-commit and **MUST NOT** be presented to synthesis as trusted
grounding; retrieval MAY surface such evidence but **only flagged as unverified**. A claim all
of whose evidence is non-`valid` is treated as unsupported for auto-commit purposes. This
prevents silent accumulation of permanently stale claims from changing gating behavior. Retry
limits, the `pending`/`failed` operator-resolution commands, and successful/ambiguous/failed
re-verification acceptance cases are in the retention + acceptance contracts.

**Deferred** until a concrete contradiction-resolution workflow is designed +
accepted: structured predicates, the `active → disputed → superseded` transitions, and
`supersedes`/`disputes` inter-claim references (columns may exist for forward-compatibility
but no V1 workflow drives them — contradiction erasure is explicitly Tier-3/review-only). Evidence idempotency is
enforced by a **non-null `evidenceId`** = hash over tagged
(`claimId`,`renditionId`,`locator`,`quoteHash`) values (absent `locator`/`quoteHash` encoded
as explicit sentinels, never SQL NULL — so a unique index cannot be bypassed by
NULL-distinctness), with checks defining the valid `locator`/`quoteHash` combinations —
making `AttachEvidence` idempotent.
`CreateRelationship` writes a typed relationship (predicate + source/target `noteId`) as a
canonical typed wikilink in frontmatter, rebuilt into `note_links`. Validation rejects
dangling `sourceId`/`noteId`/`claimId` references and duplicate evidence.

### SQLite tables (V1 subset)
`notes, note_identity_keys, note_links, content_blobs, source_captures, source_renditions,
note_sources, claims, claim_evidence, vault_schema_migrations,
jobs, job_attempts, agent_runs, model_calls, retrieval_runs, retrieval_results, change_plans,
patches, patch_operations, validation_results, git_operations, db_schema_migrations,
audit_events`.
FKs on, WAL considered, content-hash change detection, idempotent upserts. A **versioned index
contract** (Phase 0) maps concrete access patterns to composite indexes — job eligibility by
(`state`,`next_run_at`), bidirectional `note_links` traversal, run lookup by `status`,
identity resolution on `note_identity_keys(normalized_key)`, notes-needing-index scans by
(`active_generation`,`contentHash`), and audit lookup by `run_id` — verified with query-plan
assertions at representative and maximum vault sizes.

**Two migration ledgers, never conflated (finding: migration history):**
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
- `claim_evidence` has a **non-null `evidence_id`** (hash over tagged
  `claimId,renditionId,locator,quoteHash` with explicit sentinels for absent locator/quoteHash)
  with a UNIQUE index → makes `AttachEvidence` idempotent; `verification` is a CHECK-constrained
  enum `{valid,stale,pending,failed}`.
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
  primary state that **MUST be backed up**. `brain db rebuild` preserves it untouched (it
  replaces projection tables in one transaction, never reads or truncates ledger tables). Its
  authoritative disaster-recovery path is the **required, tested, encrypted SQLite ledger
  backup/restore** (see *Ledger backup subsystem* and *Audit SSOT*). The git audit ref is a
  **best-effort partial** cross-check only, never the ledger's DR system of record.

**Three DR guarantees, stated separately (finding: rebuildability):**
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

**Raw-payload retention — one policy, applied everywhere (finding: conflicting policies).**
Raw prompts, model responses, quotes, and retrieved content are **NOT persisted anywhere by
default** — the audit event, the ledger, logs, and the git ref all carry only the allowlisted
metadata schema (identifiers, hashes, classifications, destinations, metrics). Therefore, by
default, **raw payloads are not recoverable from any backup** — there is nothing to recover.
An **optional, opt-in encrypted payload store** (`sqlite.raw_payload_store`, default **off**)
may be enabled for debugging; when on, raw payloads live in a **separate, AEAD-encrypted,
non-audit store** (its own table + key, minimized filenames, bounded retention, included in the
ledger backup) — never inline in the audit event or the allowlisted ledger rows. Every section
that mentions raw-payload recoverability defers to this rule: default = never stored, never
recoverable; opt-in = recoverable only from the dedicated encrypted store's backup.

**Ledger backup subsystem (normative — finding: no delivery mechanism).** The primary DR path
is delivered by a concrete V1 subsystem, not just a config key:
- **Snapshot method:** SQLite Online Backup API (consistent, no reader/writer stall) → a single
  AEAD-encrypted backup file.
- **Trigger policy (V1, no scheduler):** a backup is taken (a) automatically after **every run
  that writes ledger rows** (post-commit, best-effort, failure logged loud but non-fatal), and
  (b) on demand via **`brain db backup`**. This gives an effective **RPO of one run**.
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
  `CreateRelationship`, `CreateClaim`, `AttachEvidence`, `UpdateEvidenceVerification`,
  `ProposeMerge`, `ProposeRename`
  (title/slug/filename/alias only — never `id`), `ProposeArchive`, `PromoteTrust`, `RevokeTrust`,
  `CreateTask`, `UpdateTaskState`. **Each operation has its own versioned, discriminated-union
  payload schema** (required/optional fields, constraints, precondition tokens — e.g. section
  selector + expected content hash, frontmatter value types, relationship-predicate enum,
  rename destination fields, task-transition guards — canonical serialization, and
  per-operation result + error codes), defined in the per-operation ChangePlan schema
  (Phase 0). Common envelope: each op carries target, rationale, supporting sourceIds,
  retrieved evidence, confidence, **`proposedRisk`** (model advisory only), reversibility, and
  an optional caller `idempotencyKey`. **`CreateTask`/`UpdateTaskState` and the `task` note
  type are reserved forward-compatible surface (per the *Scope* non-goals):** their schemas
  ship and validate so a future task workflow slots in without a schema break, but **no V1
  workflow, CLI command, or acceptance criterion exercises them**, and the validation layer
  **rejects any ChangePlan containing a task operation** in V1 (a fail-closed guard, so the
  reserved surface cannot be driven accidentally). This is deliberate in-scope schema, not a
  shipped task capability — the *Scope* list and this section agree on that classification.
- **Effective risk has exactly one producer.** The `policies` package deterministically
  derives and persists `effectiveRisk` from operation type + target note type + scope +
  configured policy; the model's `proposedRisk` is never trusted for gating. Git auto-commit
  vs. mandatory-review gating consumes **only** `effectiveRisk`.
- **Caller idempotency.** **Every state-changing command is classified** as either
  *key-accepting* or *intrinsically idempotent* — with **no command left unclassified**.
  Key-accepting (accept `--idempotency-key`,
  persisting a normalized request hash + terminal result): `ingest`, `enrich`, `reconcile`,
  `maintain`, `source add`, `source trust promote`, `source trust revoke`, `jobs run`,
  `jobs retry`, `jobs cancel`, `git approve`, `git refresh`, `rollback`, `db backup`,
  `db restore`. Intrinsically idempotent (converge on repeat, no key needed): `git reject`,
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
run ID, source IDs, changed note IDs, effective risk, validation status, plan hash).

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

**Event-stream model (finding: one event vs a stream).** A run is **not** one mutable event —
`refs/audit/runs` is an **append-only stream of one-or-more lifecycle events per run**,
correlated by `runId` and ordered by a per-ref monotonic `seq`. Defined event types:
`run.started`, `run.planned`, `run.integrated` (carries the integration commit hash — appended
as a **new event** after the commit exists, never mutating an earlier event on the append-only
ref), `run.rejected`, `run.rolled_back`, `run.failed`, `run.cancelled`, and the read-only /
projection-only `run.readonly` / `run.projection` terminal events. Each event carries `runId`,
`seq`, `type`, base/agent commit hashes, plan/patch hashes, changed note/source IDs, effective
risk, validation outcome, job snapshot + attempt outcomes, and references (ids/hashes) to
model-call and retrieval records — **allowlisted metadata only** (never raw payloads).
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
attestation key to **sign the event payload** (it can only attest, never authorize), while the
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
  **requiring a fresh approval signature** over the new commit. It never integrates.
- `reject <runId>` — records the rejection, deletes the branch + worktree, leaves canonical
  untouched.
- `rollback <runId>` — reverts an **already-`integrated`/`finalized`** canonical change
  (creates a revert commit; never rewrites shared history) and reconciles projections.
  **`rollback` is illegal from `review-pending`** (and any pre-integration state): a
  not-yet-integrated agent branch is discarded via `reject`, never `rollback` — this matches
  the normative transition table exactly. **`rollback` is a privileged canonical mutation**
  under the same separation-of-duties boundary as `approve`: it requires user-presence or a
  separately held signing-key authorization bound to the target run, the current canonical
  commit, the intended revert commit, and a replay-protection nonce, verified by the broker
  immediately before the revert — an agent workflow can never invoke it.

  **Operation-specific rollback semantics + dependency checks (finding: unsound generic
  revert).** Before reverting, `rollback` computes the **downstream reference set** of the
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
  Every rollback path ends with mandatory projection reconciliation and one audit event; these
  outcomes are enumerated in the rollback contract + tests.
- `cleanup` — prunes worktrees/branches for terminal (approved/rejected) runs.
- Every outcome (approve/reject/rollback) triggers mandatory SQLite/LanceDB reconciliation.

**Authorization boundary (separation of duties) — enforced by a privilege-separated
integration broker (finding: agent FS access can bypass approval).** The separation-of-duties
guarantee is **not** merely CLI behavior plus an unavailable signing key. It is enforced by an
OS-level privilege boundary so that **no filesystem access available to an agent or parser
process can advance a protected ref**, even with direct git plumbing:

- **Protected refs** = the canonical branch ref, `refs/audit/runs`, and the trust ledger ref.
  These are owned by a dedicated **broker OS user** (separate uid/credential). The vault's git
  object store is group-readable/writable so agents can write objects and their own
  `refs/agent/*` refs, but the **protected refs and the reflog/ref storage backing them are
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
  approved tree), and that the corresponding **audit event** is present — then atomically
  advances the protected ref **and** appends the audit event in one broker-side transaction.
  A compromised agent cannot integrate a Tier-3 change without a valid signature the broker
  verifies, because the agent physically cannot write the ref.
- **Audit-head anchoring / anti-truncation.** The broker records the `refs/audit/runs` head
  (hash + monotonically increasing event count, signed by the broker) into an **append-only /
  WORM location outside the agent-writable repository** (a broker-owned, agent-unreadable
  append-only file, plus the encrypted ledger backup). On startup and in `brain doctor`/`git
  verify`, the current audit head is checked against that external anchor: **any truncation or
  rewrite of a valid audit suffix is detectable** even after SQLite loss, because the anchor's
  event count exceeds what a truncated ref carries. Agents cannot write the anchor.

Approval itself requires either explicit **interactive user-presence confirmation** or a
**separately held signing key** the agent process cannot read; **`--yes` alone can never
authorize Tier-3 integration or any privileged op** — it only bypasses cosmetic confirmation
prompts. Key provisioning, storage (OS keychain / hardware-backed, never in the vault or in env
visible to the agent), rotation, revocation, signer identity, signature algorithm (Ed25519),
and per-approval nonce replay-protection are defined in the git/broker package contract. The
same broker boundary governs **every privileged canonical or destructive operation** —
`approve`, `refresh`-integration, `rollback`, erasure/`purge`, `db restore`, and trust
`promote`/`revoke` — each requiring user-presence or a separately held signature bound to
(target run, canonical commit, intended effect, replay nonce); none is invocable by an agent
workflow.

**Non-interactive authorization CLI contract (challenge/response — finding: no usable
contract).** Every privileged command supports a two-step, fully non-interactive protocol with
JSON schemas (in `cli-contract/`):
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
The interactive path (`--yes` + user-presence) and the non-interactive path (`--authorization`)
are the only two ways to authorize; there is no third. Signer selection, expiry, verification
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
brain index status|verify|repair|rebuild
brain db status|verify|migrate|rebuild|backup|restore
brain jobs list|run|retry|cancel
brain git status|review|refresh|approve|reject|rollback|cleanup|verify
```
Human + JSON + quiet + verbose modes; stable exit codes
(`0` ok · `1` validation · `2` config/vault · `3` secret-scan · `4` internal · `5` user/usage ·
`6` action-required, e.g. an accepted-but-not-integrated review-pending run).

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
result array** plus an **aggregate exit status** (`0` all-succeeded; `1`/appropriate category
if any failed — the JSON body distinguishes per-job outcomes), and a job that changes state
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
"runId"?: string, "jobId"?: string }`; `details.*` are optional and typed as shown, multiple
failures are carried in `errors[]`, and `runId`/`jobId` are included whenever the failing
command operates on one. **Provider retry timing is preserved end-to-end (finding: lost at the
CLI boundary):** when a failure originates from a provider `rate_limit`/`quota` error carrying
`retryAfter`, the workflow normalizes it into **`retryAfterMs`** (integer milliseconds) on this
envelope and on the corresponding `jobs`/workflow result, so rate-limit consumers can honor
provider-directed timing programmatically. `retryAfterMs` is present iff the provider supplied
timing; `retryable` remains the boolean gate. The stable per-command `code` catalog (each mapped to an exit category) is enumerated
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

**Reduced-motion & screen-reader behavior (finding: TTY progress).** Animation/spinners/
in-place cursor updates are permitted **only** on an interactive TTY **and** when not
suppressed. A **`--plain`** flag (and honoring `--no-color`, `NO_COLOR`, and a
reduced-motion/`TERM=dumb` signal) **disables all animation, spinners, cursor movement, and
in-place updates even on a TTY**, replacing them with **concise append-only textual progress**
lines and explicit terminal-state messages (`started…`, `progress: N/M`, `done`, `failed: …`)
so a direct-terminal screen-reader user receives announced, non-overwritten state changes for
every long-running command (loading, progress, completion, failure). Contract tests exercise
long-running commands in `--plain` mode and assert append-only, non-duplicated announcements.

**Terminal-safe rendering (finding: control-sequence injection).** Human-mode commands display
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
secret-bearing source never reaches the vault or git history; blocked content is quarantined
outside the repository in a mode-0700 dir under **authenticated encryption (AEAD) whose key
lives in the OS keychain / hardware-backed store — never in the vault, env, or readable by the
model/parser processes — with defined rotation/revocation, encrypted-or-minimized filenames,
bounded retention, crash-safe purge, and `brain doctor` quarantine-security checks), the egress guard below, path-traversal + symlink protection, attachment
size/type limits, audit of external transmissions, and a `models.routing.confidential` config
hook (local/allowlist) reserved for V2. **Sensitivity is a first-class canonical field, split into declared vs effective (finding:
persisted and derived sensitivity share one truth):** each note/source carries a canonical
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

**Egress guard (non-bypassable).** Every `generateText`, `generateObject`, and `embed`
request routes through a single egress guard that scans the *exact serialized payload* —
covering ingest, query text, retrieval context, generated prompts, and embedding chunks, not
just ingestion. Detected secrets block or redact the call; failures fail closed and
quarantine; only sanitized metadata (hashes/classifications/destinations, never raw payloads)
is audited. Query, enrichment, indexing, rebuild, and retry paths are all in scope.

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

**Erasure workflow.** A human-approved `brain purge` (privileged, broker-authorized under the
separation-of-duties boundary; holds the exclusive vault-maintenance lock) inventories and
removes all derived and historical copies of classified content (Markdown history, worktrees,
SQLite, LanceDB, logs, backups), documents when git-history rewrite is required, rebuilds
projections afterward, and records that Google's provider-side retention/deletion terms apply
to already-transmitted content.

**Audit-ref reconciliation for erasure (finding: erasure vs the never-rewritten audit ref).**
The audit ref is normally append-only, but erasure of personal/classified data can require
removing linkable identifiers it retains. The two requirements are reconciled by an explicit
protocol, not left to chance:
1. **Minimize by construction:** audit events store **opaque, unlinkable IDs and salted
   hashes** for note/source identifiers — chosen so that, absent the ledger's mapping table
   (itself in the erasable ledger), an event cannot be re-linked to content. Ordinary erasure
   therefore needs **no** audit-ref rewrite: deleting the ledger mapping renders the audit
   event's opaque IDs non-identifying while preserving the integrity chain.
2. **When true removal from the audit ref is legally required**, a **privileged signed
   audit-ref replacement** is performed by the broker: it writes **signed tombstone events**
   for the redacted `seq` range and produces a new audit head, **externally checkpointing the
   replacement head** (in the same WORM anchor used for truncation detection) so the rewrite is
   itself attested and auditable rather than a silent force-update. Integrity is preserved: the
   replacement is signed, the prior head is recorded as superseded, and `git verify` validates
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

## Phased build plan

Each phase is its own PR, green before the next. Fixture vault throughout; real vault only
at Phase 5.

0. **Normative contracts — phase-gated, not one big-bang gate (finding: all-command gate
   defeats incremental delivery).** To honor "phased milestones, not big-bang," contracts are
   approved **per phase**, not all before any code:
   - **Before Phase 1 (up-front gate):** the **cross-cutting safety invariants** and Phase-1
     contracts only — `recovery-state-machine.md`, the `sqlite-data-dictionary.md`, the
     `sqlite.ledger_backup` subsystem contract, the security/authorization+broker contract,
     `retention-matrix.md`, and `cli-contract/*` **for the Phase-1 commands**
     (`inspect`/`doctor`/`db …`). These gate Phase 1.
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
1. **Skeleton** — pnpm monorepo scaffold + `domain` + `config` + `vault` read/write +
   `sqlite-store` registry + migrations + `brain inspect` / `doctor` / `db rebuild` against
   a hand-built fixture vault.
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

   **Phase 2 model activity is restricted to satisfy hard invariant 3 (findings: Phase 2 vs
   retrieval-before-synthesis).** Because retrieval does not exist until Phase 3, hard invariant
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
   tiers + review gate wired through `git`.
5. **Graduate to real vault** — first a **fail-closed, full-vault secret + sensitive-data
   scan** of the copied `main-vault` sandbox (before any db rebuild, indexing, migration, or
   model call); findings block graduation and route to the reviewed-remediation /
   encrypted-quarantine workflow (which accounts for pre-existing git history). Then a
   **read-only bootstrap audit**: inventory legacy notes missing `id`/`type`/`schema_version`,
   ambiguous aliases, duplicate identities, and incompatible links. Then a **deterministic,
   review-gated bootstrap migration** governed by the normative
   `docs/specs/bootstrap-migration.md` contract (ID-derivation + collision rules,
   `type`-inference precedence, link-rewrite/preservation algorithm, per-note checkpoints,
   review artifacts, rollback, and per-quarantine-category `inspect`/`resolve` operator
   commands with executable migration fixtures): assign stable `id`s, infer `type`, quarantine
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
Markdown/frontmatter; adversarial indirect-prompt-injection sources; **plus a provider response
that itself introduces/echoes a secret** (generated-artifact persistence guard). For blocked
input, assert the content is neither transmitted nor persisted to **any sink** — inspecting
**raw-source storage, worktrees, git objects + refs, LanceDB, temp/parser output, diagnostics,
audit records, and every ledger backup** (not just Markdown + SQLite). **Quarantine tests:**
assert quarantine contains only **authenticated ciphertext (AEAD integrity)**, the key is
**inaccessible to parser/model processes**, filenames are minimized, key rotation/revocation
works, retention expiry purges, and a **crash mid-quarantine leaves no plaintext** behind.

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
promotion refused; promotion bound to `sourceId`+`rawContentHash` (a hash change after
authorization invalidates it); promotion replay rejected; multi-hop transitive taint
propagation; mixed trusted/untrusted evidence keeps a note untrusted; no laundering via
summary; revocation during a pending run and after a Tier-2 auto-commit re-taints and reopens
affected plans; assert audit records, risk escalation, and refusal of unauthorized mutations.

**Gemini adapter tests.** Deterministic doubles/recorded responses by default + opt-in
real-service contract tests; cover malformed/truncated output, schema violations, timeouts,
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
end-to-end (finding: no complete workflow):** after a rendition bump, assert the deterministic
affected-evidence enumeration, the per-owning-note re-verification job (idempotent by
`(contentId, newRenditionId)`), and the three outcomes — **exact re-match → `valid` re-pinned**,
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

**Diagnostic logging.** Structured runtime diagnostics (CLI, parser-worker, recovery,
reconciliation) write to a configured destination separate from the audit ledger, correlated
by run/job id, with a redaction boundary (never raw prompts/quotes/secrets), rotation +
retention (`logs.*`), captured worker logs, and defined crash-before-checkpoint behavior; a
`doctor` check and an e2e self-debugging test for a failed run assert diagnostics survive and
are recoverable.

**Observability assertions — table-driven run-outcome matrix (finding: omitted run classes).**
A single table-driven suite enumerates **every run class and terminal state**: mutating
(Tier-1/2 auto-commit, Tier-3 review-pending → approved / rejected / rolled-back),
**read-only/Tier-0**, **projection-only**, **failed@<checkpoint>**, and **cancelled@<checkpoint>**.
For **each** case it asserts: `model_calls`/`retrieval_runs`/change plans/validation results/git
metadata/RunReport are complete and correlated by run id and sanitized (secrets/PII redacted);
**exactly one correctly correlated, signed, sanitized audit event** (plus any required
superseding `run.integrated`/`run.rejected`/`run.rolled_back` event) is written on
`refs/audit/runs`; and after **SQLite loss** the `--from-git` rebuild reproduces the expected
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
immediately before merge — each refused by the broker's re-verification. **Non-interactive
authorization (finding: challenge/response):** `--export-challenge` → sign → `--authorization`
round trip for `approve`/`rollback`/`purge`/`db restore`/trust ops, asserting the execute step
**rejects any drift** from the exported challenge (canonical moved, nonce expired/replayed,
target commit changed, wrong signer) and that `rollback`'s challenge carries the deterministically
derived revert commit. **Audit-head anti-truncation:** truncate/rewrite the audit suffix and
assert the external WORM anchor detects it on startup / `git verify`.

**Concurrent auto-integration (Tier-1/Tier-2).** Deterministic concurrency tests for
simultaneous auto-commit runs targeting the same and different notes: move the canonical
branch between validation and commit, assert the CAS fails and patches regenerate, retrieval +
validation rerun when inputs changed, and no lost update, stale-evidence commit, duplicate
commit, or unintended cross-note conflict occurs.

**Ledger backup/restore (primary DR path — finding: not tested).** Automated tests for the
`sqlite.ledger_backup` subsystem: a **complete ledger round trip** (backup → wipe → `brain db
restore` → assert every ledger-only row, including data the git ref never carried, is
recovered); AEAD encryption + file-mode (0600) assertions; **wrong / revoked key** rejection;
**truncated / corrupt backup** rejection; **interrupted-restore atomicity** (all-or-nothing);
**schema-version compatibility** gate; and post-restore projection rebuild consistency. This is
a **required, release-blocking** suite because this backup is the ledger's authoritative DR
path.

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
  canonical CLI command list** so it covers **every** command and subcommand with no gaps —
  including `inspect`, `doctor`, `status`, `source add/list/show/trust (show/promote/revoke)`,
  `note show/related/history`, `jobs list`, `index status`, `db status`, `git status/refresh`
  alongside `ingest`, `query`, `enrich`, `reconcile`, `maintain`, `validate`,
  `jobs run/retry/cancel`, `index verify/repair/rebuild`, `db verify/migrate/rebuild`,
  `git review/approve/reject/rollback/cleanup/verify`. Each gets at least one **success,
  zero-state, invalid-input, and representative-failure** case specifying fixture/setup,
  invocation, expected stdout or JSON schema, exit code, Markdown/SQLite/LanceDB/git effects,
  prohibited effects, and representative errors.
- **Objective thresholds.** These are fixed in a version-controlled normative contract
  (`docs/specs/acceptance-thresholds.md`) that must land **before the phase whose behavior it
  gates** (workflow thresholds before Phase 4; retrieval-eval + scale profiles before Phase 5)
  — per the phase-gated contract rule, not all before Phase 1. V1 seeds it with concrete
  defaults: Tier-2 auto-commit requires model+validation confidence
  ≥ 0.8 **and** patch size ≤ 50 changed lines across ≤ 3 sections of a single note (larger
  ⇒ Tier-3); retrieval eval on the versioned labeled fixture set must hit recall@10 ≥ 0.85
  and MRR ≥ 0.7 for canonical-note discovery; `doctor`/`verify` enumerate their required
  checks in the same contract; representative and maximum-scale vault profiles live there
  too. Each failure has a defined exit code + JSON result. The per-command executable cases
  + JSON schemas (above) live alongside it as `docs/specs/cli-contract/*` and each is required
  **before its own command's implementation** (phase-gated), not before all coding.
