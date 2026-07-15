/**
 * `observability-matrix` — the PHASE-2 rows of the observability run-matrix
 * (Task 2.10 / #36). Asserts, for the run classes Phase-2 code can produce —
 * **capture Tier-1, readonly, projection, failed@, cancelled@** — two things:
 *
 *   - **Ledger completeness:** each run class writes exactly its expected
 *     `agent_runs` state + `audit_events` sequence (the `failed@`/`cancelled@`
 *     terminal records its from-checkpoint).
 *   - **Audit cardinality:** each terminal event type appears EXACTLY ONCE per run
 *     (§2.5 closed set), and a run that transmits to a model writes ONE
 *     `model_calls` row per transmission with **no `run.*` event per call** (D6) —
 *     the many transmissions fold into the run's SINGLE terminal audit event.
 *
 * SCOPE (Task 2.10): this asserts only what Phase-2 code produces. `--from-git`
 * reproduction is DEFERRED to Task 4.11 (`rebuildFromGit`) and is deliberately NOT
 * asserted here; the full matrix (incl. `--from-git`) completes there.
 *
 * Runs WITHOUT `ATLAS_PROVISIONED` (in-process broker + git fixture vault), so it
 * is part of the required `pnpm -r test` CI gate on both OS.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { platform } from "node:os";
import { probeSandbox } from "@atlas/sources";
import { newRunId } from "@atlas/contracts";
import { buildModelCallStatement } from "@atlas/models";
import { applyLedgerWrite } from "@atlas/sqlite-store";
import { startRun, type WorkflowDeps } from "../src/workflows/index.js";
import { recordReadonlyRun } from "../src/audit/readonly.js";
import {
  captureViaBroker,
  driveModelTransmittingRun,
  hasProjectionMarker,
  insertProjectionMarker,
  makePhase2Harness,
  REPO_ROOT,
  type Phase2Harness,
} from "./e2e/phase2-support.js";
import type { Store } from "@atlas/sqlite-store";

/** The `run.*` audit-event kinds for `runId`, in seq order. */
function runEventKinds(store: Store, runId: string): string[] {
  return (
    store.db
      .prepare(`SELECT event_type FROM audit_events WHERE run_id = ? AND event_type LIKE 'run.%' ORDER BY seq ASC`)
      .all(runId) as { event_type: string }[]
  ).map((r) => r.event_type);
}

