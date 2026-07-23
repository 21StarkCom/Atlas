/**
 * `workflows-core.test` — the Task 2.5 acceptance suite for the persisted run
 * state machine + reconciler (`apps/cli/src/workflows/*`), driven by
 * `docs/specs/recovery-state-machine.md`.
 *
 * It proves, against the v2 in-process seams (#334: `inProcessAuditBroker` +
 * `makeCanonicalIntegrator` — the retired BrokerService is gone), a REAL
 * `@atlas/git` repo/worktree, and a FILE-BACKED `Store` (so a "kill -9" is a
 * fresh `openStore` over the same on-disk state):
 *
 *   1. each legal transition persists EXACTLY its contract artifacts;
 *   2. illegal transitions throw;
 *   3. a capture-shaped run survives a "kill -9" at every checkpoint and
 *      reconciles per the table (committed-checkpoint crashes AND a mid-§2.8-step
 *      crash that leaves a pending intent);
 *   4. the reconciler cases from the contract table (integrated-but-unfinalized →
 *      finalize; review-pending → leave; applied-uncommitted → commit iff base
 *      unmoved else failed@worktree-applied + clean; orphaned worktree → clean);
 *   5. the caller-idempotency layer (identical retry replays; key reuse with a
 *      different request rejected; concurrent duplicate blocks on the key).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRunId, canonicalSerialize, type RunManifest } from "@atlas/contracts";
import { openStore, applyLedgerWrite, type Store } from "@atlas/sqlite-store";
import { advanceCanonicalRef, openRepo, type Repo, type Worktree } from "@atlas/git";
import {
  startRun,
  reconcileRunsOnStartup,
  assembleRunReport,
  beginIdempotent,
  completeIdempotent,
  completeIdempotentStatement,
  releaseIdempotent,
  reconcileIdempotency,
  openWorkflowStore,
  sha256Canonical,
  parseTerminalAuditDetail,
  buildTerminalDetail,
  IllegalTransitionError,
  CheckpointCasError,
  IdempotencyKeyConflictError,
  IdempotencyInProgressError,
  IdempotencyOwnershipError,
  type WorkflowDeps,
  type RunIntegrator,
  type IntegrationContext,
  type BrokerIntegration,
  type PlannedArtifacts,
  makeCanonicalIntegrator,
} from "../src/workflows/index.js";
import { runCli } from "../src/main.js";

// ── harness ──────────────────────────────────────────────────────────────────

interface Harness {
  readonly root: string;
  readonly repoDir: string;
  readonly dbPath: string;
  /** A fresh migrated store over the SAME db file (a "restart"). */
  openStore(): Store;
  /** The seed commit sha on `refs/heads/main`. */
  mainSha(): string;
  git(args: string[]): string;
  cleanup(): void;
}

let clockTick = 0;
/** Deterministic monotone RFC-3339 ms clock (stable ordering without Date.now). */
function tick(): string {
  clockTick += 1;
  const ms = Date.UTC(2026, 6, 12, 0, 0, 0) + clockTick;
  return new Date(ms).toISOString();
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "atlas-wf-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const dbPath = join(root, "ledger.db");

  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Aryeh Stark",
        GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
        GIT_COMMITTER_NAME: "Aryeh Stark",
        GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
      },
    }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  return {
    root,
    repoDir,
    dbPath,
    openStore(): Store {
      // The PRODUCTION store-open lifecycle (round-2 finding W7): open + register the
      // workflows-owned migration(s) + migrate through the normal checksum-guarded
      // runner — NOT a hand-rolled harness registration and NOT a lazy per-command
      // create. Every test therefore exercises the real store-open path.
      return openWorkflowStore({ path: dbPath });
    },
    mainSha(): string {
      return git(["rev-parse", "refs/heads/main"]);
    },
    git,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The canonical plan object a run's `planHash` is computed over (shared by patched()). */
function planOf(runId: string): Record<string, unknown> {
  return { runId, note: "n1", op: "SetSection" };
}

/** Build a `PlannedArtifacts` for a run whose plan branched off `baseRef`. */
function plannedArtifacts(runId: string, baseRef: string, over: Partial<PlannedArtifacts> = {}): PlannedArtifacts {
  return {
    planId: `${runId}-plan`,
    tier: 2,
    confidence: 0.9,
    summary: "capture plan",
    planHash: sha256Canonical(planOf(runId)),
    canonicalRef: "refs/heads/main",
    baseRef,
    ...over,
  };
}

/** Run a git command inside an on-disk worktree `dir` (recovery-time hashing/commit). */
function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Aryeh Stark",
      GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
      GIT_COMMITTER_NAME: "Aryeh Stark",
      GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
    },
  }).trim();
}

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

function depsWith(store: Store, repo?: Repo): WorkflowDeps {
  return { store, now: tick, ...(repo ? { repo } : {}) };
}

// ── 1. legal transitions persist exactly their contract artifacts ────────────

describe("workflows-core: legal transitions persist their contract artifacts", () => {
  it("drives planned→patched→worktree-applied→agent-committed→integrated→reindexed→finalized", async () => {
    const store = h.openStore();
    try {
      const base = h.mainSha();
      const handle = await startRun(depsWith(store), { operation: "ingest" });
      const runId = handle.runId;

      // run.started emitted, no agent_runs row yet (recovery table: planned is
      // "from null/run.started").
      expect(store.ledger.getAgentRun(runId)).toBeUndefined();

      const planned = plannedArtifacts(runId, base);
      await handle.checkpoint("planned", planned);
      {
        const run = store.ledger.getAgentRun(runId)!;
        expect(run.status).toBe("planned");
        expect(run.tier).toBe(2);
        // change_plans row carries the planHash; git_operations 'base' the baseRef.
        expect(planHashOf(store, runId)).toBe(planned.planHash);
        expect(gitOp(store, runId, "base")).toEqual({ ref_name: "refs/heads/main", commit_sha: base });
      }

      const patchHash = sha256Canonical({ p: "patch" });
      await handle.checkpoint("patched", {
        patchId: `${runId}-patch`,
        planId: planned.planId,
        noteId: "n1",
        changedLines: 10,
        changedSections: 1,
        patchHash,
        planHash: planned.planHash,
      });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("patched");
      expect(patchHashOf(store, runId)).toBe(patchHash);
      // no new audit event for patched

      const treeHash = "1".repeat(40);
      const agentRef = `refs/agent/${runId}`;
      const worktreePath = join(h.root, "wt", runId);
      await handle.checkpoint("worktree-applied", { worktreePath, treeHash, agentRef });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("worktree-applied");
      expect(gitOp(store, runId, "worktree-applied")).toEqual({ ref_name: worktreePath, commit_sha: treeHash });

      const commitSha = agentCommit(h, base, runId);
      await handle.checkpoint("agent-committed", { commitSha, treeHash, agentRef, tier: 2 });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("agent-committed");
      expect(gitOp(store, runId, "agent-committed")).toEqual({ ref_name: agentRef, commit_sha: commitSha });

      // REAL integration: sign + broker ref-advance installs the agent commit.
      const result = await handle.integrate(performIntegration(h));
      const canonicalSha = result.canonicalSha;
      expect(canonicalSha).toBe(commitSha); // ff installs the agent commit
      expect(h.mainSha()).toBe(canonicalSha); // canonical really advanced
      {
        const run = store.ledger.getAgentRun(runId)!;
        expect(run.status).toBe("integrated");
        expect(gitOp(store, runId, "integrated")).toEqual({ ref_name: "refs/heads/main", commit_sha: canonicalSha });
        // run.integrated recorded in the ledger at the broker-allocated seq.
      }

      await handle.checkpoint("reindexed", { indexGeneration: 7, canonicalSha });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("reindexed");
      const report = assembleRunReport(store, runId)!;
      expect(report.artifacts.indexGeneration).toBe(7);

      // finalized is not a `checkpoint()` target — the producer/reconciler advances
      // reindexed→finalized once the §2.8 step-4 backup covers the run's seq. Drive
      // it to the SUCCESS terminal and assert full coverage (round-3 finding #7:
      // the happy path must reach finalized + a covering watermark, not stop early).
      const rep = await reconcileRunsOnStartup({ store, repo: openRepo(h.repoDir), now: tick });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "finalized", to: "finalized" });
      const finalRun = store.ledger.getAgentRun(runId)!;
      expect(finalRun.status).toBe("finalized");
      expect(finalRun.finished_at).not.toBeNull();

      const finalReport = assembleRunReport(store, runId)!;
      expect(finalReport.artifacts).toMatchObject({
        planHash: planned.planHash,
        patchHash,
        baseRef: base,
        commitSha,
        canonicalSha,
        indexGeneration: 7,
      });
      expect(finalReport.checkpointSeq).toBeGreaterThan(0);
      // run.integrated remains the single success event (not re-emitted at finalized).
    } finally {
      store.close();
    }
  });

  it("terminals persist correctly: fail@planned, cancel@patched (v2 #335: reject/review-pending retired)", async () => {
    // fail from planned → status=failed, failed_checkpoint=planned, run.failed.
    {
      const store = h.openStore();
      try {
        const handle = await startRun(depsWith(store), { operation: "ingest" });
        await handle.checkpoint("planned", plannedArtifacts(handle.runId, h.mainSha()));
        const term = await handle.fail("planned", "plan-stale");
        expect(term).toMatchObject({ state: "failed", from: "planned", reason: "plan-stale" });
        const run = store.ledger.getAgentRun(handle.runId)!;
        expect(run.status).toBe("failed");
        expect(run.failed_checkpoint).toBe("planned");
      } finally {
        store.close();
      }
    }
    // cancel from patched → status=cancelled, failed_checkpoint=patched, run.cancelled.
    {
      const store = h.openStore();
      try {
        const handle = await startRun(depsWith(store), { operation: "ingest" });
        await handle.checkpoint("planned", plannedArtifacts(handle.runId, h.mainSha()));
        await handle.checkpoint("patched", patched(handle.runId));
        const term = await handle.cancel("patched");
        expect(term).toMatchObject({ state: "cancelled", from: "patched" });
        const run = store.ledger.getAgentRun(handle.runId)!;
        expect(run.status).toBe("cancelled");
        expect(run.failed_checkpoint).toBe("patched");
      } finally {
        store.close();
      }
    }
  });

  it("agent-committed integrates directly (v2 #335: no review-pending park)", async () => {
    const store = h.openStore();
    try {
      const base = h.mainSha();
      const handle = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "reconcile" });
      await handle.checkpoint("planned", plannedArtifacts(handle.runId, base, { tier: 2 }));
      await handle.checkpoint("patched", patched(handle.runId));
      await handle.checkpoint("worktree-applied", { worktreePath: join(h.root, "wt3"), treeHash: "a".repeat(40), agentRef: `refs/agent/${handle.runId}` });
      const commitSha = agentCommit(h, base, handle.runId);
      await handle.checkpoint("agent-committed", { commitSha, treeHash: "a".repeat(40), agentRef: `refs/agent/${handle.runId}`, tier: 2 });
      const r = await handle.integrate(performIntegration(h));
      expect(store.ledger.getAgentRun(handle.runId)!.status).toBe("integrated");
      expect(r.canonicalSha).toBe(commitSha);
    } finally {
      store.close();
    }
  });
});

