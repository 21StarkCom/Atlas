/**
 * The `search_chunks.text` full-text-search index (retrieval-index-contract §6).
 *
 * LanceDB's `fullTextSearch` runs a BRUTE-FORCE scan with a default tokenizer when
 * no inverted index exists — no stemming, no stop-word removal. Over the chunk
 * `text` (breadcrumb + title + aliases + body, §1) that floods top-K with chunks
 * that merely happen to contain a common query term ("team", "cloud", "project"),
 * so RRF fuses in noise and recall collapses when FTS is weighted at all.
 *
 * This module builds a real inverted index with an English analyzer — stemming +
 * stop-word removal + ASCII folding — so the FTS layer scores on content terms, not
 * stop words. Measured on the 2026-07-17 full-corpus drive (45-query graduation eval
 * set, 199 notes / 1,647 chunks): the default hybrid config went from recall 0.878 /
 * MRR 0.673 (below the 0.85/0.7 gate) to **recall 0.911 / MRR 0.830** — the FTS layer
 * turned from actively harmful into the strongest configuration (see #156, and the
 * retro `docs/retros/2026-07-18-search-index-live-drive-retro.md`).
 *
 * The analyzer is a single documented v1 constant, not a config knob: the query path
 * (`search.ts`) applies the SAME analyzer LanceDB stored on the index, so index and
 * query tokenization can never drift. Making it configurable would require a
 * co-versioned query-side switch and is deferred until a second analyzer is needed.
 *
 * D14: consumes only LanceDB. The §6 degradation contract is unchanged — a table
 * without this index still answers `fullTextSearch` (brute-force) or throws, and
 * `search.ts` already isolates both into the vector-only fallback.
 */
import { Index } from "@lancedb/lancedb";
import type { SearchTable } from "./writer.js";

/** The FTS-indexed column (the chunk's breadcrumb+title+aliases+body, §1). */
const FTS_COLUMN = "text";

/**
 * The v1 FTS analyzer for `search_chunks.text` (retrieval-index-contract §6). English
 * stemming + stop-word removal + ASCII folding over the `simple` (whitespace +
 * punctuation) base tokenizer — the config that lifted the graduation gate on the real
 * corpus (#156). `withPosition: false` (no phrase queries; RRF consumes ranks only).
 */
export const SEARCH_FTS_ANALYZER = {
  baseTokenizer: "simple",
  language: "English",
  stem: true,
  removeStopWords: true,
  asciiFolding: true,
  withPosition: false,
} as const;

/**
 * Build (or rebuild) the `text` FTS inverted index with {@link SEARCH_FTS_ANALYZER}.
 * Idempotent via `replace: true` — safe to call at the end of every `index rebuild`
 * / `index repair` convergence, which is exactly when the row set has changed and the
 * index must be re-derived to cover it. A zero-row table is skipped: LanceDB cannot
 * build an inverted index over no rows, and an empty index has nothing to serve —
 * `search.ts` degrades to vector-only until the first generation is written.
 */
export async function ensureFtsIndex(table: SearchTable): Promise<void> {
  if ((await table.countRows()) === 0) return;
  await table.createIndex(FTS_COLUMN, {
    config: Index.fts({ ...SEARCH_FTS_ANALYZER }),
    replace: true,
  });
}
