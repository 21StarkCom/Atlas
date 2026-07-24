/**
 * `fold-notes-for-paths` — the incremental `notes`-projection fold (60-B Task 2.2).
 *
 * The full {@link rebuildProjections} clears and re-derives the whole projection
 * from a `VaultSnapshot`; `foldNotesForPaths` reconciles the `notes` rows for ONLY
 * the given note ids — the O(delta) projection update a `brain sync` cycle needs
 * after absorbing a handful of changed notes. It shares the SAME derivation rule
 * ({@link deriveAndPersistNote}) as rebuild, so a note present in the canonical
 * tree ends up byte-identical either way (pinned by `fold-rebuild-parity.test.ts`).
 *
 * **The caller supplies the resolver.** `resolve(noteId)` reads the note's blob at
 * the target ref and parses it into a `ParsedNote`, or returns `null` when the note
 * no longer resolves (deleted/renamed-away). Keeping git access *and* parsing on
 * the CLI side is what lets `@atlas/sqlite-store` stay a leaf with no `Repo` and no
 * parser dependency (D14) — the store only ever sees an already-parsed note.
 *
 * Scope: only the `notes` table. `note_identity_keys`/`note_links` are deliberately
 * out of scope for the incremental fold. The whole fold runs in ONE transaction so
 * a crash leaves an all-or-nothing state; it is idempotent for both the active
 * (re-derive identical row) and archived (`status='archived'` again) cases.
 */
import type { ParsedNote } from "@atlas/contracts";
import type { Store } from "./store.js";
import { deriveAndPersistNote } from "./note-derivation.js";
import { replaceNoteEvidence } from "./evidence/fold.js";

/**
 * Reconcile the `notes` projection for `noteIds` only. For each id, `resolve`
 * yields the parsed note at the target ref (active-upsert) or `null` (archive).
 * Duplicate ids collapse; an empty id list is a no-op (no transaction).
 */
export function foldNotesForPaths(
  store: Store,
  noteIds: string[],
  resolve: (noteId: string) => ParsedNote | null,
): void {
  const ids = [...new Set(noteIds.map(String))];
  if (ids.length === 0) return;
  const run = store.db.transaction(() => {
    for (const id of ids) {
      const parsed = resolve(id);
      deriveAndPersistNote(store.db, id, parsed);
      // Evidence is a vault-derived projection (task 4-4): re-fold this note's
      // evidence rows from its frontmatter in the same transaction (self-guarded
      // no-op when 0014 is unapplied).
      replaceNoteEvidence(store.db, id, parsed);
    }
  });
  run();
}