// ── 2. illegal transitions throw ─────────────────────────────────────────────

describe("workflows-core: illegal transitions throw", () => {
  it("rejects entering at a non-planned state", async () => {
    const store = h.openStore();
    try {
      const handle = await startRun(depsWith(store), { operation: "ingest" });
      await expect(handle.checkpoint("patched", patched(handle.runId))).rejects.toBeInstanceOf(IllegalTransitionError);
    } finally {
      store.close();
    }
  });

  it("rejects skipping a checkpoint (planned→agent-committed)", async () => {
    const store = h.openStore();
    try {
      const base = h.mainSha();
      const handle = await startRun(depsWith(store), { operation: "ingest" });
      await handle.checkpoint("planned", plannedArtifacts(handle.runId, base));
      await expect(
        handle.checkpoint("agent-committed", { commitSha: "c".repeat(40), treeHash: "d".repeat(40), agentRef: `refs/agent/${handle.runId}`, tier: 2 }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);
    } finally {
      store.close();
    }
  });

  it("rejects fail() past integration (forward recovery only)", async () => {
    const store = h.openStore();
    try {
      const base = h.mainSha();
      const handle = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest" });
      await handle.checkpoint("planned", plannedArtifacts(handle.runId, base));
      await handle.checkpoint("patched", patched(handle.runId));
      await handle.checkpoint("worktree-applied", { worktreePath: join(h.root, "wtx"), treeHash: "e".repeat(40), agentRef: `refs/agent/${handle.runId}` });
      // A REAL agent commit + REAL broker integration (round-2 finding #8: no
      // synthetic canonical SHA) so the run genuinely reaches `integrated`.
      const commitSha = agentCommit(h, base, handle.runId);
      await handle.checkpoint("agent-committed", { commitSha, treeHash: "e".repeat(40), agentRef: `refs/agent/${handle.runId}`, tier: 2 });
      await handle.integrate(performIntegration(h));
      await expect(handle.fail("integrated", "nope")).rejects.toBeInstanceOf(IllegalTransitionError);
    } finally {
      store.close();
    }
  });


  it("integrate() cannot be reached via checkpoint('integrated')", async () => {
    const store = h.openStore();
    try {
      const base = h.mainSha();
      const handle = await startRun(depsWith(store), { operation: "ingest" });
      await handle.checkpoint("planned", plannedArtifacts(handle.runId, base));
      // @ts-expect-error — 'integrated' is not a checkpoint() overload target.
      await expect(handle.checkpoint("integrated", {})).rejects.toBeInstanceOf(IllegalTransitionError);
    } finally {
      store.close();
    }
  });
});

// ── 3. kill -9 survival at every checkpoint reconciles per the table ─────────

describe("workflows-core: kill -9 survival + reconcile per the table", () => {
  /** Drive a run to `stopAfter`, then simulate a crash: reopen store + broker and reconcile. */
  async function driveTo(
    stopAfter: "planned" | "patched" | "worktree-applied" | "agent-committed" | "integrated" | "reindexed",
    opts: { tier?: 1 | 2; realWorktree?: boolean } = {},
  ): Promise<{ runId: string; base: string; worktreePath: string; agentRef: string; wt?: Worktree }> {
    const store = h.openStore();
    const base = h.mainSha();
    const handle = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest" });
    const runId = handle.runId;
    const agentRef = `refs/agent/${runId}`;
    const worktreePath = join(h.root, "wt", runId);
    let wt: Worktree | undefined;
    // The REAL agent commit installed at integration + the canonical sha the broker
    // ff-advanced to; captured as the run progresses so `reindexed` chains onto the
    // actual integrated canonicalSha (not a synthetic one — round-2 finding #8).
    let agentSha = "";
    let canonicalSha = "";
    let treeHash = "a".repeat(40);

    const order = ["planned", "patched", "worktree-applied", "agent-committed", "integrated", "reindexed"] as const;
    const tier = opts.tier ?? 2;
    try {
      for (const step of order) {
        if (step === "planned") await handle.checkpoint("planned", plannedArtifacts(runId, base, { tier }));
        else if (step === "patched") await handle.checkpoint("patched", patched(runId));
        else if (step === "worktree-applied") {
          if (opts.realWorktree) {
            const repo = openRepo(h.repoDir);
            await repo.createAgentBranch(runId, "refs/heads/main");
            wt = await repo.addWorktree(agentRef, worktreePath);
            // Apply a patch into the worktree and record its REAL tree hash so the
            // recovery path can verify the live tree still hashes to it (round-3 #4).
            writeFileSync(join(worktreePath, "applied.md"), `applied ${runId}\n`);
            gitIn(worktreePath, ["add", "-A"]);
            treeHash = gitIn(worktreePath, ["write-tree"]);
          }
          await handle.checkpoint("worktree-applied", { worktreePath, treeHash, agentRef });
        } else if (step === "agent-committed") {
          if (opts.realWorktree) {
            // Commit the applied worktree IN PLACE so the agent ref (the worktree's
            // attached HEAD) advances to a real commit whose tree equals the recorded
            // `treeHash`. This is the realistic agent-committed state the reconciler's
            // normative git checks (round finding #6) require: the agent ref CONTAINS
            // the stored commit and the commit's tree matches the applied-tree hash. A
            // dangling `commit-tree` object (no ref move, divergent tree) would be
            // correctly refused as unproven.
            gitIn(worktreePath, ["add", "-A"]);
            gitIn(worktreePath, ["commit", "-q", "-m", `agent ${runId}`]);
            agentSha = gitIn(worktreePath, ["rev-parse", "HEAD"]);
          } else {
            agentSha = agentCommit(h, base, runId);
          }
          await handle.checkpoint("agent-committed", { commitSha: agentSha, treeHash, agentRef, tier });
        } else if (step === "integrated") { const r = await handle.integrate(performIntegration(h)); canonicalSha = r.canonicalSha; }
        else if (step === "reindexed") await handle.checkpoint("reindexed", { indexGeneration: 1, canonicalSha });
        if (step === stopAfter) break;
      }
    } finally {
      store.close(); // "kill -9": the process holding the store dies here.
    }
    return { runId, base, worktreePath, agentRef, ...(wt ? { wt } : {}) };
  }

  it("crash at planned, no hook → left for producer re-drive (never fabricated)", async () => {
    const { runId } = await driveTo("planned");
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({ store, repo: openRepo(h.repoDir), now: tick });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "left" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("planned");
    } finally {
      store.close();
    }
  });

  it("crash at planned, deterministic recompute → advanced to patched per the table", async () => {
    const { runId } = await driveTo("planned");
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: { recomputePlan: async () => ({ deterministic: true, patched: patched(runId) }) },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "advanced", to: "patched" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("patched");
      expect(patchHashOf(store, runId)).toBe(patched(runId).patchHash);
    } finally {
      store.close();
    }
  });

  it("crash at planned, NONdeterministic recompute → failed@planned (plan-stale)", async () => {
    const { runId } = await driveTo("planned");
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: { recomputePlan: async () => ({ deterministic: false }) },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "failed", reason: "plan-stale" });
      const run = store.ledger.getAgentRun(runId)!;
      expect(run.status).toBe("failed");
      expect(run.failed_checkpoint).toBe("planned");
    } finally {
      store.close();
    }
  });

  it("crash at patched, deterministic recompute → advanced to worktree-applied per the table", async () => {
    const { runId, base } = await driveTo("patched");
    const store = h.openStore();
    try {
      const worktreePath = join(h.root, "wtp", runId);
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: {
          // The recomputed patchHash MUST equal the run's stored one (round finding
          // #6): the reconciler compares it, not just the boolean.
          recomputePatch: async () => ({
            deterministic: true,
            patchHash: patched(runId).patchHash,
            worktree: { worktreePath, treeHash: "c".repeat(40), agentRef: `refs/agent/${runId}` },
          }),
        },
      });
      void base;
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "advanced", to: "worktree-applied" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("worktree-applied");
      expect(gitOp(store, runId, "worktree-applied")).toEqual({ ref_name: worktreePath, commit_sha: "c".repeat(40) });
    } finally {
      store.close();
    }
  });

  it("crash at patched, NONdeterministic recompute → failed@patched (patch-nondeterministic)", async () => {
    const { runId } = await driveTo("patched");
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: { recomputePatch: async () => ({ deterministic: false }) },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "failed", reason: "patch-nondeterministic" });
      const run = store.ledger.getAgentRun(runId)!;
      expect(run.status).toBe("failed");
      expect(run.failed_checkpoint).toBe("patched");
    } finally {
      store.close();
    }
  });

  it("crash at patched, recompute deterministic but patchHash MISMATCHES stored → failed@patched (round finding #6)", async () => {
    // Round finding #6: the reconciler does NOT trust the `deterministic: true`
    // boolean — it compares the RECOMPUTED patchHash against the run's durably
    // stored one. A recomputed hash that diverges from the stored evidence is
    // nondeterminism/tamper and fails the run rather than advancing it.
    const { runId } = await driveTo("patched");
    const store = h.openStore();
    try {
      const worktreePath = join(h.root, "wtpm", runId);
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: {
          recomputePatch: async () => ({
            deterministic: true,
            patchHash: sha256Canonical({ tampered: runId }), // ≠ the stored patchHash
            worktree: { worktreePath, treeHash: "c".repeat(40), agentRef: `refs/agent/${runId}` },
          }),
        },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "failed", reason: "patch-nondeterministic" });
      const run = store.ledger.getAgentRun(runId)!;
      expect(run.status).toBe("failed");
      expect(run.failed_checkpoint).toBe("patched");
      // The run did NOT advance to worktree-applied on the divergent recompute.
      expect(gitOp(store, runId, "worktree-applied")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("crash at agent-committed with NO integrate hook → left for the producer re-drive (v2 #335)", async () => {
    const { runId } = await driveTo("agent-committed", { tier: 2, realWorktree: true });
    const store = h.openStore();
    try {
      // No integrate hook supplied ⇒ the reconciler leaves the committed run for the
      // producer (v2: there is no Tier-3 review park; a hook-bearing pass integrates it).
      const rep = await reconcileRunsOnStartup({ store, repo: openRepo(h.repoDir), now: tick });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "left" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("agent-committed");
    } finally {
      store.close();
    }
  });

  it("crash at agent-committed, Tier-2 → auto-integrated via the producer hook", async () => {
    const { runId } = await driveTo("agent-committed", { tier: 2, realWorktree: true });
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: { integrate: reconcileIntegrateHook(store, h) },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "integrated", to: "integrated" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("integrated");
      expect(h.mainSha()).toBe(gitOp(store, runId, "integrated")!.commit_sha);
    } finally {
      store.close();
    }
  });

  it("crash at agent-committed, Tier-1 → auto-integrated (round finding #6: Tier-1 is routed too)", async () => {
    // Round finding #6: auto-integration must route BOTH Tier-1 AND Tier-2 (the
    // prior `=== 2` excluded Tier-1 source-capture runs). A Tier-1 agent-committed
    // run with a proven agent ref/tree integrates just like Tier-2.
    const { runId } = await driveTo("agent-committed", { tier: 1, realWorktree: true });
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: { integrate: reconcileIntegrateHook(store, h) },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "integrated", to: "integrated" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("integrated");
      expect(h.mainSha()).toBe(gitOp(store, runId, "integrated")!.commit_sha);
    } finally {
      store.close();
    }
  });

  it("crash at agent-committed, agent ref does NOT contain the commit → LEFT, never integrated (round finding #6)", async () => {
    // Round finding #6: the reconciler must PROVE the agent ref resolves to the
    // stored commit before auto-integrating — it may not trust the recorded
    // commitSha on faith. A run whose agent ref was never advanced to the commit
    // (a lost commit / missing ref) is LEFT for the producer, not integrated.
    const store = h.openStore();
    const base = h.mainSha();
    const handle = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest" });
    const runId = handle.runId;
    const agentRef = `refs/agent/${runId}`;
    try {
      await handle.checkpoint("planned", plannedArtifacts(runId, base, { tier: 2 }));
      await handle.checkpoint("patched", patched(runId));
      await handle.checkpoint("worktree-applied", { worktreePath: join(h.root, "wtmr", runId), treeHash: "a".repeat(40), agentRef });
      // The commit is recorded, but `refs/agent/<runId>` was never created/advanced
      // to it — the reconciler's readRef(agentRef) resolves to null.
      await handle.checkpoint("agent-committed", { commitSha: "b".repeat(40), treeHash: "a".repeat(40), agentRef, tier: 2 });
    } finally {
      store.close();
    }
    const store2 = h.openStore();
    let integrateCalled = false;
    try {
      const rep = await reconcileRunsOnStartup({
        store: store2,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: {
          integrate: async () => {
            integrateCalled = true;
            throw new Error("integrate must not be called when the agent ref does not contain the commit");
          },
        },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "left", reason: "agent-ref-missing-commit" });
      expect(integrateCalled).toBe(false);
      expect(store2.ledger.getAgentRun(runId)!.status).toBe("agent-committed");
      expect(h.mainSha()).toBe(base); // canonical unmoved — nothing integrated
    } finally {
      store2.close();
    }
  });

  it("crash at agent-committed, commit tree ≠ recorded treeHash → LEFT, never integrated (round finding #6)", async () => {
    // Round finding #6: even when the agent ref DOES contain the commit, the
    // commit's tree must equal the `treeHash` captured at worktree-applied. A
    // divergent tree is tamper/nondeterminism and the run is LEFT, not integrated.
    const { runId } = await driveTo("agent-committed", { tier: 2, realWorktree: true });
    const store = h.openStore();
    // Tamper the RECORDED applied-tree hash (stored in the worktree-applied git op)
    // so it no longer matches the real committed tree the reconciler recomputes.
    store.db.prepare(`UPDATE git_operations SET commit_sha = ? WHERE git_op_id = ?`).run("f".repeat(40), `${runId}:worktree-applied`);
    let integrateCalled = false;
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: {
          integrate: async () => {
            integrateCalled = true;
            throw new Error("integrate must not be called when the commit tree diverges");
          },
        },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "left", reason: "commit-tree-mismatch" });
      expect(integrateCalled).toBe(false);
      expect(store.ledger.getAgentRun(runId)!.status).toBe("agent-committed");
    } finally {
      store.close();
    }
  });


  it("crash at worktree-applied with base UNMOVED → the ORIGINAL worktree is committed (tree verified)", async () => {
    const { runId, base, worktreePath } = await driveTo("worktree-applied", { realWorktree: true });
    expect(h.mainSha()).toBe(base); // base unmoved
    const store = h.openStore();
    try {
      const recordedTree = gitOp(store, runId, "worktree-applied")!.commit_sha!;
      const repo = openRepo(h.repoDir);
      const rep = await reconcileRunsOnStartup({
        store,
        repo,
        now: tick,
        hooks: {
          // Reopen + hash the RECORDED worktree (round-3 #4): the reconciler requires
          // this to equal the recorded treeHash before committing.
          hashWorktree: async (ctx) => {
            gitIn(ctx.worktreePath!, ["add", "-A"]);
            return gitIn(ctx.worktreePath!, ["write-tree"]);
          },
          // Commit the SAME (unchanged) worktree in place; its committed tree equals
          // the recorded applied tree, which the reconciler re-verifies.
          commitApplied: async (ctx) => {
            gitIn(ctx.worktreePath!, ["add", "-A"]);
            gitIn(ctx.worktreePath!, ["commit", "-q", "-m", `recovered ${ctx.runId}`]);
            const commitSha = gitIn(ctx.worktreePath!, ["rev-parse", "HEAD"]);
            const treeHash = gitIn(ctx.worktreePath!, ["rev-parse", "HEAD^{tree}"]);
            return { commitSha, treeHash };
          },
        },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "committed", to: "agent-committed" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("agent-committed");
      // The committed tree equals the recorded applied tree (proof the SAME patch
      // was recovered), and the recorded worktree treeHash is NOT overwritten.
      const committedTree = gitIn(worktreePath, ["rev-parse", "HEAD^{tree}"]);
      expect(committedTree).toBe(recordedTree);
      expect(gitOp(store, runId, "worktree-applied")!.commit_sha).toBe(recordedTree);
    } finally {
      store.close();
    }
  });

  it("crash at worktree-applied, live tree TAMPERED → failed@worktree-applied + cleaned (round-3 #4)", async () => {
    const { runId, worktreePath } = await driveTo("worktree-applied", { realWorktree: true });
    // Tamper: mutate the applied worktree so its live tree no longer matches the
    // recorded treeHash. Recovery must refuse to commit a divergent tree.
    writeFileSync(join(worktreePath, "applied.md"), "TAMPERED\n");
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: {
          hashWorktree: async (ctx) => {
            gitIn(ctx.worktreePath!, ["add", "-A"]);
            return gitIn(ctx.worktreePath!, ["write-tree"]);
          },
          commitApplied: async () => {
            throw new Error("must not be called — the tamper check fails first");
          },
        },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "failed", reason: "tree-tampered" });
      const run = store.ledger.getAgentRun(runId)!;
      expect(run.status).toBe("failed");
      expect(run.failed_checkpoint).toBe("worktree-applied");
      expect(existsSync(worktreePath)).toBe(false); // orphan cleaned
    } finally {
      store.close();
    }
  });

  it("crash at worktree-applied with base MOVED → failed@worktree-applied (base-moved) + worktree cleaned", async () => {
    const { runId, worktreePath } = await driveTo("worktree-applied", { realWorktree: true });
    expect(existsSync(worktreePath)).toBe(true);
    // Base moves under the applied-but-uncommitted worktree.
    writeFileSync(join(h.repoDir, "moved.md"), "moved\n");
    h.git(["add", "-A"]);
    h.git(["commit", "-q", "-m", "advance main"]);

    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({ store, repo: openRepo(h.repoDir), now: tick });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "failed", reason: "base-moved" });
      const run = store.ledger.getAgentRun(runId)!;
      expect(run.status).toBe("failed");
      expect(run.failed_checkpoint).toBe("worktree-applied");
      // run.failed audit event emitted.
      // the orphaned worktree is gone.
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("crash at integrated → integrated-but-unfinalized is reprojected then finalized forward", async () => {
    const { runId } = await driveTo("integrated");
    const integratedSha = h.mainSha(); // canonical really advanced to the agent commit
    const store = h.openStore();
    try {
      // The reconciler requires a REAL reprojection covering the integrated
      // canonicalSha before it records `reindexed`, then a verified §2.8 step-4
      // backup covering the run's seq before `finalized` (round-2 finding #5) — no
      // invented index generation, no finalize without durable coverage.
      let reprojected = 0;
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: {
          reindex: async () => {
            reprojected += 1;
            return { indexGeneration: 9, canonicalSha: integratedSha };
          },
        },
      });
      expect(reprojected).toBe(1); // the producer reprojection actually ran
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "finalized", to: "finalized" });
      const run = store.ledger.getAgentRun(runId)!;
      expect(run.status).toBe("finalized");
      // reindexed generation recorded from the hook (not fabricated).
      expect(assembleRunReport(store, runId)!.artifacts.indexGeneration).toBe(9);
    } finally {
      store.close();
    }
  });

  it("crash at integrated with NO reindex hook → left integrated (no invented generation)", async () => {
    const { runId } = await driveTo("integrated");
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({ store, repo: openRepo(h.repoDir), now: tick });
      // Without a producer reprojection the reconciler never fabricates a
      // generation — the run is LEFT integrated for the producer's re-drive.
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "left" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("integrated");
    } finally {
      store.close();
    }
  });

  it("crash at reindexed → finalized forward", async () => {
    const { runId } = await driveTo("reindexed");
    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({ store, repo: openRepo(h.repoDir), now: tick });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "finalized" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("finalized");
    } finally {
      store.close();
    }
  });


  it("integration seam: broker advance SUCCEEDS but the response is LOST → integrate completes forward (round-3 #1)", async () => {
    const store = h.openStore();
    const base = h.mainSha();
    const handle = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest" });
    const runId = handle.runId;
    try {
      await handle.checkpoint("planned", plannedArtifacts(runId, base));
      await handle.checkpoint("patched", patched(runId));
      await handle.checkpoint("worktree-applied", { worktreePath: join(h.root, "wtrl", runId), treeHash: "a".repeat(40), agentRef: `refs/agent/${runId}` });
      const commitSha = agentCommit(h, base, runId);
      await handle.checkpoint("agent-committed", { commitSha, treeHash: "a".repeat(40), agentRef: `refs/agent/${runId}`, tier: 2 });

      // `perform` does the REAL FF advance (canonical advances) then the response is
      // LOST (throws AFTER success). integrate() must inspect the authoritative ref
      // state, see the mutation is durable (canonical contains the commit), and
      // complete integration forward — NOT re-drive or orphan the canonical mutation.
      const realPerform = performIntegration(h);
      const r = await handle.integrate(async (ctx) => {
        await realPerform(ctx);
        throw new Error("response lost after a successful advance");
      });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("integrated");
      expect(h.mainSha()).toBe(r.canonicalSha); // canonical really advanced
      expect(gitOp(store, runId, "integrated")!.commit_sha).toBe(r.canonicalSha);
    } finally {
      store.close();
    }
  });


  it("agent ref advanced BEYOND the recorded commit → still integrated by ANCESTRY, not tip-equality (round-2 finding W4)", async () => {
    // Round-2 finding W4: containment was tested by ref-tip EQUALITY, so a valid
    // commit that is an ANCESTOR of an agent/canonical tip advanced by a follow-up
    // commit was wrongly rejected. With `merge-base --is-ancestor`, a descendant tip
    // still CONTAINS the recorded commit and the run auto-integrates.
    const { runId, worktreePath, agentRef } = await driveTo("agent-committed", { tier: 2, realWorktree: true });
    const recorded = gitIn(worktreePath, ["rev-parse", "HEAD"]);
    // Advance the agent ref to a CHILD of the recorded commit (a later commit layered
    // on the same branch): the tip now differs from the recorded commit but contains it.
    writeFileSync(join(worktreePath, "followup.md"), `followup ${runId}\n`);
    gitIn(worktreePath, ["add", "-A"]);
    gitIn(worktreePath, ["commit", "-q", "-m", `followup ${runId}`]);
    const advancedTip = gitIn(worktreePath, ["rev-parse", "HEAD"]);
    expect(advancedTip).not.toBe(recorded);
    const repo = openRepo(h.repoDir);
    expect(await repo.readRef(agentRef)).toBe(advancedTip); // tip advanced past the recorded commit
    expect(await repo.isAncestor(recorded, advancedTip)).toBe(true); // …but still contains it

    const store = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo,
        now: tick,
        hooks: { integrate: reconcileIntegrateHook(store, h) },
      });
      // Equality would have LEFT this run (agent-ref-missing-commit); ancestry integrates it.
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "integrated", to: "integrated" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("integrated");
    } finally {
      store.close();
    }
  });

  it("agent-committed with a NULL recorded treeHash → LEFT, never integrated (round-2 finding W5)", async () => {
    // Round-2 finding W5: a null stored treeHash is MISSING evidence, not proof of a
    // matching tree — auto-integration requires a non-null hash AND an exact match.
    const { runId } = await driveTo("agent-committed", { tier: 2, realWorktree: true });
    const store = h.openStore();
    // Null out the recorded applied-tree hash (git_operations.worktree-applied.commit_sha).
    store.db.prepare(`UPDATE git_operations SET commit_sha = NULL WHERE git_op_id = ?`).run(`${runId}:worktree-applied`);
    let integrateCalled = false;
    try {
      const rep = await reconcileRunsOnStartup({
        store,
        repo: openRepo(h.repoDir),
        now: tick,
        hooks: {
          integrate: async () => {
            integrateCalled = true;
            throw new Error("integrate must not run without a non-null recorded treeHash");
          },
        },
      });
      expect(rep.runs.find((r) => r.runId === runId)).toMatchObject({ action: "left", reason: "tree-hash-missing" });
      expect(integrateCalled).toBe(false);
      expect(store.ledger.getAgentRun(runId)!.status).toBe("agent-committed");
    } finally {
      store.close();
    }
  });

  it("finalize() publishes the EXACT command result atomically with finalized (round-2 finding W2)", async () => {
    // Round-2 finding W2: idempotency completion was wired only into fail/cancel/
    // reject, not the SUCCESS terminal, and recovery reconstructed a RunArtifacts
    // wrapper — dropping fields not derivable from artifacts. The atomic finalize()
    // API persists the arbitrary result verbatim in the SAME transaction as the
    // `finalized` state, so a retry replays the ORIGINAL shape.
    const { runId } = await driveTo("reindexed", { tier: 2 });
    const store = h.openStore();
    try {
      // A result with fields that are NOT derivable from run artifacts.
      const exact = { ok: true, token: "opaque-xyz", nested: { count: 42, note: "n1" }, notInArtifacts: [1, 2, 3] };
      const req = { command: "reconcile", key: "kfinal", requestHash: sha256Canonical({ a: 1 }), runId };
      expect(beginIdempotent(store.db, req, tick()).kind).toBe("started");

      const resumed = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest", runId, resume: true });
      expect(resumed.state).toBe("reindexed");
      const completion = completeIdempotentStatement(req, JSON.stringify(exact), tick());
      const out = await resumed.finalize(completion);
      expect(out.state).toBe("finalized");
      expect(store.ledger.getAgentRun(runId)!.status).toBe("finalized");

      const slot = idempotencySlot(store, "reconcile", "kfinal")!;
      expect(slot.state).toBe("done");
      // The EXACT result, verbatim — not an {idempotencyReplay, result: artifacts} wrapper.
      expect(JSON.parse(slot.result_json!)).toEqual(exact);
      const retry = beginIdempotent(store.db, { ...req, runId: newRunId() }, tick());
      expect(retry.kind).toBe("replay");
      if (retry.kind === "replay") expect(JSON.parse(retry.resultJson)).toEqual(exact);
      // run.integrated remains the single success audit event (finalize emits none).
    } finally {
      store.close();
    }
  });

  it("integrate() refuses an UNCHANGED-BASE result — canonicalSha ≠ the agent commit (round-3 #1)", async () => {
    // Round-3 finding on engine.ts:483-500: a performer returning the unchanged base
    // sha (or any non-agent commit) could pass a bare ancestry test and falsely finalize
    // integration. integrate() must require canonicalSha == the agent commit.
    const store = h.openStore();
    const base = h.mainSha();
    const handle = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest" });
    const runId = handle.runId;
    try {
      await handle.checkpoint("planned", plannedArtifacts(runId, base));
      await handle.checkpoint("patched", patched(runId));
      await handle.checkpoint("worktree-applied", { worktreePath: join(h.root, "wtub", runId), treeHash: "a".repeat(40), agentRef: `refs/agent/${runId}` });
      const commitSha = agentCommit(h, base, runId);
      await handle.checkpoint("agent-committed", { commitSha, treeHash: "a".repeat(40), agentRef: `refs/agent/${runId}`, tier: 2 });
      // A performer that reports the UNCHANGED base as canonicalSha (nothing installed).
      await expect(
        handle.integrate(async (ctx) => ({ canonicalRef: ctx.canonicalRef, canonicalSha: ctx.baseRef })),
      ).rejects.toThrow(/≠ the agent commit|unchanged-base/);
      expect(store.ledger.getAgentRun(runId)!.status).toBe("agent-committed"); // never integrated
      expect(h.mainSha()).toBe(base);
    } finally {
      store.close();
    }
  });

  it("integrate() refuses a WRONG-REF result — canonicalRef ≠ the run's recorded ref (round-3 #1)", async () => {
    const store = h.openStore();
    const base = h.mainSha();
    const handle = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest" });
    const runId = handle.runId;
    try {
      await handle.checkpoint("planned", plannedArtifacts(runId, base));
      await handle.checkpoint("patched", patched(runId));
      await handle.checkpoint("worktree-applied", { worktreePath: join(h.root, "wtwr", runId), treeHash: "a".repeat(40), agentRef: `refs/agent/${runId}` });
      const commitSha = agentCommit(h, base, runId);
      await handle.checkpoint("agent-committed", { commitSha, treeHash: "a".repeat(40), agentRef: `refs/agent/${runId}`, tier: 2 });
      // A performer that reports a DIFFERENT canonical ref than the one recorded at planned.
      await expect(
        handle.integrate(async (ctx) => ({ canonicalRef: "refs/heads/decoy", canonicalSha: ctx.commitSha })),
      ).rejects.toThrow(/≠ the run's recorded ref/);
      expect(store.ledger.getAgentRun(runId)!.status).toBe("agent-committed");
      expect(h.mainSha()).toBe(base);
    } finally {
      store.close();
    }
  });

  it("finalize() refuses integrated→finalized (skips the reindexed checkpoint) and is a true SINK on repeat (round-3 #2)", async () => {
    // Round-3 finding on engine.ts:635-667: finalize CAS only from reindexed; an
    // integrated→finalized would skip reindexed. And a repeated finalize must be a
    // true sink — no checkpoint_seq bump, no re-write.
    const { runId: integratedId } = await driveTo("integrated", { tier: 2 });
    {
      const store = h.openStore();
      try {
        const resumed = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest", runId: integratedId, resume: true });
        expect(resumed.state).toBe("integrated");
        await expect(resumed.finalize()).rejects.toBeInstanceOf(CheckpointCasError); // integrated→finalized illegal
        expect(store.ledger.getAgentRun(integratedId)!.status).toBe("integrated"); // unchanged
      } finally {
        store.close();
      }
    }
    // Repeated finalize from reindexed is a true sink.
    const { runId } = await driveTo("reindexed", { tier: 2 });
    const store = h.openStore();
    try {
      const resumed = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest", runId, resume: true });
      await resumed.finalize();
      expect(store.ledger.getAgentRun(runId)!.status).toBe("finalized");
      const seqAfterFirst = checkpointSeqOf(store, runId);
      // Re-finalize: a true sink — no checkpoint_seq bump, no throw, still finalized.
      const again = await resumed.finalize();
      expect(again.state).toBe("finalized");
      expect(checkpointSeqOf(store, runId)).toBe(seqAfterFirst);
    } finally {
      store.close();
    }
  });

  it("resume divergence: planned base, worktree agentRef, commit treeHash/tier/agentRef, reindex indexGeneration are all validated (round-3 #4)", async () => {
    // Round-3 finding on checkpoints.ts:643-685: same-checkpoint resume replay must
    // validate ALL durable/derivable artifacts, not a subset. Each divergent field is
    // rejected rather than no-op'd through.
    // planned: divergent baseRef.
    {
      const { runId, base } = await driveTo("planned", { tier: 2 });
      const store = h.openStore();
      try {
        const r = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest", runId, resume: true });
        await expect(r.checkpoint("planned", plannedArtifacts(runId, base, { baseRef: "d".repeat(40) }))).rejects.toMatchObject({ code: "gating-evidence-invalid" });
      } finally { store.close(); }
    }
    // worktree-applied: divergent agentRef.
    {
      const { runId } = await driveTo("worktree-applied", { tier: 2 });
      const store = h.openStore();
      try {
        const r = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest", runId, resume: true });
        await expect(
          r.checkpoint("worktree-applied", { worktreePath: join(h.root, "wt", runId), treeHash: "a".repeat(40), agentRef: "refs/agent/BOGUS" }),
        ).rejects.toMatchObject({ code: "gating-evidence-invalid" });
      } finally { store.close(); }
    }
    // agent-committed: divergent treeHash (the commit's tree ≠ the applied tree).
    {
      const { runId, agentRef } = await driveTo("agent-committed", { tier: 2 });
      const store = h.openStore();
      try {
        const r = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest", runId, resume: true });
        const c = gitOp(store, runId, "agent-committed")!;
        await expect(
          r.checkpoint("agent-committed", { commitSha: c.commit_sha!, treeHash: "f".repeat(40), agentRef, tier: 2 }),
        ).rejects.toMatchObject({ code: "gating-evidence-invalid" });
        // divergent tier.
        await expect(
          r.checkpoint("agent-committed", { commitSha: c.commit_sha!, treeHash: "a".repeat(40), agentRef, tier: 1 }),
        ).rejects.toMatchObject({ code: "gating-evidence-invalid" });
      } finally { store.close(); }
    }
    // reindexed: divergent indexGeneration.
    {
      const { runId } = await driveTo("reindexed", { tier: 2 });
      const store = h.openStore();
      try {
        const r = await startRun(depsWith(store, openRepo(h.repoDir)), { operation: "ingest", runId, resume: true });
        const g = gitOp(store, runId, "reindexed")!;
        await expect(
          r.checkpoint("reindexed", { indexGeneration: 999, canonicalSha: g.commit_sha! }),
        ).rejects.toMatchObject({ code: "gating-evidence-invalid" });
      } finally { store.close(); }
    }
  });

  it("resume with a MISMATCHED operation is refused (round-3 #4: durable identity compared)", async () => {
    const { runId } = await driveTo("planned", { tier: 2 });
    const store = h.openStore();
    try {
      await expect(
        startRun(depsWith(store, openRepo(h.repoDir)), { operation: "enrich", runId, resume: true }),
      ).rejects.toMatchObject({ code: "run-not-resumable" });
    } finally { store.close(); }
  });
});

