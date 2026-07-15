/**
 * The LanceDB `SearchChunk` table schema (Task 3.1, retrieval-index-contract
 * §1 last paragraph).
 *
 * This module owns the ROW SHAPE and a column descriptor for the retrieval
 * index; the actual table open/write path (and the LanceDB/Arrow dependency)
 * lands in Task 3.2, which consumes {@link SEARCH_CHUNK_COLUMNS} to build the
 * Arrow schema and {@link toSearchChunk} to assemble rows. Keeping the shape
 * here (dependency-free) lets the chunker + generation identity be tested
 * without pulling LanceDB into this task's slice.
 *
 * A persisted row carries: `chunkId`, chunk text (breadcrumb + title + aliases +
 * body), `noteId`, section path, `contentHash`, `chunkerVersion`,
 * `embeddingModel`, `embeddingDimensions`, `generationId`, and the embedding
 * vector. `generationId` is the retrieval join key: retrieval serves only chunks
 * whose `generationId` equals the note's active `active_generation_id` (§2).
 *
 * D14: structural types over `@atlas/contracts` DTOs; no `apps/cli` import.
 */
import * as arrow from "apache-arrow";
import type { Chunk } from "@atlas/contracts";
import {
  chunkId,
  generationId,
  generationIdFor,
  type ChunkId,
  type GenerationId,
  type IndexingConfig,
} from "./generation.js";

/** Schema version of the `SearchChunk` row layout (bump on a breaking change). */
export const SEARCH_CHUNK_SCHEMA_VERSION = 1;

/** The LanceDB table name the retrieval index writes/reads (Task 3.2/3.3). */
export const SEARCH_CHUNK_TABLE = "search_chunks";

/**
 * One persisted retrieval row. The embedding is a dense `float32` vector of
 * length `embeddingDimensions` (D7 = 768); it is produced by Task 3.2's embed
 * step, so {@link toSearchChunk} takes it as an argument here.
 */
export interface SearchChunk {
  /** Deterministic `f(generationId, sectionPath, ordinal)` (contract §1.6). */
  readonly chunkId: ChunkId;
  /** Embedded/indexed text: breadcrumb + title + aliases + body (§1.2–1.3). */
  readonly text: string;
  /** Owning note's canonical id. */
  readonly noteId: string;
  /** Unique encoded `SectionTree.path` this chunk came from ("" = preamble). */
  readonly sectionPath: string;
  /** The owning note's content hash (a generation-identity component, §2). */
  readonly contentHash: string;
  /** `indexing.chunker_version` (D4) the chunk was produced under. */
  readonly chunkerVersion: number;
  /** `indexing.embedding_model` (D7) the vector was produced under. */
  readonly embeddingModel: string;
  /** `indexing.dimensions` (D7) — the embedding vector length. */
  readonly embeddingDimensions: number;
  /** The retrieval join key — `f(§2 tuple)`; equals the note's fenced id when active. */
  readonly generationId: GenerationId;
  /** Dense `float32[embeddingDimensions]` embedding vector. */
  readonly embedding: readonly number[];
}

/** Logical column type for the Arrow-schema builder in Task 3.2. */
export type SearchChunkColumnType = "utf8" | "int32" | "fixed-size-list<float32>";

/** A `SearchChunk` column: its name, logical type, and (for the vector) length. */
export interface SearchChunkColumn {
  readonly name: keyof SearchChunk;
  readonly type: SearchChunkColumnType;
  /** For `fixed-size-list<float32>` only: the list length (= embedding dims). */
  readonly listSize?: number;
}

/**
 * The `SearchChunk` columns in declaration order. Task 3.2 turns this into the
 * concrete Arrow schema (the vector column's `listSize` is bound to
 * `indexing.dimensions` at table-create time via {@link searchChunkColumns}).
 */
export const SEARCH_CHUNK_COLUMNS: readonly SearchChunkColumn[] = [
  { name: "chunkId", type: "utf8" },
  { name: "text", type: "utf8" },
  { name: "noteId", type: "utf8" },
  { name: "sectionPath", type: "utf8" },
  { name: "contentHash", type: "utf8" },
  { name: "chunkerVersion", type: "int32" },
  { name: "embeddingModel", type: "utf8" },
  { name: "embeddingDimensions", type: "int32" },
  { name: "generationId", type: "utf8" },
  { name: "embedding", type: "fixed-size-list<float32>" },
];

/**
 * Bind the column descriptors to a concrete embedding dimensionality — the
 * vector column's `listSize` is fixed at `cfg.dimensions` (D7). Task 3.2 calls
 * this at table create so the Arrow schema pins the exact vector length.
 */
