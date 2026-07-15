/**
 * The retrieval **active-generation filter** (Task 3.2, round-2 finding 5).
 *
 * Retrieval is fenced by SQLite: only chunks whose `generationId` equals the note's
 * SQLite `active_generation_id` are ever served (retrieval-index-contract §2 —
 * "Retrieval filters LanceDB chunks by `active_generation_id`"). Superseded and
 * orphaned generations are physically present in LanceDB until compaction, but this
 * filter makes them invisible to queries the instant a newer generation activates.
 *
 * This is the seam the hybrid retriever (Task 3.3) builds its layers on; it is
 * defined here so Task 3.2's acceptance suite can assert orphan-invisibility
 * through the REAL filter (not just by counting rows), and so the fence has one
 * canonical enforcement point rather than an ad-hoc predicate per query layer.
 */
import type { GenerationId } from "./generation.js";
import { readGenerationRows, type SearchTable } from "./writer.js";
import type { SearchChunk } from "./schema.js";

/** The minimal SQLite authority a retrieval read consults — the note→active-generation
 * fence (a structural slice of `GenerationRepo`/`Store`). */
export interface ActiveGenerationSource {
  /** The composite `generationId` a note's retrieval is fenced to, or `null`. */
  activeGenerationId(noteId: string): string | null;
}

/**
 * Return a note's LIVE chunks — the rows whose `generationId` equals the note's
 * SQLite `active_generation_id`, and NO others. A note that is not yet indexed
 * (`active_generation_id === null`) has no live chunks. Chunks from a superseded or
 * orphaned generation for the same note are filtered out by construction (their
 * `generationId` differs from the active one), so they can never be served even
 * while they remain physically present pending compaction.
 */
export async function retrieveActiveChunks(
  table: SearchTable,
  store: ActiveGenerationSource,
  noteId: string,
): Promise<SearchChunk[]> {
  const active = store.activeGenerationId(noteId);
  if (active === null) return [];
  return readGenerationRows(table, active as GenerationId, noteId);
}
