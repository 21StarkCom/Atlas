/**
 * `graduation-audit` (Task 5.2 / #58) — the read-only bootstrap audit is fail-closed: a healthy
 * chain + healthy backup + zero open runs passes; any unhealthy signal (broken chain, blocked
 * backup, an in-flight run) blocks graduation with a named blocker.
 */
import { describe, expect, it } from "vitest";
import { openStore, type Store } from "@atlas/sqlite-store";
import { graduationAudit, type AuditChainStatus } from "../src/graduation/audit.js";

const HEALTHY_CHAIN: AuditChainStatus = { ok: true, head: "a".repeat(40), count: 3 };

function store(): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  return s;
}

describe("graduation bootstrap audit (fail-closed)", () => {
  it("passes on a healthy chain + healthy backup + no open runs", () => {
    const s = store();
    try {
      const report = graduationAudit(s.db, HEALTHY_CHAIN);
      expect(report.ok).toBe(true);
      expect(report.openRuns).toBe(0);
      expect(report.blockers).toHaveLength(0);
    } finally {
      s.close();
    }
  });

  it("blocks on an unhealthy audit chain", () => {
    const s = store();
    try {
      const report = graduationAudit(s.db, { ok: false, head: "", count: 0, detail: "truncated" });
      expect(report.ok).toBe(false);
      expect(report.blockers.join(" ")).toMatch(/audit chain unhealthy/);
    } finally {
      s.close();
    }
  });

  it("blocks when a run is still in flight", () => {
    const s = store();
    try {
      s.db.prepare(
        `INSERT INTO agent_runs (run_id, operation, status, started_at, updated_at) VALUES (?, 'enrich', 'review-pending', '2026-07-16', '2026-07-16')`,
      ).run("run-open");
      const report = graduationAudit(s.db, HEALTHY_CHAIN);
      expect(report.ok).toBe(false);
      expect(report.openRuns).toBe(1);
      expect(report.blockers.join(" ")).toMatch(/in flight/);
    } finally {
      s.close();
    }
  });
});
