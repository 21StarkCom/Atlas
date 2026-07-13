/**
 * `provenance/fold` — `foldProvenanceManifests(snapshot, tx)`: the retained-PR-A
 * rebuild reader that reconstructs ALL four provenance projections
 * (`content_blobs`, `source_captures`, `source_renditions`, `note_sources`) from
 * the canonical Markdown manifests in a `VaultSnapshot` (dictionary §5 / §8).
 *
 * ## Why this is a fold over canonical Markdown
 * Retained PR-A discipline (plan §1, fixes R4-F5/R3-F9): a feature revert must
 * never orphan provenance projections. Because the vault Markdown is the system
 * of record, `db rebuild` reproduces every provenance row from the manifests
 * alone — so a source-heavy vault rebuilds its provenance with ONLY `0003`
 * applied, no feature code present. This function is registered into
 * {@link import("../rebuild.js").rebuildProjections} and runs inside its
 * transaction (the "`tx`" of the signature is the transaction-scoped `db`).
 *
 * ## Fail-closed rebuild (fixes wing R2-F3)
 * The fold NEVER commits a partial projection. It runs after `clearAll()` inside
 * the rebuild transaction, so any thrown error rolls the whole rebuild back and
 * leaves the PRE-EXISTING provenance projection intact (dictionary §8). Every
 * malformed manifest, invalid content id, or dangling source reference is a
 * TYPED throw ({@link MalformedManifestError} / {@link DanglingSourceError}),
 * never a silent skip — silently skipping could erase previously valid rows and
 * commit an incorrect projection.
 *
 * ## The normative manifest format (source-note frontmatter)
 * A note is a **source manifest** iff its frontmatter carries a `contentId`
 * (a serialized `ContentId`, `sha256:<64hex>:<mediaType>`). A source manifest
 * MUST additionally carry a `provenance:` block naming the immutable raw source
 * (`vault_path`) and its byte size (`size_bytes`) — these identify the immutable
 * raw blob and are NOT fabricated. Optional pieces (captures, renditions, an
 * active-rendition pointer) refine the projection:
 *
 * ```yaml
 * contentId: "sha256:<64hex>:text/plain"
 * origin: notes/wcag.txt                 # shorthand for a single capture
 * provenance:
 *   vault_path: sources/foo.txt          # REQUIRED — the immutable raw source
 *   size_bytes: 1234                      # REQUIRED — raw blob byte length
 *   first_seen_at: 2026-07-11T00:00:00Z  # optional; defaults to the note's `created`
 *   captures:                            # optional; overrides the `origin` shorthand
 *     - origin: notes/wcag.txt
 *       first_seen_at: ...
 *       last_seen_at: ...
 *       observation_count: 2
 *   renditions:
 *     - extractor_version: 1
 *       normalizer_version: 1
 *       normalized_content_hash: "<64hex>"
 *       size_bytes: 1000
 *       locator_scheme: char
 *       created_at: ...
 *   active_rendition: { extractor_version: 1, normalizer_version: 1 }
 * ```
 *
 * ## The derived active-rendition pointer (plan Review-Hint)
 * The active rendition is the **component column pair** (`active_extractor_version`,
 * `active_normalizer_version`) — never a packed string. When the manifest names
 * an explicit `active_rendition`, that wins (and MUST name a listed rendition);
 * otherwise, if the manifest lists any renditions, the pointer is **derived** as
 * the highest `(extractor_version, normalizer_version)` rendition present. With
 * no renditions the pointer stays `NULL` (blob captured, nothing extracted yet).
 *
 * ## `note_sources` citations
 * Any note whose frontmatter lists `sources: [...]` produces `note_sources`
 * rows. A source entry is resolved as either a serialized handle
 * (`sha256:…` → rendition-specific when 5-segment, blob-general when 3-segment)
 * or a manifest note-id (resolved to that manifest's `contentId` → blob-general
 * citation). Every entry MUST resolve to a blob/rendition reconstructed in this
 * fold; a dangling reference is a {@link DanglingSourceError} that rolls back.
 */
