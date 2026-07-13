/**
 * `ledger/finalize` — `finalizeLedgerWrite`, the sole cross-store orchestrator
 * (plan §2.8). Every ledger-writing run funnels through it in this EXACT order:
 *
 *   1. **Intent txn (SQLite):** allocate the monotonic audit `seq` + persist the
 *      `pending` intent (the serialization point — {@link IntentsRepo.allocate}).
 *   2. **Git append (broker):** submit the VALIDATED UNSIGNED event; the broker
 *      signs it internally with the attestation key (F4) and appends to
 *      `refs/audit/runs`, returning `{seq, head}`. Idempotent on `(runId, seq)`.
 *   3. **Ledger commit (SQLite):** ONE transaction writes the run's ledger rows
 *      (the caller's `write` closure) + the `audit_events` row + flips the intent
 *      to `done`.
 *   4. **Backup + watermark:** a post-commit encrypted backup with bounded
 *      durable retries; verified success advances the fail-closed watermark, and
 *      exhausted retries mark it blocked so the NEXT ledger-writing run is refused
 *      `backup-unhealthy` (this run already committed, so step 4 never throws).
 *
 * Crash recovery for a run interrupted between any two steps is
 * {@link reconcileInterruptedRuns} (see `./reconcile.ts`).
 */
import type { Store } from "../store.js";
import {
  IntentsRepo,
  applyLedgerWrite,
  type AuditEventDraft,
  type LedgerStatement,
  type UnsignedAuditEvent,
} from "./intents.js";
import { WatermarkRepo, assertBackupHealthy } from "../backup/watermark.js";
import { takeBackup, type LedgerBackupConfig } from "../backup/backup.js";

/** The broker surface `finalizeLedgerWrite` consumes (§2.8 step 2). Structural,
 * so `sqlite-store` never imports `@atlas/broker` (acyclic seam) — the broker
 * signs internally (F4). */
export interface AuditBroker {
  signAndAppendAuditEvent(unsigned: UnsignedAuditEvent): Promise<{ seq: number; head: string }>;
}

/** The four §2.8 steps, exposed as failpoints so tests inject crashes at each seam. */
export type FinalizeStep = "after-intent" | "after-append" | "after-commit" | "after-backup";

/** The result of {@link finalizeLedgerWrite}: the allocated audit `seq` + git head. */
export interface FinalizeResult {
  readonly seq: number;
  readonly head: string;
}

/** Everything a single ledger-writing run supplies to {@link finalizeLedgerWrite}. */
export interface RunContext {
  /** The run's ULID (idempotency key component with the allocated `seq`). */
  readonly runId: string;
  /** The audit event to anchor (sans `seq` — allocated in step 1 — and `prevAuditHead` — the broker fills it). */
  readonly event: AuditEventDraft;
  /**
   * The run's serializable step-3 business ledger writes. Persisted in the intent
   * so {@link reconcileInterruptedRuns} can replay the COMPLETE step-3 operation
   * (business rows + audit row), not merely the audit row, after a crash between
   * any two of the four steps. May be `[]` for a run that writes only its audit
   * event. Statements should be idempotent (see {@link LedgerStatement}).
   */
  readonly ledgerWrite: readonly LedgerStatement[];
  /**
   * Step 4 is MANDATORY (fail-closed §2.8): every ledger-writing run funnels a
   * post-commit verified backup + watermark advance through the sole orchestrator,
   * so a caller can neither omit backup nor bypass the watermark.
   */
  readonly backup: LedgerBackupConfig;
  /** Bounded durable backup retries before entering the blocked state (default 2). */
  readonly backupRetries?: number;
  /** Injectable clock. */
  readonly now?: () => string;
  /** Crash-injection failpoint (tests). Throwing simulates a crash after that step. */
  readonly failpoint?: (step: FinalizeStep) => void | Promise<void>;
}

const DEFAULT_BACKUP_RETRIES = 2;

function rfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Run a ledger-writing run through the §2.8 four-step protocol. The fail-closed
 * gate and the step-4 backup/watermark are INTRINSIC to this sole orchestrator
 * (round-2 finding): the run is refused up-front if the watermark is blocked, and
 * every run takes a post-commit backup — a caller can neither write while blocked
 * nor skip backup coverage.
 */
export async function finalizeLedgerWrite(
  store: Store,
  broker: AuditBroker,
  run: RunContext,
): Promise<FinalizeResult> {
  const now = run.now ?? rfc3339;
  const db = store.db;
  const intents = new IntentsRepo(db);

  // ── Step 0: intrinsic fail-closed gate ─────────────────────────────────────
  // A blocked watermark refuses the run BEFORE any state changes (F2): callers
  // cannot continue writing while `backup-unhealthy`. Throws BackupUnhealthyError
  // (exit 2). Read-only diagnostics never reach this path.
  assertBackupHealthy(db);

  // ── Step 1: intent txn + seq allocation (the serialization point) ──────────
  const allocated = intents.allocate(run.runId, run.event, run.ledgerWrite, now());
  await run.failpoint?.("after-intent");

  // ── Step 2: broker append (broker signs internally, F4). Idempotent. ───────
  const { head } = await broker.signAndAppendAuditEvent(allocated.event);
  await run.failpoint?.("after-append");

  // ── Step 3: ledger commit — business rows + audit_events + intent→done, atomically
  const commit = db.transaction(() => {
    applyLedgerWrite(db, run.ledgerWrite);
    store.ledger.insertAuditEvent({
      seq: allocated.seq,
      run_id: run.runId,
      event_type: run.event.kind,
      payload_hash: allocated.payloadHash,
      git_head: head,
      created_at: now(),
    });
    intents.markDone(run.runId, allocated.seq, now());
  });
  commit();
  await run.failpoint?.("after-commit");

  // ── Step 4 (MANDATORY): post-commit backup + watermark (fail-closed) ───────
  await runBackupStep(store, run.backup, run.backupRetries ?? DEFAULT_BACKUP_RETRIES, now);
  await run.failpoint?.("after-backup");

  return { seq: allocated.seq, head };
}

/** Base backoff (seconds) for the durable backup-retry machine; doubles per attempt. */
const RETRY_BACKOFF_BASE_SECONDS = 5;

/** `now()`-relative RFC-3339 time `seconds` in the future (best-effort parse of `now`). */
function plusSeconds(now: () => string, seconds: number): string {
  const base = Date.parse(now());
  const ms = Number.isNaN(base) ? Date.now() : base;
  return new Date(ms + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Step 4: take a verified backup with bounded, DURABLE retries (round-3 finding 9).
 * Each failed attempt persists the retry progress (attempt count + backoff
 * next-attempt time) to `backup_watermark`, so a restart RESUMES the retry machine
 * (via {@link reconcileInterruptedRuns}) instead of silently losing it. On success
 * the watermark advances + retry state resets (inside {@link takeBackup}); on
 * exhausted retries the watermark is marked blocked (contract T4). This NEVER
 * throws — the run's rows are already committed; the block gates the NEXT run.
 */
export async function runBackupStep(
  store: Store,
  cfg: LedgerBackupConfig,
  retries: number,
  now: () => string,
): Promise<void> {
  const wm = new WatermarkRepo(store.db);
  const attempts = Math.max(1, retries + 1);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await takeBackup(store, cfg, { now });
      return; // takeBackup advanced the watermark to the verified cut + reset retry state
    } catch (e) {
      lastErr = e;
      // Persist the degraded retry progress BEFORE the next attempt, so a crash
      // mid-retry leaves a durable record reconciliation resumes from.
      const spent = i + 1;
      if (spent < attempts) {
        wm.recordRetry(spent, plusSeconds(now, RETRY_BACKOFF_BASE_SECONDS * 2 ** i), now());
      }
    }
  }
  // Bounded retries exhausted → blocked (fail closed). Record why for diagnostics.
  wm.markBlocked(now());
  void lastErr;
}
