/**
 * `index verify` (Task 3.5, retrieval-index-contract.md §2/§4) — the read-only
 * SQLite ↔ LanceDB consistency check.
 *
 * Confirms that every note's SQLite-active generation (`notes.active_generation_id`,
 * the retrieval join key) has matching live LanceDB chunks, that no active generation
 * is stale relative to the current note + config, and that no live chunks are tagged
 * with a non-active (orphaned) generation. It REPORTS divergences as data — it never
 * repairs (that is `index repair`) and writes no ledger row.
 *
 * D14: consumes only `@atlas/contracts` + own modules; the caller reads the note
 * fences + the SQLite-active generation set from the store and passes them in.
 */
import { generationIdFor, type GenerationId, type IndexingConfig } from "./generation.js";
import { distinctGenerationPairs, readGenerationRows, type SearchTable } from "./writer.js";
import type { NoteFenceInput } from "./staleness.js";

/** A class of SQLite↔LanceDB inconsistency (`cli-contract/index-verify.schema.json`). */
export type DivergenceKind =
  | "missing-chunks"
  | "orphaned-generation"
  | "stale-active"
  | "generation-mismatch"
  | "permanent-embedding-failure";

/** One inconsistent note. */
export interface Divergence {
  readonly noteId: string;
  readonly kind: DivergenceKind;
  readonly detail?: string;
}

/** The `index verify` report. `consistent` MUST be true iff `divergences` is empty. */
export interface IndexVerifyReport {
  readonly consistent: boolean;
  /** Number of notes cross-checked (those with an active generation). */
  readonly checked: number;
  readonly divergences: Divergence[];
}

export interface IndexVerifyInput {
  /** Every projected note's fence (from SQLite `notes`). */
  readonly notes: readonly NoteFenceInput[];
  /** The open `search_chunks` table, or `null` when no LanceDB index is present. */
  readonly table: SearchTable | null;
  readonly config: IndexingConfig;
  /** The SQLite-active generation set (`store.generation.activeGenerationIds()`). */
  readonly activeGenerationIds: readonly string[];
}

/**
 * Cross-check SQLite ↔ LanceDB. Divergence classes:
 * - **missing-chunks** — a note's active generation has zero live chunks (LanceDB gone
 *   or the write never durably landed).
 * - **stale-active** — a note's active generation differs from the one the current
 *   note + config would produce (§4 drift, cross-checked here as SQLite-vs-config).
 * - **orphaned-generation** — live chunks tagged with a generation that is not active
 *   for any note (a superseded write, or chunks of a removed note).
 *
 * When `table === null`, every note with an active generation is a `missing-chunks`
 * divergence (its chunks cannot be present).
 */
export async function indexVerify(input: IndexVerifyInput): Promise<IndexVerifyReport> {
  const { notes, table, config, activeGenerationIds } = input;
  const divergences: Divergence[] = [];
  let checked = 0;

  for (const note of notes) {
    if (note.activeGenerationId === null) continue; // never-indexed: not a divergence (empty-note policy §4)
    checked++;
    if (table === null) {
      divergences.push({ noteId: note.noteId, kind: "missing-chunks", detail: "no LanceDB index is present" });
      continue;
    }
    const rows = await readGenerationRows(table, note.activeGenerationId as GenerationId);
    if (rows.length === 0) {
      divergences.push({ noteId: note.noteId, kind: "missing-chunks", detail: "active_generation_id has no live LanceDB chunks" });
      continue;
    }
    const expected = generationIdFor(note.noteId, note.contentHash, config) as string;
    if (note.activeGenerationId !== expected) {
      divergences.push({ noteId: note.noteId, kind: "stale-active", detail: "active generation differs from the current note + config" });
    }
  }

  // Orphan scan: any live (noteId, generationId) pair whose generation is not active.
  if (table !== null) {
    const active = new Set(activeGenerationIds);
    for (const pair of await distinctGenerationPairs(table)) {
      if (!active.has(pair.generationId)) {
        divergences.push({ noteId: pair.noteId, kind: "orphaned-generation", detail: "live chunks tagged with a non-active generation" });
      }
    }
  }

  return { consistent: divergences.length === 0, checked, divergences };
}
