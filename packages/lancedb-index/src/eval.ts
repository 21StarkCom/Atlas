/**
 * `runRetrievalEval` — the offline retrieval-quality eval harness (Task 3.6,
 * retrieval-index-contract.md; gates graduation per acceptance-thresholds.md §retrieval).
 *
 * Scores a retriever's ranked note ids against a versioned labeled fixture set
 * (`fixtures/retrieval-eval/{queries,labels}.json`) and computes the two graduation
 * metrics:
 *
 *   - **recall@K** (K = 10) — per query, `|relevant ∩ top-K| / |relevant|`, averaged over
 *     queries. For the single-relevant labels this is exactly the spec's "fraction of
 *     eval queries whose relevant note appears in the top-10 fused results."
 *   - **MRR** — the mean reciprocal rank of the FIRST relevant note across queries
 *     (`1/rank`, 1-indexed; `0` when no relevant note is retrieved).
 *
 * The harness is PURE: the retriever is injected as `(text) => Promise<string[]>`
 * (ranked note ids, best-first), so the metric math is unit-tested against a stubbed
 * retriever with hand-computed values, and the live end-to-end (Task 3.6 acceptance /
 * Task 5.4 gate) wires the real Task 3.3 `retrieve` over the `source-heavy` vault under
 * live embeddings. This module NEVER embeds or touches the index itself — it only scores
 * whatever ranking the injected retriever returns.
 *
 * D14: consumes only its own types; no `apps/cli` import (the retriever is injected).
 */

/** One labeled query (from `queries.json`). */
export interface EvalQuery {
  readonly id: string;
  readonly text: string;
}

/** The versioned query set (`queries.json`). */
export interface EvalQuerySet {
  readonly version: number;
  readonly queries: readonly EvalQuery[];
}

/** The versioned labels (`labels.json`): query id → expected canonical note ids. */
export interface EvalLabelSet {
  readonly version: number;
  readonly labels: Readonly<Record<string, readonly string[]>>;
}

/** Per-query eval detail — the transparent breakdown behind the aggregate metrics. */
export interface EvalRow {
  readonly queryId: string;
  /** The labeled relevant note ids for this query. */
  readonly expected: readonly string[];
  /** The retriever's ranked note ids, truncated to the top-K scored. */
  readonly retrieved: readonly string[];
  /** 1-indexed rank of the first relevant note in `retrieved`, or `null` if none. */
  readonly firstRelevantRank: number | null;
  /** `1/firstRelevantRank`, or `0` when no relevant note was retrieved. */
  readonly reciprocalRank: number;
  /** `|expected ∩ retrieved| / |expected|` (0 when the query has no labels). */
  readonly recall: number;
}

/** The eval result. `recallAt10`/`mrr` are the acceptance-thresholds.md §retrieval metrics. */
export interface RetrievalEvalResult {
  readonly recallAt10: number;
  readonly mrr: number;
  /** The K the recall was computed at (10 for the graduation gate). */
  readonly k: number;
  readonly perQuery: readonly EvalRow[];
}

export interface RetrievalEvalDeps {
  readonly queries: readonly EvalQuery[];
  /** query id → expected note ids. */
  readonly labels: Readonly<Record<string, readonly string[]>>;
  /** The retriever under eval: ranked note ids for a query, best-first. Adapt the Task
   * 3.3 `retrieve` as `(text) => retrieve(...).then(r => r.items.map(i => i.noteId))`. */
  readonly retrieve: (text: string) => Promise<readonly string[]>;
  /** Top-K to score recall at (default 10 — the graduation metric). */
  readonly k?: number;
}

/**
 * Run the eval: score every query's ranked retrieval against its labels and aggregate
 * recall@K + MRR. Deterministic given a deterministic retriever.
 */
export async function runRetrievalEval(deps: RetrievalEvalDeps): Promise<RetrievalEvalResult> {
  const k = deps.k ?? 10;
  const perQuery: EvalRow[] = [];

  for (const q of deps.queries) {
    const expected = deps.labels[q.id] ?? [];
    const expectedSet = new Set(expected);
    const retrieved = (await deps.retrieve(q.text)).slice(0, k);

    let firstRelevantRank: number | null = null;
    for (let i = 0; i < retrieved.length; i++) {
      if (expectedSet.has(retrieved[i]!)) {
        firstRelevantRank = i + 1;
        break;
      }
    }
    const reciprocalRank = firstRelevantRank === null ? 0 : 1 / firstRelevantRank;
    const hits = retrieved.reduce((n, id) => (expectedSet.has(id) ? n + 1 : n), 0);
    const recall = expected.length === 0 ? 0 : hits / expected.length;

    perQuery.push({ queryId: q.id, expected, retrieved, firstRelevantRank, reciprocalRank, recall });
  }

  const n = perQuery.length;
  const mean = (pick: (r: EvalRow) => number): number => (n === 0 ? 0 : perQuery.reduce((s, r) => s + pick(r), 0) / n);
  return { recallAt10: mean((r) => r.recall), mrr: mean((r) => r.reciprocalRank), k, perQuery };
}
