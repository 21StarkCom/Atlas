/**
 * Retirement + orphan compaction (Task 3.2, retrieval-index-contract §3 steps 6
 * and the reconcile sweep). These are **independently retryable** LanceDB
 * deletes that never touch the SQLite fence — retrieval already filters by the
 * note's `active_generation_id`, so a superseded/orphaned chunk is invisible to
 * queries the moment a newer generation activates; retirement only reclaims its
 * storage. A crash mid-retire leaves the prior generation harmlessly
 * present-but-inactive, cleaned on the next reconcile (§3).
 *
 * D14: LanceDB + `./schema.js`/`./generation.js` types only; no `apps/cli` import.
 */
import type { GenerationId } from "./generation.js";
import { sqlQuote, type SearchTable } from "./writer.js";

/**
 * Retire a note's superseded generations (§3 step 6): delete every chunk for
 * `noteId` whose `generationId` differs from the now-active `activeGen`. Runs
 * after a successful CAS activation; idempotent (a second run deletes nothing).
 * Returns the number of rows removed.
 */
export async function retireSupersededGenerations(
  table: SearchTable,
  noteId: string,
  activeGen: GenerationId,
): Promise<number> {
  const predicate = `noteId = ${sqlQuote(noteId)} AND generationId <> ${sqlQuote(activeGen)}`;
  const before = await table.countRows(predicate);
  if (before === 0) return 0;
  await table.delete(predicate);
  return before;
}

/**
 * Compact orphaned/mixed generations across the whole index (reconcile sweep):
 * delete every chunk whose `generationId` is NOT one of the currently-active
 * generation ids. Because a `generationId` encodes its `noteId`, "not active"
 * uniquely captures both superseded generations of a live note AND chunks left
 * behind by a removed note — either way retrieval never served them (the
 * `active_generation_id` join fenced them out); this reclaims their storage.
 *
 * `activeGenerationIds` is the SQLite-authoritative live set (from
 * `GenerationRepo.activeGenerationIds()`). An empty set means nothing is active,
 * so every row is orphaned and removed. Returns the number of rows removed.
 */
export async function compactOrphans(
  table: SearchTable,
  activeGenerationIds: readonly string[],
): Promise<number> {
  const predicate =
    activeGenerationIds.length === 0
      ? "true"
      : `generationId NOT IN (${activeGenerationIds.map(sqlQuote).join(", ")})`;
  const before = await table.countRows(predicate);
  if (before === 0) return 0;
  await table.delete(predicate);
  return before;
}
