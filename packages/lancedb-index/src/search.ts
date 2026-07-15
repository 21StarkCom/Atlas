/**
 * The statistical retrieval layers — FTS + dense-vector — over the LanceDB
 * `search_chunks` table (Task 3.3, retrieval-index-contract §5 step 4 and §6).
 *
 * This module owns the two layers that fold-and-fuse in `apps/cli/src/retrieval`:
 * it ranks **chunks** (LanceDB's native unit, §1); the caller folds them to notes
 * and fuses with RRF (`rrf.ts`). Every candidate is **active-generation fenced**:
 * a chunk is only visible when its `generationId` is in the retrieval-live set the
 * caller resolved from SQLite (`GenerationRepo.activeGenerationIds()`), so a
 * superseded/orphaned generation is never served even while physically present
 * pending compaction (§2).
 *
 * ## FTS-maturity fallback — ISOLATED HERE (contract §6, review hint)
 * LanceDB's full-text search is younger than its vector index, so it can be
 * absent (no inverted index yet) or unstable. Per §6 the hybrid retriever degrades
 * to **vector-only** RRF when FTS is unavailable, and **no other module knows
 * whether FTS participated** — the whole decision lives in {@link searchLayers}:
 *   - the config switch `retrieval.fts.enabled === false` drops the layer up front;
 *   - a thrown FTS query (immaturity: no FTS index, unsupported, transient) is
 *     CAUGHT here and also drops the layer.
 * Either way `fts` comes back `null` and `degraded === true`; the caller fuses over
 * the vector layer alone (the config's strictly-positive vector weight guarantees
 * fusion still scores — §5/§6). The vector layer never degrades.
 *
 * D14: consumes only `@atlas/contracts` DTOs (via `./writer.js` types) + LanceDB;
 * no `apps/cli` import, no config LITERALS — the caller passes the config-owned
 * `ftsEnabled` switch and the candidate `limit`.
 */
import type { SearchTable } from "./writer.js";
import { sqlQuote } from "./writer.js";

/** The two statistical layers this module produces (contract §5). */
export type StatLayer = "fts" | "vector";

/**
 * One ranked chunk candidate from a statistical layer, active-generation fenced.
 * `rank` is the chunk's 1-based position in the layer's DETERMINISTIC order —
 * relevance first (vector: ascending `_distance`; FTS: descending `_score`), ties
 * broken by ascending `chunkId` so equal-relevance rows rank reproducibly across
 * runs. It is the raw per-chunk rank the caller folds to a per-note rank (§5 step 1).
 * No raw distance/score is surfaced: RRF consumes ranks only, so ordering is all that
 * is load-bearing.
 */
export interface ChunkHit {
  readonly noteId: string;
  /** The chunk's unique encoded section path (§1) — the note's provenance selector. */
  readonly sectionPath: string;
  readonly chunkId: string;
  /** Embedded/indexed chunk text (breadcrumb + title + aliases + body, §1) — for packing. */
  readonly text: string;
  readonly generationId: string;
  /** 1-based rank within the layer, in deterministic (relevance, chunkId) order. */
  readonly rank: number;
}

/** Inputs to {@link searchLayers}. All bounds/switches are config-owned upstream. */
export interface SearchLayersInput {
  /** Verbatim query text — the FTS layer's needle. */
  readonly queryText: string;
  /** The dense query vector (length = `indexing.dimensions`, D7). */
  readonly queryVector: readonly number[];
  /** The retrieval-live generation set (SQLite `active_generation_id`s, §2). Empty ⇒ nothing to search. */
  readonly activeGenerationIds: readonly string[];
  /** Target number of DISTINCT eligible NOTES per layer (the caller's `k`). Because a
   * note can span several chunks and folding is by note (§5), the layer over-fetches
   * chunks and pages until this many distinct eligible notes are represented (or the
   * table is exhausted) — a multi-chunk note can never consume the window and hide
   * other eligible notes. */
  readonly limit: number;
  /** `retrieval.fts.enabled` (contract §6). `false` selects the vector-only fallback. */
  readonly ftsEnabled: boolean;
  /** Optional note-level eligibility predicate (e.g. the `--type` metadata filter).
   * Applied HERE — before the per-note cap — so a matching note ranked below
   * nonmatching top-`limit` chunks is never lost to a post-hoc filter. Absent ⇒ every
   * fenced note is eligible. */
  readonly noteFilter?: (noteId: string) => boolean;
}

