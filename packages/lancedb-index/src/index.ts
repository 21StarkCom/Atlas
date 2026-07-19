/**
 * `@atlas/lancedb-index` — the retrieval index package (Phase 3).
 *
 * This task's slice (3.1) ships three seams: the `SearchChunk` LanceDB row
 * schema, the deterministic v1 section chunker, and immutable generation/chunk
 * identity. The embed + fenced write path (3.2), hybrid search (3.3), and index
 * ops (3.5) build on these. D14: consumes only `@atlas/contracts`, never
 * `apps/cli`.
 */
export { CHUNKER_VERSION, chunkNote } from "./chunker.js";

export {
  type GenerationId,
  type ChunkId,
  type IndexingConfig,
  generationId,
  generationIdFor,
  indexingConfigKey,
  chunkId,
} from "./generation.js";

export {
  type SearchChunk,
  type SearchChunkColumn,
  type SearchChunkColumnType,
  SEARCH_CHUNK_SCHEMA_VERSION,
  SEARCH_CHUNK_TABLE,
  SEARCH_CHUNK_COLUMNS,
  searchChunkColumns,
  searchChunkArrowSchema,
  toSearchChunk,
} from "./schema.js";

// Fenced write path (Task 3.2): LanceDB writer + verify-complete, retirement +
// orphan compaction, and the `indexNote`/`reconcileIndex` orchestrators.
export {
  type LanceConnection,
  type SearchTable,
  openSearchTable,
  assembleRows,
  writeGeneration,
  readGenerationChunkIds,
  readGenerationRows,
  verifyComplete,
  countGenerationChunks,
  sqlQuote,
} from "./writer.js";

export { retireSupersededGenerations, compactOrphans } from "./retire.js";

export {
  type IndexMaintenanceLock,
  createIndexMaintenanceLock,
  tableMaintenanceLock,
  indexMaintenanceLockPath,
  INDEX_MAINTENANCE_LOCKFILE,
  NOOP_INDEX_LOCK,
} from "./lock.js";

export {
  type EmbedClient,
  embedderFromClient,
  asProviderFault,
} from "./embedder.js";

export {
  type ActiveGenerationSource,
  retrieveActiveChunks,
} from "./retrieval-filter.js";

// Hybrid search — the statistical (FTS + vector) layers with the FTS-maturity
// fallback isolated here (Task 3.3, retrieval-index-contract §5/§6).
export {
  type StatLayer,
  type ChunkHit,
  type SearchLayersInput,
  type SearchLayersResult,
  searchLayers,
} from "./search.js";

// The `text` FTS inverted index (English analyzer) — built at rebuild/repair so the
// FTS layer scores on content terms, not stop words (retrieval-index-contract §6, #156).
export { SEARCH_FTS_ANALYZER, ensureFtsIndex } from "./fts.js";

export {
  type ActivationStore,
  type Embedder,
  type EmbedOutcome,
  type IndexDeps,
  type IndexHooks,
  type IndexOutcome,
  type IndexedOutcome,
  type UnchangedOutcome,
  type EmptyOutcome,
  type SupersededOutcome,
  type EmbeddingFailedOutcome,
  type WriteIncompleteOutcome,
  type IndexReconcileReport,
  indexNote,
  reconcileIndex,
} from "./activate.js";

export { type GenerationPair, distinctGenerationPairs } from "./writer.js";

// Scoped reconcile (60-B Task 2.3): the O(delta) analog of reconcileIndex.
export { indexNotes, type ReconcileReport, type ReconcileKind } from "./reconcile-notes.js";

// Index maintenance ops (Task 3.5): staleness detection, SQLite↔LanceDB verify, and
// the reconcile-backed repair/rebuild convergence (retrieval-index-contract §3/§4).
export {
  type StalenessTrigger,
  type NoteStaleness,
  type NoteFenceInput,
  computeStaleness,
} from "./staleness.js";

export {
  type DivergenceKind,
  type Divergence,
  type IndexVerifyReport,
  type IndexVerifyInput,
  indexVerify,
} from "./verify.js";

export {
  type RepairAction,
  type RepairedNote,
  type UnresolvedNote,
  type IndexRepairReport,
  type IndexRebuildReport,
  indexRepair,
  indexRebuild,
} from "./repair.js";

export {
  runRetrievalEval,
  type EvalQuery,
  type EvalQuerySet,
  type EvalLabelSet,
  type EvalRow,
  type RetrievalEvalResult,
  type RetrievalEvalDeps,
} from "./eval.js";
