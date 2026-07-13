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
Store.activateGeneration(noteId: string, gen: GenerationId, expectedContentHash: string): boolean
```

Exactly three arguments (matching the plan's Task 3.2 interface). **The caller never supplies a fence
counter** — the counter is issued *inside* the transaction (below), so a stale worker cannot present
an inflated counter to jump the queue.

- **`active_generation`** — an `INTEGER NOT NULL DEFAULT 0` **monotonic fence counter**. It *orders*
  activations and drives the needs-index scan (`idx_notes_needs_index(active_generation,
  content_hash)`); it is **not** the generation identity, it only sequences generations.
- **`active_generation_id`** — the `TEXT` **composite `generationId`** (the §2 tuple hash) this note's
  retrieval is fenced to; it is the **LanceDB join key**, NULL until the note is first indexed.
  **Retrieval filters LanceDB chunks by `active_generation_id`**: only chunks whose `generationId`
  equals it are served.

**Counter issuance (server-side, monotonic).** The new counter is **allocated by SQLite within the
same CAS transaction** as `stored active_generation + 1`, never read from or supplied by the caller.
By construction it is strictly greater than the stored value — so the ordering invariant holds without
trusting any client-provided number. The counter only *sequences* activations for the needs-index
scan; it is **not** part of the correctness fence (that is `content_hash`, below).

**The correctness fence is `content_hash`, and it is sufficient for both completion orders.** Because
`generationId = f(noteId, contentHash, chunkerVersion, embeddingModel, embeddingDimensions)` (§2), two
workers computing a generation for the **same** `content_hash` (and fixed config) compute the
**identical** `generationId`; activating the same `generationId` twice is idempotent, so there is no
"older vs newer" hazard among same-content workers. The only way two workers differ is a **content
change** between them — and then their `expectedContentHash` values differ. Activation is a
transactional compare-and-set that, in one SQLite transaction, sets `active_generation_id = gen` and
`active_generation = stored + 1` **iff**:

- **(a) `content_hash-unchanged`** — the note's current `content_hash` equals `expectedContentHash`
  (the hash the worker embedded against). A note edited after a worker started embedding fails here.
- **(b) `counter-strictly-greater`** — the issued counter (`stored + 1`) exceeds the stored counter;
  trivially true given server-side issuance, it encodes the monotonicity invariant explicitly.

Guard (a) makes stale attempts **lose in both completion orders**: whether the newer-content worker
commits before or after the older-content worker, only the worker whose `expectedContentHash` matches
the note's live `content_hash` passes the CAS. An older worker that finishes *after* a content change
finds `content_hash ≠ expectedContentHash` and its CAS aborts with no write; an older worker that
finishes *before* the change activates its (then-current) generation, which the newer worker's edit
supersedes on its own activation. Either guard failing aborts the CAS with no write — generations are
fenced, never blindly overwritten. Because both columns move in the same transaction, retrieval never
observes an `active_generation_id` that disagrees with its counter. Chunks whose `generationId` ≠ the
note's `active_generation_id` are **filtered out of retrieval** and compacted later; they are never
served.

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

## 6. LanceDB FTS-maturity fallback (decision — recorded before Task 3.3)

**Decision.** If LanceDB's native full-text-search quality or stability blocks (its FTS is younger
than its vector index), the hybrid retriever **degrades to vector + id/alias with RRF** — the FTS
layer is dropped from the fusion set `L`, and fusion runs over the vector layer alone while the
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
    "method": "Store.activateGeneration(noteId, generationId, expectedContentHash) -> boolean",
    "callerSuppliesCounter": false,
    "counterIssuance": "sqlite-server-side: stored active_generation + 1, inside the CAS transaction",
    "fenceCounterColumn": "active_generation",
    "fenceCounterType": "integer",
    "generationJoinKeyColumn": "active_generation_id",
    "retrievalFilterColumn": "active_generation_id",
    "correctnessFence": "content_hash-unchanged",
    "casGuards": ["content_hash-unchanged", "counter-strictly-greater"],
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
