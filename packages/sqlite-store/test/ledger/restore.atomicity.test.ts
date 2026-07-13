/**
 * `restore.atomicity` (contract §10.4). A crash mid-restore (before the atomic
 * swap) leaves the prior DB fully intact — the restore is all-or-nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  restoreBackup,
  recoverInterruptedRestore,
  takeBackup,
  finalizeLedgerWrite,
  registerPostRestoreRebuild,
  _resetPostRestoreRebuild,
} from "../../src/index.js";
import { createLedgerHarness, runId, type LedgerHarness } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, "../../dist/src/index.js");
const CHILD = join(HERE, "restore-crash-child.mjs");

let h: LedgerHarness;
afterEach(() => {
  _resetPostRestoreRebuild();
  h?.cleanup();
});

function runCount(store: ReturnType<LedgerHarness["openStore"]>): number {
  return (
    store.db.prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE event_type NOT LIKE 'db.%'`).get() as {
      c: number;
    }
  ).c;
}
function restoreRowCount(store: ReturnType<LedgerHarness["openStore"]>): number {
  return (
    store.db.prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'db.restore'`).get() as {
      c: number;
    }
  ).c;
}

/** Baseline: a backup at cut 0, then a second committed run so live ≠ backup. */
async function twoRunBaselineWithBackup(store: ReturnType<LedgerHarness["openStore"]>) {
  const rid0 = runId();
  await finalizeLedgerWrite(store, h.service, { runId: rid0, event: h.draft(rid0), backup: h.backup, ledgerWrite: [] });
  const { backupRef } = await takeBackup(store, h.backup);
  const rid1 = runId();
  await finalizeLedgerWrite(store, h.service, { runId: rid1, event: h.draft(rid1), backup: h.backup, ledgerWrite: [] });
  expect(runCount(store)).toBe(2);
  return backupRef;
}

describe("restore.atomicity (§10.4)", () => {
  it("a crash before the swap leaves the prior DB intact", async () => {
    h = await createLedgerHarness();
    let store = h.openStore();
    const backupRef = await twoRunBaselineWithBackup(store);

    // Restore, but crash before the atomic swap.
    await expect(
      restoreBackup(store, backupRef, h.backup, {
        failpoint: (s) => {
          if (s === "before-swap") throw new Error("injected crash before swap");
        },
      }),
    ).rejects.toThrow(/before swap/);

    // The live DB is untouched: still both runs, still queryable, no db.restore row.
    store = h.openStore();
    expect(runCount(store)).toBe(2);
    expect(restoreRowCount(store)).toBe(0);

    // A subsequent real restore still succeeds (no leaked temp / lock).
    const ok = await restoreBackup(store, backupRef, h.backup);
    expect(ok.restoredCutSeq).toBe(0);
    store.close();
  });

  it("a crash AFTER the swap rolls the prior DB back (all-or-nothing, F6)", async () => {
    h = await createLedgerHarness();
    let store = h.openStore();
    const backupRef = await twoRunBaselineWithBackup(store);

    // Crash after the swap but before the watermark/D6 txn + hooks commit.
    await expect(
      restoreBackup(store, backupRef, h.backup, {
        failpoint: (s) => {
          if (s === "after-swap") throw new Error("injected crash after swap");
        },
      }),
    ).rejects.toThrow(/after swap/);

    // The prior DB was rolled back: still BOTH runs (not the 1-run backup), no db.restore row.
    store = h.openStore();
    expect(runCount(store)).toBe(2);
    expect(restoreRowCount(store)).toBe(0);

    // A subsequent real restore still succeeds.
    const ok = await restoreBackup(store, backupRef, h.backup);
    expect(ok.restoredCutSeq).toBe(0);
    store.close();
  });

  it("a post-restore hook failure rolls the prior DB back (all-or-nothing, F6)", async () => {
    h = await createLedgerHarness();
    let store = h.openStore();
    const backupRef = await twoRunBaselineWithBackup(store);

    // A rebuild hook that throws must roll the restore back entirely.
    registerPostRestoreRebuild(async () => {
      throw new Error("injected rebuild-hook failure");
    });
    await expect(restoreBackup(store, backupRef, h.backup)).rejects.toThrow(/rebuild-hook failure/);

    // The prior DB is intact (both runs), and NO db.restore row leaked.
    store = h.openStore();
    expect(runCount(store)).toBe(2);
    expect(restoreRowCount(store)).toBe(0);

    // With the hook cleared, a real restore succeeds.
    _resetPostRestoreRebuild();
    const ok = await restoreBackup(store, backupRef, h.backup);
    expect(ok.restoredCutSeq).toBe(0);
    store.close();
  });
});