// ── 3b. cooperative cancellation via AbortSignal ─────────────────────────────

describe("workflows-core: AbortSignal plumbing", () => {
  it("checkpoint throws on an aborted signal, then cancel(at) records the terminal", async () => {
    const store = h.openStore();
    try {
      const ac = new AbortController();
      const handle = await startRun(depsWith(store), { operation: "ingest", signal: ac.signal });
      await handle.checkpoint("planned", plannedArtifacts(handle.runId, h.mainSha()));
      ac.abort(); // cooperative cancel requested at `planned`
      const { RunAbortedError } = await import("../src/workflows/index.js");
      await expect(handle.checkpoint("patched", patched(handle.runId))).rejects.toBeInstanceOf(RunAbortedError);
      // The driver unwinds to a cancel from the last durable checkpoint.
      const term = await handle.cancel("planned");
      expect(term).toMatchObject({ state: "cancelled", from: "planned" });
      expect(store.ledger.getAgentRun(handle.runId)!.status).toBe("cancelled");
    } finally {
      store.close();
    }
  });
});

// ── 3b2. terminal audit payload field (finding #8) ───────────────────────────

// ── 3b2. terminal audit detail is a narrow, validated allowlist (findings #3/#4) ─

describe("workflows-core: terminal audit detail is allowlisted + terminal-owned fields win", () => {
  /**
   * A single VALID allowlisted model-call audit record (the only permitted extra) —
   * shaped to the SHARED SSOT `ModelCallAuditRecordSchema` (`@atlas/models`): a
   * derived `mc_`+32-hex callId, a `sha256:` requestHash, an in-set operation/outcome,
   * and non-negative INTEGER metrics. (A bogus hash/enum/metric is rejected — asserted
   * in the strict-schema test below.)
   */
  const validRecord = {
    callId: `mc_${"0".repeat(32)}`,
    requestHash: `sha256:${"a".repeat(64)}`,
    destination: "generativelanguage.googleapis.com",
    provider: "gemini",
    model: "gemini-3.5-flash",
    operation: "generateText" as const,
    inputTokens: 10,
    outputTokens: 5,
    costMicros: 15,
    latencyMs: 42,
    retries: 0,
    outcome: "success" as const,
  };

  it("parseTerminalAuditDetail is strict (unknown key rejected; valid allowlist passes)", () => {
    expect(() => parseTerminalAuditDetail({ modelCalls: [validRecord] })).not.toThrow();
    expect(() => parseTerminalAuditDetail({})).not.toThrow();
    expect(() => parseTerminalAuditDetail({ modelCalls: [{ ...validRecord, extra: "raw" }] })).toThrow(/terminal audit detail rejected/);
    expect(() => parseTerminalAuditDetail({ prompt: "raw" })).toThrow(/terminal audit detail rejected/);
  });

  it("parseTerminalAuditDetail enforces the SHARED receipt contract (bad hashes/enums/metrics rejected)", () => {
    // The schema is DERIVED from the @atlas/models / @atlas/broker receipt SSOT, so the
    // engine independently enforces the FULL contract — not arbitrary strings/numbers
    // (round-2 wing finding 3). Each mutation below must be rejected fail-closed.
    const bad = (over: Record<string, unknown>): unknown => ({ modelCalls: [{ ...validRecord, ...over }] });
    // Hashes: requestHash MUST be a `sha256:` digest; responseHash the same when present.
    expect(() => parseTerminalAuditDetail(bad({ requestHash: "req-hash" }))).toThrow(/terminal audit detail rejected/);
    expect(() => parseTerminalAuditDetail(bad({ responseHash: "not-a-digest" }))).toThrow(/terminal audit detail rejected/);
    // callId MUST be the derived `mc_`+32-hex id, not an arbitrary string.
    expect(() => parseTerminalAuditDetail(bad({ callId: "mc_test" }))).toThrow(/terminal audit detail rejected/);
    // Enums: operation ∈ EGRESS_OPERATIONS, outcome ∈ TRANSMISSION_OUTCOMES,
    // effectiveSensitivity ∈ SENSITIVITY_ORDER.
    expect(() => parseTerminalAuditDetail(bad({ operation: "exfiltrate" }))).toThrow(/terminal audit detail rejected/);
    expect(() => parseTerminalAuditDetail(bad({ outcome: "ok" }))).toThrow(/terminal audit detail rejected/);
    expect(() => parseTerminalAuditDetail(bad({ effectiveSensitivity: "top-secret" }))).toThrow(/terminal audit detail rejected/);
    // Metrics: non-negative INTEGERS only — a negative or fractional value is rejected.
    expect(() => parseTerminalAuditDetail(bad({ inputTokens: -1 }))).toThrow(/terminal audit detail rejected/);
    expect(() => parseTerminalAuditDetail(bad({ costMicros: 1.5 }))).toThrow(/terminal audit detail rejected/);
    expect(() => parseTerminalAuditDetail(bad({ retries: 2.7 }))).toThrow(/terminal audit detail rejected/);
    // Non-empty strings: destination/provider/model may not be blank.
    expect(() => parseTerminalAuditDetail(bad({ destination: "" }))).toThrow(/terminal audit detail rejected/);
    // The genuine allowlisted record (with the optional enum fields set validly) passes.
    expect(() => parseTerminalAuditDetail(bad({ responseHash: `sha256:${"b".repeat(64)}`, outcome: "refused", reasonCode: "policy", effectiveSensitivity: "restricted" }))).not.toThrow();
  });

  it("buildTerminalDetail merges extras FIRST + terminal-owned fields LAST (finding #4 merge order)", () => {
    // Directly guard the Object.assign ordering bug: even if a colliding key reached
    // extraDetail (bypassing the schema), the terminal-owned fields MUST win.
    const smuggled = { modelCalls: [], failedAt: "integrated", reason: "FALSIFIED" } as unknown as TerminalAuditDetail;
    const failed = buildTerminalDetail("failed", "planned", "real reason", smuggled);
    expect(failed.failedAt).toBe("planned"); // terminal wins, not "integrated"
    expect(failed.reason).toBe("real reason"); // terminal wins, not "FALSIFIED"
    const cancelled = buildTerminalDetail("cancelled", "patched", undefined, {});
    expect(cancelled.cancelledAt).toBe("patched");
    expect(cancelled.failedAt).toBeUndefined();
    // rejected records only the reason (no failedAt/cancelledAt).
    const rejected = buildTerminalDetail("rejected", "review-pending", "nope", {});
    expect(rejected.reason).toBe("nope");
    expect(rejected.failedAt).toBeUndefined();
    expect(rejected.cancelledAt).toBeUndefined();
  });
});

