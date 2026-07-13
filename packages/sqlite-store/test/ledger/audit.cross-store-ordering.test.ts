/**
 * `audit.cross-store-ordering` (plan §2.8). Inject a crash between every pair of
 * the four ordered steps (both directions) and assert convergence via
 * `reconcileInterruptedRuns`: no anchored-but-unlanded event, no duplicate, no
 * lost event; idempotency key `(runId, seq)`; a `done` intent with no backup
 * coverage re-drives step 4.
 */
import { afterEach, describe, expect, it } from "vitest";
import { finalizeLedgerWrite, reconcileInterruptedRuns } from "../../src/index.js";
import { createLedgerHarness, runId, type LedgerHarness } from "./harness.js";

let h: LedgerHarness;
afterEach(() => h?.cleanup());

function auditRowsFor(store: ReturnType<LedgerHarness["openStore"]>, rid: string): number {
  return (
    store.db.prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE run_id = ?`).get(rid) as {
      c: number;
    }
  ).c;
}
function intentState(store: ReturnType<LedgerHarness["openStore"]>, rid: string): string | undefined {
  return (
    store.db.prepare(`SELECT state FROM audit_intents WHERE run_id = ?`).get(rid) as
      | { state: string }
      | undefined
  )?.state;
}
function agentRunsFor(store: ReturnType<LedgerHarness["openStore"]>, rid: string): number {
  return (
    store.db.prepare(`SELECT COUNT(*) AS c FROM agent_runs WHERE run_id = ?`).get(rid) as { c: number }
  ).c;
}
/** The serializable step-3 business write persisted in the intent for replay. */
function writeRun(rid: string) {
  return [
    {
      sql: `INSERT INTO agent_runs (run_id, operation, status, started_at, updated_at)
            VALUES (?, 'refresh', 'integrated', '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z')`,
      params: [rid],
    },
  ];
}

const CRASH_POINTS = ["after-intent", "after-append", "after-commit", "after-backup"] as const;

describe("audit.cross-store-ordering (§2.8)", () => {
  for (const crashAt of CRASH_POINTS) {
    it(`converges after a crash ${crashAt}`, async () => {
      h = await createLedgerHarness();
      const store = h.openStore();
      const rid = runId();

      // Run finalize but crash right after `crashAt`.
      await expect(
        finalizeLedgerWrite(store, h.service, {
          runId: rid,
          event: h.draft(rid),
          backup: h.backup,
          ledgerWrite: writeRun(rid),
          failpoint: (step) => {
            if (step === crashAt) throw new Error(`injected crash ${step}`);
          },
        }),
      ).rejects.toThrow(/injected crash/);

      // Recover on a fresh broker (restart) with the backup config so step 4 re-drives.
      const svc2 = h.newService();
      const report = await reconcileInterruptedRuns(store, svc2, { backup: h.backup });

      // Exactly one audit event landed for the run — no dup, no loss.
      expect(auditRowsFor(store, rid)).toBe(1);
      expect(intentState(store, rid)).toBe("done");
      // The COMPLETE step-3 op converged: the business `agent_runs` row is present
      // exactly once at EVERY crash point (F5) — never an anchored event with a
      // missing business row.
      expect(agentRunsFor(store, rid)).toBe(1);

      // No anchored-but-unlanded event + full backup coverage after recovery.
      expect(report.backupGap).toBe(false);
      expect(report.health.healthy).toBe(true);
      expect(report.health.coveredSeq).toBe(report.health.seq);

      // Reconcile is idempotent: a second pass changes nothing.
      const again = await reconcileInterruptedRuns(store, svc2, { backup: h.backup });
      expect(again.reconciled).toBe(0);
      expect(auditRowsFor(store, rid)).toBe(1);

      store.close();
    });
  }

  it("a clean run needs no reconciliation and is idempotent under a redundant pass", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();
    const rid = runId();
    const out = await finalizeLedgerWrite(store, h.service, {
      runId: rid,
      event: h.draft(rid),
      backup: h.backup,
      ledgerWrite: writeRun(rid),
    });
    expect(out.seq).toBe(0);
    expect(agentRunsFor(store, rid)).toBe(1);
    const report = await reconcileInterruptedRuns(store, h.service, { backup: h.backup });
    expect(report.reconciled).toBe(0);
    expect(report.backupGap).toBe(false);
    expect(auditRowsFor(store, rid)).toBe(1);
    store.close();
  });

  it("seq stays gapless across interleaved runs recovered out of a crash", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();
    // Run A commits cleanly (seq 0).
    const a = runId();
    await finalizeLedgerWrite(store, h.service, { runId: a, event: h.draft(a), backup: h.backup, ledgerWrite: [] });
    // Run B crashes after its intent (seq 1 allocated, never appended).
    const b = runId();
    await expect(
      finalizeLedgerWrite(store, h.service, {
        runId: b,
        event: h.draft(b),
        backup: h.backup,
        ledgerWrite: [],
        failpoint: (s) => {
          if (s === "after-intent") throw new Error("crash");
        },
      }),
    ).rejects.toThrow();

    // Reconcile drives B's pending seq-1 intent to done via the (idempotent) broker append.
    const svc2 = h.newService();
    await reconcileInterruptedRuns(store, svc2, { backup: h.backup });

    // A new run C on the post-restart broker allocates the NEXT gapless seq (2).
    const c = runId();
    await finalizeLedgerWrite(store, svc2, { runId: c, event: h.draft(c), backup: h.backup, ledgerWrite: [] });

    const seqs = (
      store.db
        .prepare(`SELECT seq FROM audit_events WHERE event_type NOT LIKE 'db.%' ORDER BY seq`)
        .all() as { seq: number }[]
    ).map((r) => r.seq);
    expect(seqs).toEqual([0, 1, 2]); // gapless
    store.close();
  });
});
