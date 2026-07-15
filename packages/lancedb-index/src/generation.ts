/**
 * Generation + chunk identity (Task 3.1, retrieval-index-contract §2 and §1.6).
 *
 * An index *generation* is the immutable tuple that fully determines a note's
 * chunk+embedding set. Its id is a PURE function of that tuple — a stable hash
 * of the canonically-serialized components (never a timestamp or counter), so
 * the same tuple on any host reproduces the same id. All five components are
 * load-bearing: a change to ANY of them yields a different `generationId` and
 * therefore a new generation by construction (this is why changing
 * `indexing.dimensions` — D7 — "opens a new index generation").
 *
 * Both ids hash `canonicalSerialize(...)` output (`atlas-jcs-v1`, RFC-8785 JCS):
 * object keys are sorted deterministically and strings are NFC-normalized, so
 * two processes on different platforms produce BYTE-IDENTICAL ids. This is the
 * generation-fencing precondition — the SQLite CAS (Task 3.2) joins LanceDB
 * chunks to a note by exactly this `generationId`.
 *
 * D14: this package consumes the DTO/serialization from `@atlas/contracts`,
 * never from `apps/cli`.
 */
import { createHash } from "node:crypto";
import { canonicalSerialize, type ParsedNote } from "@atlas/contracts";

/**
 * The indexing knobs that participate in generation identity. A structural
 * mirror of `AtlasConfigSchema.indexing` (D4 `chunker_version`, D7
 * `dimensions`/`embedding_model`) — declared HERE, not imported from
 * `apps/cli`, because D14 forbids a package→app import. The CLI passes a value
 * of this shape at runtime; the field names match the config keys verbatim.
 */
export interface IndexingConfig {
  /** D4 — `indexing.chunker_version`. This package implements version `1`. */
  readonly chunker_version: number;
  /** D7 — `indexing.embedding_model` (e.g. `gemini-embedding-001`). */
  readonly embedding_model: string;
  /** D7 — `indexing.dimensions` (e.g. `768`). */
  readonly dimensions: number;
}

/**
 * A generation id — the composite hash of the §2 tuple. Branded so it cannot be
 * confused with an arbitrary string; only {@link generationId} mints one. Stored
 * verbatim in `notes.active_generation_id` (TEXT) and every LanceDB
 * `SearchChunk.generationId`, and used as the retrieval join key.
 */
export type GenerationId = string & { readonly __brand: "atlas.GenerationId" };

/**
 * A deterministic chunk id — the composite hash of `(generationId, sectionPath,
 * ordinal)`. Branded like {@link GenerationId}; only {@link chunkId} mints one.
 * Because chunking is deterministic (see `chunker.ts`), the complete expected
 * chunk-id set for a generation is knowable before any write, which is what
 * makes LanceDB writes idempotent and the verify-complete gate (contract §3)
 * possible.
 */
export type ChunkId = string & { readonly __brand: "atlas.ChunkId" };

/**
 * Compute the immutable generation id directly from the §2 tuple components:
 *
 *   generationId = f(noteId, contentHash, chunkerVersion, embeddingModel, embeddingDimensions)
 *
 * Pure and host-independent — identical inputs always yield identical bytes. This
 * is the authoritative minting site; {@link generationId} projects a `ParsedNote`
 * onto it, and the schema layer ({@link toSearchChunk}) recomputes it from a
 * row's `(noteId, contentHash)` + config to VALIDATE a caller-supplied id, so an
 * inconsistent generation can never be persisted (generation-fencing precondition).
 */
export function generationIdFor(
  noteId: string,
  contentHash: string,
  cfg: IndexingConfig,
): GenerationId {
  const digest = createHash("sha256")
    .update(
      canonicalSerialize({
        noteId,
        contentHash,
        chunkerVersion: cfg.chunker_version,
        embeddingModel: cfg.embedding_model,
        embeddingDimensions: cfg.dimensions,
      }),
    )
    .digest("hex");
  return digest as GenerationId;
}

/**
 * Compute the immutable generation id for `note` under `cfg` (contract §2) — the
 * `ParsedNote` projection of {@link generationIdFor}. Only `note.id` and
 * `note.contentHash` participate; every other note field is outside the identity
 * tuple by construction.
 */
export function generationId(note: ParsedNote, cfg: IndexingConfig): GenerationId {
  return generationIdFor(note.id, note.contentHash, cfg);
}

/**
 * Compute the deterministic chunk id (contract §1.6):
 *
 *   chunkId = f(generationId, sectionPath, ordinal)
 *
 * `sectionPath` is the UNIQUE encoded `SectionTree.path` (duplicate-heading and
 * slash-in-heading safe — see `chunker.ts`), NOT the human display breadcrumb,
 * so ids never collide between sibling sections that share heading text.
 *
 * `ordinal` is the chunk's 0-based ordinal WITHIN its section (contract §1.6),
 * from the authoritative `Chunk` DTO. The v1 chunker emits at most one chunk per
 * unique `sectionPath`, so it is always `0`; the id-format still carries it so a
 * future splitting chunker (multiple chunks per section) needs no id change.
 * Uniqueness rests on `sectionPath`: the note preamble is the sole `""` path and
 * every heading section — including empty headings, which the section encoder
 * maps to a reserved non-empty segment — has a distinct non-empty path, so no
 * two chunks ever share `(sectionPath, ordinal)` and no row overwrites another.
 */
export function chunkId(gen: GenerationId, sectionPath: string, ordinal: number): ChunkId {
  const digest = createHash("sha256")
    .update(
      canonicalSerialize({
        generationId: gen,
        sectionPath,
        ordinal,
      }),
    )
    .digest("hex");
  return digest as ChunkId;
}
