/**
 * `trust/promote` — the `source trust promote|revoke` execution (Task 4.8/4.9). Trust is advanced
 * on the broker-owned `refs/trust/ledger` under a broker challenge/authorization bound to the
 * source (`sourceId` + `rawContentHash`); this module owns the state-transition rules + the SQLite
 * projection update, with the privileged ledger advance as an injected seam (the broker verifies
 * the authorization + refuses a forged/replayed one, Task 1.6).
 *
 * Transition rules (contract `ops/trust.ts`): a promote must strictly RAISE the level
 * (`not-a-promotion` otherwise); a revoke on an already-untrusted source is `already-untrusted`.
 * The projection is updated ONLY after the ledger advance succeeds — a refused advance leaves the
 * prior trust state intact (fail-closed).
 */
import type { TrustLevel } from "@atlas/contracts";
import type { SqliteDatabase } from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";
import { DEFAULT_TRUST, type TrustState } from "./state.js";

/** The blob a trust op targets. */
export interface TrustTarget {
  readonly rawContentHash: string;
  readonly canonicalMediaType: string;
}

/** The ordered trust levels (a promote must move strictly up this scale). */
const RANK: Record<TrustLevel, number> = { untrusted: 0, provisional: 1, trusted: 2, authoritative: 3 };

/**
 * A source's full projected trust row — the latest transition only (the projection
 * is one row per blob; the broker-owned trust ledger is the history SSOT, and its
 * Phase-1 `execAuthorized` is authorize-only, so this row is everything persisted).
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

/** Read a source's projected trust state (fail-closed default when unprojected). */
export function readTrustState(db: SqliteDatabase, t: TrustTarget): TrustState {
  const row = readTrustRecord(db, t);
  return row ? { level: row.level, suspended: row.suspended } : DEFAULT_TRUST;
}

/** A trust-op failure the CLI maps to a validation exit. */
export class TrustError extends CliError {
  constructor(code: string, message: string) {
    super({ code, message, exitCode: EXIT.VALIDATION });
  }
}

/** The seams a trust op drives: the broker-authorized ledger advance + the clock. */
export interface TrustDeps {
  readonly db: SqliteDatabase;
  /**
   * Advance `refs/trust/ledger` for the target under the reviewer authorization (broker-verified;
   * a forged/replayed authorization is refused here, before the projection is touched).
   */
  advanceTrustLedger(args: { target: TrustTarget; op: "PromoteTrust" | "RevokeTrust"; toLevel: TrustLevel; reason: string }): Promise<void>;
  readonly now?: () => string;
}

function upsertTrust(db: SqliteDatabase, t: TrustTarget, level: TrustLevel, suspended: boolean, reason: string, now: string): void {
  db.prepare(
    `INSERT INTO trust_state (raw_content_hash, canonical_media_type, level, suspended, reason, updated_at)
     VALUES (@h, @m, @level, @suspended, @reason, @now)
     ON CONFLICT(raw_content_hash, canonical_media_type) DO UPDATE SET level=@level, suspended=@suspended, reason=@reason, updated_at=@now`,
  ).run({ h: t.rawContentHash, m: t.canonicalMediaType, level, suspended: suspended ? 1 : 0, reason, now });
}

/**
 * Promote a source's trust to `toLevel` (strictly up). Refuses `not-a-promotion` when `toLevel`
 * does not raise the current level. Advances the trust ledger (broker-authorized) THEN projects.
 */
export async function promoteTrust(target: TrustTarget, toLevel: TrustLevel, reason: string, deps: TrustDeps): Promise<TrustState> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const current = readTrustState(deps.db, target);
  if (RANK[toLevel] <= RANK[current.level] && !current.suspended) {
    throw new TrustError("not-a-promotion", `trust ${current.level} → ${toLevel} is not a promotion`);
  }
  await deps.advanceTrustLedger({ target, op: "PromoteTrust", toLevel, reason });
  upsertTrust(deps.db, target, toLevel, false, reason, now); // a promotion clears any suspension
  return { level: toLevel, suspended: false };
}

/**
 * Revoke a source's trust (drops it to `untrusted`, suspended). Refuses `already-untrusted` when
 * the source is already untrusted + unsuspended. Advances the trust ledger THEN projects.
 */
export async function revokeTrust(target: TrustTarget, reason: string, deps: TrustDeps): Promise<TrustState> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const current = readTrustState(deps.db, target);
  if (current.level === "untrusted" && !current.suspended) {
    throw new TrustError("already-untrusted", `source is already untrusted`);
  }
  await deps.advanceTrustLedger({ target, op: "RevokeTrust", toLevel: "untrusted", reason });
  upsertTrust(deps.db, target, "untrusted", true, reason, now);
  return { level: "untrusted", suspended: true };
}
