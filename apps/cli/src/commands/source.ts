/**
 * `brain source list | show | source trust show` (Task 2.9 / #35) — the read-only
 * provenance surface over the `0003_provenance` projections (D3). All three are
 * Tier-0 reads: no vault/projection/ledger/git mutation, no audit-ref write.
 *
 *  - `source list` — paginated list of captured content blobs (the pagination
 *    contract: `--limit`/`--offset`, `total`/`hasMore`, out-of-range ⇒ exit 5).
 *    Ordering is `(capturedAt DESC, contentId ASC)`; `contentId`
 *    (`rawContentHash:canonicalMediaType`, the blob PK) is unique, so the total
 *    order is fully resolved and offset pagination is deterministic.
 *  - `source show <handle>` — one blob's captures + renditions + active pointer.
 *  - `source trust show <handle>` — the source's trust state. Trust is a Phase-4
 *    concept (`source trust promote/revoke`); pre-Phase-4 there is NO trust
 *    projection, so every source reads `effectiveTrustLevel: untrusted`,
 *    `suspended: false`, `history: []` (plan §2.9 "default untrusted pre-Phase-4").
 */
import {
  parseSourceHandle,
  serializeContentId,
  serializeRenditionId,
  type SourceHandle,
} from "@atlas/contracts";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import type { SqliteDatabase } from "@atlas/sqlite-store";
import {
  DEFAULT_LIMIT,
  assertOffsetInRange,
  buildPagination,
  parseLimit,
  parseOffset,
  type PageRequest,
} from "./pagination.js";

/**
 * The trust level in effect pre-Phase-4. There is no trust projection yet, so
 * every source is `untrusted` until `source trust promote` (Phase-4) exists.
 */
const DEFAULT_TRUST_LEVEL = "untrusted" as const;

// ---------------------------------------------------------------------------
// source list
// ---------------------------------------------------------------------------

/** Parse `source list` argv: only `--limit`/`--offset` (out-of-range ⇒ exit 5). */
function parseListArgs(argv: string[]): PageRequest {
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw CliError.usage(`\`source list\`: ${a} requires a value`);
      return v;
    };
    if (a === "--limit") limit = parseLimit("source list", need());
    else if (a.startsWith("--limit=")) limit = parseLimit("source list", a.slice("--limit=".length));
    else if (a === "--offset") offset = parseOffset("source list", need());
    else if (a.startsWith("--offset=")) offset = parseOffset("source list", a.slice("--offset=".length));
    else throw CliError.usage(`\`source list\`: unknown flag/argument ${a}`);
  }
  return { limit, offset };
}

/** A `content_blobs` row joined with its rendition count (one source-list entry). */
interface SourceListRow {
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly first_seen_at: string;
  readonly active_extractor_version: number | null;
  readonly active_normalizer_version: number | null;
  readonly rendition_count: number;
}

/**
 * Query one page of captured sources, ordered by the contract sort key
 * `(capturedAt DESC, contentId ASC)`. The tie-breaker is the blob primary key
 * `(raw_content_hash, canonical_media_type)` — unique — so the ORDER BY is a total
 * order and the same offset always names the same row absent a concurrent
 * insert/delete (best-effort under concurrency, plan §2.5). Exported for the
 * pagination contract test.
 */
export function querySources(
  db: SqliteDatabase,
  req: PageRequest,
): { rows: SourceListRow[]; total: number } {
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM content_blobs`).get() as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT b.raw_content_hash, b.canonical_media_type, b.first_seen_at,
              b.active_extractor_version, b.active_normalizer_version,
              (SELECT COUNT(*) FROM source_renditions r
                WHERE r.raw_content_hash = b.raw_content_hash
                  AND r.canonical_media_type = b.canonical_media_type) AS rendition_count
         FROM content_blobs b
        ORDER BY b.first_seen_at DESC, b.raw_content_hash ASC, b.canonical_media_type ASC
        LIMIT ? OFFSET ?`,
    )
    .all(req.limit, req.offset) as SourceListRow[];
  return { rows, total };
}