import { parse as parseYaml } from "yaml";
import { parseSourceHandle, type VaultSnapshot } from "@atlas/contracts";
import type { SqliteDatabase } from "../connection.js";
import { ProvenanceRepo, captureId } from "../repos/provenance.js";
import { registerProjectionFold } from "../rebuild.js";

/**
 * Raised when a note declares a `contentId` (i.e. it IS a source manifest) but
 * the manifest is malformed: an invalid `contentId`, a missing/invalid required
 * `provenance` field, or a malformed capture/rendition/active-rendition entry.
 * Thrown inside the rebuild transaction so it rolls back (fail-closed).
 */
export class MalformedManifestError extends Error {
  constructor(readonly notePath: string, readonly reason: string) {
    super(`malformed source manifest \`${notePath}\`: ${reason} — rolling back rebuild`);
    this.name = "MalformedManifestError";
  }
}

/**
 * Raised when a note's `sources: [...]` entry resolves to no blob/rendition
 * reconstructed by this fold (an unknown note-id, an unparseable handle, or a
 * handle naming a blob/rendition absent from the manifests). Thrown inside the
 * rebuild transaction so it rolls back (dictionary §2: dangling references are
 * rejected before commit).
 */
export class DanglingSourceError extends Error {
  constructor(readonly sourceNoteId: string, readonly reference: string, readonly reason: string) {
    super(
      `dangling source reference from \`${sourceNoteId}\`: "${reference}" ${reason} — ` +
        `rolling back rebuild`,
    );
    this.name = "DanglingSourceError";
  }
}

interface ManifestRendition {
  readonly extractor_version: number;
  readonly normalizer_version: number;
  readonly normalized_content_hash: string;
  readonly size_bytes: number;
  readonly locator_scheme: string;
  readonly created_at: string;
}

interface ManifestCapture {
  readonly origin: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly observation_count: number;
}

interface SourceManifest {
  readonly rawContentHash: string;
  readonly canonicalMediaType: string;
  readonly sizeBytes: number;
  readonly vaultPath: string;
  readonly firstSeenAt: string;
  readonly captures: readonly ManifestCapture[];
  readonly renditions: readonly ManifestRendition[];
  /** Explicit or derived active pointer; `null` when no rendition exists. */
  readonly active: { extractor_version: number; normalizer_version: number } | null;
}