export function searchChunkColumns(cfg: IndexingConfig): SearchChunkColumn[] {
  return SEARCH_CHUNK_COLUMNS.map((col) =>
    col.type === "fixed-size-list<float32>" ? { ...col, listSize: cfg.dimensions } : { ...col },
  );
}

/**
 * The concrete Apache Arrow schema for the `SearchChunk` LanceDB table (Task
 * 3.1). This is the actual type LanceDB's node binding consumes at
 * `db.createEmptyTable(SEARCH_CHUNK_TABLE, searchChunkArrowSchema(cfg))` (Task
 * 3.2) — the embedding column is a **fixed-size list of `float32`** of length
 * `cfg.dimensions` (D7), which is what LanceDB requires to build an ANN index.
 *
 * Derived from {@link SEARCH_CHUNK_COLUMNS} so the logical column list and the
 * physical Arrow schema cannot drift. All columns are non-nullable: every
 * persisted row carries the full contract §1 field set.
 */
export function searchChunkArrowSchema(cfg: IndexingConfig): arrow.Schema {
  const fields = SEARCH_CHUNK_COLUMNS.map((col): arrow.Field => {
    switch (col.type) {
      case "utf8":
        return new arrow.Field(col.name, new arrow.Utf8(), false);
      case "int32":
        return new arrow.Field(col.name, new arrow.Int32(), false);
      case "fixed-size-list<float32>":
        return new arrow.Field(
          col.name,
          // FixedSizeList<Float32>[cfg.dimensions] — the dense embedding vector.
          new arrow.FixedSizeList(cfg.dimensions, new arrow.Field("item", new arrow.Float32(), false)),
          false,
        );
      default: {
        // Exhaustiveness guard — a new column type must extend this switch.
        const never: never = col.type;
        throw new Error(`searchChunkArrowSchema: unhandled column type ${String(never)}`);
      }
    }
  });
  return new arrow.Schema(fields);
}

/**
 * Assemble a persisted {@link SearchChunk} row from a chunker output `Chunk`,
 * its embedding vector, and the indexing config. Identity is DERIVED from the
 * authoritative `Chunk` DTO here — never re-invented or caller-injected — so the
 * write path (Task 3.2) cannot persist an internally-inconsistent row:
 *
 *   - The `chunkId` uses `chunk.ordinal` (the note-wide, dense ordinal), so two
 *     chunks that resolve to the same `sectionPath` (e.g. a preamble and a
 *     top-level empty heading, both `""`) still get distinct ids — one row can
 *     never overwrite another (contract §1.6; see {@link chunkId}).
 *   - The caller-supplied `gen` is VALIDATED against the id recomputed from the
 *     row tuple `(chunk.noteId, chunk.contentHash, cfg)` — an id that does not
 *     match the row it would tag is rejected, so generation fencing can never be
 *     defeated by handing in a mismatched generation.
 *
 * Also guards the vector length against `cfg.dimensions` (D7): a mismatch means
 * the embedding was produced under a different generation than claimed, which the
 * fence must never persist.
 */
export function toSearchChunk(
  chunk: Chunk,
  embedding: readonly number[],
  cfg: IndexingConfig,
  gen: GenerationId,
): SearchChunk {
  if (embedding.length !== cfg.dimensions) {
    throw new Error(
      `toSearchChunk: embedding length ${embedding.length} ≠ indexing.dimensions ${cfg.dimensions} (D7)`,
    );
  }
  const expected = generationIdFor(chunk.noteId, chunk.contentHash, cfg);
  if (gen !== expected) {
    throw new Error(
      `toSearchChunk: generationId ${gen} does not match the row tuple ` +
        `(noteId=${chunk.noteId}, contentHash=${chunk.contentHash}, ` +
        `chunkerVersion=${cfg.chunker_version}, embeddingModel=${cfg.embedding_model}, ` +
        `embeddingDimensions=${cfg.dimensions}) → expected ${expected}; refusing to persist an ` +
        `internally inconsistent generation`,
    );
  }
  return {
    chunkId: chunkId(gen, chunk.sectionPath, chunk.ordinal),
    text: chunk.text,
    noteId: chunk.noteId,
    sectionPath: chunk.sectionPath,
    contentHash: chunk.contentHash,
    chunkerVersion: cfg.chunker_version,
    embeddingModel: cfg.embedding_model,
    embeddingDimensions: cfg.dimensions,
    generationId: gen,
    embedding,
  };
}

// Re-export `generationId` alongside the schema for the Task 3.2 write path,
// which needs both the row shape and the note's generation id in one import.
export { generationId };
