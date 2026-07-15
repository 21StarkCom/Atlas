/**
 * The LanceDB write + verify-complete path (Task 3.2, retrieval-index-contract
 * §3 steps 3–4). This module owns the physical index table: opening/creating it,
 * writing a generation's `SearchChunk` rows **idempotently**, and reading them
 * back to gate activation on a COMPLETE write.
 *
 * It is deliberately dumb about the fence — SQLite is the sole activation
 * authority (Task 3.2 / D13). This module never flips `active_generation*`; it
 * only makes chunks durably present so the SQLite CAS ({@link
 * ../../sqlite-store activateGeneration}) has something to point at. Every write
 * is keyed by the deterministic `chunkId` (`f(generationId, sectionPath,
 * ordinal)`), so a re-run re-writes only the same rows — a resumed/partial batch
 * converges with no duplicates (§1.6, §3 step 3).
 *
 * D14: consumes only `@atlas/contracts` DTOs (via `./schema.js`) + LanceDB; no
 * `apps/cli` import.
 */
import * as lancedb from "@lancedb/lancedb";
import type { Chunk } from "@atlas/contracts";
import type { ChunkId, GenerationId, IndexingConfig } from "./generation.js";
import {
  SEARCH_CHUNK_TABLE,
  searchChunkArrowSchema,
  toSearchChunk,
  type SearchChunk,
} from "./schema.js";

/** A LanceDB connection (opened by the caller at `lancedb.dir`). */
export type LanceConnection = lancedb.Connection;
/** A LanceDB table handle for the `search_chunks` index. */
export type SearchTable = lancedb.Table;

/**
 * Open the `search_chunks` table, creating it (empty, with the D7-pinned vector
 * schema) if absent. Idempotent: safe to call on every `indexNote`/`reconcileIndex`
 * pass. The vector column's length is fixed to `cfg.dimensions` at create time; a
 * later run under DIFFERENT `dimensions` opens a new generation by construction
 * (D7) but cannot widen an existing table — a dimensions change is converged by
 * `index rebuild` (Task 3.5, delete `lancedb.dir` wholesale), not here.
 */
export async function openSearchTable(
  db: LanceConnection,
  cfg: IndexingConfig,
): Promise<SearchTable> {
  const names = await db.tableNames();
  if (names.includes(SEARCH_CHUNK_TABLE)) {
    return db.openTable(SEARCH_CHUNK_TABLE);
  }
  return db.createEmptyTable(SEARCH_CHUNK_TABLE, searchChunkArrowSchema(cfg));
}

/**
 * Assemble the `SearchChunk` rows for a generation from its chunks + embeddings.
 * `chunks[i]` pairs with `embeddings[i]` (embed preserves input order); every row
 * is validated by {@link toSearchChunk} — the caller-supplied `gen` must match the
 * id recomputed from the row tuple, and each vector length must equal
 * `cfg.dimensions`, so an internally inconsistent generation can never be built.
 */
export function assembleRows(
  chunks: readonly Chunk[],
  embeddings: readonly (readonly number[])[],
  cfg: IndexingConfig,
  gen: GenerationId,
): SearchChunk[] {
  if (chunks.length !== embeddings.length) {
    throw new Error(
      `assembleRows: chunk/embedding count mismatch (${chunks.length} chunks, ${embeddings.length} vectors)`,
    );
  }
  return chunks.map((chunk, i) => toSearchChunk(chunk, embeddings[i]!, cfg, gen));
}

/**
 * Write a generation's rows into LanceDB **idempotently** (§3 step 3). Uses a
 * merge-insert keyed on `chunkId`: an already-present row is updated in place
 * (a no-op for identical content) and a missing row is inserted, so a resumed
 * batch after a crash fills only the gaps with no duplicate rows. A zero-row
 * generation (a note with no prose-bearing sections) is a valid no-op.
 */
export async function writeGeneration(
  table: SearchTable,
  rows: readonly SearchChunk[],
): Promise<void> {
  if (rows.length === 0) return;
  await table
    .mergeInsert("chunkId")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(rows.map(toRecord));
}

