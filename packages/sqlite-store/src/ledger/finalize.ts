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
  latestRunSeq,
  type AuditEventDraft,
  type LedgerStatement,
  type UnsignedAuditEvent,
} from "./intents.js";
import { WatermarkRepo, assertBackupHealthy, watermarkHealth, BackupUnhealthyError } from "../backup/watermark.js";
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
  /**
   * Read-run backup COALESCING (Task 1.9). When `true`, step 4's post-commit full
   * backup MAY be skipped (coalesced) for this run — but ONLY when the event kind
   * is `run.readonly` and the coalesce policy ({@link readCoalesceCovers}) still
   * holds. The run always commits its ledger row + audit event (steps 1–3); a
   * cheap, high-frequency Tier-0 read simply does not each force a fresh encrypted
   * backup. The watermark then lags the newly committed seq (still `healthy`); the
   * next covering backup — an explicit `db backup`, a projection/mutation run, or a
   * read whose accumulated gap crosses {@link READ_COALESCE_THRESHOLD} — advances
   * coverage up to the latest seq. This bounds the read-amplification storage-DoS
   * finding (plan §2.6.1).
   *
   * The decision is made INTERNALLY here (round-2 finding): the flag is not an
   * arbitrary callback, so no ledger-writing caller can coalesce a real state
   * change or bypass its mandatory backup. Coalescing is restricted to
   * `run.readonly` and gated by the shared {@link readCoalesceCovers} predicate,
   * which {@link reconcileInterruptedRuns} also consults so a coalesced read is
   * never mistaken for an interrupted write and force-backed-up on the next pass.
   * Absent/`false` (the default) ⇒ every run takes its mandatory backup (Task
   * 1.7's original fail-closed behavior).
   */
  readonly coalesceReadonly?: boolean;
  /**
   * An additional step-3 mutation committed ATOMICALLY with the audit row inside
   * the SAME §2.8 transaction (Task 1.9 finding 2). `db rebuild` passes the
   * projection replacement here so the projection tables and the `run.projection`
   * audit event land (or roll back) together — closing the TOCTOU where
   * projections were committed BEFORE the intent/append/ledger transaction and
   * could be left changed after an audit failure. Runs BEFORE the `audit_events`
   * insert. It executes inside the outer transaction (better-sqlite3 nests it as a
   * SAVEPOINT), so a throw here rolls the whole run back and leaves the prior
   * projection intact. The mutation must be idempotently RE-DERIVABLE from source
   * (a projection rebuild is), since a crash after step 2 is converged by re-running
   * the command, not by {@link reconcileInterruptedRuns} (which replays only the
   * serializable `ledgerWrite`, never this closure).
   */
  readonly extraCommit?: (db: Store["db"]) => void;
  /**
   * STRICT backup (Task 1.9 finding 2): when `true`, exhausting the bounded backup
   * retries in step 4 THROWS {@link BackupUnhealthyError} rather than silently
   * marking the watermark blocked and returning success. A real state change (a
   * projection rebuild) must never report exit 0 without a covering backup, so its
   * caller propagates the failure; the run's rows are already committed, so the
   * next run is additionally gated by the blocked watermark. Never set for a
   * coalescible `run.readonly` (its backup is legitimately skipped).
   */
  readonly strictBackup?: boolean;
  /** Injectable clock. */
  readonly now?: () => string;
  /** Crash-injection failpoint (tests). Throwing simulates a crash after that step. */
  readonly failpoint?: (step: FinalizeStep) => void | Promise<void>;
}

const DEFAULT_BACKUP_RETRIES = 2;

/**
 * The debounce window for read-run backup coalescing (Task 1.9): a `run.readonly`
 * run skips its own full backup while the number of committed `run.*` seqs not yet
 * covered by a verified backup stays below this many. Chosen well above 1 so a
 * single interactive read never forces a backup, yet bounded so coverage still
 * advances under sustained read load. Backups also advance on any `db backup`,
 * projection, or mutation run. Owned here (not the CLI) so
 * {@link readCoalesceCovers} — consulted by BOTH finalize's step-4 skip and
 * reconcile's step-4 re-drive — shares one source of truth.
 */
