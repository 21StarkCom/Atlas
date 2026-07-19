/**
 * `note-derivation` — the ONE per-note `notes`-projection derivation primitive,
 * shared by the full rebuild loop ({@link rebuildProjections}) and the incremental
 * {@link foldNotesForPaths} (60-B Task 2.2). Having a single rule means the two
 * paths can never fork the projection derivation — the `fold-rebuild-parity` test
 * pins byte-identical `notes` rows for a note present in the canonical snapshot.
 *
 * Every persisted column is PROJECTED from canonical Markdown via the
 * `@atlas/contracts` `ParsedNote` DTO — `title`/`type`/`schema_version`/`status`/
 * `created`/`updated` are authoritative frontmatter values (dictionary §0), and
 * only `slug` is derived from the vault-relative path. **Parsing stays CLI-side:**
 * this primitive takes an already-parsed `ParsedNote` (or `null`), so the store
 * package gains no parser and no `apps/cli` dependency (D14).
 *
 * The generation-fence columns (`active_generation`, `active_generation_id`) are
 * NEVER written here: they are activation state owned solely by
 * `activateGeneration`/`tombstoneGeneration` (retrieval-index-contract §2). A
 * content change leaves the fence pointing at the note's old generation — exactly
 * the normal `stale` state the next reconcile re-embeds (#212).
 */
import type { ParsedNote } from "@atlas/contracts";
import type { SqliteDatabase } from "./connection.js";
import { deriveSlug } from "./rebuild.js";

/**
 * Persist ONE note's `notes` projection row from its `ParsedNote`, or archive it
 * when the note no longer resolves at the target ref (`parsed === null`).
 *
 * - **`parsed !== null` (active-upsert):** insert-or-update every projected column
 *   for `noteId`. On a fresh table (rebuild, post-`clearAll`) this is a plain
 *   insert; on an existing row (incremental fold of a modified/re-added note) the
 *   `ON CONFLICT(note_id)` clause updates the projected columns in place. The
 *   fence columns are untouched (see module header).
 * - **`parsed === null` (archive):** set `status = 'archived'`, leaving
 *   `content_hash` and the fence columns intact so a later re-add re-derives them.
 *   Non-destructive and reversible — the row and its history are retained (a real
 *   vault delete is `ProposeArchive`, never an erase). A no-op if no such row.
 *
 * Only the `notes` table is touched — `note_identity_keys` and `note_links` are
 * the caller's concern (the rebuild loop owns them; the incremental fold is scoped
 * to `notes` by design).
 */
export function deriveAndPersistNote(
  db: SqliteDatabase,
  noteId: string,
  parsed: ParsedNote | null,
): void {
  if (parsed === null) {
    db.prepare(`UPDATE notes SET status = 'archived' WHERE note_id = ?`).run(noteId);
    return;
  }
  db.prepare(
    `INSERT INTO notes
       (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
     VALUES
       (@note_id, @slug, @title, @type, @schema_version, @status, @file_path, @content_hash, @created, @updated)
     ON CONFLICT(note_id) DO UPDATE SET
       slug           = excluded.slug,
       title          = excluded.title,
       type           = excluded.type,
       schema_version = excluded.schema_version,
       status         = excluded.status,
       file_path      = excluded.file_path,
       content_hash   = excluded.content_hash,
       created        = excluded.created,
       updated        = excluded.updated`,
  ).run({
    note_id: noteId,
    slug: deriveSlug(parsed.path),
    title: parsed.title,
    type: parsed.type,
    schema_version: parsed.schemaVersion,
    status: parsed.status,
    file_path: parsed.path,
    content_hash: parsed.contentHash,
    created: parsed.created,
    updated: parsed.updated,
  });
}
