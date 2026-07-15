/**
 * Reciprocal Rank Fusion (RRF) — the fusion half of hybrid search (Task 3.3,
 * retrieval-index-contract §5). PURE + deterministic: given the per-layer ranked
 * candidates and the config-owned `k`/weights, it produces the fused, note-level
 * ranking with full per-layer provenance. No I/O, no LanceDB, no clock.
 *
 * The pipeline, exactly per §5:
 *   1. **Fold chunks → notes per layer** — group a layer's ranked chunks by
 *      `noteId`, keep each note's BEST (lowest) chunk rank as its layer rank; the
 *      surviving chunk supplies the note's `sectionPath` provenance. One candidate
 *      per note per layer.
 *   2. **Re-densify ranks** — compact each layer's surviving per-note ranks to a
 *      dense 1-based sequence in ascending original-rank order, so `k + rank` is
 *      well-defined and stable.
 *   3. **Fuse across layers** — `score(d) = Σ_{ℓ} weight[ℓ] / (k + rank_ℓ(d))`; a
 *      layer in which `d` did not appear contributes nothing (it is omitted from
 *      `d`'s contributions, never recorded as rank 0).
 *
 * **Determinism (§5, acceptance):** results are ordered by DESCENDING `score`,
 * ties broken by ASCENDING `noteId` (byte order of the canonical id). This two-key
 * order is total and deployment-independent.
 *
 * **Config-owned constants (NOT hardcoded — contract §5/§8):** `k` and the per-layer
 * weights are passed in from `AtlasConfig.retrieval.rrf`; this module never inlines
 * `60`, `1.0`, or the precedence. The caller decides which layers participate
 * (the FTS-maturity fallback drops `fts` upstream — §6); RRF simply fuses whatever
 * layer set it is handed, so the scoring formula is untouched by the fallback.
 */

/** The precise 5-value layer taxonomy the query result surfaces (contract §5,
 * `cli-contract/query.schema.json`). The identity layers short-circuit; `fts`/`vector`
 * are the fused statistical layers. */
export type Layer = "exact-id" | "slug" | "unique-alias" | "fts" | "vector";

/** The two statistical layers RRF fuses. */
export type StatLayer = "fts" | "vector";

/** Per-layer provenance for one fused note (contract §5, query.schema `contributions[]`). */
export interface Contribution {
  /** The layer that surfaced this note. */
  readonly layer: Layer;
  /** The note's folded, re-densified 1-based rank within the layer. */
  readonly rank: number;
  /** `weight[layer] / (k + rank)` — this layer's addend to the fused score. */
  readonly weightedContribution: number;
}

/** A fused, note-level result item, in fused rank order. `Σ contributions.weightedContribution === score`. */
export interface FusedItem {
  readonly noteId: string;
  /** The best-ranked matching section's path across contributing layers (§5 provenance). */
  readonly sectionPath: string;
  readonly score: number;
  readonly contributions: Contribution[];
}

/** The RRF constants, sourced from `AtlasConfig.retrieval.rrf` (never inlined). */
export interface RrfConfig {
  readonly k: number;
  readonly weights: Readonly<Record<StatLayer, number>>;
}

/** A single chunk hit fed into fusion — the minimal projection RRF needs from a
 * layer's ranked candidates (`@atlas/lancedb-index` `ChunkHit` is a superset). */
export interface RankedChunk {
  readonly noteId: string;
  readonly sectionPath: string;
  /** 1-based rank within the layer, in provider order (pre-fold). */
  readonly rank: number;
}

/** One statistical layer's ranked chunk candidates, ready to fold + fuse. */
export interface LayerCandidates {
  readonly layer: StatLayer;
  readonly hits: readonly RankedChunk[];
}

/** A note folded within a single layer: its best rank + the section that carried it. */
interface FoldedNote {
  readonly noteId: string;
  /** The note's BEST (lowest) chunk rank in this layer, pre-densify. */
  readonly bestRank: number;
  /** The section path of the best-ranked chunk (§5: the surviving chunk supplies provenance). */
  readonly sectionPath: string;
  /** The dense 1-based rank after re-densify (§5 step 2). */
  denseRank: number;
}

