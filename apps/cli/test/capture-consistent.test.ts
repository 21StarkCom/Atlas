/**
 * `capture-consistent` (console watch SP-1, Phase 1 Task 1) — the SINGLE
 * probe-vs-capture consistency protocol shared by `status` and `watch`'s attach.
 * Proves it takes the EXACT shared `ReadonlyLedger` contract and covers the three
 * behaviours the plan pins: a stable read collapses to one resolve-then-capture; a
 * `data_version` bump under the probe forces a retry; and unbounded churn exhausts
 * the retry budget with a distinguishable bounded-retry error.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, openReadonlyLedger, type ReadonlyLedger, type Store } from "@atlas/sqlite-store";
import { captureConsistent } from "../src/health/snapshot.js";
import type { AnchorProbe } from "../src/audit/anchor-check.js";

let dir: string;
let writer: Store;
let ledger: ReadonlyLedger;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-capture-"));
  path = join(dir, "ledger.db");
  writer = openStore({ path });
  writer.migrate();
  writer.ledger.upsertAgentRun({
    run_id: "run-1",
    operation: "ingest",
    status: "planned",
    started_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
  });
  ledger = openReadonlyLedger(path);
});
afterEach(() => {
  ledger.close();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

const UNREACHABLE: AnchorProbe = { kind: "unreachable" };

/** Commit a write on the WRITER connection — bumps the read connection's `data_version`. */
let seq = 1;
function bumpDataVersion(): void {
  writer.ledger.insertAuditEvent({
    seq: seq++,
    run_id: "run-1",
    event_type: "run.started",
    payload_hash: "h".repeat(64),
    git_head: "a".repeat(40),
    created_at: "2026-07-14T00:00:00Z",
  });
}

describe("captureConsistent", () => {
  it("stable read: resolves the probe and runs capture exactly once", async () => {
    let captures = 0;
    const result = await captureConsistent(
      ledger,
      async () => UNREACHABLE, // no write under the probe ⇒ data_version stable
      (conn) => {
        captures++;
        return (conn.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get() as { n: number }).n;
      },
    );
    expect(result.probe).toEqual(UNREACHABLE);
    expect(result.captured).toBe(0);
    expect(captures).toBe(1);
  });

  it("retries when data_version moves under the probe, then succeeds on a stable read", async () => {
    let probeCalls = 0;
    let captures = 0;
    const result = await captureConsistent(
      ledger,
      async () => {
        probeCalls++;
        if (probeCalls === 1) bumpDataVersion(); // first probe straddles a commit ⇒ retry
        return UNREACHABLE;
      },
      (conn) => {
        captures++;
        return (conn.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get() as { n: number }).n;
      },
      { retries: 3 },
    );
    // Two probe rounds (first aborted by the bump, second stable); capture ran only
    // on the stable read (the aborted attempt returns before invoking capture).
    expect(probeCalls).toBe(2);
    expect(captures).toBe(1);
    expect(result.captured).toBe(1); // the one event the bump committed
  });

  it("throws a bounded-retry-exhausted error when the ledger never stabilises", async () => {
    let captures = 0;
    await expect(
      captureConsistent(
        ledger,
        async () => {
          bumpDataVersion(); // EVERY probe commits ⇒ data_version always moved ⇒ never stable
          return UNREACHABLE;
        },
        (conn) => {
          captures++;
          return conn;
        },
        { retries: 3 },
      ),
    ).rejects.toThrow(/bounded-retry-exhausted/);
    // Capture NEVER ran — every attempt aborted at the data_version re-check.
    expect(captures).toBe(0);
  });
});
