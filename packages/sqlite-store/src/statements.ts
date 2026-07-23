/**
 * `statements` — the surviving statement-runner seam (v2 #338).
 *
 * The §2.8 audit-ledger write protocol, the durable `audit_intents`, the AEAD
 * backup/watermark, and the crash-recovery drain are all retired: git (one commit
 * per ChangePlan on `refs/heads/main`) is v2's only safety mechanism, and
 * `agent_runs` / `model_calls` are plain operational tables. But the small,
 * general statement-runner the §2.8 machinery used to execute a batch of guarded
 * DML — `applyLedgerWrite` + its {@link LedgerStatement} / {@link LedgerAssertion}
 * CAS shape — is still the primitive every SURVIVING plain-transaction writer uses
 * (the workflow-engine checkpoints, the retrieval `model_calls`/`agent_runs`
 * writes, the model-call statement builder). It lives here now that the
 * `src/ledger/` subtree is gone.
 */
import { createHash } from "node:crypto";
import { canonicalSerialize, type AuditEvent } from "@atlas/contracts";
import type { SqliteDatabase } from "./connection.js";

/**
 * A single serializable DML write with an optional post-write CAS guard. Executed
 * by {@link applyLedgerWrite} inside a plain `db.transaction`. Statements should be
 * idempotent (`INSERT OR IGNORE` / a guarded upsert) so a re-drive is safe.
 */
export interface LedgerStatement {
  readonly sql: string;
  readonly params?: readonly unknown[] | Record<string, unknown>;
  /**
   * An optional post-execution guard enforced by {@link applyLedgerWrite}: `assert.sql`
   * is a `SELECT` that MUST return at least one row after `sql` runs; if it returns
   * NONE, {@link LedgerAssertionError} is thrown and the whole transaction rolls back.
   */
  readonly assert?: LedgerAssertion;
  /**
   * An optional AFFECTED-ROW assertion: the number of rows `sql` must change when it
   * runs. Proves a guarded `ON CONFLICT DO UPDATE … WHERE` actually mutated the
   * expected number of rows, so a no-op UPDATE (predicate blocked) never masquerades
   * as a successful advance. Typically `1` for a single-row guarded upsert.
   */
  readonly expectChanges?: number;
}

/** A serializable post-write guard for a {@link LedgerStatement}. */
export interface LedgerAssertion {
  /** A `SELECT` that MUST return ≥1 row after the statement ran; else the write is rejected. */
  readonly sql: string;
  readonly params?: readonly unknown[] | Record<string, unknown>;
  /** The human-readable reason surfaced on failure. */
  readonly message: string;
}

/**
 * Raised when a {@link LedgerStatement}'s serialized {@link LedgerAssertion} guard
 * finds its required row absent — the transactional affected-row / immutable-artifact
 * CAS failed (a stale/concurrent advance). Thrown inside the transaction so the whole
 * write rolls back.
 */
export class LedgerAssertionError extends Error {
  constructor(readonly detail: string) {
    super(`ledger-write assertion failed: ${detail}`);
    this.name = "LedgerAssertionError";
  }
}

function runStatement(
  db: SqliteDatabase,
  sql: string,
  params?: readonly unknown[] | Record<string, unknown>,
): { changes: number } {
  const stmt = db.prepare(sql);
  if (params === undefined) return stmt.run();
  if (Array.isArray(params)) return stmt.run(...(params as unknown[]));
  return stmt.run(params as Record<string, unknown>);
}

function checkAssertion(db: SqliteDatabase, a: LedgerAssertion): void {
  const stmt = db.prepare(a.sql);
  const row = a.params === undefined
    ? stmt.get()
    : Array.isArray(a.params)
      ? stmt.get(...(a.params as unknown[]))
      : stmt.get(a.params as Record<string, unknown>);
  if (row === undefined) throw new LedgerAssertionError(a.message);
}

/** Execute a batch of serializable guarded DML writes on `db` (caller wraps a transaction). */
export function applyLedgerWrite(db: SqliteDatabase, statements: readonly LedgerStatement[]): void {
  for (const st of statements) {
    const info = runStatement(db, st.sql, st.params);
    // Affected-row assertion: a guarded upsert whose ON CONFLICT WHERE-predicate
    // blocked the update changes ZERO rows even when the row already sits at the
    // target status (written by another handle) — the post-state SELECT below cannot
    // tell the two apart, so rejecting on the mutated-row COUNT closes that gap.
    if (st.expectChanges !== undefined && info.changes !== st.expectChanges) {
      throw new LedgerAssertionError(
        `expected ${st.expectChanges} affected row(s) but ${info.changes} changed (guarded write blocked — stale or concurrent handle)`,
      );
    }
    // Post-write guard: an audit event is never completed against a row the CAS could
    // not advance.
    if (st.assert) checkAssertion(db, st.assert);
  }
}

/**
 * An event as the caller drafts it: everything except `seq` and `prevAuditHead`.
 * Retained (with {@link UnsignedAuditEvent} / {@link payloadHashOf}) for the small
 * number of surviving callers that still hash a canonical event payload; v2 no
 * longer allocates a `seq` or appends to any audit ref.
 */
export type AuditEventDraft = Omit<AuditEvent, "seq" | "prevAuditHead">;

/** An event once its `seq` is filled in, sans the (retired) `prevAuditHead` chain field. */
export type UnsignedAuditEvent = Omit<AuditEvent, "prevAuditHead">;

/** The canonical payload hash of an unsigned event (sha256 over its JCS bytes). */
export function payloadHashOf(event: UnsignedAuditEvent): string {
  return createHash("sha256").update(canonicalSerialize(event)).digest("hex");
}