/**
 * The per-layer ranked candidates. `fts` is `null` exactly when the FTS layer did
 * NOT participate (config-off OR runtime immaturity); `degraded` mirrors that — it
 * is the query result's §6 `degraded` flag. `layersUsed` names the statistical
 * layers that ran, in contract order (`fts` before `vector`).
 */
export interface SearchLayersResult {
  readonly vector: ChunkHit[];
  readonly fts: ChunkHit[] | null;
  readonly degraded: boolean;
  readonly layersUsed: StatLayer[];
}

/** Build the active-generation SQL fence `generationId IN ('…', …)`, or `null`
 * when the live set is empty (an `IN ()` is not valid SQL — the caller skips the
 * query entirely and serves nothing, which is the correct answer for a vault with
 * no active generations). */
function activeGenerationFilter(activeGenerationIds: readonly string[]): string | null {
  if (activeGenerationIds.length === 0) return null;
  const list = activeGenerationIds.map((g) => sqlQuote(g)).join(", ");
  return `generationId IN (${list})`;
}

/** The columns a layer projects — everything the fold/pack needs, minus the heavy
 * embedding vector (never read back on the query path). */
const PROJECTION = ["chunkId", "noteId", "sectionPath", "text", "generationId"] as const;

/** LanceDB's scored-query relevance columns (auto-appended; also selected explicitly
 * to future-proof against the scoring-autoprojection deprecation). Vector search adds
 * `_distance` (ascending = better); FTS adds `_score` (descending = better). */
const DISTANCE = "_distance";
const SCORE = "_score";

/** How the provider orders a layer's relevance column. */
type Order = "distance-asc" | "score-desc";

/** Over-fetch tuning. A note can span several chunks, so a `limit`-row fetch can
 * surface fewer than `limit` distinct notes; we start well above `limit` and double
 * until enough distinct eligible notes appear (with a deterministic boundary) or the
 * table is exhausted. There is deliberately NO fixed row cap: a prior 4096-row cap
 * could stop paging before `limit` distinct eligible notes were seen, letting one
 * large note (or a run of nonmatching chunks) hide later eligible notes (finding:
 * crowding). Paging is still bounded — each grow strictly increases the window and a
 * finite table always yields a short (exhausted) page. */
const OVERFETCH_FACTOR = 8;

/** Normalize a LanceDB result row into a {@link ChunkHit} with its assigned rank. */
function toHit(rec: Record<string, unknown>, rank: number): ChunkHit {
  return {
    noteId: rec.noteId as string,
    sectionPath: rec.sectionPath as string,
    chunkId: rec.chunkId as string,
    text: rec.text as string,
    generationId: rec.generationId as string,
    rank,
  };
}

/** A row's numeric relevance (missing ⇒ 0, so a scoreless double still sorts stably
 * on the chunkId secondary key). */
function relevanceOf(rec: Record<string, unknown>, order: Order): number {
  const v = order === "distance-asc" ? rec[DISTANCE] : rec[SCORE];
  return typeof v === "number" ? v : 0;
}

/** Is `rel` strictly WORSE than `boundary` in this layer's order? (distance-asc:
 * larger distance is worse; score-desc: smaller score is worse.) A fetched row that
 * is strictly worse than the note-selection boundary proves the boundary's relevance
 * tie-group was fully materialized — the provider returns by relevance, so every row
 * at-or-better than the boundary is already in the page. */
function strictlyWorse(rel: number, boundary: number, order: Order): boolean {
  return order === "distance-asc" ? rel > boundary : rel < boundary;
}