export const READ_COALESCE_THRESHOLD = 64;

/**
 * The read-run coalescing policy, shared by {@link finalizeLedgerWrite} (deciding
 * to SKIP a read's backup) and {@link reconcileInterruptedRuns} (deciding NOT to
 * force-backup a coalesced gap). Returns `true` when the uncovered tail above
 * `coveredSeq` is an INTENTIONAL coalesced-read lag — i.e. every committed `run.*`
 * event above the watermark is a `run.readonly` AND the accumulated gap is still
 * within `threshold`. Any non-readonly uncovered event (a real state change that
 * committed but was not yet backed up — e.g. an interrupted write) OR a gap that
 * has crossed the debounce window makes this `false`, so that tail is backed up.
 *
 * The persisted state this reads — `audit_events.event_type` per seq and the
 * watermark `seq` — is exactly what lets reconciliation honor the threshold across
 * a restart instead of eagerly backing up every coalesced read (round-2 finding).
 */
export function readCoalesceCovers(
  db: Store["db"],
  coveredSeq: number,
  threshold: number = READ_COALESCE_THRESHOLD,
): boolean {
  const latest = latestRunSeq(db);
  if (latest <= coveredSeq) return true; // nothing uncovered
  if (latest - coveredSeq >= threshold) return false; // gap crossed the debounce window
  const rows = db
    .prepare(`SELECT event_type FROM audit_events WHERE seq > ? AND event_type NOT LIKE 'db.%' ORDER BY seq`)
    .all(coveredSeq) as { event_type: string }[];
  return rows.length > 0 && rows.every((r) => r.event_type === "run.readonly");
}

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

  // ── Step 3: ledger commit — business rows + optional extra mutation +
  //    audit_events + intent→done, ALL atomically (Task 1.9 finding 2: the
  //    projection replacement lands in the SAME transaction as its audit event).
  const commit = db.transaction(() => {
    applyLedgerWrite(db, run.ledgerWrite);
    run.extraCommit?.(db);
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

  // ── Step 4: post-commit backup + watermark (fail-closed) ───────────────────
  // MANDATORY by default. A read-run coalescing policy (Task 1.9) may SKIP this
  // run's full backup when the watermark is healthy and the accumulated coverage
  // gap is within the debounce window — the run's rows are already durable in the
  // committed DB; the next covering backup advances the watermark up to this seq.
  // Coalescing is decided INTERNALLY and restricted to `run.readonly` (round-2
  // finding): only a Tier-0 read whose kind is `run.readonly` may skip its backup,
  // and only while the shared policy holds (healthy watermark + the uncovered tail
  // is coalescible reads within the debounce window). A real state change can never
  // reach this skip.
  const wm = new WatermarkRepo(db).get();
  const coalesce =
    run.coalesceReadonly === true &&
    run.event.kind === "run.readonly" &&
    wm.healthy === 1 &&
    readCoalesceCovers(db, wm.seq);
  if (!coalesce) {
    const backedUp = await runBackupStep(store, run.backup, run.backupRetries ?? DEFAULT_BACKUP_RETRIES, now);
    // STRICT backup (finding 2): a real state change must not report success with
    // no covering backup. The watermark is already blocked; surface it so the
    // caller exits non-zero (the committed rows are recovered by the next run's
    // step-4 re-drive once the fault clears).
    if (!backedUp && run.strictBackup === true) {
      const h = watermarkHealth(db);
      throw new BackupUnhealthyError(h.coveredSeq, h.seq);
    }
  }
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
): Promise<boolean> {
  const wm = new WatermarkRepo(store.db);
  const attempts = Math.max(1, retries + 1);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await takeBackup(store, cfg, { now });
      return true; // takeBackup advanced the watermark to the verified cut + reset retry state
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
  return false;
}