/**
 * Read back the set of `chunkId`s durably present for `gen` (§3 step 4 input).
 * Retrieval-scoped by `generationId`, so it never counts another generation's
 * rows toward completeness.
 */
export async function readGenerationChunkIds(
  table: SearchTable,
  gen: GenerationId,
): Promise<Set<string>> {
  const rows = (await table
    .query()
    .where(`generationId = ${sqlQuote(gen)}`)
    .select(["chunkId"])
    .toArray()) as { chunkId: string }[];
  return new Set(rows.map((r) => r.chunkId));
}

/**
 * Read back the full `SearchChunk` rows for `gen`, optionally scoped to one
 * `noteId` — the physical read the retrieval active-generation filter
 * (`retrieval-filter.ts`) and Task 3.3's layers project from. Generation-scoped, so
 * a superseded/orphaned generation's rows are never returned when the caller passes
 * the active `generationId`.
 */
export async function readGenerationRows(
  table: SearchTable,
  gen: GenerationId,
  noteId?: string,
): Promise<SearchChunk[]> {
  const predicate =
    noteId === undefined
      ? `generationId = ${sqlQuote(gen)}`
      : `generationId = ${sqlQuote(gen)} AND noteId = ${sqlQuote(noteId)}`;
  const rows = (await table.query().where(predicate).toArray()) as Record<string, unknown>[];
  return rows.map(recordToSearchChunk);
}

/**
 * Verify-complete (§3 step 4): confirm EVERY expected `chunkId` for the
 * generation is durably present in LanceDB before activation. Returns `false` if
 * any is missing — a short/partial batched write fails this gate, so a partially
 * written generation can never be CAS-activated and therefore never queryable.
 * A generation with no expected chunks is trivially complete.
 */
export async function verifyComplete(
  table: SearchTable,
  gen: GenerationId,
  expectedChunkIds: Iterable<string>,
): Promise<boolean> {
  const expected = [...expectedChunkIds];
  if (expected.length === 0) return true;
  const present = await readGenerationChunkIds(table, gen);
  return expected.every((id) => present.has(id));
}

/** Count the live rows tagged with `gen`. */
export async function countGenerationChunks(table: SearchTable, gen: GenerationId): Promise<number> {
  return table.countRows(`generationId = ${sqlQuote(gen)}`);
}

/** Reconstruct a {@link SearchChunk} from a LanceDB record (inverse of
 * {@link toRecord}). The `embedding` column returns as an array-like (Arrow
 * fixed-size-list) — normalized back to a plain `number[]`. */
function recordToSearchChunk(rec: Record<string, unknown>): SearchChunk {
  return {
    chunkId: rec.chunkId as ChunkId,
    text: rec.text as string,
    noteId: rec.noteId as string,
    sectionPath: rec.sectionPath as string,
    contentHash: rec.contentHash as string,
    chunkerVersion: Number(rec.chunkerVersion),
    embeddingModel: rec.embeddingModel as string,
    embeddingDimensions: Number(rec.embeddingDimensions),
    generationId: rec.generationId as GenerationId,
    embedding: Array.from(rec.embedding as ArrayLike<number>, Number),
  };
}

/** Turn a {@link SearchChunk} into the plain record LanceDB persists (mutable
 * `embedding` array; the fixed-size-list<float32> coercion is by table schema). */
function toRecord(row: SearchChunk): Record<string, unknown> {
  return {
    chunkId: row.chunkId,
    text: row.text,
    noteId: row.noteId,
    sectionPath: row.sectionPath,
    contentHash: row.contentHash,
    chunkerVersion: row.chunkerVersion,
    embeddingModel: row.embeddingModel,
    embeddingDimensions: row.embeddingDimensions,
    generationId: row.generationId,
    embedding: [...row.embedding],
  };
}

/**
 * Quote a string as a DataFusion/LanceDB SQL literal — wrap in single quotes and
 * double any embedded single quote. `generationId` is hex (never needs it) but
 * `noteId` is a frontmatter `id` that could carry a quote, so every predicate
 * value funnels through here rather than string-concatenating raw input.
 */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
