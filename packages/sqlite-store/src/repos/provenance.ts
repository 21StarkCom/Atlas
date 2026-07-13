/**
 * `repos/provenance` — typed access to the four **provenance projection** tables
 * owned by `0003_provenance`: `content_blobs`, `source_captures`,
 * `source_renditions`, `note_sources` (dictionary §5). Like `ProjectionRepo`,
 * these are the primitives {@link import("../provenance/fold.js").foldProvenanceManifests}
 * composes inside the rebuild transaction.
 *
 * Upsert conflict targets are copied verbatim from the dictionary §5:
 *  - `content_blobs`: `ON CONFLICT(raw_content_hash, canonical_media_type) DO NOTHING`
 *    for the immutable body; the active-rendition pointer is re-pointed by an
 *    explicit `UPDATE` ({@link ProvenanceRepo.setActiveRendition}), never the upsert.
 *  - `source_captures`: `DO UPDATE SET last_seen_at, observation_count = +1`.
 *  - `source_renditions`: `DO NOTHING` (immutable, deterministic re-extraction).
 *  - `note_sources`: `DO NOTHING` (via the coalesced-key `idx_note_sources_identity`).
 *
 * The `capture_id` surrogate is a deterministic sha256 of `(contentId, origin)`
 * (dictionary §5) — a scalar surrogate, never a foreign key.
 */
import { createHash } from "node:crypto";
import type { ContentId, RenditionId } from "@atlas/contracts";
import type { SqliteDatabase } from "../connection.js";

/** A row of the `content_blobs` projection (all columns, verbatim names). */
export interface ContentBlobRow {
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly size_bytes: number;
  readonly vault_path: string;
  readonly first_seen_at: string;
  readonly active_extractor_version: number | null;
  readonly active_normalizer_version: number | null;
}

/** A row of `source_captures`. */
export interface SourceCaptureRow {
  readonly capture_id: string;
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly origin: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly observation_count: number;
}

/** A row of `source_renditions`. */
export interface SourceRenditionRow {
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly extractor_version: number;
  readonly normalizer_version: number;
  readonly normalized_content_hash: string;
  readonly size_bytes: number;
  readonly locator_scheme: string;
  readonly created_at: string;
}

/** A row of `note_sources`. */
export interface NoteSourceRow {
  readonly note_id: string;
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly extractor_version: number | null;
  readonly normalizer_version: number | null;
}

/** The four component columns identifying a concrete rendition. */
export interface RenditionComponents {
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly extractor_version: number;
  readonly normalizer_version: number;
}

/**
 * Deterministic `source_captures.capture_id`: sha256 over the NUL-separated
 * `(contentId, origin)` tuple (dictionary §5). Stable across re-observation so a
 * repeat capture upserts the same row rather than inserting a duplicate.
 */
export function captureId(
  rawContentHash: string,
  canonicalMediaType: string,
  origin: string,
): string {
  return createHash("sha256")
    .update(`sha256:${rawContentHash}:${canonicalMediaType}`, "utf8")
    .update(Buffer.from([0]))
    .update(origin, "utf8")
    .digest("hex");
}

