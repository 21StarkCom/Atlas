/**
 * `ledger.dr-roundtrip` (contract §12). `db backup` → wipe/corrupt the ledger DB
 * → authorized `db restore` → every ledger row recovered byte-equal; the
 * post-restore rebuild hook fires. Wrong/revoked key + truncated/corrupt bundle
 * are rejected.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { PrivilegedOpDescriptor } from "@atlas/broker";
import {
  BackupIntegrityError,
  _resetPostRestoreRebuild,
  finalizeLedgerWrite,
  readBundleHeader,
  registerPostRestoreRebuild,
  restoreBackup,
  takeBackup,
  verifyBackup,
} from "../../src/index.js";
import { createLedgerHarness, runId, type LedgerHarness } from "./harness.js";

let h: LedgerHarness;
afterEach(() => {
  _resetPostRestoreRebuild();
  h?.cleanup();
});

/** The serializable step-3 business write for a `refresh` run. */
function writeRun(rid: string) {
  return [
    {
      sql: `INSERT INTO agent_runs (run_id, operation, status, started_at, updated_at)
            VALUES (?, 'refresh', 'integrated', '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z')`,
      params: [rid],
    },
  ];
}

/**
 * The COMPLETE required ledger-table state (finding #16): the audit stream
 * EXCLUDING the restore-added `db.restore` row, the durable intents, the business
 * `agent_runs`, and the watermark coverage — everything the backup is the system
 * of record for, so it must recover byte-equal.
 */
function ledgerDump(store: ReturnType<LedgerHarness["openStore"]>): {
  audit: unknown[];
  intents: unknown[];
  runs: unknown[];
  coveredSeq: number;
  healthy: number;
} {
  const wm = store.db.prepare(`SELECT seq, healthy FROM backup_watermark WHERE id = 1`).get() as
    | { seq: number; healthy: number }
    | undefined;
  return {
    // Exclude `db.restore` (restore adds it) but KEEP `db.backup` rows + run.* rows.
    audit: store.db
      .prepare(`SELECT * FROM audit_events WHERE event_type != 'db.restore' ORDER BY seq`)
      .all(),
    intents: store.db.prepare(`SELECT * FROM audit_intents ORDER BY seq`).all(),
    runs: store.db.prepare(`SELECT * FROM agent_runs ORDER BY run_id`).all(),
    coveredSeq: wm?.seq ?? -1,
    healthy: wm?.healthy ?? -1,
  };
}

/** The `db.restore` op descriptor the CLI/broker bind authorization to (§10.1). */
function restoreDescriptor(backupRef: string, contentHash: string): PrivilegedOpDescriptor {
  return {
    op: "db restore",
    canonicalBaseCommit: "0".repeat(40),
    intendedEffect: { kind: "restore", backupRef, backupContentHash: `sha256:${contentHash}` },
  };
}

describe("ledger.dr-roundtrip (§12)", () => {
  it("backup → wipe → authorized restore recovers the complete ledger state byte-equal", async () => {
    h = await createLedgerHarness();
    let store = h.openStore();

    // Commit three ledger-writing runs (each anchors an audit event + agent_runs row).
    const rids = [runId(), runId(), runId()];
    for (const rid of rids) {
      await finalizeLedgerWrite(store, h.service, {
        runId: rid,
        event: h.draft(rid),
        backup: h.backup,
        ledgerWrite: writeRun(rid),
      });
    }
    // Capture the complete required state BEFORE the explicit final backup snapshots it.
    const before = ledgerDump(store);
    expect((before.audit as unknown[]).filter((r) => (r as { event_type: string }).event_type.startsWith("run.")).length).toBe(3);
    expect(before.runs.length).toBe(3);
    expect(before.intents.length).toBe(3);

    // Take an explicit final backup (snapshots `before`) and capture its ref + hash.
    const { backupRef } = await takeBackup(store, h.backup);

    // A post-restore hook must fire (projection/index rebuild seam).
    let hookFired = false;
    registerPostRestoreRebuild(async (ctx) => {
      expect(ctx.db).toBeDefined();
      hookFired = true;
    });

    // Exercise the REAL challenge/authorization path (test-signer), binding the
    // authorization to the bundle's authenticated content hash (finding #16).
    const contentHash = readBundleHeader(h.backup, backupRef).contentHash;
    const desc = restoreDescriptor(backupRef, contentHash);
    const auth = h.authorize(desc);
    h.service.execAuthorized(desc, auth); // throws if the authorization does not verify

    // Corrupt the live DB (simulate disaster), then restore under the authorized hash.
    writeFileSync(h.dbPath, "totally corrupt not-a-sqlite-file", "utf8");
    const result = await restoreBackup(store, backupRef, h.backup, { expectedContentHash: contentHash });
    expect(result.restoredCutSeq).toBe(2); // highest run seq

    // Re-open and compare: the complete required state is byte-equal.
    store = h.openStore();
    const after = ledgerDump(store);
    expect(after.audit).toEqual(before.audit); // run.* + db.backup rows, intents-free
    expect(after.intents).toEqual(before.intents); // durable intents recovered
    expect(after.runs).toEqual(before.runs); // business rows recovered
    expect(after.coveredSeq).toBe(before.coveredSeq); // watermark re-established at the cut
    expect(after.healthy).toBe(1);
    expect(hookFired).toBe(true);

    // A `db.restore` audit row was recorded (D6).
    const restoreRows = store.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'db.restore'`)
      .get() as { c: number };
    expect(restoreRows.c).toBe(1);
    store.close();
  });

  it("restore refuses a bundle whose content hash differs from the authorized hash (TOCTOU)", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();
    const rid = runId();
    await finalizeLedgerWrite(store, h.service, {
      runId: rid,
      event: h.draft(rid),
      backup: h.backup,
      ledgerWrite: writeRun(rid),
    });
    const { backupRef } = await takeBackup(store, h.backup);

    // Authorization was bound to a DIFFERENT content hash than the bundle carries.
    await expect(
      restoreBackup(store, backupRef, h.backup, { expectedContentHash: "0".repeat(64) }),
    ).rejects.toThrow(BackupIntegrityError);
    store.close();
  });

  it("a wrong/revoked key fails verify + restore (never selectable)", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();
    const rid = runId();
    await finalizeLedgerWrite(store, h.service, { runId: rid, event: h.draft(rid), backup: h.backup, ledgerWrite: [] });
    const { backupRef } = await takeBackup(store, h.backup);

    const wrongKeyCfg = { ...h.backup, key: randomBytes(32) };
    expect(() => verifyBackup(wrongKeyCfg, backupRef)).toThrow(BackupIntegrityError);
    await expect(restoreBackup(store, backupRef, wrongKeyCfg)).rejects.toThrow(BackupIntegrityError);
    store.close();
  });

  it("a truncated/corrupt bundle fails verify (exit-1 class)", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();
    const rid = runId();
    await finalizeLedgerWrite(store, h.service, { runId: rid, event: h.draft(rid), backup: h.backup, ledgerWrite: [] });
    const { backupRef } = await takeBackup(store, h.backup);

    // Truncate the ciphertext → auth tag / content-hash check fails.
    const bundle = JSON.parse(readFileSync(backupRef, "utf8")) as { ciphertext: string };
    bundle.ciphertext = bundle.ciphertext.slice(0, Math.floor(bundle.ciphertext.length / 2));
    writeFileSync(backupRef, JSON.stringify(bundle), "utf8");
    expect(() => verifyBackup(h.backup, backupRef)).toThrow(BackupIntegrityError);
    store.close();
  });
});