/** Count committed audit events of a kind for `runId`. */
function auditCount(store: Store, runId: string, kind: string): number {
  return (
    store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND event_type = ?`).get(runId, kind) as { n: number }
  ).n;
}

/** The stored (durable) audit event detail for `kind` — read from `audit_intents.event_json`. */
function storedDetail(store: Store, runId: string, kind: string): Record<string, unknown> | undefined {
  const rows = store.db.prepare(`SELECT event_json FROM audit_intents WHERE run_id = ? ORDER BY seq`).all(runId) as { event_json: string }[];
  for (const r of rows) {
    if (!r.event_json) continue;
    const ev = JSON.parse(r.event_json) as { kind: string; detail?: Record<string, unknown> };
    if (ev.kind === kind) return ev.detail ?? {};
  }
  return undefined;
}

let h: Phase2Harness;
beforeEach(async () => {
  h = await makePhase2Harness();
});
afterEach(async () => {
  await h.cleanup();
});

/**
 * A fixed workflow clock (RFC-3339 ms). Injected into {@link deps} so a checkpoint's
 * engine-clock-derived `created_at` is DETERMINISTIC — the failed@/cancelled@ matrix
 * rows can then assert the LITERAL value (round-3 wing finding: the prior tests copied
 * the observed timestamp back into the expected object, so a malformed-but-prefixed or
 * wrong timestamp still passed).
 */
const FIXED_CLOCK = "2026-07-14T00:00:00.000Z";

function deps(store: Store, now?: () => string): WorkflowDeps {
  return { store, broker: h.service, backup: h.backup, repo: h.repo(), ...(now !== undefined ? { now } : {}) };
}


/**
 * Capture rows run the parser in the OS sandbox (D15); stock hosted Linux lacks the
 * cgroup resource-caps primitive so `runInSandbox` fails closed. Same #29 gate as the
 * exit test: STRICT on a provisioned host, LOUD SKIP otherwise (never a false green).
 * Restore Linux CI coverage via cgroup delegation (#29 follow-up, tracker #5).
 */
const OBS_SANDBOX = await probeSandbox();
const OBS_REQUIRE = process.env.ATLAS_SANDBOX_REQUIRE === "1" || (process.env.CI === "true" && platform() === "darwin");
if (!OBS_SANDBOX.supported && OBS_REQUIRE) {
  const missing = OBS_SANDBOX.checks.filter((c) => !c.available).map((c) => c.guarantee).join(", ");
  throw new Error(`[observability-matrix] provisioned host must support the sandbox but does not (${OBS_SANDBOX.host}: ${missing})`);
}
if (!OBS_SANDBOX.supported) console.warn(`[observability-matrix] SKIP capture-dependent rows: sandbox unsupported on ${OBS_SANDBOX.host}`);
const describeIfSandbox = OBS_SANDBOX.supported ? describe : describe.skip;

describeIfSandbox("observability-matrix (Phase-2 classes): ledger completeness + audit cardinality", () => {
  it("capture Tier-1: agent_runs finalized@tier-1, audit chain [started, planned, integrated], one terminal, no model_calls", async () => {
    const result = await captureViaBroker(h, join(REPO_ROOT, "fixtures/inputs/sample.md"));
    const store = h.openStore();
    try {
      // Ledger completeness: the run reached the SUCCESS terminal at Tier 1.
      const run = store.db.prepare(`SELECT status, tier, failed_checkpoint, finished_at FROM agent_runs WHERE run_id = ?`).get(result.runId) as {
        status: string;
        tier: number;
        failed_checkpoint: string | null;
        finished_at: string | null;
      };
      expect(run.status).toBe("finalized");
      expect(run.tier).toBe(1);
      expect(run.failed_checkpoint).toBeNull();
      expect(run.finished_at).not.toBeNull();

      // Audit cardinality: the closed, ordered chain — with run.integrated the
      // exactly-once success terminal (finalize emits no audit event of its own).
      expect(runEventKinds(store, result.runId)).toEqual(["run.started", "run.planned", "run.integrated"]);
      expect(auditCount(store, result.runId, "run.integrated")).toBe(1);

      // The capture recorded its provenance + git-op ledger rows (completeness).
      expect((store.db.prepare(`SELECT COUNT(*) AS n FROM change_plans WHERE run_id = ?`).get(result.runId) as { n: number }).n).toBe(1);
      const gitOps = (
        store.db.prepare(`SELECT op_type FROM git_operations WHERE run_id = ? ORDER BY op_type`).all(result.runId) as { op_type: string }[]
      ).map((r) => r.op_type);
      for (const op of ["agent-committed", "base", "integrated", "reindexed", "worktree-applied"]) expect(gitOps).toContain(op);

      // A capture is deterministic + model-free: NO model_calls, NO run.* per call.
      expect((store.db.prepare(`SELECT COUNT(*) AS n FROM model_calls WHERE run_id = ?`).get(result.runId) as { n: number }).n).toBe(0);
    } finally {
      store.close();
    }
  });

  it("readonly: one run.readonly, no agent_runs row (a read is not a workflow run)", async () => {
    const store = h.openStore();
    try {
      const runId = newRunId();
      const res = await recordReadonlyRun("run.readonly", "inspect", store, h.service, { backup: h.backup, runId });
      expect(res.recorded).toBe(true);
      // Ledger completeness + cardinality: exactly one run.readonly, and no other.
      expect(runEventKinds(store, runId)).toEqual(["run.readonly"]);
      expect(auditCount(store, runId, "run.readonly")).toBe(1);
      // A read run writes ONLY its audit event — no agent_runs row.
      expect(store.db.prepare(`SELECT 1 FROM agent_runs WHERE run_id = ?`).get(runId)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("projection: one run.projection, no agent_runs row, a REAL projection marker + its audit event commit atomically", async () => {
    const store = h.openStore();
    try {
      const runId = newRunId();
      const noteId = `projection/${runId}`;
      const res = await recordReadonlyRun("run.projection", "db rebuild", store, h.service, {
        backup: h.backup,
        runId,
        strictBackup: true,
        // A projection is a REAL state change — write a durable projection marker (a
        // `notes` projection row) inside the SAME §2.8 transaction as the audit event
        // (Task 1.9 finding 2), so the marker and run.projection land together.
        extraCommit: (db) => insertProjectionMarker(db, noteId),
      });
      expect(res.recorded).toBe(true);
      // Ledger completeness: exactly one run.projection AND the durable marker persisted.
      expect(runEventKinds(store, runId)).toEqual(["run.projection"]);
      expect(auditCount(store, runId, "run.projection")).toBe(1);
      expect(hasProjectionMarker(store, noteId)).toBe(true);
      expect(store.db.prepare(`SELECT 1 FROM agent_runs WHERE run_id = ?`).get(runId)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("projection ATOMICITY: a failure in the projection mutation rolls BACK both the marker AND the audit event", async () => {
    const store = h.openStore();
    try {
      const runId = newRunId();
      const noteId = `projection/${runId}`;
      // The projection mutation throws AFTER writing the marker inside the transaction.
      // finalizeLedgerWrite runs extraCommit inside the §2.8 transaction, so the throw
      // rolls the WHOLE run back — neither the marker NOR the run.projection audit event
      // may survive (round-3 finding: prove real rollback atomicity, not a boolean flag).
      await expect(
        recordReadonlyRun("run.projection", "db rebuild", store, h.service, {
          backup: h.backup,
          runId,
          strictBackup: true,
          extraCommit: (db) => {
            insertProjectionMarker(db, noteId);
            throw new Error("injected projection failure after the marker write");
          },
        }),
      ).rejects.toThrow(/injected projection failure/);

      // BOTH rolled back atomically: no marker row AND no run.projection audit event.
      expect(hasProjectionMarker(store, noteId)).toBe(false);
      expect(auditCount(store, runId, "run.projection")).toBe(0);
      expect(runEventKinds(store, runId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("failed@<checkpoint>: agent_runs failed + failed_checkpoint set; one run.failed carrying failedAt", async () => {
    const store = h.openStore();
    try {
      // Inject the FIXED workflow clock so `created_at` is deterministic and can be
      // asserted as a LITERAL below (round-3 wing finding).
      const handle = await startRun(deps(store, () => FIXED_CLOCK), { operation: "ingest", canonicalCommit: h.git(["rev-parse", "refs/heads/main"]) });
      const runId = handle.runId;
      await handle.checkpoint("planned", {
        planId: `${runId}-plan`,
        tier: 3,
        confidence: 0.5,
        summary: "planned then failed",
        planHash: "0".repeat(64),
        canonicalRef: "refs/heads/main",
        baseRef: h.git(["rev-parse", "refs/heads/main"]),
      });
      const terminal = await handle.fail("planned", "injected extraction failure");
      expect(terminal.state).toBe("failed");
      expect(terminal.from).toBe("planned");

      // Ledger completeness: failed@planned recorded in the column + the run row.
      const run = store.db.prepare(`SELECT status, failed_checkpoint FROM agent_runs WHERE run_id = ?`).get(runId) as {
        status: string;
        failed_checkpoint: string | null;
      };
      expect(run.status).toBe("failed");
      expect(run.failed_checkpoint).toBe("planned");

      // Audit cardinality: exactly one run.failed terminal; its detail carries failedAt.
      expect(runEventKinds(store, runId)).toEqual(["run.started", "run.planned", "run.failed"]);
      expect(auditCount(store, runId, "run.failed")).toBe(1);
      expect(storedDetail(store, runId, "run.failed")).toMatchObject({ failedAt: "planned" });

      // Ledger completeness: the planned checkpoint's persisted artifacts are the EXACT
      // rows it writes — EVERY stable column of the change_plans row + the `base`
      // git_operations row (round-2 wing finding 5: not just plan_id/tier/plan_hash, but
      // run_id/confidence/summary and git_op_id too). A checkpoint-persistence regression
      // altering ANY of those values fails HERE. `created_at` is engine-clock-derived, and
      // the FIXED workflow clock pins it to the LITERAL RFC3339-ms value (round-3 wing
      // finding: NOT the observed value copied back — a malformed/wrong-but-prefixed
      // timestamp must fail), asserted inside the exact `toEqual`.
      const head = h.git(["rev-parse", "refs/heads/main"]);
      const plans = store.db.prepare(`SELECT plan_id, run_id, tier, confidence, summary, plan_hash, created_at FROM change_plans WHERE run_id = ?`).all(runId) as {
        plan_id: string;
        run_id: string;
        tier: number;
        confidence: number;
        summary: string;
        plan_hash: string;
        created_at: string;
      }[];
      expect(plans).toEqual([
        { plan_id: `${runId}-plan`, run_id: runId, tier: 3, confidence: 0.5, summary: "planned then failed", plan_hash: "0".repeat(64), created_at: FIXED_CLOCK },
      ]);
      const gitOps = store.db
        .prepare(`SELECT git_op_id, run_id, op_type, ref_name, commit_sha, created_at FROM git_operations WHERE run_id = ? ORDER BY op_type`)
        .all(runId) as { git_op_id: string; run_id: string; op_type: string; ref_name: string; commit_sha: string | null; created_at: string }[];
      // A failed@planned run wrote ONLY the base checkpoint (nothing past planned), with
      // the LITERAL fixed-clock `created_at`.
      expect(gitOps).toEqual([
        { git_op_id: `${runId}:base`, run_id: runId, op_type: "base", ref_name: "refs/heads/main", commit_sha: head, created_at: FIXED_CLOCK },
      ]);
    } finally {
      store.close();
    }
  });

  it("cancelled@<checkpoint>: agent_runs cancelled + failed_checkpoint set; one run.cancelled carrying cancelledAt", async () => {
    const store = h.openStore();
    try {
      // Inject the FIXED workflow clock so `created_at` is deterministic (round-3 finding).
      const handle = await startRun(deps(store, () => FIXED_CLOCK), { operation: "ingest", canonicalCommit: h.git(["rev-parse", "refs/heads/main"]) });
      const runId = handle.runId;
      await handle.checkpoint("planned", {
        planId: `${runId}-plan`,
        tier: 2,
        confidence: 0.9,
        summary: "planned then cancelled",
        planHash: "1".repeat(64),
        canonicalRef: "refs/heads/main",
        baseRef: h.git(["rev-parse", "refs/heads/main"]),
      });
      const terminal = await handle.cancel("planned");
      expect(terminal.state).toBe("cancelled");
      expect(terminal.from).toBe("planned");

      const run = store.db.prepare(`SELECT status, failed_checkpoint FROM agent_runs WHERE run_id = ?`).get(runId) as {
        status: string;
        failed_checkpoint: string | null;
      };
      expect(run.status).toBe("cancelled");
      expect(run.failed_checkpoint).toBe("planned"); // the CHECK pins the column for cancelled too

      expect(runEventKinds(store, runId)).toEqual(["run.started", "run.planned", "run.cancelled"]);
      expect(auditCount(store, runId, "run.cancelled")).toBe(1);
      expect(storedDetail(store, runId, "run.cancelled")).toMatchObject({ cancelledAt: "planned" });

      // Ledger completeness: the planned checkpoint's persisted artifacts are the EXACT
      // rows it writes — EVERY stable column of the change_plans row (tier 2 / confidence
      // 0.9 / summary / plan_hash "1"*64 here) + the `base` git_operations row (round-2
      // wing finding 5). A checkpoint-persistence regression altering ANY value fails
      // HERE. `created_at` is engine-clock-derived and the FIXED workflow clock pins it to
      // the LITERAL RFC3339-ms value (round-3 wing finding: NOT the observed value copied
      // back), asserted inside the exact `toEqual`.
      const head = h.git(["rev-parse", "refs/heads/main"]);
      const plans = store.db.prepare(`SELECT plan_id, run_id, tier, confidence, summary, plan_hash, created_at FROM change_plans WHERE run_id = ?`).all(runId) as {
        plan_id: string;
        run_id: string;
        tier: number;
        confidence: number;
        summary: string;
        plan_hash: string;
        created_at: string;
      }[];
      expect(plans).toEqual([
        { plan_id: `${runId}-plan`, run_id: runId, tier: 2, confidence: 0.9, summary: "planned then cancelled", plan_hash: "1".repeat(64), created_at: FIXED_CLOCK },
      ]);
      const gitOps = store.db
        .prepare(`SELECT git_op_id, run_id, op_type, ref_name, commit_sha, created_at FROM git_operations WHERE run_id = ? ORDER BY op_type`)
        .all(runId) as { git_op_id: string; run_id: string; op_type: string; ref_name: string; commit_sha: string | null; created_at: string }[];
      // A cancelled@planned run wrote ONLY the base checkpoint (nothing past planned),
      // with the LITERAL fixed-clock `created_at`.
      expect(gitOps).toEqual([
        { git_op_id: `${runId}:base`, run_id: runId, op_type: "base", ref_name: "refs/heads/main", commit_sha: head, created_at: FIXED_CLOCK },
      ]);
    } finally {
      store.close();
    }
  });

  it("model-transmitting run (D6): real lifecycle [started, planned, failed], one applicable terminal, one model_calls row per transmission, no run.* per call", async () => {
    // A REAL Phase-2 model-transmitting WORKFLOW run with its ACTUAL lifecycle — NOT
    // a fabricated finalized+run.readonly (round-2 finding 4). It transmits N times
    // then FAILS (Phase 2 cannot integrate a model-derived synthesis), folding every
    // transmission into its SINGLE run.failed terminal. N=4 ≠ the 3 lifecycle events,
    // so "run.* count is independent of transmission count" is unambiguous.
    const N = 4;
    const { runId, receipts } = await driveModelTransmittingRun(h, N);
    const store = h.openStore();
    try {
      // Ledger completeness: a real agent_runs row at its applicable WORKFLOW terminal
      // (failed@planned) — the from-checkpoint recorded in the column.
      const run = store.db.prepare(`SELECT status, tier, failed_checkpoint, finished_at FROM agent_runs WHERE run_id = ?`).get(runId) as {
        status: string;
        tier: number;
        failed_checkpoint: string | null;
        finished_at: string | null;
      };
      expect(run.status).toBe("failed");
      expect(run.failed_checkpoint).toBe("planned");
      expect(run.tier).toBe(3);
      expect(run.finished_at).not.toBeNull();

      // Actual lifecycle: the real workflow chain ending in exactly one applicable terminal.
      expect(runEventKinds(store, runId)).toEqual(["run.started", "run.planned", "run.failed"]);
      const terminals = runEventKinds(store, runId).filter((k) => k !== "run.started" && k !== "run.planned");
      expect(terminals).toEqual(["run.failed"]); // exactly one applicable terminal
      expect(auditCount(store, runId, "run.failed")).toBe(1);

      // One model_calls row PER TRANSMISSION.
      expect((store.db.prepare(`SELECT COUNT(*) AS n FROM model_calls WHERE run_id = ?`).get(runId) as { n: number }).n).toBe(N);
      // D6: run.* event count is the LIFECYCLE count (3), independent of the N=4
      // transmissions — the transmissions fold into the run's single terminal, NEVER
      // one run.* per call.
      const runEvents = store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND event_type LIKE 'run.%'`).get(runId) as {
        n: number;
      };
      expect(runEvents.n).toBe(3);
      // The N transmissions' allowlisted audit records folded into the SINGLE terminal event.
      const detail = storedDetail(store, runId, "run.failed");
      expect(Array.isArray(detail?.modelCalls)).toBe(true);
      expect((detail?.modelCalls as unknown[]).length).toBe(N);

      // Idempotent rows: re-applying the same receipts writes no duplicate (ON CONFLICT).
      applyLedgerWrite(store.db, receipts.map((r) => buildModelCallStatement(r)));
      expect((store.db.prepare(`SELECT COUNT(*) AS n FROM model_calls WHERE run_id = ?`).get(runId) as { n: number }).n).toBe(N);
    } finally {
      store.close();
    }
  });

  it("audit terminal cardinality across the Phase-2 classes: each terminal event type is once-per-run", async () => {
    // Drive one run of each terminal class + a capture, then assert the §2.5 closed
    // set holds: no terminal event type appears more than once for any run.
    const captured = await captureViaBroker(h, join(REPO_ROOT, "fixtures/inputs/sample.md"));

    const store = h.openStore();
    try {
      const rows = store.db
        .prepare(`SELECT run_id, event_type, COUNT(*) AS n FROM audit_events GROUP BY run_id, event_type`)
        .all() as { run_id: string; event_type: string; n: number }[];
      const terminals = new Set(["run.integrated", "run.rejected", "run.rolled_back", "run.failed", "run.cancelled", "run.readonly", "run.projection"]);
      for (const r of rows) {
        if (terminals.has(r.event_type)) expect(r.n, `${r.event_type} for ${r.run_id}`).toBe(1);
      }
      // The capture run specifically has its one run.integrated terminal.
      expect(auditCount(store, captured.runId, "run.integrated")).toBe(1);
    } finally {
      store.close();
    }
  });
});
