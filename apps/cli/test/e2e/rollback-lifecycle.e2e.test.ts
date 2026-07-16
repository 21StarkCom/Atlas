/**
 * `rollback-lifecycle.e2e` (Task 4.9) — rollback execution over a real git vault: a self-contained
 * run is reverted onto canonical (a DISTINCT rolled-back run, the reverted run untouched); a run
 * whose rendition is cited is REFUSED (`has-dependents`, canonical untouched); the mandatory
 * reconciliation always runs on an exit-0 rollback.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rollbackRun, type RollbackDeps, type RunToRollback } from "../../src/workflows/index.js";
import { makePhase2Harness, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

describe("rollback execution (Task 4.9)", () => {
  let h: Phase2Harness;
  beforeEach(async () => { h = await makePhase2Harness(); });
  afterEach(async () => { await h.cleanup(); });

  /** Land a self-contained synthesis-style commit on canonical, return its sha. */
  function landCommit(): string {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const wt = `${h.worktreesPath}/land`;
    h.git(["worktree", "add", "-q", "-b", "land", wt, CANONICAL_REF]);
    const p = `${wt}/note-alpha.md`;
    writeFileSync(p, readFileSync(p, "utf8") + "\nSynthesis edit.\n");
    h.gitIn(wt, ["add", "-A"]); h.gitIn(wt, ["commit", "-q", "-m", "synthesis edit"]);
    const sha = h.gitIn(wt, ["rev-parse", "HEAD"]);
    h.git(["update-ref", CANONICAL_REF, sha, before]);
    h.git(["worktree", "remove", "--force", wt]); h.git(["branch", "-D", "land"]);
    return sha;
  }

  function baseDeps(dependents: string[]): Omit<RollbackDeps, "produceRevert" | "installRevert"> {
    const store = h.openStore();
    return {
      store,
      dependentsOf: () => dependents,
      reconcile: async () => {},
      now: () => "2026-07-14T00:00:00.000Z",
    };
  }

  it("self-contained: reverts the run onto canonical as a DISTINCT rolled-back run", async () => {
    const landed = landCommit();
    const store = h.openStore();
    try {
      const target: RunToRollback = { runId: "run-syn", operation: "enrich" };
      const deps: RollbackDeps = {
        ...baseDeps([]),
        store,
        // Produce a real git revert of the landed commit on a rollback agent branch.
        produceRevert: async ({ rollbackRunId }) => {
          const base = h.git(["rev-parse", CANONICAL_REF]);
          const wt = `${h.worktreesPath}/rb-${rollbackRunId}`;
          h.git(["worktree", "add", "-q", "-b", `rb-${rollbackRunId}`, wt, CANONICAL_REF]);
          h.gitIn(wt, ["revert", "--no-edit", landed]);
          const revertCommit = h.gitIn(wt, ["rev-parse", "HEAD"]);
          h.git(["worktree", "remove", "--force", wt]);
          return { revertCommit, base };
        },
        // Install the revert onto canonical (broker run.rolled_back advance, here a FF).
        installRevert: async ({ revertCommit, base }) => {
          h.git(["update-ref", CANONICAL_REF, revertCommit, base]);
          return { canonicalSha: revertCommit };
        },
      };
      const out = await rollbackRun(target, deps);
      expect(out.mode).toBe("rolled-back");
      if (out.mode !== "rolled-back") throw new Error("unreachable");
      expect(out.rollbackClass).toBe("self-contained");
      expect(out.rollbackOf).toBe("run-syn");
      expect(out.reconciled).toBe(true);
      // Canonical now reverts the synthesis edit; the rollback run is recorded rolled-back.
      const alpha = h.git(["show", `${CANONICAL_REF}:note-alpha.md`]);
      expect(alpha).not.toContain("Synthesis edit.");
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(out.rollbackRunId) as { status: string };
      expect(row.status).toBe("rolled-back");
    } finally {
      store.close();
    }
  });

  it("has-dependents: a run whose rendition is cited is REFUSED, canonical untouched", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const store = h.openStore();
    try {
      const target: RunToRollback = { runId: "run-cap", operation: "source-add" };
      let produceCalled = false;
      const deps: RollbackDeps = {
        ...baseDeps(["claim-a", "claim-b"]),
        store,
        produceRevert: async () => { produceCalled = true; return { revertCommit: null, base: before }; },
        installRevert: async () => ({ canonicalSha: before }),
      };
      const out = await rollbackRun(target, deps);
      expect(out.mode).toBe("refused");
      if (out.mode !== "refused") throw new Error("unreachable");
      expect(out.reason).toBe("has-dependents");
      expect(out.dependents).toEqual(["claim-a", "claim-b"]);
      // Refused BEFORE any revert/install — canonical untouched.
      expect(produceCalled).toBe(false);
      expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
    } finally {
      store.close();
    }
  });
});