/** Stable, total secondary key: chunkId is deterministic (`f(gen, sectionPath,
 * ordinal)`) and unique within the table, so equal-relevance rows get reproducible
 * ranks regardless of the provider's unspecified tie order (contract §5 determinism). */
function compareChunkId(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const ca = a.chunkId as string;
  const cb = b.chunkId as string;
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/** Deterministic total order over eligible rows: relevance first, then chunkId. */
function orderRows(rows: Record<string, unknown>[], order: Order): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const ra = relevanceOf(a, order);
    const rb = relevanceOf(b, order);
    if (ra !== rb) return order === "distance-asc" ? ra - rb : rb - ra;
    return compareChunkId(a, b);
  });
}

/** The top-`limit` distinct notes over `ordered` (relevance-then-chunkId), by first
 * occurrence, plus the relevance of the last selected note's first occurrence — the
 * **selection boundary**. Because `ordered` is the deterministic total order, the
 * selected set + boundary are a pure function of the eligible chunk set. */
function selectNotes(ordered: Record<string, unknown>[], limit: number, order: Order): { notes: Set<string>; boundary: number | null } {
  const notes = new Set<string>();
  let boundary: number | null = null;
  for (const r of ordered) {
    const noteId = r.noteId as string;
    if (notes.has(noteId)) continue;
    if (notes.size >= limit) break;
    notes.add(noteId);
    boundary = relevanceOf(r, order);
  }
  return { notes, boundary };
}

/**
 * Run one statistical layer: over-fetch + page → filter → deterministically order →
 * assign ranks over the top-`limit` distinct eligible notes' chunks.
 *
 *   - **Paging to `limit` distinct notes or true exhaustion (finding: crowding).**
 *     Fetch `limit * OVERFETCH_FACTOR` chunks and grow (×2, no fixed cap) until the
 *     page holds ≥ `limit` distinct ELIGIBLE notes WITH a deterministic boundary, or
 *     the provider returns a short page (table exhausted). Eligibility is applied
 *     here, so a matching note below nonmatching top-`limit` chunks is not lost, and a
 *     note spanning many chunks cannot crowd out other notes — even past the old cap.
 *   - **Deterministic boundary (finding: unstable ties across the fetch boundary).**
 *     The note-selection boundary is the relevance of the `limit`-th distinct note's
 *     best chunk. We keep growing until a fetched eligible row is strictly WORSE than
 *     that boundary (proving the boundary tie-group is fully materialized) or the
 *     table is exhausted — so a relevance tie straddling the fetch window can never
 *     reorder which notes are selected. Rows worse than the boundary are then trimmed
 *     (unless exhausted, where the full table is already deterministic), keeping the
 *     emitted chunk set a pure function of the data.
 *   - **Note cap + ranks (contract §5).** Ordered by relevance then chunkId, ranks are
 *     assigned over the chunks of the top-`limit` distinct notes, keeping each included
 *     note's eligible chunks within the deterministic frontier so downstream section
 *     assembly is stable. The caller folds these to per-note ranks and fuses (§5).
 */
async function rankedLayer(
  runQuery: (fetch: number) => Promise<Record<string, unknown>[]>,
  input: SearchLayersInput,
  order: Order,
): Promise<ChunkHit[]> {
  const eligible = (noteId: string): boolean => input.noteFilter?.(noteId) ?? true;

  let fetch = Math.max(input.limit * OVERFETCH_FACTOR, input.limit);
  let ordered: Record<string, unknown>[] = [];
  let boundary: number | null = null;
  let exhausted = false;
  for (;;) {
    const rows = await runQuery(fetch);
    exhausted = rows.length < fetch;
    ordered = orderRows(
      rows.filter((r) => eligible(r.noteId as string)),
      order,
    );
    const selected = selectNotes(ordered, input.limit, order);
    boundary = selected.boundary;
    // Stop when the table is exhausted, or when we have `limit` distinct eligible
    // notes AND the boundary tie-group is fully materialized (a strictly-worse row
    // was fetched) so note selection can't shift as the window grows.
    const boundaryStable = boundary !== null && ordered.some((r) => strictlyWorse(relevanceOf(r, order), boundary!, order));
    if (exhausted || (selected.notes.size >= input.limit && boundaryStable)) break;
    fetch *= 2;
  }

  const { notes: includedNotes } = selectNotes(ordered, input.limit, order);
  // Frontier trim: past the (non-exhausted) boundary the fetched tie order is not
  // authoritative, so drop those rows; when exhausted the whole table is present and
  // deterministic, so keep every eligible chunk of the included notes.
  const frontier = exhausted ? null : boundary;
  const out: ChunkHit[] = [];
  for (const r of ordered) {
    const noteId = r.noteId as string;
    if (!includedNotes.has(noteId)) continue;
    if (frontier !== null && strictlyWorse(relevanceOf(r, order), frontier, order)) continue;
    out.push(toHit(r, out.length + 1));
  }
  return out;
}

