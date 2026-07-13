/**
 * `db.ledger` — the security-authoritative `audit_events` insert is idempotent
 * on `seq` but NEVER silently accepts a mismatched retry. `audit_events` is
 * append-only and immutable, so a retry reusing an existing `seq` with any
 * different immutable field (a different run/payload/head/timestamp) is a hard
 * conflict, not a no-op success.
 */
import { describe, expect, it } from "vitest";
import { AuditEventConflictError, openStore, type AuditEventRow } from "../src/index.js";

function migrated() {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  store.ledger.upsertAgentRun({
    run_id: "run-1",
    operation: "ingest",
    status: "planned",
    started_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
  });
  store.ledger.upsertAgentRun({
    run_id: "run-2",
    operation: "ingest",
    status: "planned",
    started_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
  });
  return store;
}

const BASE: AuditEventRow = {
  seq: 1,
  run_id: "run-1",
  event_type: "run.started",
  payload_hash: "h".repeat(64),
  git_head: "a".repeat(40),
  created_at: "2026-07-13T00:00:00Z",
};

describe("db.ledger audit_events idempotency", () => {
  it("a byte-identical retry is idempotent (single row, no throw)", () => {
    const store = migrated();
    try {
      store.ledger.insertAuditEvent(BASE);
      expect(() => store.ledger.insertAuditEvent({ ...BASE })).not.toThrow();
      expect(store.ledger.countAuditEvents()).toBe(1);
    } finally {
      store.close();
    }
  });

  it.each([
    ["run_id", { run_id: "run-2" }],
    ["event_type", { event_type: "run.integrated" as const }],
    ["payload_hash", { payload_hash: "z".repeat(64) }],
    ["git_head", { git_head: "b".repeat(40) }],
    ["created_at", { created_at: "2026-07-13T09:09:09Z" }],
  ])("rejects a retry with a different %s at the same seq", (_field, patch) => {
    const store = migrated();
    try {
      store.ledger.insertAuditEvent(BASE);
      expect(() =>
        store.ledger.insertAuditEvent({ ...BASE, ...(patch as Partial<AuditEventRow>) }),
      ).toThrow(AuditEventConflictError);
      // The original row is unchanged — the conflicting retry was rejected, not applied.
      const row = store.db.prepare(`SELECT * FROM audit_events WHERE seq = 1`).get() as AuditEventRow;
      expect(row.run_id).toBe("run-1");
      expect(row.event_type).toBe("run.started");
      expect(row.payload_hash).toBe("h".repeat(64));
      expect(store.ledger.countAuditEvents()).toBe(1);
    } finally {
      store.close();
    }
  });

  it("treats an absent git_head consistently (null retry after null insert is idempotent)", () => {
    const store = migrated();
    try {
      const noHead: AuditEventRow = { ...BASE, git_head: null };
      store.ledger.insertAuditEvent(noHead);
      expect(() => store.ledger.insertAuditEvent({ ...noHead })).not.toThrow();
      // But adding a head to a previously headless event IS a mismatch.
      expect(() => store.ledger.insertAuditEvent({ ...noHead, git_head: "c".repeat(40) })).toThrow(
        AuditEventConflictError,
      );
    } finally {
      store.close();
    }
  });
});
