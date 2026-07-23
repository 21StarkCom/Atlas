/**
 * `fold-notes-v2` — the v2 reconciling projection fold (#329 round-3, wing finding 1).
 *
 * {@link foldNotesForPaths} reconciles ONLY the `notes` table, which is correct for the
 * absorb-cycle it was written for but WRONG for the v2 `sync` command: a note whose
 * identity (its path-derived slug, its aliases) or whose outgoing `[[wiki-link]]`s changed
 * would advance the `notes.content_hash` cursor while leaving `note_identity_keys` /
 * `note_links` stale — and because the content hash IS the cursor, the next sync sees an
 * unchanged tree and can NEVER repair the drift. A new note would get NO identity keys at
 * all (unresolvable by slug/alias); a filename rename would update `notes.slug` while
 * retaining the OLD slug identity key.
 *
 * {@link foldNotesV2} closes that: for each folded id it reconciles the `notes` row
 * (shared {@link deriveAndPersistNote} rule), REPLACES the note's `note_identity_keys`
 * (slug + deduped aliases, slug wins), and REPLACES ALL its OUTGOING `note_links`
 * (`source_note_id = id`) — both plain links (body `[[wiki-link]]`s, `predicate` NULL) and
 * typed relationships (frontmatter `related`, `predicate` set) — all in ONE transaction, so
 * the cursor advances only against a fully-reconciled projection. Both link kinds are
 * markdown-DERIVED and rebuildable (v2 model A, #331) — nothing is projection-authored.
 * Deletes-then-inserts the whole affected namespace in TWO sub-passes (all deletes, then all
 * inserts) so a pure namespace transfer — e.g. swapping two filenames — cannot collide on a
 * still-present PK row. Incoming links (other notes → this note) are untouched; the
 * dropped-note purge owns full removal (both link directions).
 *
 * ## Link-target resolution + broken-link tolerance
 * Outgoing links are resolved in a SECOND pass, after every folded note's identity keys are
 * current, so a link to another note in the SAME fold batch (e.g. two new notes that cite
 * each other) resolves. A target that resolves to no note is SKIPPED — not a hard error:
 * `sync` treats a dangling/`broken-link` wiki-link as a non-structural advisory (it never
 * halts the cycle on one), so the fold must not either. This diverges from the strict
 * whole-vault {@link rebuildProjections}, which rejects a dangling link — the incremental
 * fold has no whole-vault view to prove a target is *globally* absent, only locally.
 *
 * ## Identity collisions still fail closed
 * `note_identity_keys` uses a plain INSERT (dictionary §2): a `normalized_key` claimed by
 * two notes surfaces as a uniqueness failure that rolls the whole fold (and its caller's
 * enclosing transaction) back — the cursor never advances against an ambiguous identity.
 */
import { normalizeIdentityKey, type ParsedNote } from "@atlas/contracts";
import type { SqliteDatabase } from "./connection.js";
import type { Store } from "./store.js";
import { deriveAndPersistNote } from "./note-derivation.js";
import { IDENTITY_NORMALIZER_VERSION, noteIdentityKeys } from "./rebuild.js";
import { ProjectionRepo } from "./repos/projections.js";
import { replaceNoteEvidence } from "./evidence/fold.js";

/** Resolve a wiki-link target (raw note_id, slug, or alias) against the CURRENT projection. */
function resolveLinkTarget(db: SqliteDatabase, raw: string): string | undefined {
  const asId = db.prepare(`SELECT note_id FROM notes WHERE note_id = ?`).get(raw) as
    | { note_id: string }
    | undefined;
  if (asId !== undefined) return asId.note_id;
  const key = normalizeIdentityKey(raw);
  const row = db.prepare(`SELECT note_id FROM note_identity_keys WHERE normalized_key = ?`).get(key) as
    | { note_id: string }
    | undefined;
  return row?.note_id;
}

/**
 * Reconcile the FULL vault projection (`notes` + `note_identity_keys` + outgoing
 * `note_links`) for `noteIds` only, in one transaction. For each id, `resolve` yields the
 * parsed note at the target ref (active-upsert) or `null` (archive — the row is marked
 * archived and its identity keys + outgoing links are removed). Duplicate ids collapse; an
 * empty id list is a no-op (no transaction). Nests safely inside a caller's transaction
 * (better-sqlite3 uses a savepoint), so `sync` can fold + activate atomically.
 */
