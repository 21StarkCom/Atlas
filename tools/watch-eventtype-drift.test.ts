import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "./cli-contract.js";

/**
 * SP-1 Phase 2 Task 4 — `watch.schema.json`'s `audit.eventType` enum is a REPLICA
 * of the `audit_events` DDL CHECK (the SSOT, `packages/sqlite-store/migrations/
 * 0001_core.ts`), and the two-seq-space classification the spec/schema describe
 * must match the executable predicate in `packages/sqlite-store/src/ledger/
 * intents.ts`. Both sides are derived AT RUNTIME from the owning source files —
 * nothing here is hardcoded — so a new DDL kind, a renamed kind, or a changed
 * allocator predicate fails CI until the schema replica catches up.
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

function schemaEventTypes(): string[] {
  const schema = JSON.parse(
    readFileSync(join(root, "docs/specs/cli-contract/watch.schema.json"), "utf8"),
  ) as { $defs: { audit: { properties: { eventType: { enum: string[] } } } } };
  return schema.$defs.audit.properties.eventType.enum;
}

describe("watch.schema.json audit.eventType ↔ audit_events DDL CHECK", () => {
  it("the schema enum equals the DDL allowlist exactly (order-insensitive, no extras, no omissions)", () => {
    const ddl = ddlEventTypes();
    const schema = schemaEventTypes();
    expect([...schema].sort()).toEqual([...ddl].sort());
  });

  it("the DDL allowlist is the expected 14 kinds (10 run.* + 4 non-run.%)", () => {
    const ddl = ddlEventTypes();
    expect(ddl).toHaveLength(14);
    expect(ddl.filter((k) => k.startsWith("run.")).length).toBe(10);
  });
});

describe("seq-space classification ↔ ledger/intents.ts (the executable predicate)", () => {
  const intentsSrc = readFileSync(join(root, "packages/sqlite-store/src/ledger/intents.ts"), "utf8");

  it("DB_EVENT_SEQ_BASE is 10^12 in intents.ts, and the schema's high-space example sits at it", () => {
    expect(intentsSrc).toMatch(/DB_EVENT_SEQ_BASE\s*=\s*1_000_000_000_000/);
    const schema = JSON.parse(
      readFileSync(join(root, "docs/specs/cli-contract/watch.schema.json"), "utf8"),
    ) as { examples: { event: string; seq?: number; eventType?: string }[] };
    const audits = schema.examples.filter((e) => e.event === "audit");
    // one example per space: a run.* row below the base, a non-run.% row at/above it
    expect(audits.some((e) => e.eventType!.startsWith("run.") && e.seq! < 1_000_000_000_000)).toBe(true);
    expect(audits.some((e) => !e.eventType!.startsWith("run.") && e.seq! >= 1_000_000_000_000)).toBe(true);
  });

  it("the high-space allocator counts every non-run.% row (NOT LIKE 'run.%'), never db.%-only", () => {
    const alloc = /function nextDbEventSeq[\s\S]*?\n\}/.exec(intentsSrc);
    expect(alloc, "nextDbEventSeq not found in intents.ts").toBeTruthy();
    expect(alloc![0]).toContain("NOT LIKE 'run.%'");
    expect(alloc![0]).not.toContain("LIKE 'db.%'");
  });

  it("the DDL's non-run.% kinds are exactly the 3 db.* kinds plus evidence.retry_enqueued", () => {
    const high = ddlEventTypes().filter((k) => !k.startsWith("run."));
    expect(high.sort()).toEqual(
      ["db.backup", "db.force_unblock", "db.restore", "evidence.retry_enqueued"].sort(),
    );
  });
});