/**
 * Run the dense-vector layer: KNN over the embedding column, active-generation
 * pre-filtered, over-fetched + folded to the top-`limit` distinct notes. The vector
 * layer never degrades.
 */
async function vectorLayer(table: SearchTable, filter: string, input: SearchLayersInput): Promise<ChunkHit[]> {
  return rankedLayer(
    (fetch) =>
      table
        .query()
        .nearestTo([...input.queryVector])
        .where(filter)
        .select([...PROJECTION, DISTANCE])
        .limit(fetch)
        .toArray() as Promise<Record<string, unknown>[]>,
    input,
    "distance-asc",
  );
}

/**
 * Attempt the FTS layer. Returns the ranked hits, or `null` to DEGRADE (contract
 * §6) — this is the sole place the FTS-maturity decision is made. A thrown query
 * (no inverted index yet / unsupported / transient) is caught and mapped to `null`
 * so the hybrid retriever silently continues vector-only; the error never escapes
 * this module (isolation guarantee).
 */
async function ftsLayer(table: SearchTable, filter: string, input: SearchLayersInput): Promise<ChunkHit[] | null> {
  try {
    return await rankedLayer(
      (fetch) =>
        table
          .query()
          .fullTextSearch(input.queryText, { columns: ["text"] })
          .where(filter)
          .select([...PROJECTION, SCORE])
          .limit(fetch)
          .toArray() as Promise<Record<string, unknown>[]>,
      input,
      "score-desc",
    );
  } catch {
    // FTS immaturity (missing index / unsupported / transient): drop the layer.
    // Deliberately swallowed — §6 requires the fallback be invisible to callers.
    return null;
  }
}

/**
 * Produce the statistical layers' ranked candidates for a query, active-generation
 * fenced (§2) and FTS-degradation isolated (§6). The vector layer always runs; the
 * FTS layer runs iff `ftsEnabled` and its query succeeds — otherwise it degrades to
 * `null` and `degraded` is `true`. Folding to notes, re-densifying, and RRF fusion
 * are the caller's job (`apps/cli/src/retrieval/rrf.ts`); this module intentionally
 * returns per-chunk ranks and no fused score.
 */
export async function searchLayers(table: SearchTable, input: SearchLayersInput): Promise<SearchLayersResult> {
  const filter = activeGenerationFilter(input.activeGenerationIds);

  // No live generations ⇒ nothing is served. FTS is still "dropped" iff disabled.
  if (filter === null) {
    const disabled = !input.ftsEnabled;
    return { vector: [], fts: disabled ? null : [], degraded: disabled, layersUsed: [] };
  }

  const vector = await vectorLayer(table, filter, input);

  // FTS disabled by config ⇒ degrade without touching LanceDB (contract §6 switch).
  if (!input.ftsEnabled) {
    return { vector, fts: null, degraded: true, layersUsed: ["vector"] };
  }

  const fts = await ftsLayer(table, filter, input);
  const degraded = fts === null;
  const layersUsed: StatLayer[] = degraded ? ["vector"] : ["fts", "vector"];
  return { vector, fts, degraded, layersUsed };
}
