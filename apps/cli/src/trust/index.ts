/**
 * `trust` — the RESIDUAL read-only trust surface (v2, #334). The trust lifecycle
 * (promote/revoke ledger advance, transitive taint, remediation) is retired with
 * the security architecture (ADR-0003); what remains is the projection READ the
 * surviving `source list|show` payloads still report until the #339
 * `0015_source_registry` rebase replaces their schema — at which point this
 * directory goes entirely.
 */
import type { TrustLevel } from "@atlas/contracts";
import type { SqliteDatabase } from "@atlas/sqlite-store";

export { trustStateFor, isTrusted, DEFAULT_TRUST, type TrustState } from "./state.js";

/** The blob a trust row keys on. */
export interface TrustTarget {
  readonly rawContentHash: string;
  readonly canonicalMediaType: string;
}

/**
 * A source's full projected trust row — the latest transition only. With the
 * mutation surface retired nothing writes this table anymore; rows persist from
 * v1 history and read as-is until #339 drops the field from the source payloads.
 */
export interface TrustRecord {
  readonly level: TrustLevel;
  readonly suspended: boolean;
  readonly reason: string | null;
  readonly updatedAt: string;
}

/** Read a source's full projected trust row; `null` when unprojected (⇒ untrusted). */
export function readTrustRecord(db: SqliteDatabase, t: TrustTarget): TrustRecord | null {
  const row = db
    .prepare(
      `SELECT level, suspended, reason, updated_at FROM trust_state WHERE raw_content_hash = ? AND canonical_media_type = ?`,
    )
    .get(t.rawContentHash, t.canonicalMediaType) as
    | { level: TrustLevel; suspended: number; reason: string | null; updated_at: string }
    | undefined;
  if (row === undefined) return null;
  return { level: row.level, suspended: row.suspended === 1, reason: row.reason, updatedAt: row.updated_at };
}
