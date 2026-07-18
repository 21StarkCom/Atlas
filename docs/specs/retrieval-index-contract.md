# Retrieval / index contract

**Status:** normative (Phase-3 contracts gate, Task 3.0). **Consumed by** Tasks 3.1–3.6.
**Consumes** the plan's decisions **D4** (`indexing.chunker_version = 1`) and **D7**
(`indexing.dimensions = 768`, `gemini-embedding-001`) — this contract does not re-decide them, it
references them.

This document is the single source of truth for how notes become searchable chunks, how index
generations are identified and reconciled, how staleness is detected, and how the hybrid-search
layers are ordered and fused. Per plan §2.5 and §2.6.1, **the RRF weights/bounds and the layer
precedence live HERE (config/contract-owned), never hardcoded in code** — `apps/cli/src/retrieval/*`
and `packages/lancedb-index/*` consume these values, they do not embed literals.

A machine-checkable digest of the load-bearing constants is carried in the fenced
`retrievalContract` JSON block in §8; `tools/contract-lint.test.ts` asserts it, so the prose and
the constants the code reads cannot drift.

---

## 1. Chunking rules

Chunking is **deterministic** — the same `ParsedNote` + `IndexingConfig` produces a byte-identical
chunk set (Task 3.1 acceptance). The chunker version is **`1`** (D4, `indexing.chunker_version`).

1. **Unit = semantic section.** The chunker walks the note's `SectionTree` (Task 1.3) and emits one
   chunk per leaf-bearing section. Prose between a heading and its first sub-heading belongs to that
   heading's section. Front matter is metadata, never chunk body.
2. **Heading hierarchy is embedded in the chunk text.** Each chunk is prefixed with its heading
   breadcrumb (the ordered `H1 › H2 › …` path down to the section) so a section's meaning survives
   out of document order. The breadcrumb is part of the embedded/indexed text, not a side field.
3. **Title + aliases are IN the chunk text.** Every chunk carries the note's canonical title and its
   declared `aliases` inline (deduped, in declaration order). This makes exact-title and alias hits
   reachable by both the FTS and vector layers, not only by the id/alias resolver — the resolver
   still short-circuits (§5), but a chunk that mentions an alias remains discoverable by fusion.
4. **Rune-safe.** Chunk splitting and title/alias inclusion operate on Unicode scalar values, not
   bytes or UTF-16 code units, so mixed Hebrew/English content chunks identically on every platform
   (Task 3.1 test).
5. **Stable ordering.** Chunks are emitted in document order; ties (empty headings) break on the
   section's start offset. Ordering is part of the deterministic-output guarantee.
6. **Deterministic chunk IDs.** Every chunk carries a `chunkId = f(generationId, sectionPath,
   ordinal)` — a stable hash over the generation, the section's heading breadcrumb, and the chunk's
   0-based ordinal within that section. Since chunking is deterministic (above), the **complete
   expected chunk-ID set for a generation is knowable before any write** — a pure function of the
   `ParsedNote` + `IndexingConfig`. This is the set the verify-complete step (§3) checks the LanceDB
   write against, and (being generation-scoped) it makes writes idempotent: re-writing the same
   `chunkId` is a no-op, so a resumed batch fills only the missing chunks.

The persisted `SearchChunk` row (Task 3.1 LanceDB schema) carries: `chunkId`, `chunk text`
(breadcrumb + title + aliases + body), `noteId`, section path, `contentHash`, `chunkerVersion`,
`embeddingModel`, `embeddingDimensions`, `generationId`, and the embedding vector.

## 2. Generation identity

An index **generation** is the immutable tuple that fully determines a note's chunk+embedding set:

```
generationId = f(noteId, contentHash, chunkerVersion, embeddingModel, embeddingDimensions)
```

All five components are load-bearing: a change to **any** of them yields a different `generationId`
and therefore a new generation by construction (this is why changing `indexing.dimensions` — D7 —
"opens a new index generation"). `generationId` is a pure function of the tuple (a stable hash of the
canonically-serialized components); it is never a timestamp or a counter, so the same tuple on any
host reproduces the same id.

**SQLite is the sole activation authority.** Two `notes` columns carry the fence, and they are
updated **atomically together in one SQLite transaction** — never independently — by the
authoritative Task 3.2 repo method:

```
Store.activateGeneration(noteId: string, gen: GenerationId, expectedContentHash: string, configKey: string): boolean
```