export function foldNotesV2(
  store: Store,
  noteIds: string[],
  resolve: (noteId: string) => ParsedNote | null,
): void {
  const ids = [...new Set(noteIds.map(String))];
  if (ids.length === 0) return;
  const repo = new ProjectionRepo(store.db);
  const delKeys = store.db.prepare(`DELETE FROM note_identity_keys WHERE note_id = ?`);
  // Replace ALL outgoing links (plain AND typed). v2 model A (#331): a typed
  // relationship (non-null predicate) is DERIVED from the note's frontmatter
  // `related` list (ParsedNote.relationships), exactly as a plain link is derived
  // from a body `[[wiki-link]]` — both are markdown-authored and rebuildable, so
  // both are re-derived here from the (re-)parsed note. Incoming links (other
  // notes → this note) are untouched; the dropped-note purge owns full removal.
  const delOutLinks = store.db.prepare(`DELETE FROM note_links WHERE source_note_id = ?`);

  // Resolve each id ONCE (resolve() shells git per call — avoid re-reading it per pass).
  const parsedById = new Map<string, ParsedNote | null>();
  for (const id of ids) parsedById.set(id, resolve(id));

  const neutralizeSlug = store.db.prepare(`UPDATE notes SET slug = note_id WHERE note_id = ?`);

  const run = store.db.transaction(() => {
    // Pass 1a — clear the whole affected namespace FIRST, across ALL ids, before any
    // insert/derive sets a final value. A per-id delete-then-insert (the previous shape)
    // makes a pure namespace TRANSFER collide mid-loop: swapping a.md↔b.md, setting a's new
    // slug (== b's old slug) hits b's still-present row and fails deterministically on every
    // retry (round-3 finding 2). Two collision surfaces are neutralized up front:
    //   (i) `notes.slug` is NOT NULL UNIQUE — reset every affected EXISTING row's slug to
    //       its own note_id (the PK, globally unique ⇒ never collides), so deriveAndPersistNote
    //       can then set each final slug without hitting a sibling's not-yet-updated row;
    //   (ii) `note_identity_keys` + plain `note_links` — delete every affected owner's rows.
    for (const id of ids) neutralizeSlug.run(id);
    for (const id of ids) {
      const parsed = parsedById.get(id) ?? null;
      deriveAndPersistNote(store.db, id, parsed);
      delKeys.run(id);
      delOutLinks.run(id);
      // Evidence is a vault-derived projection (task 4-4): re-fold this note's
      // evidence rows from its frontmatter in the same reconciling transaction
      // (self-guarded no-op when 0014 is unapplied). A resolved note replaces its
      // rows; an archived (parsed === null) note has them dropped.
      replaceNoteEvidence(store.db, id, parsed);
    }

    // Pass 1b — INSERT the complete final identity namespace, now that no stale key from any
    // affected owner remains. A `normalized_key` still claimed by TWO surviving notes is a
    // genuine collision: the plain INSERT's uniqueness failure rolls the whole fold back
    // (the cursor never advances against an ambiguous identity).
    for (const id of ids) {
      const parsed = parsedById.get(id) ?? null;
      if (parsed === null) continue; // archived: keys + plain links dropped; incoming + typed left intact
      const keys = noteIdentityKeys(parsed); // slug first, then deduped aliases
      keys.forEach((key, i) => {
        repo.insertIdentityKey({
          normalized_key: key,
          note_id: id,
          kind: i === 0 ? "slug" : "alias",
          normalizer_version: IDENTITY_NORMALIZER_VERSION,
        });
      });
    }

    // Pass 2: outgoing links, resolved against the now-current identity namespace so a
    // link to another note in this same batch resolves. A dangling target is a tolerated
    // advisory (see module header) — skip it rather than throwing. Plain links (predicate
    // NULL) come from the body `[[wiki-link]]`s; typed relationships (predicate set) come
    // from the frontmatter `related` list — both markdown-derived (v2 model A, #331).
    for (const id of ids) {
      const parsed = parsedById.get(id) ?? null;
      if (parsed === null) continue;
      for (const link of parsed.links) {
        const target = resolveLinkTarget(store.db, link.target);
        if (target === undefined) continue;
        repo.insertLink({
          source_note_id: id,
          target_note_id: target,
          predicate: null,
          alias: link.alias ?? null,
        });
      }
      for (const rel of parsed.relationships ?? []) {
        const target = resolveLinkTarget(store.db, rel.target);
        if (target === undefined) continue;
        repo.insertLink({
          source_note_id: id,
          target_note_id: target,
          predicate: rel.predicate,
          alias: rel.alias ?? null,
        });
      }
    }
  });
  run();
}
