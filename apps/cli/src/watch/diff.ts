/**
 * `watch/diff` — the per-source diff cursors (SP-1 Phase 4 Task 1), built for the
 * fact that COMMIT ORDER ≠ KEY ORDER (§7.4): the low (`run.%`) audit space reads
 * `seq > contiguousPrefix` minus the sparse emitted-set (a late-committing lower
 * seq is emitted on the tick it commits, never twice); the high (non-`run.%`)
 * space and `model_calls` diff against incarnation-scoped seen-sets (full-scan —
 * correct at the §4 scale, immune to late commits carrying early timestamps);
 * `jobs` is a full-table diff via the SSOT `listAllJobs` reader comparing the
 * ENTIRE projected row; `backup_watermark` is a single-row compare. Fixed
 * per-tick source order: audit, model_call, job, backup — audit in `seq` order
 * within the batch.
 */
import type { SqliteDatabase } from "@atlas/sqlite-store";
import { listAllJobs, type JobListRow } from "@atlas/jobs";
import { DB_EVENT_SEQ_BASE } from "./attach.js";
import { buildAuditEvent, buildBackupEvent, buildJobEvent, buildModelCallEvent, type BackupRowState } from "./events.js";
import { recordLowSpaceEmitted } from "./incarnation.js";
import type { AuditEventRow, SourceBaselines, WatchEvent } from "./types.js";

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

interface RawAuditRow {
  seq: number;
  run_id: string;
  event_type: string;
  git_head: string | null;
  created_at: string;
}

function toAuditRow(r: RawAuditRow): AuditEventRow {
  return { seq: r.seq, runId: r.run_id, eventType: r.event_type, gitHead: r.git_head, createdAt: r.created_at };
}

/** Low-space: `seq > prefix` minus the sparse set; advance prefix + sparse via the sole mutator. */
function diffLowSpace(db: SqliteDatabase, state: SourceBaselines): WatchEvent[] {
  const rows = db
    .prepare(
      `SELECT seq, run_id, event_type, git_head, created_at FROM audit_events
       WHERE event_type LIKE 'run.%' AND seq > ? AND seq < ? ORDER BY seq ASC`,
    )
    .all(state.auditContiguousPrefix, DB_EVENT_SEQ_BASE) as RawAuditRow[];
  const out: WatchEvent[] = [];
  for (const r of rows) {
    if (state.auditSparseEmitted.has(r.seq)) continue; // already emitted / baseline-seen
    out.push(buildAuditEvent(toAuditRow(r)));
    recordLowSpaceEmitted(state, r.seq);
  }
  return out;
}

/** High-space (non-`run.%`): live-only, diffed against the incarnation-scoped seen-set. */
function diffHighSpace(db: SqliteDatabase, state: SourceBaselines): WatchEvent[] {
  const rows = db
    .prepare(
      `SELECT seq, run_id, event_type, git_head, created_at FROM audit_events
       WHERE event_type NOT LIKE 'run.%' ORDER BY seq ASC`,
    )
    .all() as RawAuditRow[];
  const out: WatchEvent[] = [];
  for (const r of rows) {
    if (state.highSpaceEmitted.has(r.seq)) continue;
    state.highSpaceEmitted.add(r.seq);
    out.push(buildAuditEvent(toAuditRow(r)));
  }
  return out;
}