function sourceListEntry(r: SourceListRow): Record<string, unknown> {
  const contentId = serializeContentId({
    kind: "content",
    rawContentHash: r.raw_content_hash,
    canonicalMediaType: r.canonical_media_type,
  });
  const out: Record<string, unknown> = {
    contentId,
    canonicalMediaType: r.canonical_media_type,
    capturedAt: r.first_seen_at,
    renditionCount: r.rendition_count,
    trustLevel: DEFAULT_TRUST_LEVEL,
  };
  if (r.active_extractor_version !== null && r.active_normalizer_version !== null) {
    out.activeRenditionId = serializeRenditionId({
      kind: "rendition",
      rawContentHash: r.raw_content_hash,
      canonicalMediaType: r.canonical_media_type,
      extractorVersion: r.active_extractor_version,
      normalizerVersion: r.active_normalizer_version,
    });
  }
  return out;
}

function sourceList(ctx: RunContext): number {
  const req = parseListArgs(ctx.argv);
  const store = openMigratedStore(ctx);
  try {
    const { rows, total } = querySources(store.db, req);
    assertOffsetInRange("source list", req.offset, total);
    const out = {
      command: "source list",
      sources: rows.map(sourceListEntry),
      pagination: buildPagination(req, total, rows.length),
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`sources: ${rows.length} of ${total}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// shared handle resolution (source show / source trust show)
// ---------------------------------------------------------------------------

/** A `content_blobs` row (subset the show commands need). */
interface BlobRow {
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly size_bytes: number;
  readonly active_extractor_version: number | null;
  readonly active_normalizer_version: number | null;
}

/** Parse + validate the single `<source>` positional (usage/invalid-handle mapping). */
function parseHandleArg(command: string, argv: string[]): { raw: string; handle: SourceHandle } {
  let raw: string | undefined;
  for (const a of argv) {
    if (a.startsWith("-")) throw CliError.usage(`\`${command}\`: unknown flag ${a}`);
    if (raw !== undefined) throw CliError.usage(`\`${command}\`: unexpected extra argument ${a}`);
    raw = a;
  }
  if (raw === undefined) throw CliError.usage(`\`${command}\` requires a <source> argument`);
  let handle: SourceHandle;
  try {
    handle = parseSourceHandle(raw);
  } catch (e) {
    throw new CliError({
      code: "invalid-source-handle",
      message: `\`${command}\`: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Pass a serialized contentId (sha256:<hash>:<mediaType>) or renditionId (…:<ext>:<norm>).",
      exitCode: EXIT.VALIDATION,
    });
  }
  return { raw, handle };
}

/** Look up the blob the handle names; `source-not-found` (exit 1) if none. */
function resolveBlob(command: string, db: SqliteDatabase, handle: SourceHandle): BlobRow {
  const blob = db
    .prepare(
      `SELECT raw_content_hash, canonical_media_type, size_bytes,
              active_extractor_version, active_normalizer_version
         FROM content_blobs
        WHERE raw_content_hash = ? AND canonical_media_type = ?`,
    )
    .get(handle.rawContentHash, handle.canonicalMediaType) as BlobRow | undefined;
  if (blob === undefined) throw notFound(command, handle);
  // A rendition handle must name a rendition that actually exists, else the handle
  // resolves to no capture (source-not-found), never a silent fallback to active.
  if (handle.kind === "rendition") {
    const exists = db
      .prepare(
        `SELECT 1 FROM source_renditions
          WHERE raw_content_hash = ? AND canonical_media_type = ?
            AND extractor_version = ? AND normalizer_version = ?`,
      )
      .get(handle.rawContentHash, handle.canonicalMediaType, handle.extractorVersion, handle.normalizerVersion);
    if (exists === undefined) throw notFound(command, handle);
  }
  return blob;
}

function notFound(command: string, handle: SourceHandle): CliError {
  const s =
    handle.kind === "content" ? serializeContentId(handle) : serializeRenditionId(handle);
  return new CliError({
    code: "source-not-found",
    message: `\`${command}\`: no capture resolves for ${s}`,
    hint: "Run `brain source list` to see captured sources.",
    exitCode: EXIT.VALIDATION,
  });
}

/** The active rendition's `(renditionId, normalizedContentHash)` binding, if any. */
function activeRenditionBinding(db: SqliteDatabase, blob: BlobRow): { renditionId: string; normalizedContentHash: string } | undefined {
  if (blob.active_extractor_version === null || blob.active_normalizer_version === null) return undefined;
  const row = db
    .prepare(
      `SELECT normalized_content_hash FROM source_renditions
        WHERE raw_content_hash = ? AND canonical_media_type = ?
          AND extractor_version = ? AND normalizer_version = ?`,
    )
    .get(blob.raw_content_hash, blob.canonical_media_type, blob.active_extractor_version, blob.active_normalizer_version) as
    | { normalized_content_hash: string }
    | undefined;
  if (row === undefined) return undefined;
  return {
    renditionId: serializeRenditionId({
      kind: "rendition",
      rawContentHash: blob.raw_content_hash,
      canonicalMediaType: blob.canonical_media_type,
      extractorVersion: blob.active_extractor_version,
      normalizerVersion: blob.active_normalizer_version,
    }),
    normalizedContentHash: row.normalized_content_hash,
  };
}

// ---------------------------------------------------------------------------
// source show
// ---------------------------------------------------------------------------

function sourceShow(ctx: RunContext): number {
  const { handle } = parseHandleArg("source show", ctx.argv);
  const store = openMigratedStore(ctx);
  try {
    const blob = resolveBlob("source show", store.db, handle);
    const contentId = serializeContentId({
      kind: "content",
      rawContentHash: blob.raw_content_hash,
      canonicalMediaType: blob.canonical_media_type,
    });
    const active = activeRenditionBinding(store.db, blob);

    const captures = (store.db
      .prepare(
        `SELECT capture_id, origin, first_seen_at
           FROM source_captures
          WHERE raw_content_hash = ? AND canonical_media_type = ?
          ORDER BY capture_id ASC`,
      )
      .all(blob.raw_content_hash, blob.canonical_media_type) as {
      capture_id: string;
      origin: string;
      first_seen_at: string;
    }[]).map((c) => ({ captureId: c.capture_id, origin: c.origin, capturedAt: c.first_seen_at }));

    const renditions = (store.db
      .prepare(
        `SELECT extractor_version, normalizer_version, normalized_content_hash, size_bytes
           FROM source_renditions
          WHERE raw_content_hash = ? AND canonical_media_type = ?
          ORDER BY extractor_version ASC, normalizer_version ASC`,
      )
      .all(blob.raw_content_hash, blob.canonical_media_type) as {
      extractor_version: number;
      normalizer_version: number;
      normalized_content_hash: string;
      size_bytes: number;
    }[]).map((r) => ({
      renditionId: serializeRenditionId({
        kind: "rendition",
        rawContentHash: blob.raw_content_hash,
        canonicalMediaType: blob.canonical_media_type,
        extractorVersion: r.extractor_version,
        normalizerVersion: r.normalizer_version,
      }),
      extractorVersion: r.extractor_version,
      normalizerVersion: r.normalizer_version,
      normalizedContentHash: r.normalized_content_hash,
      sizeBytes: r.size_bytes,
      active:
        blob.active_extractor_version === r.extractor_version &&
        blob.active_normalizer_version === r.normalizer_version,
    }));

    const source: Record<string, unknown> = {
      contentId,
      canonicalMediaType: blob.canonical_media_type,
      sizeBytes: blob.size_bytes,
      trustLevel: DEFAULT_TRUST_LEVEL,
      captures,
      renditions,
    };
    if (active !== undefined) source.activeRenditionId = active.renditionId;

    const out = { command: "source show", source };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`${contentId} — ${captures.length} capture(s), ${renditions.length} rendition(s)`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// source trust show
// ---------------------------------------------------------------------------

function sourceTrustShow(ctx: RunContext): number {
  const { raw, handle } = parseHandleArg("source trust show", ctx.argv);
  const store = openMigratedStore(ctx);
  try {
    const blob = resolveBlob("source trust show", store.db, handle);
    const contentId = serializeContentId({
      kind: "content",
      rawContentHash: blob.raw_content_hash,
      canonicalMediaType: blob.canonical_media_type,
    });
    const active = activeRenditionBinding(store.db, blob);
    // Pre-Phase-4: no trust ledger/projection exists, so trust is definitively
    // `untrusted`, never suspended, with an empty history. `reviewedTrustLevel`,
    // `reviewedRendition`, and `suspensionReason` are absent (no promotion exists).
    const out: Record<string, unknown> = {
      command: "source trust show",
      sourceHandle: raw,
      contentId,
      effectiveTrustLevel: DEFAULT_TRUST_LEVEL,
      suspended: false,
      history: [] as unknown[],
    };
    if (active !== undefined) out.activeRendition = active;

    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`${contentId}: ${DEFAULT_TRUST_LEVEL}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("source list", sourceList);
registerCommand("source show", sourceShow);
registerCommand("source trust show", sourceTrustShow);

export { sourceList, sourceShow, sourceTrustShow };