/**
 * Fold a layer's ranked chunks to notes (§5 step 1) then re-densify (step 2).
 * Keeps each note's lowest chunk rank and that chunk's `sectionPath`; ties on
 * `bestRank` for a single note cannot happen (ranks are unique within a layer),
 * so folding is unambiguous. The dense rank is assigned in ascending `bestRank`
 * order — the layer's provider order with gaps removed.
 */
function foldLayer(hits: readonly RankedChunk[]): Map<string, FoldedNote> {
  const byNote = new Map<string, FoldedNote>();
  for (const hit of hits) {
    const existing = byNote.get(hit.noteId);
    if (existing === undefined || hit.rank < existing.bestRank) {
      byNote.set(hit.noteId, {
        noteId: hit.noteId,
        bestRank: hit.rank,
        sectionPath: hit.sectionPath,
        denseRank: 0, // assigned below
      });
    }
  }
  // Re-densify: ascending original best-rank → dense 1..n.
  const ordered = [...byNote.values()].sort((a, b) => a.bestRank - b.bestRank);
  ordered.forEach((note, i) => {
    note.denseRank = i + 1;
  });
  return byNote;
}

/**
 * Fuse the statistical layers into a deterministic, note-level ranking (contract
 * §5). Folds + re-densifies each layer, then sums `weight[ℓ] / (k + rank_ℓ(d))`
 * over the layers a note appears in. The result is ordered by descending score,
 * ties broken by ascending `noteId`.
 *
 * `sectionPath` provenance for a note surfaced by several layers is taken from the
 * layer where it ranked BEST (lowest dense rank); ties break by the layers'
 * incoming order (the caller passes `fts` before `vector`, per §5).
 */
export function fuse(layers: readonly LayerCandidates[], config: RrfConfig): FusedItem[] {
  const { k } = config;

  // Fold every layer up front, preserving incoming layer order for provenance ties.
  const folded = layers.map((l) => ({ layer: l.layer, notes: foldLayer(l.hits) }));

  // Union of all candidate note ids across layers.
  const noteIds = new Set<string>();
  for (const { notes } of folded) for (const id of notes.keys()) noteIds.add(id);

  const items: FusedItem[] = [];
  for (const noteId of noteIds) {
    const contributions: Contribution[] = [];
    let score = 0;
    let best: { denseRank: number; sectionPath: string } | null = null;

    for (const { layer, notes } of folded) {
      const note = notes.get(noteId);
      if (note === undefined) continue; // layer d did not appear in → contributes nothing (§5)
      const weight = config.weights[layer];
      const weightedContribution = weight / (k + note.denseRank);
      score += weightedContribution;
      contributions.push({ layer, rank: note.denseRank, weightedContribution });
      // Best-section provenance: lowest dense rank wins; earlier layer wins ties.
      if (best === null || note.denseRank < best.denseRank) {
        best = { denseRank: note.denseRank, sectionPath: note.sectionPath };
      }
    }

    // A note in the union always has ≥1 contribution.
    items.push({ noteId, sectionPath: best?.sectionPath ?? "", score, contributions });
  }

  // Deterministic total order: score desc, then noteId asc (§5 tie-break).
  items.sort((a, b) => (b.score - a.score) || compareNoteIdUtf8(a.noteId, b.noteId));
  return items;
}

/**
 * Compare two note ids in **UTF-8 byte order** (contract §5 tie-break: "byte order
 * of the canonical id"). JavaScript's `<`/`>` on strings compares UTF-16 code
 * UNITS, which diverges from UTF-8/code-point order for supplementary characters
 * (their surrogate halves 0xD800–0xDFFF sort before BMP chars they should follow).
 * Comparing the encoded bytes makes the tie-break total, correct, and identical on
 * every platform for Unicode note ids (e.g. emoji or CJK-extension-B ids).
 */
function compareNoteIdUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