// ── 3b3. resume hydration + same-checkpoint replay immutability (finding #7) ──

describe("workflows-core: resume hydrates durable state", () => {
  it("resume:true hydrates #state, suppresses a second run.started, and same-checkpoint replay is immutable", async () => {
    // Drive a run to `patched`, then "crash" (close the store).
    let runId = "";
    {
      const store = h.openStore();
      try {
        const handle = await startRun(depsWith(store), { operation: "ingest" });
        runId = handle.runId;
        await handle.checkpoint("planned", plannedArtifacts(runId, h.mainSha()));
        await handle.checkpoint("patched", patched(runId));
      } finally {
        store.close();
      }
    }

    const store = h.openStore();
    try {
      const seqBefore = checkpointSeqOf(store, runId);

      // Resume the interrupted run. Round finding #7: this hydrates #state from the
      // durable status (so it can resume from BEYOND planned) and suppresses a second
      // run.started (the run already started).
      const resumed = await startRun(depsWith(store), { operation: "ingest", runId, resume: true });
      expect(resumed.state).toBe("patched"); // hydrated, not null

      // Same-checkpoint replay is immutable: re-driving the checkpoint the run is
      // ALREADY durably at is a no-op — no checkpoint_seq bump, no new audit event,
      // no gating overwrite.
      await resumed.checkpoint("patched", patched(runId));
      expect(checkpointSeqOf(store, runId)).toBe(seqBefore);

      // It then advances forward normally from the hydrated position.
      await resumed.checkpoint("worktree-applied", { worktreePath: join(h.root, "wtres", runId), treeHash: "a".repeat(40), agentRef: `refs/agent/${runId}` });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("worktree-applied");
    } finally {
      store.close();
    }
  });

  it("resume:true on a TERMINAL run is refused (a sink has no next step)", async () => {
    let runId = "";
    {
      const store = h.openStore();
      try {
        const handle = await startRun(depsWith(store), { operation: "ingest" });
        runId = handle.runId;
        await handle.checkpoint("planned", plannedArtifacts(runId, h.mainSha()));
        await handle.fail("planned", "boom");
      } finally {
        store.close();
      }
    }
    const store = h.openStore();
    try {
      await expect(startRun(depsWith(store), { operation: "ingest", runId, resume: true })).rejects.toMatchObject({ code: "run-not-resumable" });
    } finally {
      store.close();
    }
  });

  it("resume:true of a COMPLETELY UNKNOWN run is refused (round-2 finding W3)", async () => {
    // Round-2 finding W3: resume must validate durable identity — a resume of an id
    // with NO agent_runs row AND no run.started evidence is unknown and rejected,
    // never a phantom handle.
    const store = h.openStore();
    try {
      await expect(
        startRun(depsWith(store), { operation: "ingest", runId: newRunId(), resume: true }),
      ).rejects.toMatchObject({ code: "run-not-resumable" });
    } finally {
      store.close();
    }
  });

  it("same-checkpoint replay with DIVERGENT artifacts is rejected, not no-op'd (round-2 finding W3)", async () => {
    // Round-2 finding W3: same-checkpoint replay is IMMUTABLE, not blind. A resumed
    // run replaying its last checkpoint with artifacts that diverge from the durable
    // evidence is rejected rather than silently accepted.
    let runId = "";
    {
      const store = h.openStore();
      try {
        const handle = await startRun(depsWith(store), { operation: "ingest" });
        runId = handle.runId;
        await handle.checkpoint("planned", plannedArtifacts(runId, h.mainSha()));
        await handle.checkpoint("patched", patched(runId));
      } finally {
        store.close();
      }
    }
    const store = h.openStore();
    try {
      const resumed = await startRun(depsWith(store), { operation: "ingest", runId, resume: true });
      expect(resumed.state).toBe("patched");
      // Replay `patched` with a DIFFERENT patchHash than the durably-stored one.
      const divergent = { ...patched(runId), patchHash: sha256Canonical({ tampered: true }) };
      await expect(resumed.checkpoint("patched", divergent)).rejects.toMatchObject({ code: "gating-evidence-invalid" });
      // The durable row is untouched (still the original patched evidence).
      expect(patchHashOf(store, runId)).toBe(patched(runId).patchHash);
    } finally {
      store.close();
    }
  });

  it("pre-planned startRun leaves NO durable footprint — a fresh start on the id succeeds; resume is refused (v2 #338)", async () => {
    // v2 (#338): the `run.started` audit event is retired, so a `startRun` that never
    // reached `planned` leaves NO durable state at all (a run's first durable artifact
    // IS its `planned` agent_runs row). So there is nothing to collide with — a fresh
    // start on the id succeeds and drives `planned`; a resume of that id is refused
    // (nothing to resume).
    let runId = "";
    {
      const store = h.openStore();
      try {
        const handle = await startRun(depsWith(store), { operation: "ingest" });
        runId = handle.runId; // no planned checkpoint → no agent_runs row, no durable footprint
        expect(store.ledger.getAgentRun(runId)).toBeUndefined();
      } finally {
        store.close();
      }
    }
    const store = h.openStore();
    try {
      // Resume of an id with no durable row is refused — nothing to resume.
      await expect(
        startRun(depsWith(store), { operation: "ingest", runId, resume: true }),
      ).rejects.toMatchObject({ code: "run-not-resumable" });
      // A FRESH start on the same id succeeds (no phantom collision) and drives planned.
      const fresh = await startRun(depsWith(store), { operation: "ingest", runId });
      expect(fresh.state).toBeNull(); // no agent_runs row yet
      await fresh.checkpoint("planned", plannedArtifacts(runId, h.mainSha()));
      expect(store.ledger.getAgentRun(runId)!.status).toBe("planned");
    } finally {
      store.close();
    }
  });
});

