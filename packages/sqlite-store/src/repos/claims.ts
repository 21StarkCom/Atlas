/**
 * `repos/claims` — typed access to the two **claims projection** tables owned by
 * `0004_claims`: `claims` and `claim_evidence` (dictionary §5). Like
 * `ProvenanceRepo`, these are the primitives
 * {@link import("../claims/fold.js").foldClaimManifests} composes inside the
 * rebuild transaction.
 *
 * ## Sentinel encoding (dictionary §5 / plan Review-Hint)
 * `claim_evidence.locator` and `quote_hash` are **NOT NULL** columns. An absent
 * locator/quote is encoded as the fixed **6-byte printable-ASCII string
 * `(none)`** (`SENTINEL_NONE`) — never SQL `NULL`. This matters because the
 * idempotency guard is the UNIQUE index on `payload_hash`, and `payload_hash` is
 * derived from the sentinel-encoded fields: two attaches that both omit
 * `locator`/`quote_hash` therefore hash to the **same** `payload_hash` and
 * collapse to one row (the second is a no-op). Had absent fields been `NULL`,
 * NULL-distinctness would have let a duplicate slip past a composite unique
 * index — the sentinel closes that hole. The sentinel can never collide with a
 * real value: a real `locator` carries its `locator_scheme` prefix
 * (`byte:`/`char:`/`page:`/`dom:`) and a real `quote_hash` is a 64-char
 * lowercase-hex digest, so neither domain contains the literal `(none)`.
 *
 * ## Identity surrogates (dictionary §5)
 * `evidence_id` is a non-null immutable surrogate; when the caller does not
 * supply one it is **derived deterministically** from the `payload_hash` (which
 * itself hashes only immutable payload fields, never `verification`), so a
 * rebuild from canonical Markdown reproduces byte-identical rows. `lineage_id`
 * defaults to the row's own `evidence_id` (a lineage-founding root); a
 * re-anchored successor inherits the superseded row's `lineage_id`.
 */
import { createHash } from "node:crypto";
import type { ContentId } from "@atlas/contracts";
import type { SqliteDatabase } from "../connection.js";
import type { RenditionComponents } from "./provenance.js";

/** The fixed printable-ASCII sentinel for an absent `locator`/`quote_hash` (dictionary §5). */
export const SENTINEL_NONE = "(none)";

/** The `verification` CHECK enum (dictionary §5 — the single source is the DDL). */
export type EvidenceVerification = "valid" | "stale" | "pending" | "failed";

/** A row of the `claims` projection (all columns, verbatim names). */
export interface ClaimRow {
  readonly claim_id: string;
  readonly owning_note_id: string;
  readonly text: string;
  readonly status: string;
  readonly created_at: string;
}

/** A row of the `claim_evidence` projection (all columns, verbatim names). */
export interface ClaimEvidenceRow {
  readonly evidence_id: string;
  readonly lineage_id: string;
  readonly claim_id: string;
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly extractor_version: number;
  readonly normalizer_version: number;
  readonly locator: string;
  readonly quote_hash: string;
  readonly payload_hash: string;
  readonly verification: EvidenceVerification;
  /** `1` current, `0` tombstoned (SQLite has no boolean). */
  readonly current: number;
  readonly tombstoned_at: string | null;
  readonly supersedes_evidence_id: string | null;
  readonly created_at: string;
}

/** Input to {@link ClaimsRepo.attachEvidence} — a rendition pin plus optional payload/lineage. */
export interface AttachEvidenceInput {
  readonly claim_id: string;
  /** The pinned rendition's four component columns (composite FK → `source_renditions`). */
  readonly rendition: RenditionComponents;
  /** Absent → encoded as {@link SENTINEL_NONE}. */
  readonly locator?: string | null;
  /** Absent → encoded as {@link SENTINEL_NONE}. */
  readonly quote_hash?: string | null;
  /** Defaults to `'pending'` (the DDL default). */
  readonly verification?: EvidenceVerification | undefined;
  readonly created_at: string;
  /** Optional explicit surrogate; derived from `payload_hash` when omitted. */
  readonly evidence_id?: string | undefined;
  /** Optional explicit lineage key; defaults to this row's `evidence_id` (a root). */
  readonly lineage_id?: string | undefined;
  /** The prior head this row re-anchored from (null for a lineage-founding row). */
  readonly supersedes_evidence_id?: string | null | undefined;
  /** Defaults to `true` (current head); set `false` for a tombstoned row. */
  readonly current?: boolean | undefined;
  /** Required (and only allowed) when `current` is `false` — the tombstone timestamp. */
  readonly tombstoned_at?: string | null | undefined;
}

/**
 * Serialize a rendition's component columns back to its `renditionId` handle
 * (`sha256:<hash>:<mt>:<ev>:<nv>`) — the form fed into {@link payloadHash}.
 */
