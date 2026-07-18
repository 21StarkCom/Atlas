# `@atlas/lancedb-index` — Phase-3 retrieval index

Turns notes into fenced, searchable chunk+embedding **generations** in LanceDB and exposes the
statistical (FTS + vector) retrieval layers. Private, `version 0.0.0`, ESM, `main = dist/index.js`.
The whole package is engineered around **crash-safety + concurrency correctness**: deterministic
identity so state is re-derivable, verify-before-activate so partial writes never go live, one
required lock so retire/compaction can't race activation across processes.

- **Normative spec (SSOT):** [`docs/specs/retrieval-index-contract.md`](../../docs/specs/retrieval-index-contract.md).
  §8 carries the `retrievalContract` JSON digest that `tools/contract-lint.test.ts` asserts against
  code constants, so prose and code can't drift. §-refs below are that contract's.
- **RRF fusion is NOT here.** `searchLayers` returns per-chunk *ranks only*; fold-to-note + RRF
  (`k=60`, weights) live in the caller `apps/cli/src/retrieval/rrf.ts` (§5). Config constants are
  contract/`AtlasConfigSchema`-owned — `search.ts` takes `ftsEnabled` + `limit` as inputs, inlines
  no literals.

## Boundary discipline (D14 — stated in every module header)

Imports only `@atlas/contracts` (DTOs + `canonicalSerialize`) + LanceDB/Arrow. **Never** imports
`apps/cli`, `@atlas/sqlite-store`, `@atlas/models`, or `@atlas/broker` in production — the SQLite
activation authority and the embedder are injected as **structural interfaces** (`ActivationStore`,
`Embedder`, `EmbedClient`). `@atlas/models` + `@atlas/sqlite-store` are `devDependencies` (tests only).
`asProviderFault` duck-types a `ProviderCallError` by shape (`kind ∈ PROVIDER_ERROR_KINDS` + boolean
`retryable`, or `name === "ProviderCallError"`) rather than importing the class; a non-provider throw
is rethrown, so a bug never masquerades as an embed failure.

## Key files (`src/`)

| File | Role |
|---|---|
| `index.ts` | Barrel; the entire public surface, exports mapped to Tasks 3.1/3.2/3.3/3.5. |
| `chunker.ts` | `chunkNote(note, cfg) → Chunk[]`; `CHUNKER_VERSION = 1`. Byte-identical per `(ParsedNote, IndexingConfig)`. |
| `generation.ts` | `generationId`/`generationIdFor`, `chunkId`, `indexingConfigKey`; branded `GenerationId`/`ChunkId`. |
| `schema.ts` | `SearchChunk` row, `SEARCH_CHUNK_TABLE` (`"search_chunks"`), `SEARCH_CHUNK_SCHEMA_VERSION` (`1`), `searchChunkArrowSchema`, `toSearchChunk` (identity validator). |
| `writer.ts` | Table open/create, idempotent `mergeInsert` write, `verifyComplete`, generation reads, `sqlQuote`. |
| `activate.ts` | `indexNote` + `reconcileIndex` orchestrators; `ActivationStore`/`Embedder`/`IndexDeps`/`IndexHooks`; the `IndexOutcome` union. |
| `embedder.ts` | `embedderFromClient` capability-closing adapter; `asProviderFault`. |
| `retire.ts` | `retireSupersededGenerations`, `compactOrphans` (LanceDB deletes only — never touch SQLite). |
| `lock.ts` | `IndexMaintenanceLock`; two-layer mutex + advisory lockfile. |
| `retrieval-filter.ts` | `retrieveActiveChunks` — the active-generation fence enforcement point. |
| `search.ts` | `searchLayers` — FTS + vector ranked candidates; FTS-fallback isolated here. |
| `fts.ts` | `SEARCH_FTS_ANALYZER` + `ensureFtsIndex` — the English-analyzer inverted index on `text`. |
| `staleness.ts` / `verify.ts` / `repair.ts` | `computeStaleness` (drift class), `indexVerify` (read-only divergence report), `indexRepair`/`indexRebuild`. |
| `eval.ts` | `runRetrievalEval` — recall@10 + MRR over labeled fixtures, the graduation gate metric math. |
| `test/generation-fencing.test.ts` | 1,015 lines — locks fence/crash/lock/empty-note behavior. The correctness core. |