/** `model_calls`: full-scan diff by `call_id` (no `created_at` window — late commits survive). */
function diffModelCalls(db: SqliteDatabase, state: SourceBaselines): WatchEvent[] {
  if (!tableExists(db, "model_calls")) return [];
  const rows = db
    .prepare(
      `SELECT call_id, run_id, provider, model, operation, input_tokens, output_tokens, cost_micros, created_at
       FROM model_calls ORDER BY created_at ASC, call_id ASC`,
    )
    .all() as {
    call_id: string;
    run_id: string;
    provider: string;
    model: string;
    operation: string;
    input_tokens: number;
    output_tokens: number;
    cost_micros: number;
    created_at: string;
  }[];
  const out: WatchEvent[] = [];
  for (const r of rows) {
    if (state.modelCallEmitted.has(r.call_id)) continue;
    state.modelCallEmitted.add(r.call_id);
    out.push(
      buildModelCallEvent({
        callId: r.call_id,
        runId: r.run_id,
        provider: r.provider,
        model: r.model,
        operation: r.operation,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costMicros: r.cost_micros,
        createdAt: r.created_at,
      }),
    );
  }
  return out;
}

/** Whole-projection equality — a change confined to ANY JobListRow field still emits. */
function sameJobRow(a: JobListRow, b: JobListRow): boolean {
  return (
    a.jobId === b.jobId &&
    a.workflow === b.workflow &&
    a.state === b.state &&
    a.attempts === b.attempts &&
    a.maxAttempts === b.maxAttempts &&
    a.nextRunAt === b.nextRunAt &&
    a.lastError === b.lastError &&
    a.updatedAt === b.updatedAt
  );
}

/** `jobs`: full-table diff via the SSOT `listAllJobs` reader vs the full projected map. */
function diffJobs(db: SqliteDatabase, state: SourceBaselines): WatchEvent[] {
  if (!tableExists(db, "jobs")) return [];
  const rows = listAllJobs(db);
  const out: WatchEvent[] = [];
  const liveIds = new Set<string>();
  for (const row of rows) {
    liveIds.add(row.jobId);
    const prior = state.jobsMap.get(row.jobId);
    if (prior === undefined || !sameJobRow(prior, row)) {
      // Current-state semantics: one event with the latest observed state (kubectl
      // MODIFIED — intermediate transitions inside one interval coalesce, §7.4).
      state.jobsMap.set(row.jobId, row);
      out.push(buildJobEvent(row));
    }
  }
  // A vanished row (purge) simply leaves the map — no synthetic event type exists for it.
  for (const id of [...state.jobsMap.keys()]) {
    if (!liveIds.has(id)) state.jobsMap.delete(id);
  }
  return out;
}

/** `backup_watermark`: single-row compare vs the baseline. */
function diffBackup(db: SqliteDatabase, state: SourceBaselines): WatchEvent[] {
  const wm = db
    .prepare(`SELECT seq, healthy, last_backup_at, updated_at FROM backup_watermark WHERE id = 1`)
    .get() as { seq: number; healthy: number; last_backup_at: string | null; updated_at: string } | undefined;
  if (wm === undefined) return [];
  const row: BackupRowState = {
    watermarkSeq: wm.seq,
    healthy: wm.healthy === 1,
    lastBackupAt: wm.last_backup_at,
    updatedAt: wm.updated_at,
  };
  const prior = state.backupRow;
  const changed =
    prior === null ||
    prior.watermarkSeq !== row.watermarkSeq ||
    prior.healthy !== row.healthy ||
    prior.lastBackupAt !== row.lastBackupAt ||
    prior.updatedAt !== row.updatedAt;
  if (!changed) return [];
  state.backupRow = row;
  // Latest-state only — an intermediate watermark value superseded within one
  // interval is not separately emitted (§7.4 current-state coalescing).
  return [buildBackupEvent(row)];
}

/**
 * Diff the four sources against the incarnation baselines and return the events
 * in the fixed §7.4 per-tick source order: audit (both spaces, `seq` order),
 * model_call, job, backup.
 */
export function diffSources(conn: SqliteDatabase, state: SourceBaselines): WatchEvent[] {
  const audit = [...diffLowSpace(conn, state), ...diffHighSpace(conn, state)].sort(
    (a, b) => (a.seq as number) - (b.seq as number),
  );
  return [...audit, ...diffModelCalls(conn, state), ...diffJobs(conn, state), ...diffBackup(conn, state)];
}
