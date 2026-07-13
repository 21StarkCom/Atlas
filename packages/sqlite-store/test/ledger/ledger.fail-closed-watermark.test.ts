/**
 * `ledger.fail-closed-watermark` (contract §5, §6, §12). An injected backup
 * failure (exhausted retries, T4) blocks a subsequent ledger-writing run with
 * `backup-unhealthy` (exit 2); read-only diagnostics still work in `blocked`; a
 * verified backup unblocks (T5); `--force-unblock` records the audited RPO gap
 * (T6); `db restore` is never blocked (T7).
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  BackupUnhealthyError,
  BACKUP_UNHEALTHY_EXIT,
  assertBackupHealthy,
  finalizeLedgerWrite,
  forceUnblock,
  restoreBackup,
  takeBackup,
  watermarkHealth,
  _resetPostRestoreRebuild,
} from "../../src/index.js";
import { createLedgerHarness, runId, type LedgerHarness } from "./harness.js";

let h: LedgerHarness;
afterEach(() => {
  _resetPostRestoreRebuild();
  h?.cleanup();
});

/** A backup config whose writer always fails (AEAD key of the wrong length). */
function brokenBackup(h: LedgerHarness) {
  return { ...h.backup, key: randomBytes(16) };
}

async function commit(store: ReturnType<LedgerHarness["openStore"]>, h: LedgerHarness, backup?: unknown) {
  const rid = runId();
  await finalizeLedgerWrite(store, h.service, {
    runId: rid,
    event: h.draft(rid),
    backup: (backup ?? h.backup) as never,
    backupRetries: 1,
    ledgerWrite: [],
  });
  return rid;
}

describe("ledger.fail-closed-watermark (§5, §6, §12)", () => {
  it("exhausted backup retries block the next ledger-writing run (exit 2)", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();

    // A committed run whose post-commit backup fails → watermark enters `blocked`.
    await commit(store, h, brokenBackup(h));
    expect(watermarkHealth(store.db).healthy).toBe(false);

    // The fail-closed gate the NEXT ledger-writing command calls throws exit 2.
    try {
      assertBackupHealthy(store.db);
      throw new Error("gate should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BackupUnhealthyError);
      expect((e as BackupUnhealthyError).exitCode).toBe(BACKUP_UNHEALTHY_EXIT);
      expect((e as BackupUnhealthyError).code).toBe("backup-unhealthy");
    }

    // The gate is INTRINSIC to the sole orchestrator (F2): a SECOND
    // finalizeLedgerWrite is itself refused while blocked — a caller cannot keep
    // writing even with a healthy backup config, and it commits NOTHING.
    const auditBefore = (
      store.db.prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE event_type NOT LIKE 'db.%'`).get() as {
        c: number;
      }
    ).c;
    await expect(
      finalizeLedgerWrite(store, h.service, {
        runId: runId(),
        event: h.draft(runId()),
        backup: h.backup,
        ledgerWrite: [],
      }),
    ).rejects.toBeInstanceOf(BackupUnhealthyError);
    const auditAfter = (
      store.db.prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE event_type NOT LIKE 'db.%'`).get() as {
        c: number;
      }
    ).c;
    expect(auditAfter).toBe(auditBefore); // the refused run wrote nothing

    // Read-only, non-persisting diagnostics still work in `blocked` (they never
    // call the gate) — the ledger is fully readable.
    const rows = store.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE event_type NOT LIKE 'db.%'`)
      .get() as { c: number };
    expect(rows.c).toBe(1);
    expect(() => watermarkHealth(store.db)).not.toThrow();

    // A verified backup unblocks (T5) and steady state returns.
    await takeBackup(store, h.backup);
    expect(watermarkHealth(store.db).healthy).toBe(true);
    expect(() => assertBackupHealthy(store.db)).not.toThrow();
    store.close();
  });

  it("--force-unblock clears the block and records the audited RPO gap (T6)", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();

    await commit(store, h, h.backup); // seq 0 covered, healthy
    await commit(store, h, brokenBackup(h)); // seq 1 committed, backup fails → blocked
    expect(watermarkHealth(store.db).healthy).toBe(false);

    const { fromSeq, toSeq } = forceUnblock(store);
    expect(fromSeq).toBe(0); // last verified coverage
    expect(toSeq).toBe(1); // accepted up to the latest committed seq
    expect(watermarkHealth(store.db).healthy).toBe(true);

    const rows = store.db
      .prepare(`SELECT payload_hash FROM audit_events WHERE event_type = 'db.force_unblock'`)
      .all() as { payload_hash: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.payload_hash).toBe("force_unblock:0:1");
    store.close();
  });

  it("db restore is never blocked and establishes a fresh watermark (T7)", async () => {
    h = await createLedgerHarness();
    let store = h.openStore();

    await commit(store, h, h.backup); // seq 0, a valid backup exists
    const { backupRef } = await takeBackup(store, h.backup);
    await commit(store, h, brokenBackup(h)); // seq 1, backup fails → blocked
    expect(watermarkHealth(store.db).healthy).toBe(false);

    // Restore is allowed even while blocked (emergency recovery) and re-establishes health.
    const result = await restoreBackup(store, backupRef, h.backup);
    expect(result.restoredCutSeq).toBe(0);
    store = h.openStore();
    expect(watermarkHealth(store.db).healthy).toBe(true);
    store.close();
  });
});
