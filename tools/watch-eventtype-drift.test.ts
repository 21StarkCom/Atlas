import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "./cli-contract.js";

/**
 * Ledger seq-space + DDL-allowlist gates (originally SP-1 Phase 2 Task 4). The
 * `watch.schema.json` replica half is RETIRED with the `watch` command (v2,
 * #333); what survives here are the EXECUTABLE gates over the still-live ledger
 * sources — the `audit_events` DDL CHECK allowlist and the two-seq-space
 * allocator predicate in `packages/sqlite-store/src/ledger/intents.ts` (the
 * #217 seq-partition bug class). These die with the ledger itself in Phase 4
 * (#338), not before.
 */

const root = findRepoRoot();

/** Parse the event_type CHECK allowlist out of the migration source (the SSOT). */
function ddlEventTypes(): string[] {
  const src = readFileSync(join(root, "packages/sqlite-store/migrations/0001_core.ts"), "utf8");
  const check = /event_type\s+TEXT\s+NOT NULL\s+CHECK\s*\(event_type IN \(([\s\S]*?)\)\)/.exec(src);
  if (!check) throw new Error("0001_core.ts: audit_events event_type CHECK not found");
  const kinds = [...check[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (kinds.length === 0) throw new Error("0001_core.ts: empty event_type CHECK allowlist");
  return kinds;
}

describe("audit_events DDL CHECK allowlist (SSOT shape)", () => {
  it("the DDL allowlist is the expected 14 kinds (10 run.* + 4 non-run.%)", () => {
    const ddl = ddlEventTypes();
    expect(ddl).toHaveLength(14);
    expect(ddl.filter((k) => k.startsWith("run.")).length).toBe(10);
  });

  it("the DDL's non-run.% kinds are exactly the 3 db.* kinds plus evidence.retry_enqueued", () => {
    const high = ddlEventTypes().filter((k) => !k.startsWith("run."));
    expect(high.sort()).toEqual(
      ["db.backup", "db.force_unblock", "db.restore", "evidence.retry_enqueued"].sort(),
    );
  });
});

describe("seq-space classification ↔ ledger/intents.ts (the executable predicate)", () => {
  const intentsSrc = readFileSync(join(root, "packages/sqlite-store/src/ledger/intents.ts"), "utf8");

  it("DB_EVENT_SEQ_BASE is 10^12 in intents.ts", () => {
    expect(intentsSrc).toMatch(/DB_EVENT_SEQ_BASE\s*=\s*1_000_000_000_000/);
  });

  it("the high-space allocator counts every non-run.% row (NOT LIKE 'run.%'), never db.%-only", () => {
    const alloc = /function nextDbEventSeq[\s\S]*?\n\}/.exec(intentsSrc);
    expect(alloc, "nextDbEventSeq not found in intents.ts").toBeTruthy();
    expect(alloc![0]).toContain("NOT LIKE 'run.%'");
    expect(alloc![0]).not.toContain("LIKE 'db.%'");
  });
});
