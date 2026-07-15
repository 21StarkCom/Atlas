/**
 * Staleness detection (Task 3.5, retrieval-index-contract.md §4).
 *
 * A note's active generation is **stale** when the generation-identity tuple that
 * would be computed today (from the CURRENT note content + config) differs from the
 * tuple the active generation was embedded under. Because all four staleness triggers
 * are generation-identity components (§2), "stale" is exactly
 * `active_generation_id ≠ generationIdFor(noteId, currentContentHash, currentConfig)`.
 *
 * This module reports staleness AS DATA — it never mutates the index (that is
 * `index repair`/`index rebuild`). It decodes WHICH component drifted by reading a
 * representative active-generation `SearchChunk` row from LanceDB (the row carries the
 * `contentHash`/`chunkerVersion`/`embeddingModel`/`embeddingDimensions` it was embedded
 * under, §2) and comparing each to the current note + config. A note whose active
 * generation has NO live chunks (LanceDB directory deleted, or never durably written)
 * reports the `missing` trigger.
 *
 * D14: this package consumes only `@atlas/contracts` + its own modules; the caller
 * (`apps/cli`) reads the note fences from SQLite and passes them in as plain data.
 */
import { generationIdFor, type GenerationId, type IndexingConfig } from "./generation.js";
import { readGenerationRows, type SearchTable } from "./writer.js";

/** The per-note fence the caller reads from SQLite `notes` (the activation authority). */
export interface NoteFenceInput {
  readonly noteId: string;
  /** The note's CURRENT content hash (the live projection value). */
  readonly contentHash: string;
  /** The composite `generationId` retrieval is fenced to, or `null` if never indexed. */
  readonly activeGenerationId: string | null;
}

/** A generation-identity drift (retrieval-index-contract §4), or `missing` chunks. */
export type StalenessTrigger =
  | "contentHash"
  | "chunkerVersion"
  | "embeddingModel"
  | "embeddingDimensions"
  | "missing";

/** Per-note coverage status. `indexed` ⇒ current + live; else `triggers` is non-empty. */
export interface NoteStaleness {
  readonly noteId: string;
  readonly status: "indexed" | "stale" | "missing";
  /** Non-empty iff `status !== "indexed"`; the drifts (§4) that make the note stale/missing. */
  readonly triggers: readonly StalenessTrigger[];
}

/**
 * Classify every note's active-generation coverage against the current config.
 *
 * - `activeGenerationId === null` ⇒ **missing** (never indexed, or tombstoned).
 * - active set but the generation has **no live chunks** ⇒ **missing** (LanceDB gone).
 * - active generation's embedded tuple differs from the current note + config ⇒
 *   **stale**, with one trigger per drifted component (§4).
 * - otherwise ⇒ **indexed** (current + live).
 *
 * `table === null` means no LanceDB index is configured/present: every note with an
 * active generation reports `missing` (its chunks cannot be present).
 */
export async function computeStaleness(
  notes: readonly NoteFenceInput[],
  table: SearchTable | null,
  config: IndexingConfig,
): Promise<NoteStaleness[]> {
  const out: NoteStaleness[] = [];
  for (const note of notes) {
    if (note.activeGenerationId === null) {
      out.push({ noteId: note.noteId, status: "missing", triggers: ["missing"] });
      continue;
    }
    if (table === null) {
      out.push({ noteId: note.noteId, status: "missing", triggers: ["missing"] });
      continue;
    }
    const rows = await readGenerationRows(table, note.activeGenerationId as GenerationId);
    if (rows.length === 0) {
      out.push({ noteId: note.noteId, status: "missing", triggers: ["missing"] });
      continue;
    }
    const expected = generationIdFor(note.noteId, note.contentHash, config) as string;
    if (note.activeGenerationId === expected) {
      out.push({ noteId: note.noteId, status: "indexed", triggers: [] });
      continue;
    }
    // Stale: decode which generation-identity component drifted from a representative
    // active-generation row (they are all identical within a generation, §2).
    const row = rows[0]!;
    const triggers: StalenessTrigger[] = [];
    if (row.contentHash !== note.contentHash) triggers.push("contentHash");
    if (row.chunkerVersion !== config.chunker_version) triggers.push("chunkerVersion");
    if (row.embeddingModel !== config.embedding_model) triggers.push("embeddingModel");
    if (row.embeddingDimensions !== config.dimensions) triggers.push("embeddingDimensions");
    // A generationId mismatch with no decoded component drift is impossible (the id is
    // f(those components)); fall back to `contentHash` so a stale note is never reported
    // with an empty trigger set.
    out.push({ noteId: note.noteId, status: "stale", triggers: triggers.length > 0 ? triggers : ["contentHash"] });
  }
  return out;
}
