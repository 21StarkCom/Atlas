/**
 * Stable ID mint/parse (D3) + opaque salted IDs (§5.1 of the security/broker
 * contract). This is the ONLY module that parses/serializes source handles —
 * every producer/verifier across the process seam (CLI, sqlite-store, git,
 * both broker daemons) mints identical IDs here so serialization stays
 * byte-stable (D3: "Parsing lives in `packages/contracts/src/ids.ts` only").
 *
 * Zero runtime dependencies — uses only Node built-ins (`node:crypto`).
 */
import { createHmac, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Source handles (D3)
// ---------------------------------------------------------------------------

/**
 * A content-addressed blob handle. Serialized as
 * `sha256:<rawContentHash>:<canonicalMediaType>` (colon-delimited, lowercase
 * hex). Resolved to an active rendition via `content_blobs.active_rendition_id`.
 */
export interface ContentId {
  /** Discriminant so `parseSourceHandle`'s union is narrowable by consumers. */
  readonly kind: "content";
  /** Lowercase-hex SHA-256 of the raw captured bytes (64 hex chars). */
  readonly rawContentHash: string;
  /** Canonical media type, e.g. `text/markdown`. */
  readonly canonicalMediaType: string;
}

/**
 * A normalized-rendition handle. Serialized as
 * `sha256:<rawContentHash>:<canonicalMediaType>:<extractorVersion>:<normalizerVersion>`.
 */
export interface RenditionId {
  readonly kind: "rendition";
  readonly rawContentHash: string;
  readonly canonicalMediaType: string;
  readonly extractorVersion: number;
  readonly normalizerVersion: number;
}

/** A parsed source handle is either a content id or a rendition id. */
export type SourceHandle = ContentId | RenditionId;

const HASH_RE = /^[0-9a-f]{64}$/;
// Media types are token/subtype with optional parameters; crucially they never
// contain a colon, so colon-splitting a serialized handle is unambiguous.
const MEDIA_TYPE_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function assertVersion(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid source handle: ${label} must be a non-negative integer, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * Parse a serialized source handle into a `ContentId` (3 segments) or
 * `RenditionId` (5 segments). Rejects malformed algorithm prefixes, non-hex
 * hashes, bad media types, and non-integer versions.
 */
export function parseSourceHandle(s: string): SourceHandle {
  const parts = s.split(":");
  if (parts[0] !== "sha256") {
    throw new Error(`invalid source handle: expected "sha256:" prefix, got "${s}"`);
  }
  const rawContentHash = parts[1] ?? "";
  if (!HASH_RE.test(rawContentHash)) {
    throw new Error(`invalid source handle: rawContentHash must be 64 lowercase hex chars`);
  }
  const canonicalMediaType = parts[2] ?? "";
  if (!MEDIA_TYPE_RE.test(canonicalMediaType)) {
    throw new Error(`invalid source handle: canonicalMediaType "${canonicalMediaType}" is not a media type`);
  }
  if (parts.length === 3) {
    return { kind: "content", rawContentHash, canonicalMediaType };
  }
  if (parts.length === 5) {
    return {
      kind: "rendition",
      rawContentHash,
      canonicalMediaType,
      extractorVersion: assertVersion(parts[3]!, "extractorVersion"),
      normalizerVersion: assertVersion(parts[4]!, "normalizerVersion"),
    };
  }
  throw new Error(`invalid source handle: expected 3 (content) or 5 (rendition) segments, got ${parts.length}`);
}

/** Serialize a `ContentId` back to its `sha256:<hash>:<mediaType>` form. */
export function serializeContentId(c: ContentId): string {
  return `sha256:${c.rawContentHash}:${c.canonicalMediaType}`;
}

/** Serialize a `RenditionId` back to its 5-segment form. */
export function serializeRenditionId(r: RenditionId): string {
  return `sha256:${r.rawContentHash}:${r.canonicalMediaType}:${r.extractorVersion}:${r.normalizerVersion}`;
}

// ---------------------------------------------------------------------------
// ULID run/event ids
// ---------------------------------------------------------------------------

// Crockford's base32 (no I, L, O, U) — the ULID alphabet.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Canonical ULID shape: 26 Crockford chars, first char ≤ 7 (48-bit time). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Mint a new run id as a ULID (RFC-less spec): 48-bit big-endian millisecond
 * timestamp (10 chars) + 80-bit crypto randomness (16 chars), Crockford base32.
 * Lexicographically sortable and monotonic-ish across the deployment.
 */
export function newRunId(): string {
  let ts = Date.now();
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[ts % 32]!;
    ts = Math.floor(ts / 32);
  }
  let bits = 0n;
  for (const b of randomBytes(10)) bits = (bits << 8n) | BigInt(b);
  const randChars = new Array<string>(16);
  for (let i = 15; i >= 0; i--) {
    randChars[i] = CROCKFORD[Number(bits & 31n)]!;
    bits >>= 5n;
  }
  return timeChars.join("") + randChars.join("");
}

/** True if `s` is a well-formed ULID. */
export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}

// ---------------------------------------------------------------------------
// Opaque salted IDs (security/broker contract §5.1)
// ---------------------------------------------------------------------------

/** Entity kinds that get an opaque audit id. */
export type OpaqueEntityKind = "note" | "source";

const OPAQUE_PREFIX: Record<OpaqueEntityKind, string> = { note: "n", source: "s" };

/**
 * Opaque salted id: `"<prefix>_" + hex(HMAC-SHA256(salt, entityKind ‹NUL› naturalId))`.
 *
 * ASSUMPTION: the contract's prose says "…[:16bytes]" but every JSON example in
 * the doc (§5, §5.1) uses a 16-hex-char digest (8 bytes), e.g.
 * `n_9f2c1a8e0b3d4f56`. The examples are the acceptance target
 * (`contracts.authorization.test`), so we truncate to 16 hex chars to match
 * them — and `OPAQUE_ID_RE` below is derived from the same 16-char shape.
 */
export function saltedOpaqueId(kind: OpaqueEntityKind, id: string, salt: Uint8Array): string {
  // Single NUL byte as an unambiguous domain separator (contract §5.1).
  const input = Buffer.concat([Buffer.from(kind, "utf8"), Buffer.from([0]), Buffer.from(id, "utf8")]);
  const digest = createHmac("sha256", salt).update(input).digest("hex");
  return `${OPAQUE_PREFIX[kind]}_${digest.slice(0, 16)}`;
}

/** Shape of an opaque salted id, mirroring the contract's JSON examples. */
export const OPAQUE_ID_RE = /^[ns]_[0-9a-f]{16}$/;
