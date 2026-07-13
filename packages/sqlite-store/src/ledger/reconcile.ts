/**
 * `ledger/reconcile` — `reconcileInterruptedRuns`, the §2.8 crash-recovery pass
 * run on startup. It converges every run interrupted between any two of the four
 * ordered steps, idempotently on `(runId, seq)`, with no anchored-but-unlanded
 * event and no duplicate or lost event.
 *
 * For each still-`pending` intent (oldest seq first, so the gapless git chain is
 * driven in order):
 *
 *   - **pending, no git event yet** → re-drive step 2: submit the persisted
 *     unsigned event to the broker (idempotent on `(runId, seq)`), then land
 *     step 3.
 *   - **pending, git event already anchored** → the broker replay returns the
 *     anchored `{seq, head}`; land step 3 (write the `audit_events` row + flip the
 *     intent), completing the interrupted commit idempotently.
 *
 * Landing step 3 replays the COMPLETE persisted operation — the run's business
 * rows (from the intent's `write_json`) AND the `audit_events` row + intent flip —
 * in one transaction. A pending intent means step 3 never committed (it is atomic),
 * so the business rows are absent and are reconstructed exactly, guaranteeing no
 * anchored event is ever left with missing business ledger state (§2.8 invariant:
 * the audit event and its business rows are consistent across the git ref and the
 * ledger).
 *
 * Finally, a `done` intent whose cut is not yet covered by a verified backup
 * (§2.8 "a `done` intent with no backup coverage → re-attempt step 4") re-drives
 * step 4 when a backup config is supplied.
 */
import type { Store } from "../store.js";
import { IntentsRepo, applyLedgerWrite, latestRunSeq } from "./intents.js";
import type { AuditBroker } from "./finalize.js";
import { runBackupStep, readCoalesceCovers } from "./finalize.js";
import { WatermarkRepo, type WatermarkHealth, watermarkHealth } from "../backup/watermark.js";
import type { LedgerBackupConfig } from "../backup/backup.js";

/** Options for {@link reconcileInterruptedRuns} (the plan's 2-arg call still works). */
export interface ReconcileOptions {
  /** When set, re-drive step 4 for any uncovered `done` cut (post-recovery backup). */
  readonly backup?: LedgerBackupConfig;
  /** Bounded backup retries for the step-4 re-drive (default 2). */
  readonly backupRetries?: number;
  readonly now?: () => string;
}

/** What {@link reconcileInterruptedRuns} converged. */
export interface ReconcileReport {
  /** Pending intents driven to `done`. */
  readonly reconciled: number;
  /** Of those, how many had to (re-)append the git event (step 2 re-driven). */
  readonly appended: number;
  /** Whether a backup cut remained uncovered after reconciliation. */
  readonly backupGap: boolean;
  /** Whether a step-4 backup was re-driven (only when `opts.backup` was supplied). */
  readonly backupReDriven: boolean;
  /** The post-reconciliation watermark health. */
  readonly health: WatermarkHealth;
}

function rfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function reconcileInterruptedRuns(
  store: Store,
  broker: AuditBroker,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const now = opts.now ?? rfc3339;
  const db = store.db;
  const intents = new IntentsRepo(db);

  let reconciled = 0;
  let appended = 0;

  for (const row of intents.listPending()) {
    // Legacy-pending-intent handling (round-3 finding 5): a `pending` intent
    // written under `0001` (before `0005_ledger_finalize` added `event_json`) has
    // no re-drivable event. We NEVER fabricate one; such a pre-migration intent is
    // simply finalized to `done` (its step-2/step-3 either already landed or is
    // unrecoverable by this binary), leaving the gapless chain to a fresh run.
    if (!row.event_json || row.event_json.length === 0) {
      intents.markDone(row.run_id, row.seq, now());
      reconciled++;
      continue;
    }
    const event = IntentsRepo.parseEvent(row);
    const write = IntentsRepo.parseWrite(row);

    // Step 2 (idempotent): appends if absent, replays the anchored result if
    // already on the ref. Either way we obtain the authoritative git head.
    const { head } = await broker.signAndAppendAuditEvent(event);
    appended++;

    // Step 3 (idempotent): replay the COMPLETE step-3 operation — the run's
    // business rows AND the audit_events row + intent flip, atomically. A pending
    // intent means step 3 never committed (it is atomic), so the business rows are
    // absent; replaying the persisted `write_json` reconstructs them exactly, so a
    // crash after intent/append can never leave an anchored event with missing
    // business ledger state (round-2 finding).
    const commit = db.transaction(() => {
      applyLedgerWrite(db, write);
      store.ledger.insertAuditEvent({
        seq: row.seq,
        run_id: row.run_id,
        event_type: event.kind,
        payload_hash: row.payload_hash,
        git_head: head,
        created_at: now(),
      });
      intents.markDone(row.run_id, row.seq, now());
    });
    commit();
    reconciled++;
  }

  // Step 4 re-drive: a committed cut not yet covered by a verified backup. A gap
  // that is ENTIRELY coalesced Tier-0 reads within the debounce window is
  // INTENTIONAL (Task 1.9 read-run coalescing), not an interrupted write, so it
  // must NOT be force-backed-up here — doing so would defeat the debounce on every
  // reconciliation pass (round-2 finding). `readCoalesceCovers` reads the SAME
  // persisted policy state finalize used (audit_events kinds + watermark seq), so
  // reconciliation honors the threshold; a non-readonly uncovered event or a gap
  // past the window still re-drives the backup as before.
  const covered = new WatermarkRepo(db).get().seq;
  const latest = latestRunSeq(db);
  let backupGap = latest > covered && !readCoalesceCovers(db, covered);
  let backupReDriven = false;
  if (backupGap && opts.backup) {
    await runBackupStep(store, opts.backup, opts.backupRetries ?? 2, now);
    backupReDriven = true;
    backupGap = latestRunSeq(db) > new WatermarkRepo(db).get().seq && !readCoalesceCovers(db, new WatermarkRepo(db).get().seq);
  }

  return { reconciled, appended, backupGap, backupReDriven, health: watermarkHealth(db) };
}
