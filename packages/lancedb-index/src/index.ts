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
