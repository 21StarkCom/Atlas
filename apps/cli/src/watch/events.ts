/**
 * `watch/events` — the SSOT-bound event payload builders (SP-1 Phase 4 Task 2).
 * Each returns the matching `watch.schema.json` member. `job` is the
 * `projectJobListRow` output verbatim (never a second copy of the shape);
 * `model_call`/`audit` are the DDL columns camelCased (`audit` omits
 * `payload_hash` — an integrity internal); `backup` exposes the DDL column `seq`
 * as `watermarkSeq` (the ONE documented correlation rename, §7.3); `daemon` is
 * transition-only and carries `previousReachable` so a consumer renders the
 * transition without state.
 */
import type { JobListRow } from "@atlas/jobs";
import { nowIso, type AuditEventRow, type WatchErrorLine, type WatchEvent } from "./types.js";

/** A `job` event — the jobs-list item shape (the SSOT projection) + the envelope. */
export function buildJobEvent(row: JobListRow): WatchEvent {
  return { v: 1, event: "job", at: nowIso(), ...row };
}

/** One `model_calls` row, DDL columns camelCased. */
export interface ModelCallRow {
  callId: string;
  runId: string;
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  createdAt: string;
}

export function buildModelCallEvent(row: ModelCallRow): WatchEvent {
  return { v: 1, event: "model_call", at: nowIso(), ...row };
}

/** An `audit` event; `gitHead` is OMITTED (never null) when the DDL column is NULL. */
export function buildAuditEvent(row: AuditEventRow): WatchEvent {
  return {
    v: 1,
    event: "audit",
    at: nowIso(),
    seq: row.seq,
    runId: row.runId,
    eventType: row.eventType,
    ...(row.gitHead !== null ? { gitHead: row.gitHead } : {}),
    createdAt: row.createdAt,
  };
}

/** The `backup_watermark` row state; `lastBackupAt` omitted when NULL. */
export interface BackupRowState {
  watermarkSeq: number;
  healthy: boolean;
  lastBackupAt: string | null;
  updatedAt: string;
}

export function buildBackupEvent(row: BackupRowState): WatchEvent {
  return {
    v: 1,
    event: "backup",
    at: nowIso(),
    watermarkSeq: row.watermarkSeq,
    healthy: row.healthy,
    ...(row.lastBackupAt !== null ? { lastBackupAt: row.lastBackupAt } : {}),
    updatedAt: row.updatedAt,
  };
}

export function buildDaemonEvent(
  daemon: "broker" | "egress",
  socketPath: string,
  reachable: boolean,
  previousReachable: boolean,
): WatchEvent {
  return { v: 1, event: "daemon", at: nowIso(), daemon, socketPath, reachable, previousReachable };
}

/** A non-fatal `watch.error` line (§7.1) — the stream continues after it. */
export function buildWatchError(source: WatchErrorLine["source"], code: string, message: string): WatchErrorLine {
  return { v: 1, event: "watch.error", at: nowIso(), source, code, message };
}