/** Extract and YAML-parse the leading `---` frontmatter block of a note's raw text. */
function parseFrontmatter(raw: string): Record<string, unknown> | undefined {
  // Tolerate a leading BOM / whitespace, then require the `---` fence.
  const m = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(raw);
  if (!m) return undefined;
  try {
    const parsed = parseYaml(m[1]!) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return String(v);
  return undefined;
}

function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/**
 * Interpret one note's frontmatter as a source manifest, or `undefined` if it
 * carries no `contentId` (not a manifest). A note that DOES declare a
 * `contentId` is validated strictly: any malformed piece is a
 * {@link MalformedManifestError} (fail-closed), never a silent drop — the fold
 * reconstructs exactly what the canonical Markdown states or rejects the rebuild.
 */
function readManifest(
  fm: Record<string, unknown>,
  notePath: string,
  noteCreated: string,
): SourceManifest | undefined {
  const contentIdRaw = asString(fm.contentId);
  if (contentIdRaw === undefined) return undefined; // not a source manifest
  let handle;
  try {
    handle = parseSourceHandle(contentIdRaw);
  } catch (err) {
    throw new MalformedManifestError(
      notePath,
      `invalid contentId "${contentIdRaw}" (${(err as Error).message})`,
    );
  }
  if (handle.kind !== "content") {
    throw new MalformedManifestError(
      notePath,
      `contentId must be a blob handle (3-segment), got a rendition handle "${contentIdRaw}"`,
    );
  }
  const { rawContentHash, canonicalMediaType } = handle;

  // A source manifest MUST carry a `provenance` block with the immutable raw
  // source's `vault_path` + `size_bytes` (the normative format). These identify
  // the raw blob and are never fabricated (fixes wing R2-F2).
  if (!fm.provenance || typeof fm.provenance !== "object" || Array.isArray(fm.provenance)) {
    throw new MalformedManifestError(notePath, "missing required `provenance:` block");
  }
  const prov = fm.provenance as Record<string, unknown>;

  const sizeBytes = asInt(prov.size_bytes);
  if (sizeBytes === undefined || sizeBytes < 0) {
    throw new MalformedManifestError(
      notePath,
      "`provenance.size_bytes` must be a non-negative integer",
    );
  }
  const vaultPath = asString(prov.vault_path);
  if (vaultPath === undefined || vaultPath.length === 0) {
    throw new MalformedManifestError(
      notePath,
      "`provenance.vault_path` (immutable raw source path) is required",
    );
  }
  const firstSeenAt = asString(prov.first_seen_at) ?? noteCreated;

  // Captures: an explicit `provenance.captures` list wins; otherwise the
  // top-level `origin` shorthand yields a single observation.
  const captures: ManifestCapture[] = [];
  const capturesRaw = prov.captures;
  if (capturesRaw !== undefined) {
    if (!Array.isArray(capturesRaw)) {
      throw new MalformedManifestError(notePath, "`provenance.captures` must be a list");
    }
    for (const c of capturesRaw) {
      if (!c || typeof c !== "object") {
        throw new MalformedManifestError(notePath, "each `provenance.captures` entry must be a map");
      }
      const cc = c as Record<string, unknown>;
      const origin = asString(cc.origin);
      if (origin === undefined) {
        throw new MalformedManifestError(notePath, "a capture entry is missing `origin`");
      }
      const count = cc.observation_count === undefined ? 1 : asInt(cc.observation_count);
      if (count === undefined || count < 1) {
        throw new MalformedManifestError(
          notePath,
          `capture "${origin}" has an invalid observation_count`,
        );
      }
      const first = asString(cc.first_seen_at) ?? firstSeenAt;
      captures.push({
        origin,
        first_seen_at: first,
        last_seen_at: asString(cc.last_seen_at) ?? first,
        observation_count: count,
      });
    }
  } else {
    const origin = asString(fm.origin);
    if (origin !== undefined) {
      captures.push({
        origin,
        first_seen_at: firstSeenAt,
        last_seen_at: firstSeenAt,
        observation_count: 1,
      });
    }
  }

  // Renditions.
  const renditions: ManifestRendition[] = [];
  const rendRaw = prov.renditions;
  if (rendRaw !== undefined) {
    if (!Array.isArray(rendRaw)) {
      throw new MalformedManifestError(notePath, "`provenance.renditions` must be a list");
    }
    for (const r of rendRaw) {
      if (!r || typeof r !== "object") {
        throw new MalformedManifestError(notePath, "each `provenance.renditions` entry must be a map");
      }
      const rr = r as Record<string, unknown>;
      const ev = asInt(rr.extractor_version);
      const nv = asInt(rr.normalizer_version);
      const nch = asString(rr.normalized_content_hash);
      const sz = asInt(rr.size_bytes);
      const ls = asString(rr.locator_scheme);
      if (
        ev === undefined ||
        nv === undefined ||
        nch === undefined ||
        sz === undefined ||
        ls === undefined
      ) {
        throw new MalformedManifestError(
          notePath,
          "a rendition entry is missing a required field " +
            "(extractor_version, normalizer_version, normalized_content_hash, size_bytes, locator_scheme)",
        );
      }
      if (ev < 1 || nv < 1) {
        throw new MalformedManifestError(
          notePath,
          `rendition (${ev},${nv}) versions must be ≥ 1`,
        );
      }
      renditions.push({
        extractor_version: ev,
        normalizer_version: nv,
        normalized_content_hash: nch,
        size_bytes: sz,
        locator_scheme: ls,
        created_at: asString(rr.created_at) ?? firstSeenAt,
      });
    }
  }

  // Active-rendition pointer: explicit wins (and MUST name a listed rendition),
  // else derive the highest version pair.
  let active: { extractor_version: number; normalizer_version: number } | null = null;
  const activeRaw = prov.active_rendition;
  if (activeRaw !== undefined) {
    if (!activeRaw || typeof activeRaw !== "object" || Array.isArray(activeRaw)) {
      throw new MalformedManifestError(notePath, "`provenance.active_rendition` must be a map");
    }
    const ar = activeRaw as Record<string, unknown>;
    const ev = asInt(ar.extractor_version);
    const nv = asInt(ar.normalizer_version);
    if (ev === undefined || nv === undefined) {
      throw new MalformedManifestError(
        notePath,
        "`provenance.active_rendition` must carry integer extractor_version + normalizer_version",
      );
    }
    if (!renditions.some((r) => r.extractor_version === ev && r.normalizer_version === nv)) {
      throw new MalformedManifestError(
        notePath,
        `active_rendition (${ev},${nv}) names no listed rendition`,
      );
    }
    active = { extractor_version: ev, normalizer_version: nv };
  }
  if (active === null && renditions.length > 0) {
    const best = renditions.reduce((b, r) =>
      r.extractor_version > b.extractor_version ||
      (r.extractor_version === b.extractor_version && r.normalizer_version > b.normalizer_version)
        ? r
        : b,
    );
    active = { extractor_version: best.extractor_version, normalizer_version: best.normalizer_version };
  }

  return {
    rawContentHash,
    canonicalMediaType,
    sizeBytes,
    vaultPath,
    firstSeenAt,
    captures,
    renditions,
    active,
  };
}

/** `raw:mediaType` blob key + `raw:mediaType:ev:nv` rendition key (existence sets). */
function blobKey(rawContentHash: string, canonicalMediaType: string): string {
  return `${rawContentHash}:${canonicalMediaType}`;
}
function renditionKey(
  rawContentHash: string,
  canonicalMediaType: string,
  ev: number,
  nv: number,
): string {
  return `${rawContentHash}:${canonicalMediaType}:${ev}:${nv}`;
}

/**
 * Reconstruct the provenance projections from `snapshot` inside the rebuild
 * transaction `db`. A self-guarded no-op when `0003_provenance` has not been
 * applied (Phase-1 DBs rebuild unchanged). Clears the four provenance tables
 * then re-derives every row from the canonical manifests. Any malformed manifest
 * or dangling source reference throws, rolling the rebuild back (fail-closed).
 */
export function foldProvenanceManifests(snapshot: VaultSnapshot, db: SqliteDatabase): void {
  if (!ProvenanceRepo.isApplied(db)) return;
  const repo = new ProvenanceRepo(db);
  repo.clearAll();

  // First pass: source manifests → blobs + captures + renditions + active pointer.
  // Track existence so `sources: [...]` citations resolve strictly (fail-closed).
  const noteIdToContentId = new Map<string, string>();
  const knownBlobs = new Set<string>();
  const knownRenditions = new Set<string>();
  for (const note of snapshot.notes) {
    const fm = parseFrontmatter(note.raw);
    if (!fm) continue;
    const manifest = readManifest(fm, note.path, note.created);
    if (!manifest) continue;

    noteIdToContentId.set(note.id, `sha256:${manifest.rawContentHash}:${manifest.canonicalMediaType}`);
    knownBlobs.add(blobKey(manifest.rawContentHash, manifest.canonicalMediaType));

    repo.upsertBlob({
      raw_content_hash: manifest.rawContentHash,
      canonical_media_type: manifest.canonicalMediaType,
      size_bytes: manifest.sizeBytes,
      vault_path: manifest.vaultPath,
      first_seen_at: manifest.firstSeenAt,
    });
    for (const r of manifest.renditions) {
      repo.recordRendition({
        raw_content_hash: manifest.rawContentHash,
        canonical_media_type: manifest.canonicalMediaType,
        ...r,
      });
      knownRenditions.add(
        renditionKey(manifest.rawContentHash, manifest.canonicalMediaType, r.extractor_version, r.normalizer_version),
      );
    }
    for (const c of manifest.captures) {
      // Idempotent per (contentId, origin): a manifest states the aggregate, so
      // set the counters explicitly rather than incrementing on re-observation.
      db.prepare(
        `INSERT INTO source_captures
          (capture_id, raw_content_hash, canonical_media_type, origin, first_seen_at, last_seen_at, observation_count)
         VALUES (@capture_id, @raw, @mt, @origin, @first, @last, @count)
         ON CONFLICT(raw_content_hash, canonical_media_type, origin) DO UPDATE SET
           last_seen_at = excluded.last_seen_at, observation_count = excluded.observation_count`,
      ).run({
        capture_id: captureId(manifest.rawContentHash, manifest.canonicalMediaType, c.origin),
        raw: manifest.rawContentHash,
        mt: manifest.canonicalMediaType,
        origin: c.origin,
        first: c.first_seen_at,
        last: c.last_seen_at,
        count: c.observation_count,
      });
    }
    if (manifest.active) {
      repo.setActiveRendition({
        raw_content_hash: manifest.rawContentHash,
        canonical_media_type: manifest.canonicalMediaType,
        extractor_version: manifest.active.extractor_version,
        normalizer_version: manifest.active.normalizer_version,
      });
    }
  }

  // Second pass: `sources: [...]` citations → note_sources rows.
  for (const note of snapshot.notes) {
    for (const src of note.sources) {
      const comps = resolveCitation(note.id, src, noteIdToContentId, knownBlobs, knownRenditions);
      repo.insertNoteSource({
        note_id: note.id,
        raw_content_hash: comps.rawContentHash,
        canonical_media_type: comps.canonicalMediaType,
        extractor_version: comps.extractorVersion,
        normalizer_version: comps.normalizerVersion,
      });
    }
  }
}

/**
 * Resolve one `sources` entry to citation components (blob-general or
 * rendition-specific), throwing {@link DanglingSourceError} when it resolves to
 * no blob/rendition reconstructed in this fold (fail-closed — dictionary §2).
 */
function resolveCitation(
  sourceNoteId: string,
  src: string,
  noteIdToContentId: Map<string, string>,
  knownBlobs: Set<string>,
  knownRenditions: Set<string>,
): {
  rawContentHash: string;
  canonicalMediaType: string;
  extractorVersion: number | null;
  normalizerVersion: number | null;
} {
  // A serialized source handle (starts with `sha256:`).
  if (src.startsWith("sha256:")) {
    let handle;
    try {
      handle = parseSourceHandle(src);
    } catch (err) {
      throw new DanglingSourceError(sourceNoteId, src, `is not a valid source handle (${(err as Error).message})`);
    }
    if (handle.kind === "rendition") {
      if (!knownRenditions.has(
        renditionKey(handle.rawContentHash, handle.canonicalMediaType, handle.extractorVersion, handle.normalizerVersion),
      )) {
        throw new DanglingSourceError(sourceNoteId, src, "names a rendition absent from the manifests");
      }
      return {
        rawContentHash: handle.rawContentHash,
        canonicalMediaType: handle.canonicalMediaType,
        extractorVersion: handle.extractorVersion,
        normalizerVersion: handle.normalizerVersion,
      };
    }
    if (!knownBlobs.has(blobKey(handle.rawContentHash, handle.canonicalMediaType))) {
      throw new DanglingSourceError(sourceNoteId, src, "names a blob absent from the manifests");
    }
    return {
      rawContentHash: handle.rawContentHash,
      canonicalMediaType: handle.canonicalMediaType,
      extractorVersion: null, // blob-general citation
      normalizerVersion: null,
    };
  }
  // Otherwise a manifest note-id reference → blob-general citation.
  const contentId = noteIdToContentId.get(src);
  if (contentId === undefined) {
    throw new DanglingSourceError(sourceNoteId, src, "resolves to no source manifest in the snapshot");
  }
  const handle = parseSourceHandle(contentId);
  return {
    rawContentHash: handle.rawContentHash,
    canonicalMediaType: handle.canonicalMediaType,
    extractorVersion: null,
    normalizerVersion: null,
  };
}

/** Register the provenance fold into the rebuild pipeline (idempotent). */
registerProjectionFold(foldProvenanceManifests);