**Pipeline (§3), all in `activate.ts::indexNote`:** `chunk → embed → write → verify-complete →
activate(SQLite CAS) → retire → mark`. Steps 3–6 run inside one `lock.runExclusive`; **embed is
deliberately outside the lock** (the network step must not serialize). `reconcileIndex` threads ONE
lock through every `indexNote` + the final `compactOrphans` sweep.

## Invariants & guardrails

- **Chunking is byte-identical** per `(ParsedNote, IndexingConfig)` — the generation-fencing
  precondition (§1). Text NFC-normalized; spans sliced only at `\n`, rune-safe on mixed
  Hebrew/English. `chunkNote` throws on unsupported `chunker_version`.
- **`generationId` = pure hash of the §2 five-tuple** `(noteId, contentHash, chunkerVersion,
  embeddingModel, embeddingDimensions)` via `canonicalSerialize` (RFC-8785 JCS) — never a
  timestamp/counter, identical on any host. Change ANY component ⇒ new generation by construction
  (this is why changing `dimensions` opens a new generation). `chunkId = f(generationId, sectionPath,
  ordinal)`; uniqueness rests on `sectionPath` (preamble is the sole `""`), NOT the ordinal (v1
  ordinal is always `0`).
- **`toSearchChunk` refuses inconsistent rows** — rejects `embedding.length ≠ cfg.dimensions` (D7)
  and a caller-supplied `gen ≠ generationIdFor(...)`. Identity is derived from the DTO, never
  caller-injected. All Arrow columns non-nullable.
- **SQLite is the sole activation authority (D13).** This package never flips `active_generation*`;
  it calls the injected `ActivationStore.activateGeneration` CAS (fences on **content-hash unchanged**
  AND **config-revision-not-superseded**) + `tombstoneGeneration`. Epoch is **server-owned** — callers
  pass `indexingConfigKey(cfg)` (config identity), never a raw revision integer.
- **Verify-complete gates activation (§3 step 4).** A short/partial batched write ⇒ `write-incomplete`
  outcome, never activated, never queryable. Writes are idempotent (`mergeInsert("chunkId")`), so a
  resumed batch fills only gaps. Empty expected set is trivially complete.
- **Retrieval is active-generation fenced (§2).** Only chunks whose `generationId` ∈ SQLite active set
  are served; superseded/orphaned rows are invisible the instant a newer generation activates, even
  while physically present pending compaction. `searchLayers` builds `generationId IN (...)`; an empty
  set serves nothing (`IN ()` is invalid SQL, deliberately skipped).
- **Maintenance lock is REQUIRED** — `indexNote`/`reconcileIndex` throw if neither `lock` nor
  `lockLocation` is given. `NOOP_INDEX_LOCK` is tests-only.
