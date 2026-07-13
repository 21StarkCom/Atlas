/**
 * `repos/projections` — typed access to the four **vault-projection** tables
 * owned by `0001_core`: `notes`, `note_identity_keys`, `note_links`,
 * `vault_schema_migrations` (dictionary §2). These are deterministically
 * rebuildable from canonical Markdown; {@link ProjectionRepo.clearAll} +
 * the insert helpers are the primitives `rebuildProjections` composes inside
 * one transaction.
 *
 * Identity keys use a plain `INSERT` (not upsert): a `normalized_key` that would
 * map to two `note_id`s is an **ambiguity error** the dictionary requires be
 * caught before commit (§2 `note_identity_keys`), and a plain insert surfaces it
 * as a uniqueness failure that rolls the rebuild transaction back.
 */
import type { SqliteDatabase } from "../connection.js";

/** A row of the `notes` projection (all columns, verbatim names). */
export interface NoteRow {
  readonly note_id: string;
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly schema_version: number;
  readonly status: string;
  readonly file_path: string;
  readonly content_hash: string;
  readonly created: string;
  readonly updated: string;
}

/** A row of `note_identity_keys`. */
export interface IdentityKeyRow {
  readonly normalized_key: string;
  readonly note_id: string;
  readonly kind: "slug" | "alias";
  readonly normalizer_version: number;
}

/** A row of `note_links`. */
export interface NoteLinkRow {
  readonly source_note_id: string;
  readonly target_note_id: string;
  readonly predicate: string;
  readonly ordinal: number;
}

/** A row of `vault_schema_migrations`. */
export interface VaultSchemaMigrationRow {
  readonly schema_version: number;
  readonly applied_at: string;
  readonly note_count: number;
}

export class ProjectionRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Delete every projection row. `notes` cascades to `note_identity_keys` and
   * `note_links` (both `ON DELETE CASCADE`), but we delete children explicitly
   * first so the operation is order-independent of the FK pragma state.
   */
  clearAll(): void {
    this.db.exec(`DELETE FROM note_links;
      DELETE FROM note_identity_keys;
      DELETE FROM notes;
      DELETE FROM vault_schema_migrations;`);
  }

  insertNote(row: NoteRow): void {
    this.db
      .prepare(
        `INSERT INTO notes
          (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
         VALUES
          (@note_id, @slug, @title, @type, @schema_version, @status, @file_path, @content_hash, @created, @updated)`,
      )
      .run(row);
  }

  /** Plain insert — a duplicate `normalized_key` is an ambiguity error (design). */
  insertIdentityKey(row: IdentityKeyRow): void {
    this.db
      .prepare(
        `INSERT INTO note_identity_keys (normalized_key, note_id, kind, normalizer_version)
         VALUES (@normalized_key, @note_id, @kind, @normalizer_version)`,
      )
      .run(row);
  }

  insertLink(row: NoteLinkRow): void {
    this.db
      .prepare(
        `INSERT INTO note_links (source_note_id, target_note_id, predicate, ordinal)
         VALUES (@source_note_id, @target_note_id, @predicate, @ordinal)
         ON CONFLICT(source_note_id, target_note_id, predicate) DO UPDATE SET ordinal = excluded.ordinal`,
      )
      .run(row);
  }

  insertSchemaMigration(row: VaultSchemaMigrationRow): void {
    this.db
      .prepare(
        `INSERT INTO vault_schema_migrations (schema_version, applied_at, note_count)
         VALUES (@schema_version, @applied_at, @note_count)
         ON CONFLICT(schema_version) DO UPDATE SET applied_at = excluded.applied_at, note_count = excluded.note_count`,
      )
      .run(row);
  }

  countNotes(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM notes`).get() as { c: number }).c;
  }

  getNote(noteId: string): NoteRow | undefined {
    return this.db.prepare(`SELECT * FROM notes WHERE note_id = ?`).get(noteId) as
      | NoteRow
      | undefined;
  }

  allNotes(): NoteRow[] {
    return this.db.prepare(`SELECT * FROM notes ORDER BY note_id`).all() as NoteRow[];
  }
}
