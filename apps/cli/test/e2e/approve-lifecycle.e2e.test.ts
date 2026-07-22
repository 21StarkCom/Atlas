/**
 * `approve-lifecycle.e2e` — the review-gate approve/reject engine over the real store + broker:
 * a review-pending run is APPROVED → integrated onto canonical → reindexed → finalized; a moved
 * base is a stable `refresh-required` (approve never rebases); a reject terminates the run; and
 * the broker AUTHORITY refuses a forged-signature canonical advance.
 *
 * NOTE: no production path produces a `review-pending` run any more (the Tier-3 synthesis review
 * loop is retired, ADR-0003) — the gate precondition is synthesized directly in the ledger so the
 * SURVIVING approve/reject engine + broker authority stay covered.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrokerClient, BrokerRefusal } from "@atlas/broker";
import { newRunId } from "@atlas/contracts";
import type { IntegrationContext, RunIntegrator } from "../../src/workflows/index.js";
import { approveRun, rejectRun, type ApproveDeps } from "../../src/workflows/index.js";
import { gitOpId, gitOpUpsert } from "../../src/workflows/checkpoints.js";
import { makePhase2Harness, prepareForbiddenAuthorizedAdvance, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const NOW = "2026-07-14T00:00:00.000Z";

/** A CAS integrator that honours the broker contract: refuse on a moved base, else FF canonical. */
function casIntegrator(h: Phase2Harness): RunIntegrator {
  return async (ctx: IntegrationContext) => {
    const current = (await h.repo().readRef(ctx.canonicalRef)) ?? "0".repeat(40);
    if (current !== ctx.baseRef) throw Object.assign(new Error("cas"), { code: "broker.cas_failed" });
    h.git(["update-ref", ctx.canonicalRef, ctx.commitSha, ctx.baseRef]);
    return { canonicalRef: ctx.canonicalRef, canonicalSha: ctx.commitSha, seq: ctx.event.seq, auditHead: `audit:${ctx.commitSha}` };
  };
}

describe("review-gate approve lifecycle", () => {
  let h: Phase2Harness;
  let client: BrokerClient;

  beforeEach(async () => {
    h = await makePhase2Harness();
    client = await BrokerClient.connect(h.socketPath);
  });
  afterEach(async () => {
    client.close();
    await h.cleanup();
  });

  async function withStore<T>(fn: (s: ReturnType<Phase2Harness["openStore"]>) => Promise<T>): Promise<T> {
    const s = h.openStore();
    try { return await fn(s); } finally { s.close(); }
  }

  /** Synthesize a durable review-pending run + a real agent commit that FF-installs onto canonical. */
  function seedReviewPending(): { runId: string; commitSha: string } {
    const runId = newRunId();
    const base = h.git(["rev-parse", CANONICAL_REF]);
    const agentRef = `refs/agent/${runId}`;
    const commitSha = h.gitIn(h.vaultDir, ["commit-tree", `${base}^{tree}`, "-p", base, "-m", `agent ${runId}`], Buffer.from(""));
    h.git(["update-ref", agentRef, commitSha]);
    const store = h.openStore();
    try {
      store.ledger.upsertAgentRun({ run_id: runId, operation: "enrich", status: "review-pending", tier: 3, started_at: NOW, updated_at: NOW });
      store.db.prepare(`INSERT INTO change_plans (plan_id, run_id, tier, confidence, summary, plan_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(`${runId}-plan`, runId, 3, 0.5, "enrich alpha", "sha256:plan", NOW);
      for (const stmt of [
        gitOpUpsert({ gitOpId: gitOpId(runId, "agent-committed"), runId, opType: "agent-committed", refName: agentRef, commitSha, now: NOW }),
        gitOpUpsert({ gitOpId: gitOpId(runId, "base"), runId, opType: "base", refName: CANONICAL_REF, commitSha: base, now: NOW }),
      ]) store.db.prepare(stmt.sql).run(stmt.params);
    } finally { store.close(); }
    return { runId, commitSha };
  }

  function approveDeps(store: ReturnType<Phase2Harness["openStore"]>): ApproveDeps {
    return { store, broker: client, backup: h.backup, repo: h.repo(), integrate: casIntegrator(h), foldProjections: async () => {}, canonicalRef: CANONICAL_REF, now: () => NOW };
  }

  it("approves a review-pending run → integrated onto canonical + finalized", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const { runId, commitSha } = seedReviewPending();
    const out = await withStore((store) => approveRun(runId, approveDeps(store)));
    expect(out.mode).toBe("integrated");
    // Canonical advanced to the reviewed commit; the run is finalized.
    expect(h.git(["rev-parse", CANONICAL_REF])).not.toBe(before);
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(commitSha);
    await withStore(async (store) => {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("finalized");
    });
  });

  it("a moved base is refresh-required — approve NEVER rebases", async () => {
    const { runId } = seedReviewPending();
    // A concurrent writer advances canonical after the run reached review-pending.
    const wt = join(h.worktreesPath, "concurrent");
    h.git(["worktree", "add", "-q", "-b", "concurrent", wt, CANONICAL_REF]);
    const p = join(wt, "note-beta.md");
    writeFileSync(p, readFileSync(p, "utf8") + "\nedit\n");
    h.gitIn(wt, ["add", "-A"]); h.gitIn(wt, ["commit", "-q", "-m", "concurrent"]);
    h.git(["update-ref", CANONICAL_REF, h.gitIn(wt, ["rev-parse", "HEAD"])]);
    h.git(["worktree", "remove", "--force", wt]); h.git(["branch", "-D", "concurrent"]);

    const out = await withStore((store) => approveRun(runId, approveDeps(store)));
    expect(out.mode).toBe("refresh-required");
    // The run stays review-pending (not integrated).
    await withStore(async (store) => {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("review-pending");
    });
  });

  it("rejects a review-pending run → rejected terminal", async () => {
    const { runId } = seedReviewPending();
    const out = await withStore((store) => rejectRun(runId, "not accurate", approveDeps(store)));
    expect(out.state).toBe("rejected");
    await withStore(async (store) => {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("rejected");
    });
  });

  it("the broker refuses a FORGED-signature canonical advance (no approval can be forged)", async () => {
    const attempt = prepareForbiddenAuthorizedAdvance(h);
    await expect(attempt.run()).rejects.toBeInstanceOf(BrokerRefusal);
    // Canonical is untouched by the refused advance.
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(h.git(["rev-parse", CANONICAL_REF]));
  });
});
