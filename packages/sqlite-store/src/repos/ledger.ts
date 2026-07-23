/**
 * `repos/ledger` — typed access to the `agent_runs` operational table owned by
 * `0001_core` (dictionary §3). `agent_runs` is a plain operational table: `db
 * rebuild` never touches it (it references notes/runs only by scalar historical
 * id, no cross-class FK). v2 (#338) retired the audit ledger — the `audit_events`
 * append + its conflict guard are gone with the table — so this repo now exposes
 * only the `agent_runs` read/write surface the run state machine + read commands
 * need.
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

  countAgentRuns(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM agent_runs`).get() as { c: number }).c;
  }

  getAgentRun(runId: string): AgentRunRow | undefined {
    return this.db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as
      | AgentRunRow
      | undefined;
  }
}