The `configKey` (fourth argument) is the **config identity** that drives the generation/config fence
(Task issue #39, carry-forward #1): a deterministic hash of the fence-relevant indexing config
(`chunker_version` / `embedding_model` / `dimensions`). The CAS resolves that identity to the config's
monotonic **epoch** and stamps it into `active_generation`. The fence is **required** — a
`content_hash`-only CAS does **not** fence workers running DIFFERENT indexing configs over the **same**
content, and would let a stale-config worker overwrite a newer index (see the fence below).

**Server-owned epoch, consumed by identity (round-3 findings 3 & 4).** The epoch is **owned by SQLite,
never a caller-invented integer** (an inflated value would fence out every future worker; an under-shot
one would permanently reject a legitimate config). Activation therefore takes the config *identity*, not
a number: the store resolves the epoch internally, so a caller can neither inflate it nor bind it to the
wrong config. The epoch lives in the `index_config_revisions` table (migration
`0008_index_config_revision`, a feature migration registered via `registerGenerationMigration`) as an
append-only **adoption log**, NOT a permanent first-seen mapping (which cannot roll back and confuses
first-seen with recency):

- `Store.adoptConfig(configKey)` records a durable **adoption event**. Re-adopting the already-current
  config is idempotent; adopting a different config — an upgrade OR a rollback / re-adoption — appends a
  NEW event with a strictly-higher `MAX(revision) + 1` epoch and marks it the current configuration.
- a config's LIVE epoch is `MAX(revision) WHERE config_key = ?` — its most-recent adoption. So a
  rolled-back-to config gets a fresh epoch that OUT-RANKS whatever is live and CAN supersede it, and
  **adoption recency** (operator order), not first-seen order, drives the fence.

The orchestrator adopts the current config ONCE per pass; every `activateGeneration` /
`tombstoneGeneration` in the pass resolves the same live epoch by identity. Activation under a config
that was never adopted (epoch `0`) is rejected — the caller must declare the current configuration
first. When a note loses all its prose, `Store.tombstoneGeneration(noteId, expectedContentHash,
configKey)` clears its `active_generation_id` under the SAME fence, so retrieval stops serving it.

- **`active_generation`** — an `INTEGER NOT NULL DEFAULT 0` carrying the **config revision** the active
  generation was produced under. It *orders* activations by config epoch and drives the needs-index scan
  (`idx_notes_needs_index(active_generation, content_hash)`, `… WHERE active_generation < ?` — a note
  produced under an older epoch is exactly one needing re-index); it is **not** the generation identity.
- **`active_generation_id`** — the `TEXT` **composite `generationId`** (the §2 tuple hash) this note's
  retrieval is fenced to; it is the **LanceDB join key**, NULL until the note is first indexed.
  **Retrieval filters LanceDB chunks by `active_generation_id`**: only chunks whose `generationId`
  equals it are served.

**Why `content_hash` alone is insufficient (the carry-forward #1 gap).** Because
`generationId = f(noteId, contentHash, chunkerVersion, embeddingModel, embeddingDimensions)` (§2), two
workers running DIFFERENT configs (a bumped `chunker_version` / `embedding_model` / `dimensions`) over
the SAME `content_hash` compute DIFFERENT `generationId`s yet share the same `content_hash`. A
`content_hash`-only CAS (with a server-issued `stored + 1` counter that always passes) would let a
stale-config worker that finishes AFTER a newer-config generation activated overwrite it. So activation
fences on **both** the content hash **and** the config revision.

**The CAS.** Activation is a transactional compare-and-set that, in one SQLite statement, sets
`active_generation_id = gen` and `active_generation = <the config's live epoch>` **iff**:

- **(a) `content_hash-unchanged`** — the note's current `content_hash` equals `expectedContentHash`
  (the hash the worker embedded against). A note edited after a worker started embedding fails here.
- **(b) `config-revision-not-superseded`** — the worker's config's live epoch (resolved from
  `configKey`) is `>=` the stored `active_generation`, so a strictly-older config epoch that finishes
  after a newer activation is rejected (and a same-or-newer epoch supersedes).

**Both fences make stale attempts lose in both completion orders.** Guard (a) fences a mid-flight
content change (whoever's `expectedContentHash` matches the live `content_hash` wins). Guard (b) fences
a stale config:

- **new-then-old** — the newer-config worker (`configRevision = revNew`) activates first, setting
  `active_generation = revNew`; the older worker (`revOld < revNew`) then fails guard (b) → no write.
- **old-then-new** — the older worker activates first (`active_generation = revOld`); the newer worker
  (`revNew >= revOld`) passes and supersedes it. A subsequent stale old worker again fails guard (b).

Either way the newer config wins and the stale one never overwrites it. Either guard failing aborts the
CAS with no write — generations are fenced, never blindly overwritten. Because both columns move in the
same statement (one implicit transaction), retrieval never observes an `active_generation_id` that
disagrees with its `active_generation`. Chunks whose `generationId` ≠ the note's `active_generation_id`
are **filtered out of retrieval** and compacted later; they are never served.

## 3. Reconciliation steps

Indexing is a pipeline of independently-retryable, crash-safe steps. `reconcileIndex` (Task 3.2) and
`index repair` (Task 3.5) drive it to convergence from any partial state. The canonical order:

1. **Chunk** the note (§1) → deterministic chunk set for the current `generationId`.
2. **Embed** the chunks via `models.embed` through the egress broker (batched; D7 dimensions from
   config) → vectors.
3. **Write** the `SearchChunk` rows into LanceDB tagged with their `generationId`, keyed by the
   deterministic `chunkId` (§1). Idempotent: a re-run with the same `generationId` re-writes only
   missing `chunkId`s (chunks are keyed by generation + chunk id), so batched writes are resumable.
4. **Verify-complete.** Before activation, read back the generation's chunk rows from LanceDB and
   confirm the **complete expected chunk-ID set** (§1) is durably present. Activation proceeds **only**
   when every expected `chunkId` for the generation is written; a short or partial batched write
   (some chunks still missing) **fails this gate**, so a partially-written generation can never be
   CAS-activated and therefore can never become queryable. Resumable: a crash here recomputes the
   expected set on rerun and re-writes only the gaps, then re-checks.
5. **Activate** via the SQLite CAS (§2). This is the linearization point — before it, the new
   generation is invisible to retrieval; after it, it is live. The CAS refuses to run unless
   verify-complete passed, so activation of an incomplete generation is structurally impossible.
6. **Retire** the previously-active generation's chunks (independently retryable; a crash here leaves
   the prior generation harmlessly present-but-inactive, cleaned on the next reconcile).
7. **Mark** the note `indexed` (the reconciliation marker).

Each step is separately resumable: a crash between any two steps converges on rerun with **no
duplicate chunks and no orphaned active generation** (Task 3.2 / 4.11 crash-recovery suites). Steps
3–7 never mutate the vault or the ledger's canonical git refs — index state is disposable derived
state (Phase-3 rollback: delete `lancedb.dir` wholesale).

## 4. Staleness detection

A note's active generation is **stale** when the tuple that would be computed today differs from the
active generation's tuple. `index status` reports staleness; `index verify` cross-checks SQLite ↔
LanceDB; `index repair` re-embeds and re-activates stale/divergent notes (Task 3.5).

Staleness triggers (any one is sufficient):

| Trigger | Drift detected |
|---|---|
| `contentHash` | the note's Markdown changed since it was embedded |
| `chunkerVersion` | `indexing.chunker_version` was bumped (D4) |
| `embeddingModel` | `indexing.embedding_model` changed |
| `embeddingDimensions` | `indexing.dimensions` changed (D7) |

Because all four are generation-identity components (§2), "stale" is exactly "the active generation's
`generationId` ≠ the `generationId` recomputed from current note + config." Missing chunks (LanceDB
directory deleted) and a note whose active generation has zero live chunks are also divergences that
`verify` reports and `repair`/`rebuild` converge.

**Empty-note policy.** A note that produces **zero chunks** (no prose-bearing section — e.g. a
title-only stub) has nothing to embed, write, or activate. The write path (Task 3.2) does **NOT**
activate it: `active_generation_id` stays `NULL` (never-indexed) and the pass reports a benign `empty`
outcome. This is deliberate — activating a zero-chunk generation would create precisely the
"active generation with zero live chunks" divergence above. So "zero live chunks is divergent" applies
only to a note that HAS an active generation (`active_generation_id` non-NULL) whose expected chunk set
is non-empty but whose rows are missing; a never-activated empty note is not divergent. A rerun
re-derives `empty` idempotently, and if the note later gains prose it indexes normally.

## 5. Hybrid search — layer precedence and RRF fusion

Retrieval resolves in **strict layer precedence**. The identity layers are exact, deterministic
short-circuits and are tried **before** any statistical fusion:

```
exact id  →  slug  →  unique alias  →  fts / vector fusion
```

1. **exact id** — the query resolves to a canonical note id. Return it directly; no fusion.
2. **slug** — the query matches a note's canonical slug. Return it directly.
3. **unique alias** — the query normalizes to exactly one note's alias. Return it directly. A
   normalized value matching **more than one** note is a **typed ambiguity error** — never a silent
   pick (Task 3.3 test).
4. **fts / vector fusion** — only when the identity layers do not resolve, the full-text (FTS) and
   dense-vector layers each produce a ranked candidate list, fused by **Reciprocal Rank Fusion
   (RRF)**.

**Candidate unit: the note, folded from chunks.** LanceDB ranks **chunks** (§1), but the query result
unit — and the RRF candidate `d` — is the **note**. Each statistical layer's chunk ranking is folded
to a per-note ranking before fusion:

1. **Fold chunks → notes per layer.** Within a layer `ℓ`, group its ranked chunks by `noteId` and keep
   each note's **best (lowest) chunk rank** as that note's layer rank `rank_ℓ(note)`. The
   surviving chunk (the best-ranked one for that note) supplies the item's `sectionPath` provenance.
   This deduplicates a note that matched on several chunks into a single candidate per layer.
2. **Re-densify ranks.** After folding, each layer's surviving per-note ranks are compacted to a dense
   1-based sequence in ascending original-rank order (so `k + rank` is well-defined and stable).
3. **Fuse across layers (RRF).** For each candidate note `d`, over the set of participating layers `L`:

   ```
   score(d) = Σ_{ℓ ∈ L}  weight[ℓ] / (k + rank_ℓ(d))
   ```

   where `rank_ℓ(d)` is `d`'s folded 1-based rank in layer `ℓ`; a layer in which `d` did not appear
   **contributes 0** (it is omitted from `d`'s per-layer contributions, not recorded as rank 0).

**Deterministic ordering and tie-breaking.** Results are ordered by **descending `score(d)`**; exact
score ties break by ascending **`noteId`** (byte order of the canonical id). This two-key order is
total and deployment-independent, so the fused ranking is reproducible (Task 3.3: "RRF fusion
deterministic").

**Per-layer provenance in the output (Task 3.3).** Because a note may be surfaced by FTS *and* vector,
each result item records **every** contributing layer with its folded rank and weighted contribution,
not a single winning layer. The `query` result contract (`cli-contract/query.schema.json`) carries,
per item: the fused `score`, and a `contributions[]` array of `{ layer, rank, weightedContribution }`
where `weightedContribution = weight[layer] / (k + rank)` and `Σ weightedContribution == score`. An
identity short-circuit (exact-id / slug / unique-alias) yields a single-entry `contributions[]` naming
that identity layer with its deterministic score. This makes an FTS+vector hit representable and every
score traceable to its layers.

**Config/contract-owned constants (normative — see the §8 digest). Owner: the typed `retrieval`
section of `brain.config.yaml` (`AtlasConfigSchema`, `apps/cli/src/config/schema.ts`):**

| Constant | Default | Bounds | Config key |
|---|---|---|---|
| RRF `k` | `60` | `[1, 1000]` | `retrieval.rrf.k` |
| `weight[fts]` | `1.0` | `[0, 10]` | `retrieval.rrf.weights.fts` |
| `weight[vector]` | `1.0` | `(0, 10]` | `retrieval.rrf.weights.vector` |
| FTS participation | `true` | boolean | `retrieval.fts.enabled` |

These are the **defaults and bounds**; a deployment may override the values within the bounds via the
`retrieval.*` config keys, which `AtlasConfigSchema` validates strictly (out-of-bounds ⇒ `ConfigError`,
exit 2). Code reads them from `AtlasConfig` (seeded from this contract) — it must **not** inline `60`,
`1.0`, the precedence order, or the fallback switch. **`weight[vector]` is bounded `(0, 10]` — a
strictly-positive lower bound**: the schema rejects `weight[vector] = 0`, because the FTS-maturity
fallback (§6) fuses over the vector layer alone, and a zero vector weight would silently annihilate the
only surviving statistical layer. `weight[fts]` may be `0` (a way to disable FTS by weight rather than
by the `retrieval.fts.enabled` switch). Retrieval eval (recall@10 ≥ 0.85, MRR ≥ 0.7 — §2.5) tunes the
weights on the copy without touching phase code (§Phase-3 risks).

## 6. LanceDB FTS index + maturity fallback (decision — updated 2026-07-18)

**FTS inverted index (updated per #156).** The `search_chunks.text` column is indexed with a real
LanceDB inverted index built with an **English analyzer** — the `SEARCH_FTS_ANALYZER` constant in
`packages/lancedb-index/src/fts.ts`: `simple` base tokenizer + stemming + stop-word removal + ASCII
folding. `ensureFtsIndex` runs at the end of every `index rebuild` / `index repair` convergence, over
the freshly written rows. Without it, `fullTextSearch` falls back to a brute-force scan with LanceDB's
default (no-stem, no-stop-word) tokenizer, which floods top-K with chunks that merely contain a common
query term — on the 2026-07-17 full-corpus drive that dragged the default hybrid config below the gate
(recall 0.878 / MRR 0.673). With the analyzer index the same config scores **recall 0.911 / MRR 0.830**,
and the FTS layer is the strongest contributor rather than a liability. The analyzer is a single
documented v1 constant, not a config knob: LanceDB applies the index's stored analyzer to the query
too, so index and query tokenization cannot drift. Query tokenization is unchanged in `search.ts` — the
index is transparent to the retrieval code.

**Maturity-fallback decision.** If LanceDB's native full-text-search quality or stability blocks (its
FTS is younger than its vector index), the hybrid retriever **degrades to vector + id/alias with RRF** —
the FTS layer is dropped from the fusion set `L`, and fusion runs over the vector layer alone while the
exact-id / slug / unique-alias short-circuits (§5) continue unchanged. RRF still applies (it simply
fuses one statistical layer), so the scoring formula, weights, and precedence are untouched.

**The switch is `retrieval.fts.enabled` (config-owned, default `true`).** Setting it `false` selects
the fallback for a deployment; the retriever then omits `fts` from `layersUsed` and sets the query
result's `degraded` flag. Because the vector layer becomes the sole statistical layer, the schema's
strictly-positive `retrieval.rrf.weights.vector` bound (§5) guarantees fusion still produces scores —
a zero vector weight is rejected at config load, so the fallback can never silently return nothing.

**Why this is safe.** The layer interface isolates the change to `packages/lancedb-index/src/search.ts`
— no other module knows whether FTS participated. Identity resolution (id/slug/alias) does not depend
on FTS at all, so exact lookups are unaffected. Because title + aliases are embedded in every chunk's
text (§1), much of what FTS would catch remains reachable through the vector layer. This is a
per-deployment fallback recorded now so Task 3.3 can ship the degraded mode without a contract change;
re-enabling FTS is a config/weights change, not a code change.

## 7. CLI surface (schemas)

This contract is realized by the Phase-3 `cli-contract/*` schemas (Task 3.0), one per registry row:

| Command | Schema | Kind |
|---|---|---|
| `query` | `cli-contract/query.schema.json` | Tier-0 audited read (`run.readonly`) |
| `index status` | `cli-contract/index-status.schema.json` | read (staleness report) |
| `index verify` | `cli-contract/index-verify.schema.json` | read (SQLite ↔ LanceDB consistency) |
| `index repair` | `cli-contract/index-repair.schema.json` | projection-write (`run.projection`) |
| `index rebuild` | `cli-contract/index-rebuild.schema.json` | projection-write (`run.projection`) |
| `index eval` | `cli-contract/index-eval.schema.json` | Tier-0 audited read (`run.readonly`) — the graduation eval gate (acceptance-thresholds.md §retrieval) |

Each schema's `x-atlas-contract` block carries the command's phase, privilege, idempotency,
execution class, side/prohibited effects, locks, exit codes (from the §2.5 set), and error catalog,
mirroring the Phase-1/Phase-2 schema shape.

## 8. Machine-checkable digest

The constants below are the load-bearing values the code consumes. `contract-lint.test.ts` asserts
this block against D4/D7 and the precedence/RRF/staleness/fallback rules so prose and code cannot
drift. **Do not edit the values here without updating the prose above (and vice versa).**

```json retrievalContract
{
  "version": 1,
  "chunker": {
    "version": 1,
    "unit": "semantic-section",
    "headingHierarchy": true,
    "includeTitle": true,
    "includeAliases": true,
    "runeSafe": true,
    "deterministicChunkId": true,
    "chunkIdComponents": ["generationId", "sectionPath", "ordinal"]
  },
  "generationIdentity": [
    "noteId",
    "contentHash",
    "chunkerVersion",
    "embeddingModel",
    "embeddingDimensions"
  ],
  "reconciliationSteps": ["chunk", "embed", "write", "verify-complete", "activate", "retire", "mark-indexed"],
  "activation": {
    "authority": "sqlite",
    "method": "Store.activateGeneration(noteId, generationId, expectedContentHash, configKey) -> boolean",
    "callerSuppliesConfigIdentity": true,
    "callerSuppliesConfigRevision": false,
    "configRevisionColumn": "active_generation",
    "configRevisionSemantics": "monotonic indexing-config adoption epoch (>=1; 0 = never indexed); a new epoch is minted per adoption EVENT (upgrade or rollback), reflecting adoption recency",
    "configRevisionOwner": "sqlite-adoption-log",
    "configIdentityInput": "configKey (deterministic hash of chunker_version/embedding_model/dimensions)",
    "configEpochResolution": "MAX(revision) WHERE config_key = ? — the config's most-recent adoption (server-resolved; never a caller integer)",
    "configAdoption": "Store.adoptConfig(configKey)",
    "configRevisionAllocatorTable": "index_config_revisions",
    "configRevisionAllocatorMigration": "0008_index_config_revision",
    "supportsRollback": true,
    "tombstoneMethod": "Store.tombstoneGeneration(noteId, expectedContentHash, configKey) -> boolean",
    "fenceCounterColumn": "active_generation",
    "fenceCounterType": "integer",
    "generationJoinKeyColumn": "active_generation_id",
    "retrievalFilterColumn": "active_generation_id",
    "correctnessFence": "content_hash-unchanged AND config-revision-not-superseded",
    "casGuards": ["content_hash-unchanged", "config-revision-not-superseded"],
    "bothCompletionOrders": "a stale-config worker's activation fails after a newer activation in both old-then-new and new-then-old",
    "atomic": "both columns updated in one SQLite transaction",
    "verifyBeforeActivate": true
  },
  "stalenessTriggers": ["contentHash", "chunkerVersion", "embeddingModel", "embeddingDimensions"],
  "layerPrecedence": ["exact-id", "slug", "unique-alias", "fts-vector-fusion"],
  "candidateUnit": "note",
  "chunkToNoteAggregation": {
    "fold": "best-chunk-rank-per-note-per-layer",
    "dedup": "one candidate per noteId per layer",
    "reDensifyRanks": true,
    "provenance": "per-item contributions[] of {layer, rank, weightedContribution}",
    "tieBreaker": "noteId"
  },
  "rrf": {
    "k": 60,
    "kBounds": [1, 1000],
    "weights": { "fts": 1.0, "vector": 1.0 },
    "weightBounds": [0, 10],
    "vectorWeightMinExclusive": 0,
    "tieBreaker": "noteId",
    "configKeyPrefix": "retrieval.rrf",
    "configOwner": "AtlasConfigSchema.retrieval (apps/cli/src/config/schema.ts)"
  },
  "config": {
    "section": "retrieval",
    "keys": {
      "retrieval.rrf.k": { "default": 60, "bounds": [1, 1000] },
      "retrieval.rrf.weights.fts": { "default": 1.0, "bounds": [0, 10] },
      "retrieval.rrf.weights.vector": { "default": 1.0, "boundsExclusiveMin": 0, "boundsMax": 10 },
      "retrieval.fts.enabled": { "default": true, "type": "boolean" }
    },
    "validation": "strict; out-of-bounds -> ConfigError (exit 2); vector weight must be > 0"
  },
  "ftsFallback": {
    "trigger": "lancedb-fts-immature",
    "switchKey": "retrieval.fts.enabled",
    "degradesTo": ["vector", "exact-id", "slug", "unique-alias"],
    "droppedLayer": "fts",
    "fusionRemains": "rrf",
    "vectorWeightMustBePositive": true,
    "isolatedTo": "packages/lancedb-index/src/search.ts"
  }
}
```