// ── 3c. stale-handle persisted-state CAS races (finding #2) ──────────────────

describe("workflows-core: stale-handle persisted-state CAS", () => {
  it("a terminal from a superseded checkpoint is rejected — no audit event, no regression", async () => {
    const store = h.openStore();
    const base = h.mainSha();
    const handle = await startRun(depsWith(store), { operation: "ingest" });
    const runId = handle.runId;
    try {
      await handle.checkpoint("planned", plannedArtifacts(runId, base));
      await handle.checkpoint("patched", patched(runId));
      // Another actor advances the run under a different handle (concurrency/restart).
      store.db.prepare(`UPDATE agent_runs SET status='worktree-applied' WHERE run_id=?`).run(runId);
      // The stale handle still believes it is at `patched` and tries to fail there.
      await expect(handle.fail("patched", "stale")).rejects.toBeInstanceOf(CheckpointCasError);
      // The pre-flight CAS rejected it BEFORE any broker append — no terminal audit
      // event, and the advanced row is never regressed.
      expect(store.ledger.getAgentRun(runId)!.status).toBe("worktree-applied");
      expect(store.ledger.getAgentRun(runId)!.failed_checkpoint).toBeNull();
    } finally {
      store.close();
    }
  });

  it("a checkpoint advance from a superseded state is rejected — no gating-row/state regression", async () => {
    const store = h.openStore();
    const base = h.mainSha();
    const handle = await startRun(depsWith(store), { operation: "ingest" });
    const runId = handle.runId;
    try {
      await handle.checkpoint("planned", plannedArtifacts(runId, base));
      // Another actor advances the run well past `patched`.
      store.db.prepare(`UPDATE agent_runs SET status='worktree-applied' WHERE run_id=?`).run(runId);
      // The stale handle (still at planned) tries a legal-by-graph planned→patched,
      // but the persisted state has moved on → CAS rejects it.
      await expect(handle.checkpoint("patched", patched(runId))).rejects.toBeInstanceOf(CheckpointCasError);
      expect(store.ledger.getAgentRun(runId)!.status).toBe("worktree-applied");
      // no patch row was written by the rejected transition
      expect(patchHashOf(store, runId)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

// ── 4. reconciler orphan sweep ────────────────────────────────────────────────

describe("workflows-core: reconciler orphan sweep", () => {
  it("cleans a worktree recorded for an already-terminal run", async () => {
    const store = h.openStore();
    const repo = openRepo(h.repoDir);
    const base = h.mainSha();
    // No lent repo → the engine leaves the worktree for the reconciler's sweep.
    const handle = await startRun(depsWith(store), { operation: "ingest" });
    const runId = handle.runId;
    const agentRef = `refs/agent/${runId}`;
    const worktreePath = join(h.root, "wt", runId);
    await handle.checkpoint("planned", plannedArtifacts(runId, base));
    await handle.checkpoint("patched", patched(runId));
    await repo.createAgentBranch(runId, "refs/heads/main");
    await repo.addWorktree(agentRef, worktreePath);
    await handle.checkpoint("worktree-applied", { worktreePath, treeHash: "a".repeat(40), agentRef });
    // Terminate WITHOUT a lent repo (so the engine leaves the worktree for the sweep).
    await handle.fail("worktree-applied", "boom");
    expect(existsSync(worktreePath)).toBe(true);
    store.close();

    const store2 = h.openStore();
    try {
      const rep = await reconcileRunsOnStartup({ store: store2, repo, now: tick });
      expect(rep.worktreesCleaned).toBeGreaterThanOrEqual(1);
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      store2.close();
    }
  });
});

// ── 5. caller-idempotency layer ──────────────────────────────────────────────

describe("workflows-core: caller-idempotency layer", () => {
  it("identical retry returns the prior terminal result without re-running", () => {
    const store = h.openStore();
    try {
      const req = { command: "reconcile", key: "k1", requestHash: sha256Canonical({ a: 1 }), runId: newRunId() };
      const first = beginIdempotent(store.db, req, tick());
      expect(first.kind).toBe("started");
      completeIdempotent(store.db, req, JSON.stringify({ ok: true, noteId: "n1" }), tick());

      const retry = beginIdempotent(store.db, { ...req, runId: newRunId() }, tick());
      expect(retry.kind).toBe("replay");
      if (retry.kind === "replay") expect(JSON.parse(retry.resultJson)).toEqual({ ok: true, noteId: "n1" });
    } finally {
      store.close();
    }
  });

  it("key reuse with a DIFFERENT request is rejected", () => {
    const store = h.openStore();
    try {
      const req = { command: "ingest", key: "k2", requestHash: sha256Canonical({ path: "a.md" }), runId: newRunId() };
      beginIdempotent(store.db, req, tick());
      completeIdempotent(store.db, req, JSON.stringify({ ok: true }), tick());
      expect(() =>
        beginIdempotent(store.db, { ...req, requestHash: sha256Canonical({ path: "b.md" }), runId: newRunId() }, tick()),
      ).toThrow(IdempotencyKeyConflictError);
    } finally {
      store.close();
    }
  });

  it("a concurrent duplicate (still in-progress) blocks on the key", () => {
    const store = h.openStore();
    try {
      const req = { command: "maintain", key: "k3", requestHash: sha256Canonical({ scope: "all" }), runId: newRunId() };
      const first = beginIdempotent(store.db, req, tick());
      expect(first.kind).toBe("started"); // in-progress, not yet completed
      // A duplicate with the SAME key + request while the first is in-flight blocks.
      expect(() => beginIdempotent(store.db, { ...req, runId: newRunId() }, tick())).toThrow(IdempotencyInProgressError);
    } finally {
      store.close();
    }
  });
});

// ── 6. idempotency terminal reconciliation + ownership CAS (finding #6) ──────

describe("workflows-core: idempotency reconciliation + ownership CAS", () => {
  it("releases a crashed in-progress claim whose owning run has terminated", async () => {
    const store = h.openStore();
    try {
      const handle = await startRun(depsWith(store), { operation: "ingest" });
      await handle.checkpoint("planned", plannedArtifacts(handle.runId, h.mainSha()));
      const req = { command: "ingest", key: "kr", requestHash: sha256Canonical({ x: 1 }), runId: handle.runId };
      expect(beginIdempotent(store.db, req, tick()).kind).toBe("started");
      // The owning run terminates WITHOUT publishing the slot (a crash between the
      // terminal write and the completion publish). Startup reconciliation must free
      // the key rather than wedge it `in-progress` forever (round-2 finding #6).
      await handle.fail("planned", "boom");
      expect(reconcileIdempotency(store.db, tick())).toBeGreaterThanOrEqual(1);
      // The key is now free: a fresh retry re-claims it.
      expect(beginIdempotent(store.db, { ...req, runId: newRunId() }, tick()).kind).toBe("started");
    } finally {
      store.close();
    }
  });

  it("a FINALIZED run's crashed claim without a durable result FAILS CLOSED — never fabricated (round-3 #6)", () => {
    const store = h.openStore();
    try {
      // A `finalized` run whose slot is still `in-progress` means the completion was
      // never committed (a legacy/unwired finalize), so there is NO durable exact
      // result. Reconstructing one from run artifacts would fabricate an opaque response
      // the caller never returned — reconciliation must FAIL CLOSED (leave it
      // in-progress), not invent a replay (round-3 finding on idempotency.ts:306-317).
      const runId = newRunId();
      store.db
        .prepare(`INSERT INTO agent_runs (run_id, operation, status, checkpoint_seq, started_at, updated_at, finished_at) VALUES (?, 'ingest', 'finalized', 1, ?, ?, ?)`)
        .run(runId, tick(), tick(), tick());
      const req = { command: "ingest", key: "kfin", requestHash: sha256Canonical({ z: 1 }), runId };
      expect(beginIdempotent(store.db, req, tick()).kind).toBe("started");

      // Fail closed: the finalized-but-unpublished slot is NOT resolved (not counted)
      // and is NEVER fabricated into a replay.
      expect(reconcileIdempotency(store.db, tick())).toBe(0);
      const slot = idempotencySlot(store, "ingest", "kfin")!;
      expect(slot.state).toBe("in-progress"); // left as-is, no invented result
      expect(slot.result_json).toBeNull();

      // A retry BLOCKS on the key (retryable) rather than receiving a fabricated result.
      expect(() => beginIdempotent(store.db, { ...req, runId: newRunId() }, tick())).toThrow(IdempotencyInProgressError);
    } finally {
      store.close();
    }
  });

  it("a duplicate completion (already-done slot) affects zero rows and is rejected (round-3 expectChanges)", () => {
    // Round-3 finding on idempotency.ts:205-227: an already-`done` row with the SAME
    // owner/hash changes ZERO rows on re-completion yet still satisfies the post-state
    // SELECT (a `done` row exists) — the assert alone would let a DUPLICATE completion
    // pass. `expectChanges: 1` rejects the no-op UPDATE.
    const store = h.openStore();
    try {
      const req = { command: "reconcile", key: "kdup", requestHash: sha256Canonical({ d: 1 }), runId: newRunId() };
      expect(beginIdempotent(store.db, req, tick()).kind).toBe("started");
      completeIdempotent(store.db, req, JSON.stringify({ ok: true }), tick()); // first: done
      // The STATEMENT form (used inside a terminal tx) carries expectChanges:1 — a
      // second application changes 0 rows and its serialized affected-row CAS throws.
      const dup = completeIdempotentStatement(req, JSON.stringify({ ok: true }), tick());
      expect(() => applyLedgerWrite(store.db, [dup])).toThrow(/assertion failed|affected/);
      // The standalone form also refuses (0-row CAS → ownership error).
      expect(() => completeIdempotent(store.db, req, JSON.stringify({ ok: true }), tick())).toThrow(IdempotencyOwnershipError);
    } finally {
      store.close();
    }
  });

  it("a stale owner cannot complete or release another run's claim", () => {
    const store = h.openStore();
    try {
      const req = { command: "maintain", key: "ko", requestHash: sha256Canonical({ y: 2 }), runId: newRunId() };
      expect(beginIdempotent(store.db, req, tick()).kind).toBe("started");
      const stale = { ...req, runId: newRunId() };
      // Owner CAS: a non-owning run cannot complete the slot.
      expect(() => completeIdempotent(store.db, stale, JSON.stringify({ ok: true }), tick())).toThrow(IdempotencyOwnershipError);
      // Owner CAS: a non-owning run's release is a no-op — the live claim survives and
      // still blocks a concurrent duplicate.
      releaseIdempotent(store.db, stale, tick());
      expect(() => beginIdempotent(store.db, { ...req, runId: newRunId() }, tick())).toThrow(IdempotencyInProgressError);
      // The true owner can release it, freeing the key for a retry.
      releaseIdempotent(store.db, req, tick());
      expect(beginIdempotent(store.db, { ...req, runId: newRunId() }, tick()).kind).toBe("started");
    } finally {
      store.close();
    }
  });

  it("a crashed claim with NO agent_runs row is RELEASED by reconciliation (round finding #5 LEFT JOIN)", () => {
    // Round finding #5: a crash in the claim → run-start seam leaves a claim whose
    // owning run never wrote an agent_runs row. The prior INNER-join reconciliation
    // dropped such a claim, wedging it `in-progress` forever. The LEFT JOIN frees it
    // (at startup a claim with no run row is a crashed seam, not a live attempt).
    const store = h.openStore();
    try {
      const req = { command: "ingest", key: "kseam", requestHash: sha256Canonical({ s: 1 }), runId: newRunId() };
      expect(beginIdempotent(store.db, req, tick()).kind).toBe("started");
      // No agent_runs row was ever written for req.runId (crash before first checkpoint).
      expect(store.ledger.getAgentRun(req.runId)).toBeUndefined();
      expect(reconcileIdempotency(store.db, tick())).toBeGreaterThanOrEqual(1);
      // Freed: a fresh retry re-claims the key.
      expect(beginIdempotent(store.db, { ...req, runId: newRunId() }, tick()).kind).toBe("started");
    } finally {
      store.close();
    }
  });
});

// ── 5b. terminal-transaction idempotency completion (finding #4) ─────────────

describe("workflows-core: terminal-transaction idempotency completion", () => {
  it("completeStatement inside the terminal commits atomically — exactly one owner/hash/state row", async () => {
    // Round finding #4: the completion is published as a LedgerStatement committed
    // INSIDE the run's terminal transaction, so the terminal state + the published
    // result land together. After the terminal, exactly ONE `done` row owned by this
    // run with the matching request hash exists, and a retry replays it.
    const store = h.openStore();
    try {
      const handle = await startRun(depsWith(store), { operation: "reconcile" });
      const runId = handle.runId;
      await handle.checkpoint("planned", plannedArtifacts(runId, h.mainSha()));
      const req = { command: "reconcile", key: "kterm", requestHash: sha256Canonical({ a: 1 }), runId };
      expect(beginIdempotent(store.db, req, tick()).kind).toBe("started");

      const completion = completeIdempotentStatement(req, JSON.stringify({ ok: true, noteId: "n1" }), tick());
      const term = await handle.fail("planned", "done", completion);
      expect(term).toMatchObject({ state: "failed", from: "planned" });
      expect(store.ledger.getAgentRun(runId)!.status).toBe("failed");

      // The slot committed to `done` in the SAME transaction as the terminal state.
      const slot = idempotencySlot(store, "reconcile", "kterm")!;
      expect(slot.state).toBe("done");
      expect(JSON.parse(slot.result_json!)).toEqual({ ok: true, noteId: "n1" });
      // Exactly ONE owner/hash/state row.
      const owned = store.db
        .prepare(`SELECT COUNT(*) AS c FROM workflow_idempotency WHERE command=? AND idempotency_key=? AND run_id=? AND request_hash=? AND state='done'`)
        .get("reconcile", "kterm", runId, req.requestHash) as { c: number };
      expect(owned.c).toBe(1);
      // A retry replays the published result rather than re-running.
      const retry = beginIdempotent(store.db, { ...req, runId: newRunId() }, tick());
      expect(retry.kind).toBe("replay");
      if (retry.kind === "replay") expect(JSON.parse(retry.resultJson)).toEqual({ ok: true, noteId: "n1" });
    } finally {
      store.close();
    }
  });

  it("a STALE claim's completion rolls the WHOLE terminal transaction back (round finding #4)", async () => {
    // Round finding #4: the serialized owner/hash/state CAS means a completion for a
    // slot NOT owned by this run affects zero rows, its assert finds no `done` row,
    // and the ENTIRE terminal transaction rolls back — the run's terminal state and
    // the publish land or roll back together (never a half-applied terminal).
    const store = h.openStore();
    try {
      // Run A owns the slot (a bare claim, no agent_runs row needed).
      const reqA = { command: "reconcile", key: "kroll", requestHash: sha256Canonical({ a: 1 }), runId: newRunId() };
      expect(beginIdempotent(store.db, reqA, tick()).kind).toBe("started");

      // Run B (a real run at planned) tries to terminate WITH a completion for the
      // SAME (command,key) but owned by B — a stale claim it does not hold.
      const handleB = await startRun(depsWith(store), { operation: "reconcile" });
      await handleB.checkpoint("planned", plannedArtifacts(handleB.runId, h.mainSha()));
      const reqB = { command: "reconcile", key: "kroll", requestHash: reqA.requestHash, runId: handleB.runId };
      const staleCompletion = completeIdempotentStatement(reqB, JSON.stringify({ ok: true }), tick());

      await expect(handleB.fail("planned", "boom", staleCompletion)).rejects.toThrow(/assertion failed|stale claim/);
      // The terminal rolled back: B is NOT failed, and A's claim is untouched.
      expect(store.ledger.getAgentRun(handleB.runId)!.status).toBe("planned");
      const slot = idempotencySlot(store, "reconcile", "kroll")!;
      expect(slot.state).toBe("in-progress");
      expect(slot.result_json).toBeNull();
    } finally {
      store.close();
    }
  });
});

// ── 5c. idempotency-table migration ownership (finding #3) ───────────────────

describe("workflows-core: idempotency migration ownership", () => {
  it("the workflow_idempotency table is created by the REGISTERED 0006 migration, recorded in db_schema_migrations", () => {
    // Round finding #3: the table is a first-class checksum-guarded migration applied
    // at store-open via registerWorkflowMigrations (Store.registerMigration +
    // Store.migrate) — NOT lazily created during a command.
    const store = h.openStore(); // registers 0006 then migrates
    try {
      const table = store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_idempotency'`).get();
      expect(table).toBeDefined();
      const mig = store.db.prepare(`SELECT 1 FROM db_schema_migrations WHERE id='0006_workflow_idempotency'`).get();
      expect(mig).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("a BARE store (no registerWorkflowMigrations) does NOT own the idempotency table (§2.7 default set preserved)", () => {
    // The migration is deliberately OUT of openStore's default retained set, so the
    // migrate-ownership fresh-DB diff stays exactly the §2.7 core/provenance/claims
    // set. A store opened WITHOUT registering the workflows migration lacks the table.
    const bareDb = join(h.root, "bare-ledger.db");
    const store = openStore({ path: bareDb });
    try {
      store.migrate(); // default set only — 0006 NOT registered
      const table = store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_idempotency'`).get();
      expect(table).toBeUndefined();
      const mig = store.db.prepare(`SELECT 1 FROM db_schema_migrations WHERE id='0006_workflow_idempotency'`).get();
      expect(mig).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("the PRODUCTION openWorkflowStore lifecycle applies 0006 at store-open (round-2 finding W7)", () => {
    // Round-2 finding W7: registration must be wired into a real store-open path, not
    // only invoked by the test harness. openWorkflowStore is that production path — it
    // opens, registers the workflows-owned migration(s), and migrates, so the table is
    // guaranteed present at open.
    const prodDb = join(h.root, "prod-ledger.db");
    const store = openWorkflowStore({ path: prodDb });
    try {
      const table = store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_idempotency'`).get();
      expect(table).toBeDefined();
      const mig = store.db.prepare(`SELECT 1 FROM db_schema_migrations WHERE id='0006_workflow_idempotency'`).get();
      expect(mig).toBeDefined();
      // The core §2.7 set is present too (a fully-migrated store), not just 0006.
      expect(store.db.prepare(`SELECT 1 FROM db_schema_migrations WHERE id='0001_core'`).get()).toBeDefined();
    } finally {
      store.close();
    }
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function patched(runId: string) {
  return {
    patchId: `${runId}-patch`,
    planId: `${runId}-plan`,
    noteId: "n1",
    changedLines: 3,
    changedSections: 1,
    patchHash: sha256Canonical({ p: runId }),
    // The patch is materialized against the run's OWN plan — its planHash chains
    // onto the durably-stored one (round-3 finding #5: planHash is required).
    planHash: sha256Canonical(planOf(runId)),
  };
}

/**
 * Create a REAL fast-forward child commit of `base` on canonical (an agent commit
 * ready to integrate). Returns its sha — used as the `agent-committed` commitSha so
 * the broker's real ref-advance installs an actual object (round-2 finding: no
 * synthetic canonical SHA).
 */
function agentCommit(h: Harness, base: string, runId: string): string {
  h.git(["read-tree", base]);
  const rel = `agent-${runId}.md`;
  writeFileSync(join(h.repoDir, rel), `agent ${runId}\n`);
  h.git(["add", rel]);
  const tree = h.git(["write-tree"]);
  return h.git(["commit-tree", tree, "-p", base, "-m", `agent ${runId}`]);
}

/**
 * The REAL v2 integrator: `makeCanonicalIntegrator` — the FF-only in-process
 * CAS advance of `refs/heads/main` (the production seam enrich/evidence use).
 */
function performIntegration(h: Harness, _svc?: unknown): RunIntegrator {
  return makeCanonicalIntegrator(openRepo(h.repoDir));
}

function manifestFor(runId: string, state: RunManifest["state"], base: string): RunManifest {
  return { schemaVersion: 1, runId, state, createdAt: "2026-07-12T00:00:00.000Z", canonicalBaseCommit: base, targets: ["n1"] };
}

/**
 * v2 (#338): the audit event stream is retired. There is no longer any per-run
 * `run.*` event sequence to read — a run's history IS its `agent_runs.status`
 * progression. This helper survives only as a no-op so the remaining callers (which
 * assert the audit stream is EMPTY) stay meaningful; the state-machine assertions in
 * those tests rest on `agent_runs` directly.
 */
function auditKinds(_store: Store, _runId: string): string[] {
  return [];
}

function planHashOf(store: Store, runId: string): string | undefined {
  return (store.db.prepare(`SELECT plan_hash FROM change_plans WHERE run_id = ?`).get(runId) as { plan_hash: string } | undefined)?.plan_hash;
}

function patchHashOf(store: Store, runId: string): string | undefined {
  return (
    store.db
      .prepare(`SELECT p.patch_hash AS h FROM patches p JOIN change_plans c ON c.plan_id = p.plan_id WHERE c.run_id = ?`)
      .get(runId) as { h: string } | undefined
  )?.h;
}

function gitOp(store: Store, runId: string, opType: string): { ref_name: string; commit_sha: string | null } | undefined {
  return store.db.prepare(`SELECT ref_name, commit_sha FROM git_operations WHERE git_op_id = ?`).get(`${runId}:${opType}`) as
    | { ref_name: string; commit_sha: string | null }
    | undefined;
}

/** The stored idempotency slot state + result for a `(command, key)`, or undefined. */
function idempotencySlot(store: Store, command: string, key: string): { state: string; result_json: string | null } | undefined {
  return store.db.prepare(`SELECT state, result_json FROM workflow_idempotency WHERE command = ? AND idempotency_key = ?`).get(command, key) as
    | { state: string; result_json: string | null }
    | undefined;
}

/** A run's `agent_runs.checkpoint_seq` (the same-checkpoint-replay immutability probe). */
function checkpointSeqOf(store: Store, runId: string): number | undefined {
  return (store.db.prepare(`SELECT checkpoint_seq FROM agent_runs WHERE run_id = ?`).get(runId) as { checkpoint_seq: number } | undefined)?.checkpoint_seq;
}

/**
 * A reconciler `integrate` hook for a Tier-2 auto-integrate recovery: the FF-only
 * in-process CAS advance of the canonical ref, returning the {@link IntegratedArtifacts}
 * the reconciler's step records. v2 (#338): no audit `seq`/append — just the git FF.
 */
function reconcileIntegrateHook(store: Store, hh: Harness) {
  void store;
  return async (ctx: { runId: string; commitSha: string | null; canonicalRef: string | null; baseRef: string | null }) => {
    const canonicalRef = ctx.canonicalRef ?? "refs/heads/main";
    const base = await openRepo(hh.repoDir).readRef(canonicalRef);
    const newCommit = await advanceCanonicalRef(hh.repoDir, canonicalRef, ctx.commitSha!, base ?? "0".repeat(40));
    return { canonicalRef, canonicalSha: newCommit };
  };
}
