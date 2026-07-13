/**
 * `backup/watermark` — the §2.8 step-4 fail-closed backup watermark + gate
 * (ledger-backup-contract §5, §6).
 *
 * The `backup_watermark` single row (`id = 1`) records the highest `run.*` ledger
 * seq covered by a **verified** backup and a binary `healthy` flag. `healthy = 0`
 * is the contract's **blocked** state: the ledger-writing command set is refused
 * with `backup-unhealthy` (exit 2) until a verified backup, a `db restore`, or an
 * audited `--force-unblock` clears it. Non-persisting diagnostics and `db restore`
 * are never gated (contract §6).
 */
import type { SqliteDatabase } from "../connection.js";
import { latestRunSeq } from "../ledger/intents.js";

/** The stable error code + exit code for the fail-closed gate (contract §6, §2.5). */
export const BACKUP_UNHEALTHY_CODE = "backup-unhealthy";
export const BACKUP_UNHEALTHY_EXIT = 2;

/** A `backup_watermark` row. */
export interface BackupWatermarkRow {
  readonly id: 1;
  readonly seq: number;
  readonly healthy: number;
  readonly last_backup_at: string | null;
  readonly updated_at: string;
  /** Durable backup-retry state (round-3 finding 9): attempts spent + next-attempt time. */
  readonly retry_count: number;
  readonly next_retry_at: string | null;
}

/** The {@link watermarkHealth} surface (Task 1.7 `watermarkHealth`). */
export interface WatermarkHealth {
  /** The highest committed `run.*` ledger seq (the latest row needing coverage). */
  readonly seq: number;
  /** The highest ledger seq a verified backup covers (`backup_watermark.seq`). */
  readonly coveredSeq: number;
  /** `false` in the blocked state — the fail-closed gate refuses ledger writes. */
  readonly healthy: boolean;
}

/**
 * Raised by {@link assertBackupHealthy} when the watermark is blocked. Carries the
 * stable `backup-unhealthy` code + exit 2 so the CLI maps it to the config/vault
 * class without re-deriving it.
 */
export class BackupUnhealthyError extends Error {
  readonly code = BACKUP_UNHEALTHY_CODE;
  readonly exitCode = BACKUP_UNHEALTHY_EXIT;
  constructor(readonly coveredSeq: number, readonly latestSeq: number) {
    super(
      `backup-unhealthy: bounded backup retries exhausted; a verified backup covers only ` +
        `seq ${coveredSeq} of ${latestSeq} — ledger-writing commands are blocked (exit 2). ` +
        `Run \`db backup\` (or \`db backup --force-unblock\` / \`db restore\`) to clear the block.`,
    );
    this.name = "BackupUnhealthyError";
  }
}

export class WatermarkRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Ensure the single `id = 1` row exists (idempotent). Seeds `seq = -1`, the
   * "no verified backup yet" sentinel: `run.*` seqs start at 0, so `-1` keeps
   * "nothing covered" distinct from "seq 0 covered" (the default `0` in the DDL
   * would falsely read as covering the first committed row).
   */
  ensureRow(now: string): void {
    this.db
      .prepare(
        `INSERT INTO backup_watermark (id, seq, healthy, last_backup_at, updated_at)
         VALUES (1, -1, 1, NULL, @now)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({ now });
  }

  get(): BackupWatermarkRow {
    const row = this.db.prepare(`SELECT * FROM backup_watermark WHERE id = 1`).get() as
      | BackupWatermarkRow
      | undefined;
    return row ?? { id: 1, seq: -1, healthy: 1, last_backup_at: null, updated_at: "", retry_count: 0, next_retry_at: null };
  }

  /**
   * A verified backup covered `coveredSeq`: advance the watermark (never
   * regressing), clear the block (transition to `unblocked`/`healthy`), and RESET
   * the durable retry state — a successful cut retires any degraded retry progress.
   */
  markCovered(coveredSeq: number, now: string): void {
    this.ensureRow(now);
    this.db
      .prepare(
        `UPDATE backup_watermark
           SET seq = MAX(seq, @seq), healthy = 1, last_backup_at = @now, updated_at = @now,
               retry_count = 0, next_retry_at = NULL
         WHERE id = 1`,
      )
      .run({ seq: coveredSeq, now });
  }

  /**
   * A backup attempt failed but bounded retries are NOT yet exhausted (contract:
   * healthy → degraded). Persist the durable retry progress (attempt count +
   * next-attempt time) so a restart RESUMES the retry machine rather than losing it
   * (round-3 finding 9). The watermark stays `healthy` (this run already committed;
   * only exhaustion blocks the NEXT run).
   */
  recordRetry(retryCount: number, nextRetryAt: string, now: string): void {
    this.ensureRow(now);
    this.db
      .prepare(
        `UPDATE backup_watermark SET retry_count = @retryCount, next_retry_at = @nextRetryAt, updated_at = @now WHERE id = 1`,
      )
      .run({ retryCount, nextRetryAt, now });
  }

  /**
   * Bounded durable retries exhausted (contract T4): enter the blocked state.
   * Does not regress `seq` — it still reflects the last verified coverage. The
   * durable retry state is retained so diagnostics/reconciliation see the degraded
   * history; `markCovered`/`forceUnblock` clears it.
   */
  markBlocked(now: string): void {
    this.ensureRow(now);
    this.db.prepare(`UPDATE backup_watermark SET healthy = 0, updated_at = @now WHERE id = 1`).run({ now });
  }

  /**
   * `--force-unblock` (T6) / `db restore` (T7): accept an RPO gap and clear the
   * block at `acceptedSeq` without a fresh verified backup covering it.
   */
  forceUnblock(acceptedSeq: number, now: string): void {
    this.ensureRow(now);
    this.db
      .prepare(
        `UPDATE backup_watermark
           SET seq = MAX(seq, @seq), healthy = 1, updated_at = @now, retry_count = 0, next_retry_at = NULL
         WHERE id = 1`,
      )
      .run({ seq: acceptedSeq, now });
  }
}

/** The {@link WatermarkHealth} surface for `doctor`/`--json`/`db status` (D12). */
export function watermarkHealth(db: SqliteDatabase): WatermarkHealth {
  const wm = new WatermarkRepo(db).get();
  return { seq: latestRunSeq(db), coveredSeq: wm.seq, healthy: wm.healthy === 1 };
}

/**
 * The fail-closed gate: throw {@link BackupUnhealthyError} (exit 2) if the
 * watermark is blocked. Ledger-writing commands call this BEFORE
 * `finalizeLedgerWrite`; non-persisting diagnostics and `db restore` never do
 * (contract §6 degraded-mode matrix).
 */
export function assertBackupHealthy(db: SqliteDatabase): void {
  const h = watermarkHealth(db);
  if (!h.healthy) throw new BackupUnhealthyError(h.coveredSeq, h.seq);
}