function serializeRendition(r: RenditionComponents): string {
  return `sha256:${r.raw_content_hash}:${r.canonical_media_type}:${r.extractor_version}:${r.normalizer_version}`;
}

/**
 * Deterministic `claim_evidence.payload_hash`: sha256 over the NUL-separated,
 * domain-tagged tuple `(claimId, renditionId, locator, quoteHash)` with absent
 * `locator`/`quote_hash` encoded as {@link SENTINEL_NONE} (dictionary §5). Two
 * attaches with the same payload (including both omitting locator/quote) hash
 * identically, so the UNIQUE index makes `attachEvidence` idempotent.
 */
export function payloadHash(
  claimId: string,
  rendition: RenditionComponents,
  locator: string,
  quoteHash: string,
): string {
  const NUL = Buffer.from([0]);
  return createHash("sha256")
    .update("claim-evidence", "utf8")
    .update(NUL)
    .update(claimId, "utf8")
    .update(NUL)
    .update(serializeRendition(rendition), "utf8")
    .update(NUL)
    .update(locator, "utf8")
    .update(NUL)
    .update(quoteHash, "utf8")
    .digest("hex");
}

/** Deterministic surrogate `evidence_id` derived from the immutable `payload_hash`. */
export function evidenceIdFor(payload: string): string {
  return createHash("sha256").update("evidence-id", "utf8").update(Buffer.from([0])).update(payload, "utf8").digest("hex");
}