- **Empty-note policy (§4).** Zero-chunk note is never activated (would create the "active generation
  with zero live chunks" divergence): never-indexed ⇒ benign `empty`; formerly-indexed ⇒ fenced
  tombstone + retire orphaned chunks.
- **Embedding failures are typed, never thrown across the seam** — `Embedder` returns a discriminated
  `EmbedOutcome`; `embedding-failed` (permanent) / `embedding-retryable` surface as outcomes so
  `index repair` can converge or escalate.
- **Eval gate:** `recall@10 ≥ 0.85`, `MRR ≥ 0.70` (default `K=10`). Metric math in `eval.ts`; the
  threshold comparison is enforced CLI-side (`index eval`, exit 1 on miss).

## Gotchas & sharp edges

- **A MISSING FTS index does NOT throw — it silently brute-force-scans.** `fullTextSearch` with no
  inverted index falls back to LanceDB's default no-stem/no-stop-word tokenizer and *returns rows*, so
  the FTS layer PARTICIPATES with degraded QUALITY (floods top-K with common-term matches) rather than
  degrading to `null` — `search.ts::ftsLayer` only maps *thrown* queries to `null`. A pre-#159 table
  (rows, no analyzer index) stays actively degraded — brute-forced, not fenced — until its next
  `index rebuild`/`repair`. **This is exactly the #156 failure.** Fix: `ensureFtsIndex` runs at the end
  of every rebuild/repair convergence (`replace: true`, idempotent); it skips a zero-row table (LanceDB
  can't index no rows — `search.ts` degrades to vector-only until the first generation lands).
- **The FTS analyzer is a single v1 constant, not a config knob.** `SEARCH_FTS_ANALYZER` = `simple`
  base tokenizer + English stem + stop-word removal + ASCII folding. LanceDB applies the index's stored
  analyzer to the query too, so index/query tokenization can't drift; making it configurable would need
  a co-versioned query switch (deferred). `withPosition: false` (no phrase queries; RRF consumes ranks).
- **`weight[vector]` is bounded `(0, 10]` — strictly positive** (schema-enforced): the FTS-fallback
  fuses over the vector layer alone, so a zero vector weight would silently annihilate the only
  surviving layer. `weight[fts]` may be `0`.
- **The chunker re-scans `note.raw` to recover body spans** because `SectionTree` (Task 1.3) carries
  heading hierarchy + unique `path` but NOT bodies/spans, and D14 forbids importing the section model.
  Its ATX-heading + fenced-code rules (`parseAtxHeading`/`openingFence`/`isClosingFence`) MUST stay
  lock-step with `apps/cli` `markdown/{parse,sections,fence}.ts`. `chunkNote` guards drift by matching
  each scanned heading to the tree by LEVEL + NFC(TEXT) — not just count — and throws (rejects
  renamed/reordered/level-changed/count-mismatched trees) rather than mis-zipping bodies to wrong ids.
- **`normalizeBody` strips only leading/trailing BLANK lines, not `/^\s+/`** — a whitespace strip would
  eat the 4-space indent of an indented code block on the first content line and turn it into prose,
  changing the indexed body. Interior blanks + content-line indentation preserved.
- **Two distinct "breadcrumbs" MUST NOT be conflated:** the *display breadcrumb* (`H1 › H2`, raw
  heading text, embedded in chunk text, may collide) vs. the unique encoded `SectionTree.path` (used
  for `sectionPath` + `chunkId`; duplicate headings get `-2`/`-3`, literal `/` percent-encoded).
- **Retire/compaction race (round-2 findings 2/3).** Naive retire ("delete all but mine") after a
  concurrent newer activation would delete the now-live generation; compaction snapshotting the active
  set before a delete could delete about-to-activate chunks. Fix: run the whole snapshot/mutate section
  under the lock and **re-read the current active generation inside the lock** (both the empty-tombstone
  and fast-path retire re-read).
- **The lock has two layers (round-3 finding 1):** in-process FIFO mutex keyed by canonical dir (so
  same-process uncoordinated callers still serialize — no NOOP default) + `O_CREAT|O_EXCL` advisory
  lockfile `.atlas-index-maintenance.lock` in the LanceDB dir (30s acquire, 60s stale-steal, 15ms spin).
  Fixed acquire order (mutex then file) — the write path never nests `runExclusive`.
- **`search.ts` over-fetch has NO fixed row cap.** A prior 4096-row cap could stop paging before `limit`
  distinct eligible notes appeared, letting one large note crowd out others. It over-fetches
  `limit * OVERFETCH_FACTOR` (8), doubling until `limit` distinct eligible notes + a stable relevance
  boundary (a strictly-worse row proves the tie-group is materialized) or table exhaustion. Ties broken
  by ascending `chunkId` for reproducibility across the provider's unspecified tie order.
- **`sqlQuote` is the only SQL-injection seam** — `noteId` is a frontmatter `id` that can carry a
  quote; every predicate value funnels through it (doubles `'`). `generationId` is hex.
- **`index rebuild` clears the table CLI-side** (drops the `search_chunks` table) before calling the
  engine-identical `reconcileIndex`; a `dimensions` change can't widen an existing fixed-size vector
  column, so it's converged only by rebuild, not `openSearchTable`.

## History (real PR/issue numbers)

Phase 3, ~6 slices (contracts gate #68, tracker #6) + two 2026-07-18 follow-ups.

- **Task 3.1** schema/chunker/identity — PR #80. **Task 3.5** status/verify/repair/rebuild + staleness
  — PR #84. **Eval harness** shipped CLI-side (#85), then **`eval.ts` moved into this package** in
  `7fd802f` (#155) for `brain index eval` — the graduation gate.
- **Task 3.2** embedding + fenced write path — PR #81. **The correctness core.** Heavy multi-round
  review; the code cites **round-2 findings 2/3/5/6** (retire/compaction races, orphan-invisibility,
  empty-note policy) and **round-3 findings 1/2/3/4/6** (required cross-process lock, fenced tombstone,
  server-owned epoch by config identity, rollback, capability-closing embedder).
- **Task 3.3** hybrid search — PR #82 (`9aa20de`): shipped `search.ts` with the FTS-maturity fallback
  isolated here, and **deferred FTS *index creation* to index-ops (#42)** ("search degrades correctly
  until it exists"). That deferral is the bug that bit — the index was never actually built until #159.
  (The PR's other two fixes — UTF-8-byte noteId tie-break and `packContext` non-finite `maxTokens`
  guard — landed in the CLI caller `apps/cli/src/retrieval/`, not this package.)
- **FTS immaturity — the big retrieval story.** Issue **#156**, PR **#159** (`db16590`): added `fts.ts`
  + `fts.test.ts`. Root cause: **no FTS index was ever built** (deferred at #82, never done at #42), so
  brute-force FTS flooded top-K and dragged the *default hybrid* below the gate (0.878/0.673) on the
  2026-07-17 drive; every FTS-weighted config collapsed recall to ~0.49. Only the §6 **vector-only
  fallback** (0.878/0.784) passed. Post-#159 the **default hybrid scores 0.911/0.830** — FTS the
  strongest layer. **Hybrid is now the recommended default; `fts.enabled:false` is the retained safety
  valve.** Authoritative retro:
  [`docs/retros/2026-07-18-search-index-live-drive-retro.md`](../../docs/retros/2026-07-18-search-index-live-drive-retro.md).
- **#157 → PR #161** (`ba39e3e`): `index eval` validates the eval-set files before connecting egress —
  CLI-side, did not touch this package.

## Live-drive gotcha (folds into `apps/cli` / broker / install docs)

Every mint-bearing command that reaches this package's paths — `index rebuild`, `index eval`, `query` —
needs **`ATLAS_EGRESS_CAPABILITY_KEY`** exported: the CLI mints an embed capability against the same
secret the egress daemon verifies. `index rebuild` correctly leaves title-only stubs unactivated (10 of
209 on the 2026-07-17 drive).

## Open items / follow-ups

- **#60** (open) — graduation E2E remaining slices touching this package: `tools/scale-bench.ts`
  (synthetic 5k/50k profiles; §scale gate spec'd but unbenchmarked), ingest→index auto-hook.
  Rebuild-consistency already proven deterministic (`index rebuild ×2` → identical 199 notes / 1,647
  chunks; chunk-id set guaranteed identical by contract §1 even though embedding vector bytes may differ).
- **FTS analyzer configurability** — deferred until a second analyzer is needed (needs a co-versioned
  query-side switch); currently a single documented v1 constant.
- **LanceDB-native FTS follow-up** — the maturity fallback (`retrieval.fts.enabled`) stays the safety
  valve if a LanceDB FTS regression reappears.
