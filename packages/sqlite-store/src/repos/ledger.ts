/**
 * `repos/ledger` — typed access to the operational/audit **ledger** tables owned
 * by `0001_core` (dictionary §3). Ledger rows are primary state: `db rebuild`
 * NEVER touches them (they reference notes/runs only by scalar historical id, no
 * cross-class FK). This repo exposes the minimal surface Phase 1 needs —
 * `agent_runs` + `audit_events` writes and count helpers — used by higher tasks
 * (finalizeLedgerWrite, Task 1.7) and by the rebuild test to prove ledger
 * survival.
 */
import type { SqliteDatabase } from "../connection.js";

/** An `agent_runs` row (the single authoritative workflow-state record). */
export interface AgentRunRow {
  readonly run_id: string;
  readonly operation: string;
  readonly status: string;
  readonly failed_checkpoint?: string | null;
  readonly checkpoint_seq?: number;
  readonly target_note_id?: string | null;
  readonly tier?: number | null;
  readonly started_at: string;
  readonly updated_at: string;
  readonly finished_at?: string | null;
}

/** An `audit_events` row (the committed audit record). */
export interface AuditEventRow {
  readonly seq: number;
  readonly run_id: string;
  readonly event_type: string;
  readonly payload_hash: string;
  readonly git_head?: string | null;
  readonly created_at: string;
}

export class LedgerRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Upsert an `agent_runs` row (conflict target `run_id`) advancing the state
   * machine's mutable columns (dictionary §3 `agent_runs`).
   */
  upsertAgentRun(row: AgentRunRow): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs
          (run_id, operation, status, failed_checkpoint, checkpoint_seq, target_note_id, tier,
           started_at, updated_at, finished_at)
         VALUES
          (@run_id, @operation, @status, @failed_checkpoint, @checkpoint_seq, @target_note_id, @tier,
           @started_at, @updated_at, @finished_at)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           failed_checkpoint = excluded.failed_checkpoint,
           checkpoint_seq = excluded.checkpoint_seq,
           tier = excluded.tier,
           updated_at = excluded.updated_at,
           finished_at = excluded.finished_at`,
      )
      .run({
        failed_checkpoint: null,
        checkpoint_seq: 0,
        target_note_id: null,
        tier: null,
        finished_at: null,
        ...row,
      });
  }

  /**
   * Insert an audit event idempotently on its `seq`.
   *
   * `audit_events` is security-authoritative and append-only: a `seq` is a
   * global monotonic allocation, so a retry MUST carry byte-identical immutable
   * fields. We insert-or-ignore on the `seq` primary key, then — if the row
   * already existed (no insert happened) — read it back and compare EVERY
   * immutable column. A different run or payload reusing the same `seq` is a
   * {@link AuditEventConflictError}, never a silent success (a bare
   * `ON CONFLICT DO NOTHING` would mask a forged/mismatched retry).
   */
  insertAuditEvent(row: AuditEventRow): void {
    const params = { git_head: null, ...row };
    const info = this.db
      .prepare(
        `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
         VALUES (@seq, @run_id, @event_type, @payload_hash, @git_head, @created_at)
         ON CONFLICT(seq) DO NOTHING`,
      )
      .run(params);

    if (info.changes === 1) return; // freshly inserted — nothing to reconcile.

    // A row for this seq already exists: it must match this retry exactly.
    const existing = this.db
      .prepare(`SELECT seq, run_id, event_type, payload_hash, git_head, created_at FROM audit_events WHERE seq = ?`)
      .get(row.seq) as AuditEventRow | undefined;
    if (existing === undefined) {
      // Insert reported no change yet no row exists — should never happen.
      throw new AuditEventConflictError(row.seq, "row", "<inserted>", "<missing>");
    }

    const mismatch =
      existing.run_id !== params.run_id ? (["run_id", existing.run_id, params.run_id] as const)
      : existing.event_type !== params.event_type ? (["event_type", existing.event_type, params.event_type] as const)
      : existing.payload_hash !== params.payload_hash ? (["payload_hash", existing.payload_hash, params.payload_hash] as const)
      : (existing.git_head ?? null) !== (params.git_head ?? null) ? (["git_head", String(existing.git_head), String(params.git_head)] as const)
      : existing.created_at !== params.created_at ? (["created_at", existing.created_at, params.created_at] as const)
      : undefined;

    if (mismatch) {
      throw new AuditEventConflictError(row.seq, mismatch[0], mismatch[1], mismatch[2]);
    }
    // All immutable fields matched → a true idempotent retry; treat as success.
  }

  countAgentRuns(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM agent_runs`).get() as { c: number }).c;
  }

  countAuditEvents(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM audit_events`).get() as { c: number }).c;
  }

  getAgentRun(runId: string): AgentRunRow | undefined {
    return this.db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as
      | AgentRunRow
      | undefined;
  }
}

/**
 * Raised when an `audit_events` retry reuses an existing `seq` with a different
 * immutable field — a security-authoritative conflict that must never be
 * silently swallowed.
 */
export class AuditEventConflictError extends Error {
  constructor(
    readonly seq: number,
    readonly field: string,
    readonly existing: string,
    readonly attempted: string,
  ) {
    super(
      `audit event seq ${seq} already recorded with a different ${field} ` +
        `(existing ${existing} != retry ${attempted}); audit_events is append-only and immutable`,
    );
    this.name = "AuditEventConflictError";
  }
}