export class ProvenanceRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /** True if the `0003_provenance` tables exist (retained PR-A applied). */
  static isApplied(db: SqliteDatabase): boolean {
    return (
      db
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_blobs'`,
        )
        .get() !== undefined
    );
  }

  /** Delete every provenance projection row, children first (FK-safe order). */
  clearAll(): void {
    // Ordering that satisfies every FK immediately (SQLite enforces RESTRICT at
    // statement time even for the DEFERRABLE active-rendition FK):
    //  1. drop the active-rendition pointers so no `content_blobs` row still
    //     references a `source_renditions` row (RESTRICT parent → child);
    //  2. delete `note_sources` (RESTRICT children of blobs + renditions);
    //  3. delete captures + renditions (now unreferenced);
    //  4. delete the blobs.
    this.db.exec(`UPDATE content_blobs
        SET active_extractor_version = NULL, active_normalizer_version = NULL;
      DELETE FROM note_sources;
      DELETE FROM source_captures;
      DELETE FROM source_renditions;
      DELETE FROM content_blobs;`);
  }

  /**
   * Insert the immutable blob body if absent (`DO NOTHING`). The active-rendition
   * pointer is NEVER set here — it is re-pointed by {@link setActiveRendition}
   * once the target rendition exists (dictionary §5 two-step protocol).
   */
  upsertBlob(row: {
    raw_content_hash: string;
    canonical_media_type: string;
    size_bytes: number;
    vault_path: string;
    first_seen_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO content_blobs
          (raw_content_hash, canonical_media_type, size_bytes, vault_path, first_seen_at,
           active_extractor_version, active_normalizer_version)
         VALUES
          (@raw_content_hash, @canonical_media_type, @size_bytes, @vault_path, @first_seen_at, NULL, NULL)
         ON CONFLICT(raw_content_hash, canonical_media_type) DO NOTHING`,
      )
      .run(row);
  }

  /**
   * Record an origin observation: insert the capture aggregate or, on a repeat
   * `(contentId, origin)`, bump `last_seen_at` + `observation_count` (dictionary
   * §5 upsert). `capture_id` is derived deterministically from the components.
   */
  recordCapture(row: {
    raw_content_hash: string;
    canonical_media_type: string;
    origin: string;
    first_seen_at: string;
    last_seen_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO source_captures
          (capture_id, raw_content_hash, canonical_media_type, origin, first_seen_at, last_seen_at, observation_count)
         VALUES
          (@capture_id, @raw_content_hash, @canonical_media_type, @origin, @first_seen_at, @last_seen_at, 1)
         ON CONFLICT(raw_content_hash, canonical_media_type, origin) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           observation_count = source_captures.observation_count + 1`,
      )
      .run({
        capture_id: captureId(row.raw_content_hash, row.canonical_media_type, row.origin),
        ...row,
      });
  }

  /** Insert an immutable rendition if absent (`DO NOTHING` — deterministic output). */
  recordRendition(row: SourceRenditionRow): void {
    this.db
      .prepare(
        `INSERT INTO source_renditions
          (raw_content_hash, canonical_media_type, extractor_version, normalizer_version,
           normalized_content_hash, size_bytes, locator_scheme, created_at)
         VALUES
          (@raw_content_hash, @canonical_media_type, @extractor_version, @normalizer_version,
           @normalized_content_hash, @size_bytes, @locator_scheme, @created_at)
         ON CONFLICT(raw_content_hash, canonical_media_type, extractor_version, normalizer_version) DO NOTHING`,
      )
      .run(row);
  }

  /**
   * Re-point a blob's active rendition to the given component pair (dictionary
   * §5 rendition-upgrade protocol). The pair must name an existing rendition of
   * the same blob; the deferred composite FK enforces that at commit.
   */
  setActiveRendition(c: RenditionComponents): void {
    const res = this.db
      .prepare(
        `UPDATE content_blobs
            SET active_extractor_version = @extractor_version,
                active_normalizer_version = @normalizer_version
          WHERE raw_content_hash = @raw_content_hash
            AND canonical_media_type = @canonical_media_type`,
      )
      .run(c);
    if (res.changes === 0) {
      throw new Error(
        `setActiveRendition: no content blob ${c.raw_content_hash}:${c.canonical_media_type}`,
      );
    }
  }

  /**
   * Insert a note-level provenance citation (dictionary §5 `note_sources`).
   * A blob-general citation leaves both version components `NULL`; a
   * rendition-specific citation carries both (`≥ 1`). Idempotent via the
   * coalesced-key unique index.
   */
  insertNoteSource(row: NoteSourceRow): void {
    this.db
      .prepare(
        `INSERT INTO note_sources
          (note_id, raw_content_hash, canonical_media_type, extractor_version, normalizer_version)
         VALUES
          (@note_id, @raw_content_hash, @canonical_media_type, @extractor_version, @normalizer_version)
         ON CONFLICT(note_id, raw_content_hash, canonical_media_type,
                     COALESCE(extractor_version, 0), COALESCE(normalizer_version, 0)) DO NOTHING`,
      )
      .run(row);
  }

  /**
   * Resolve a parsed source handle (D3) to the FULL {@link SourceRenditionRow} it
   * names. A `RenditionId` resolves to that rendition directly; a `ContentId`
   * resolves via the blob's **active** rendition pointer (dictionary §5 / ids.ts
   * `ContentId` doc). Returns `null` when the handle names no stored rendition
   * (e.g. a `contentId` whose blob has no active rendition yet, or an unknown
   * blob/rendition).
   *
   * The parameter is the typed union `ContentId | RenditionId` (the binding
   * interface, plan §2.1) — parsing a serialized string into that union lives in
   * `@atlas/contracts` `parseSourceHandle`, never here.
   */
  resolveSourceHandle(handle: ContentId | RenditionId): SourceRenditionRow | null {
    const selectRendition = (
      rawContentHash: string,
      canonicalMediaType: string,
      extractorVersion: number,
      normalizerVersion: number,
    ): SourceRenditionRow | null =>
      (this.db
        .prepare(
          `SELECT raw_content_hash, canonical_media_type, extractor_version, normalizer_version,
                  normalized_content_hash, size_bytes, locator_scheme, created_at
             FROM source_renditions
            WHERE raw_content_hash = ? AND canonical_media_type = ?
              AND extractor_version = ? AND normalizer_version = ?`,
        )
        .get(rawContentHash, canonicalMediaType, extractorVersion, normalizerVersion) as
        | SourceRenditionRow
        | undefined) ?? null;

    if (handle.kind === "rendition") {
      return selectRendition(
        handle.rawContentHash,
        handle.canonicalMediaType,
        handle.extractorVersion,
        handle.normalizerVersion,
      );
    }
    // contentId → follow the blob's active-rendition pointer to the full row.
    const blob = this.db
      .prepare(
        `SELECT active_extractor_version AS e, active_normalizer_version AS n
           FROM content_blobs
          WHERE raw_content_hash = ? AND canonical_media_type = ?`,
      )
      .get(handle.rawContentHash, handle.canonicalMediaType) as
      | { e: number | null; n: number | null }
      | undefined;
    if (!blob || blob.e === null || blob.n === null) return null;
    return selectRendition(handle.rawContentHash, handle.canonicalMediaType, blob.e, blob.n);
  }

  // --- read helpers (tests + `db verify`/fold assertions) -------------------

  allBlobs(): ContentBlobRow[] {
    return this.db
      .prepare(`SELECT * FROM content_blobs ORDER BY raw_content_hash, canonical_media_type`)
      .all() as ContentBlobRow[];
  }

  allCaptures(): SourceCaptureRow[] {
    return this.db
      .prepare(`SELECT * FROM source_captures ORDER BY capture_id`)
      .all() as SourceCaptureRow[];
  }

  allRenditions(): SourceRenditionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM source_renditions
          ORDER BY raw_content_hash, canonical_media_type, extractor_version, normalizer_version`,
      )
      .all() as SourceRenditionRow[];
  }

  allNoteSources(): NoteSourceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM note_sources
          ORDER BY note_id, raw_content_hash, canonical_media_type,
                   COALESCE(extractor_version, 0), COALESCE(normalizer_version, 0)`,
      )
      .all() as NoteSourceRow[];
  }
}
