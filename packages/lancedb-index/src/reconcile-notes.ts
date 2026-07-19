/**
 * `indexNotes` — the note-SCOPED reconcile (60-B Task 2.3), the O(delta) analog of
 * {@link reconcileIndex}. Where `reconcileIndex` walks the whole corpus and compacts
 * globally, `indexNotes` touches ONLY the notes it is handed: it re-embeds the ones
 * that drifted (via the exact same fenced {@link indexNote} pipeline), leaves current
 * ones untouched via the fast path (no embed spend), and drops the chunks of ones
 * that no longer resolve. It NEVER drops the table and NEVER touches a note outside
 * its payload — the property a per-sync-cycle reindex needs.
 *
 * `deps.notes` is the SAME `ParsedNote` provider {@link reconcileIndex} consumes,
 * scoped by the caller to (a superset of) `noteIds`: a requested id present in the
 * provided notes is re-embedded/kept; a requested id ABSENT from them is treated as
 * removed (archived/deleted) and has its chunks dropped. Re-embedding needs the note
 * body, so the caller supplies parsed notes — a bare fence cannot be re-embedded.
 *
 * Shares `reconcileIndex`'s lock threading ({@link withReconcileLock}) and the fenced
 * {@link indexNote} pipeline verbatim (DRY) — one shared lock across every per-note
 * critical section, `adoptConfig` once per pass, SQLite the sole activation authority.
 *
 * D14: consumes `@atlas/contracts` DTOs + LanceDB only; the SQLite authority and the
 * embedder arrive as the injected structural interfaces on {@link IndexDeps}.
 */
import { indexNote, removeNoteChunks, withReconcileLock, type IndexDeps } from "./activate.js";
import { indexingConfigKey } from "./generation.js";

/** The per-note disposition a scoped reconcile records. */
export type ReconcileKind = "reembedded" | "unchanged" | "removed";

/**
 * Aggregate tally of a {@link indexNotes} pass. Invariant:
 * `scanned === reembedded + unchanged + removed` (every requested, de-duplicated id
 * lands in exactly one bucket).
 */
export interface ReconcileReport {
  /** Distinct note ids examined (post-dedup). */
  scanned: number;
  /** Notes whose drifted/missing generation was (re)written and activated. */
  reembedded: number;
  /** Notes already current on the fast path — no embed spend. */
  unchanged: number;
  /** Notes that no longer resolve — their chunks were dropped. */
  removed: number;
  /** Per-note disposition, in input (deduplicated) order. */
  results: Array<{ noteId: string; kind: ReconcileKind }>;
}

/**
 * Reconcile ONLY `noteIds` to the current index config. Throws on an empty id list
 * (a caller error — the sync layer only enqueues a reconcile for a non-empty change
 * set) and when `deps.notes` is absent. A requested id present in `deps.notes()` is
 * driven through {@link indexNote}; one absent is removed. Idempotent and crash-safe
 * per note (the underlying pipeline is), so a re-run converges.
 */
export async function indexNotes(deps: IndexDeps, noteIds: string[]): Promise<ReconcileReport> {
  const ids = [...new Set(noteIds.map(String))];
  if (ids.length === 0) throw new Error("indexNotes: noteIds must be non-empty");
  if (deps.notes === undefined) {
    throw new Error("indexNotes: deps.notes is required (the ParsedNotes for the requested ids)");
  }
  const notesProvider = deps.notes;
  const report: ReconcileReport = { scanned: 0, reembedded: 0, unchanged: 0, removed: 0, results: [] };

  return withReconcileLock(deps, async (lock, noteDeps) => {
    // Adopt the current config ONCE for the pass (idempotent) so the activation CAS
    // has a server-owned epoch to fence against — same as reconcileIndex.
    deps.store.adoptConfig(indexingConfigKey(deps.config));

    const notes = await notesProvider();
    const byId = new Map(notes.map((n) => [n.id, n]));

    for (const id of ids) {
      report.scanned++;
      const note = byId.get(id);
      if (note === undefined) {
        // Not in the payload's ParsedNotes ⇒ removed/deleted: drop its chunks so
        // retrieval serves nothing for it. The SQLite fence is the caller's concern.
        await removeNoteChunks(noteDeps, id, lock);
        report.removed++;
        report.results.push({ noteId: id, kind: "removed" });
        continue;
      }
      const outcome = await indexNote(note, noteDeps);
      switch (outcome.kind) {
        case "indexed":
          report.reembedded++;
          report.results.push({ noteId: id, kind: "reembedded" });
          break;
        case "unchanged":
        case "superseded":
          // `superseded`: a newer generation/config won the CAS — this pass changed
          // nothing, so it is not a re-embed. Report it as unchanged.
          report.unchanged++;
          report.results.push({ noteId: id, kind: "unchanged" });
          break;
        case "empty":
          // A prose-less note. Formerly-indexed ⇒ it was fenced-tombstoned and its
          // chunks retired (removed); never-indexed ⇒ nothing to do (unchanged).
          if (outcome.retiredChunks > 0) {
            report.removed++;
            report.results.push({ noteId: id, kind: "removed" });
          } else {
            report.unchanged++;
            report.results.push({ noteId: id, kind: "unchanged" });
          }
          break;
        case "embedding-failed":
        case "write-incomplete":
          // A real, actionable failure — surface it so the caller (the job runner)
          // classifies/retries rather than silently under-reporting the tally.
          throw new Error(
            `indexNotes: note ${id} did not converge (${outcome.kind})` +
              ("message" in outcome && outcome.message ? `: ${outcome.message}` : ""),
          );
      }
    }
    return report;
  });
}
