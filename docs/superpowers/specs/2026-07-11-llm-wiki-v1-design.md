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
local file/url ─▶ Capture + Normalize ─▶ Immutable source note (sources/)
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
3. Retrieval happens **before** any mutation, enforced by orchestration code, not prompts.
4. Raw sources are immutable/append-only; synthesis notes are mutable but source-backed.

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

## Data model

### Note identity & frontmatter
- Human-readable slug filename + **stable frontmatter `id`** (filenames may change, IDs
  never do) + `type` + `schema_version` + `aliases` + `sources` + `created`/`updated` +
  `status`.
- Duplicate `id` = hard error; unresolved duplicate identity is quarantined.
- Schema migrations are explicit and versioned.

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

### Claims & provenance
Claims carry evidence (`sourceId` + optional `locator` + `quoteHash`) and a status
(`active` / `disputed` / `superseded`). An LLM-generated synthesis must never become an
unmarked source.

### SQLite tables (V1 subset)
`notes, note_aliases, note_links, sources, note_sources, claims, claim_evidence, jobs,
job_attempts, agent_runs, model_calls, retrieval_runs, retrieval_results, change_plans,
patches, patch_operations, validation_results, git_operations, schema_migrations`.
FKs on, WAL considered, content-hash change detection, idempotent upserts, deterministic
rebuild from vault.

### LanceDB
Disposable retrieval projection only (chunks, embeddings, fts, vector, hybrid, metadata
filters). Never holds workflow/approval/job/identity/git state. `SearchChunk` records store
`contentHash`, `chunkerVersion`, `embeddingModel`, `embeddingDimensions` for staleness
detection. Chunk by semantic section, preserve heading hierarchy, include title + aliases.

### SQLite↔LanceDB consistency
Idempotent reconciliation (no distributed transactions): parse → hash → SQLite txn → mark
needs-index → chunk → embed → upsert LanceDB → verify chunks → mark indexed with version +
hash. Safely retryable; crash-recoverable after any step.

## Change planning, patches, risk

- Typed `ChangePlan` (Zod-validated) with operations: `CreateNote`, `UpdateSection`,
  `AppendSection`, `Add/UpdateFrontmatterField`, `AddAlias`, `Add/RemoveLink`,
  `CreateRelationship`, `CreateClaim`, `AttachEvidence`, `ProposeMerge`, `ProposeRename`,
  `ProposeArchive`, `CreateTask`, `UpdateTaskState`. Each op carries target, rationale,
  supporting sourceIds, retrieved evidence, confidence, risk level, reversibility.
- Patches are section/AST-level (not whole-file rewrites), preserve unknown frontmatter and
  formatting, fail safely on stale context, produce human-readable diff summaries.
- **Risk tiers** gate git behavior:
  - **Tier 0** read-only (search/answer/inspect) — no git mutation
  - **Tier 1** safe writes (add source, append log, rebuild index, inbox item) — auto-commit
  - **Tier 2** structured updates (update project/person, enrich concept, add sourced
    claims) — auto-commit when confidence + validation thresholds pass
  - **Tier 3** high-risk (merge, rename ID, delete, archive, resolve contradiction, rewrite
    large synthesis, schema migration) — **review required by default**
  - **Tier 4** external actions — out of V1 scope

## Git workflow
Human work stays on the primary branch; agent operations run in isolated branches/worktrees.
One workflow run → one commit (or small series) with run metadata (workflow, run ID, source
IDs, changed note IDs, risk, validation status). Commands: `brain git status/review/approve/
reject/rollback/cleanup`.

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
brain ingest <path> [--dry-run]
brain query "<question>"
brain enrich <note> [--dry-run]
brain reconcile
brain maintain
brain validate
brain source add|list|show
brain note show|related|history
brain index status|verify|repair|rebuild
brain db status|verify|migrate|rebuild
brain jobs list|retry|cancel
brain git status|review|approve|reject|rollback|cleanup
```
Human + JSON + quiet + verbose modes; stable exit codes
(`0` ok · `1` validation/user · `2` config/vault · `3` secret-scan · `4` internal).

## Security & privacy
Vault may contain sensitive Evinced + personal content. **V1 is cloud-only (Gemini)** — the
user has accepted that ingested/queried content goes to Google. Mitigations baked in:
secret scanning fails closed, path-traversal + symlink protection, attachment size/type
limits, audit of external transmissions, and a `models.routing.confidential` config hook
(local/allowlist) reserved for V2. Secrets live in env/OS keychain, never in the vault or
SQLite.

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
2. **Ingest loop** — `sources` normalize (md/txt/pdf/html) → immutable source note →
   `models` Gemini adapter → typed `ChangePlan` → `markdown` patch gen → `validation` →
   `git` branch → commit → RunReport. `brain ingest <file> --dry-run` then `--apply`.
3. **Retrieval** — `lancedb-index` chunk + embed (Gemini) + hybrid search; `retrieval` RRF
   + context packing; `brain query`; `brain index` ops + staleness detection.
4. **Workflows** — `enrich`, `reconcile` (aliases/duplicates), `maintain`
   (orphans/broken-links/stale → proposals, never silent destructive), `validate`; risk
   tiers + review gate wired through `git`.
5. **Graduate to real vault** — copy `main-vault` into a sandbox, run against it
   agent-branch-only; verify git-rollback + full derived-state rebuild; retrieval eval on a
   small labeled set.

## Testing
Fixture vaults: `empty`, `small-valid`, `broken-links`, `duplicate-ids`,
`conflicting-claims`, `source-heavy`. Layers: unit (parse/hash/ID-normalize/chunk/patch/
risk/schema), integration (sqlite repos, lancedb indexing, sqlite↔lancedb consistency, git
worktrees, job retries, model adapter), e2e (ingest one source, update existing note, reject
duplicate-note creation, require review for high-risk, recover after index failure, rebuild
all derived state, rollback applied change). Retrieval eval (recall@K, MRR, canonical-note
discovery, source-grounding) before claiming quality.

## Acceptance criteria (V1)
- Markdown authoritative; raw sources immutable; stable IDs; per-type mutation policies.
- SQLite + LanceDB each deletable and rebuildable; stale-chunk detection works; hybrid
  retrieval traceable.
- Raw model output cannot write files; every write is a typed plan producing a git diff;
  Tier-3 requires review; rollback works.
- Retrieval precedes mutation and is logged; eval fixtures exist.
- `brain doctor` reports health; index/db verify work; failed jobs retry; runs inspectable.
- CLI usable without reading source; `--dry-run` exists; JSON output exists; errors
  actionable.