export class ClaimsRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /** True if the `0004_claims` tables exist (retained PR-A applied). */
  static isApplied(db: SqliteDatabase): boolean {
    return (
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claims'`)
        .get() !== undefined
    );
  }

  /** Delete every claims projection row, children first (FK-safe order). */
  clearAll(): void {
    // `claim_evidence.supersedes_evidence_id` is a self-`ON DELETE RESTRICT` FK,
    // so a successor row referencing a predecessor blocks that predecessor's
    // delete (RESTRICT is enforced immediately, even within one table-wide
    // DELETE). Break every supersession link FIRST so the child table can be
    // emptied regardless of chain depth or delete order; then drop children
    // before the `claims` parent.
    this.db.exec(`UPDATE claim_evidence SET supersedes_evidence_id = NULL;
      DELETE FROM claim_evidence;
      DELETE FROM claims;`);
  }

  /**
   * Insert a claim, or merge `text`/`status` from the canonical Markdown on a
   * repeat `claim_id` (dictionary §5 upsert — `ON CONFLICT(claim_id) DO UPDATE`).
   * `owning_note_id` + `created_at` are immutable and never overwritten.
   */
  upsertClaim(row: ClaimRow): void {
    this.db
      .prepare(
        `INSERT INTO claims (claim_id, owning_note_id, text, status, created_at)
         VALUES (@claim_id, @owning_note_id, @text, @status, @created_at)
         ON CONFLICT(claim_id) DO UPDATE SET
           text = excluded.text,
           status = excluded.status`,
      )
      .run(row);
  }

  /**
   * Attach evidence to a claim, **idempotent by `evidence_id`** (equivalently by
   * `payload_hash`, from which the default `evidence_id` is derived). A retry
   * recreating an existing payload resolves to the existing row rather than
   * colliding (dictionary §5 upsert — `ON CONFLICT(payload_hash) DO NOTHING`).
   * Absent `locator`/`quote_hash` are encoded as {@link SENTINEL_NONE} so the
   * UNIQUE index cannot be bypassed by NULL-distinctness. Returns the resulting
   * row (freshly inserted or the pre-existing one).
   */
  attachEvidence(input: AttachEvidenceInput): ClaimEvidenceRow {
    const locator = input.locator == null ? SENTINEL_NONE : input.locator;
    const quoteHash = input.quote_hash == null ? SENTINEL_NONE : input.quote_hash;
    const payload = payloadHash(input.claim_id, input.rendition, locator, quoteHash);
    const evidenceId = input.evidence_id ?? evidenceIdFor(payload);

    // Lineage resolution (dictionary §5). A row that re-anchors a predecessor
    // (`supersedes_evidence_id`) INHERITS the predecessor's `lineage_id` — it does
    // NOT start a fresh lineage even when the Markdown omits an explicit
    // `lineage_id`. Resolve + validate the predecessor: it must exist, belong to
    // the SAME claim, and (if `lineage_id` was given explicitly) agree with the
    // inherited lineage. A lineage-founding row (no predecessor) defaults its
    // lineage to its own `evidence_id`.
    let lineageId: string;
    if (input.supersedes_evidence_id != null) {
      const pred = this.db
        .prepare(`SELECT lineage_id, claim_id FROM claim_evidence WHERE evidence_id = ?`)
        .get(input.supersedes_evidence_id) as { lineage_id: string; claim_id: string } | undefined;
      if (pred === undefined) {
        throw new Error(
          `attachEvidence: supersedes_evidence_id ${input.supersedes_evidence_id} names no existing evidence row`,
        );
      }
      if (pred.claim_id !== input.claim_id) {
        throw new Error(
          `attachEvidence: successor on claim ${input.claim_id} supersedes evidence of a different claim ${pred.claim_id}`,
        );
      }
      if (input.lineage_id !== undefined && input.lineage_id !== pred.lineage_id) {
        throw new Error(
          `attachEvidence: explicit lineage_id ${input.lineage_id} conflicts with the predecessor's lineage ${pred.lineage_id}`,
        );
      }
      lineageId = pred.lineage_id;
    } else {
      lineageId = input.lineage_id ?? evidenceId;
    }

    // Tombstone state is taken from the Markdown verbatim (SSOT) — never silently
    // normalized. The two states the `(current = 1) = (tombstoned_at IS NULL)`
    // CHECK enforces are surfaced as explicit errors so a mismatch (e.g.
    // `current: true` carrying a `tombstoned_at`) rolls the rebuild back instead
    // of discarding the Markdown timestamp.
    const current = input.current === false ? 0 : 1;
    const tombstonedAt = input.tombstoned_at ?? null;
    if (current === 1 && tombstonedAt !== null) {
      throw new Error("attachEvidence: a current row (current: true) must not carry tombstoned_at");
    }
    if (current === 0 && tombstonedAt === null) {
      throw new Error("attachEvidence: a tombstoned row (current: false) requires tombstoned_at");
    }

    this.db
      .prepare(
        `INSERT INTO claim_evidence
          (evidence_id, lineage_id, claim_id, raw_content_hash, canonical_media_type,
           extractor_version, normalizer_version, locator, quote_hash, payload_hash,
           verification, current, tombstoned_at, supersedes_evidence_id, created_at)
         VALUES
          (@evidence_id, @lineage_id, @claim_id, @raw_content_hash, @canonical_media_type,
           @extractor_version, @normalizer_version, @locator, @quote_hash, @payload_hash,
           @verification, @current, @tombstoned_at, @supersedes_evidence_id, @created_at)
         ON CONFLICT(payload_hash) DO NOTHING`,
      )
      .run({
        evidence_id: evidenceId,
        lineage_id: lineageId,
        claim_id: input.claim_id,
        raw_content_hash: input.rendition.raw_content_hash,
        canonical_media_type: input.rendition.canonical_media_type,
        extractor_version: input.rendition.extractor_version,
        normalizer_version: input.rendition.normalizer_version,
        locator,
        quote_hash: quoteHash,
        payload_hash: payload,
        verification: input.verification ?? "pending",
        current,
        tombstoned_at: tombstonedAt,
        supersedes_evidence_id: input.supersedes_evidence_id ?? null,
        created_at: input.created_at,
      });

    // Return the row keyed by the (idempotent) payload_hash — the existing row on
    // a conflict, or the just-inserted one otherwise.
    return this.db
      .prepare(`SELECT * FROM claim_evidence WHERE payload_hash = ?`)
      .get(payload) as ClaimEvidenceRow;
  }

  /**
   * Set an evidence row's `verification` state (dictionary §5 — Markdown is the
   * SSOT for `verification`, so a rebuild folds the persisted state back). Throws
   * when the `evidence_id` names no row.
   */
  setEvidenceVerification(evidenceId: string, verification: EvidenceVerification): void {
    const res = this.db
      .prepare(`UPDATE claim_evidence SET verification = @verification WHERE evidence_id = @evidence_id`)
      .run({ evidence_id: evidenceId, verification });
    if (res.changes === 0) {
      throw new Error(`setEvidenceVerification: no evidence row ${evidenceId}`);
    }
  }

  /**
   * Every evidence row pinned to a rendition of the given content blob, ordered
   * deterministically. The parameter is a typed {@link ContentId} (a blob
   * handle) — evidence pins a specific rendition, but this returns all evidence
   * across any rendition of that blob (the dependency-enumeration access pattern,
   * plan Task 4.6 consumes it).
   */
  evidenceForRendition(contentId: ContentId): ClaimEvidenceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM claim_evidence
          WHERE raw_content_hash = ? AND canonical_media_type = ?
          ORDER BY claim_id, lineage_id, created_at, evidence_id`,
      )
      .all(contentId.rawContentHash, contentId.canonicalMediaType) as ClaimEvidenceRow[];
  }

  // --- read helpers (tests + rebuild assertions) ----------------------------

  allClaims(): ClaimRow[] {
    return this.db.prepare(`SELECT * FROM claims ORDER BY claim_id`).all() as ClaimRow[];
  }

  allEvidence(): ClaimEvidenceRow[] {
    return this.db
      .prepare(`SELECT * FROM claim_evidence ORDER BY claim_id, lineage_id, created_at, evidence_id`)
      .all() as ClaimEvidenceRow[];
  }
}
