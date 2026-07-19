/**
 * `trust-remediation` (Task 4.8/4.11) — the `trust-remediation` job HANDLER: the
 * reviewer-facing remediation run an INTEGRATED run's source-revocation spawns.
 *
 * The invariants under test are the security-critical ones:
 *  - a revoked-source remediation is **Tier-3** (review-required) and NEVER
 *    auto-applies — the handler reports `action-required` (→ `jobs run` exit 6) and
 *    parks the proposal for a human-driven, broker-authorized apply;
 *  - the handler MUTATES nothing itself — it returns a `commit` closure + a
 *    non-empty `sideEffectId` so the jobs runner lands the effect ATOMICALLY with
 *    the job's terminal flip (Task 2.7 decision 1);
 *  - a malformed payload is REJECTED as a permanent (validation) failure, not
 *    retried until the budget burns;
 *  - a cooperative cancel (`AbortSignal`) at a checkpoint unwinds via `AbortError`.
 */
import { describe, expect, it } from "vitest";
import { openStore, type Store } from "@atlas/sqlite-store";
import type { JobHandlerContext } from "@atlas/jobs";
import type { RunContext } from "../src/handlers.js";
import { buildRemediationHandler } from "../src/trust/remediation.js";
import type { JobHandlerDeps } from "../src/commands/job-handlers.js";

const NOW = "2026-07-19T00:00:00.000Z";

/** A migrated in-memory store (0001_core carries agent_runs + change_plans). */
function migratedStore(): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  return s;
}

/** Build a handler over a real store but a stub `ctx` (the handler must not deref ctx). */
function handlerOver(store: Store) {
  const deps: JobHandlerDeps = { ctx: {} as RunContext, store };
  return buildRemediationHandler(deps);
}

/** A `JobHandlerContext` with an optional, never-aborted signal by default. */
function jobCtx(payload: unknown, signal?: AbortSignal): JobHandlerContext {
  return {
    jobId: "job-1",
    workflow: "trust-remediation",
    attempt: 1,
    payload,
    signal: signal ?? new AbortController().signal,
    now: NOW,
  };
}

const validPayload = { revokedSourceHandle: "sha256:src", affectedRunId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" };

describe("trust-remediation handler — laziness (registry-completeness contract)", () => {
  it("builds with a stub deps without dereferencing anything", () => {
    // The completeness gate builds the registry with `{} as JobHandlerDeps`; a build
    // that touched the store would crash it. Building must be pure.
    expect(() => buildRemediationHandler({} as JobHandlerDeps)).not.toThrow();
  });
});

describe("trust-remediation handler — happy path (Tier-3, action-required, no self-apply)", () => {
  it("reports action-required with a fresh remediation runId + non-empty sideEffectId", async () => {
    const store = migratedStore();
    try {
      const result = await handlerOver(store)(jobCtx(validPayload));
      expect(result.actionRequired).toBe(true);
      expect(result.runId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/); // ULID
      expect(result.sideEffectId).toBeTruthy();
      expect(result.sideEffectId!.length).toBeGreaterThan(0);
      // A mutable committed effect MUST be returned as a closure, not self-applied.
      expect(typeof result.commit).toBe("function");
    } finally {
      store.close();
    }
  });

  it("does NOT self-apply the SQLite effect — the store is untouched until commit runs", async () => {
    const store = migratedStore();
    try {
      const before = store.db.prepare(`SELECT COUNT(*) AS c FROM agent_runs`).get() as { c: number };
      const result = await handlerOver(store)(jobCtx(validPayload));
      // The handler returned — but nothing may have been written yet (the runner
      // commits the closure atomically with the terminal flip).
      const afterReturn = store.db.prepare(`SELECT COUNT(*) AS c FROM agent_runs`).get() as { c: number };
      expect(afterReturn.c).toBe(before.c);

      // Now apply the effect the way the runner would (inside a transaction).
      store.db.transaction(() => result.commit!(store.db))();

      const run = store.db
        .prepare(`SELECT run_id, operation, status, tier, target_note_id FROM agent_runs WHERE run_id = ?`)
        .get(result.runId) as { run_id: string; operation: string; status: string; tier: number; target_note_id: string | null } | undefined;
      expect(run).toBeDefined();
      expect(run!.operation).toBe("trust-remediation");
      expect(run!.tier).toBe(3); // Tier-3, review-required (workflow-risk-contract §risk-tiers)
      // Parked at a NON-terminal state: the reconciler leaves it for the human-driven
      // authorized apply; it is never auto-advanced.
      expect(["planned", "review-pending"]).toContain(run!.status);

      const plan = store.db
        .prepare(`SELECT tier, summary FROM change_plans WHERE run_id = ?`)
        .get(result.runId) as { tier: number; summary: string } | undefined;
      expect(plan).toBeDefined();
      expect(plan!.tier).toBe(3);
      // The proposal references BOTH the revoked source and the affected run.
      expect(plan!.summary).toContain(validPayload.revokedSourceHandle);
      expect(plan!.summary).toContain(validPayload.affectedRunId);
    } finally {
      store.close();
    }
  });

  it("mirrors the affected run's target note onto the remediation run when it exists", async () => {
    const store = migratedStore();
    try {
      // Seed the affected (integrated) run so the handler can mirror its target.
      store.db
        .prepare(
          `INSERT INTO agent_runs (run_id, operation, status, checkpoint_seq, target_note_id, tier, started_at, updated_at)
           VALUES (?, 'enrich', 'integrated', 0, 'note-42', 2, ?, ?)`,
        )
        .run(validPayload.affectedRunId, NOW, NOW);

      const result = await handlerOver(store)(jobCtx(validPayload));
      store.db.transaction(() => result.commit!(store.db))();

      const run = store.db
        .prepare(`SELECT target_note_id FROM agent_runs WHERE run_id = ?`)
        .get(result.runId) as { target_note_id: string | null };
      expect(run.target_note_id).toBe("note-42");
    } finally {
      store.close();
    }
  });
});

describe("trust-remediation handler — payload validation (permanent rejection)", () => {
  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "nope"],
    ["missing affectedRunId", { revokedSourceHandle: "sha256:src" }],
    ["missing revokedSourceHandle", { affectedRunId: "run-1" }],
    ["empty revokedSourceHandle", { revokedSourceHandle: "", affectedRunId: "run-1" }],
    ["empty affectedRunId", { revokedSourceHandle: "sha256:src", affectedRunId: "" }],
    ["non-string field", { revokedSourceHandle: 7, affectedRunId: "run-1" }],
  ];
  for (const [name, payload] of bad) {
    it(`rejects ${name} as a permanent validation error`, async () => {
      const store = migratedStore();
      try {
        await expect(handlerOver(store)(jobCtx(payload))).rejects.toMatchObject({ kind: "validation" });
      } finally {
        store.close();
      }
    });
  }
});

describe("trust-remediation handler — cooperative cancel", () => {
  it("throws AbortError when the signal is already aborted", async () => {
    const store = migratedStore();
    try {
      const ac = new AbortController();
      ac.abort();
      await expect(handlerOver(store)(jobCtx(validPayload, ac.signal))).rejects.toMatchObject({ name: "AbortError" });
      // Nothing was parked.
      const c = store.db.prepare(`SELECT COUNT(*) AS c FROM agent_runs`).get() as { c: number };
      expect(c.c).toBe(0);
    } finally {
      store.close();
    }
  });
});
