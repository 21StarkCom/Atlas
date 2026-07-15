/**
 * `brain git cleanup` (Task 2.9 / #35) — prune the abandoned agent branches +
 * worktrees of TERMINAL runs. Convergent / intrinsically idempotent: a repeat run
 * with nothing to prune reports zero and succeeds (exit 0).
 *
 * SAFETY (review hint — "only prune terminal-run branches/worktrees, never an
 * in-flight run"):
 *  - It selects ONLY runs in a terminal `agent_runs.status` ({@link TERMINAL_RUN_STATES});
 *    an OPEN run (planned…review-pending) is never a candidate.
 *  - It runs under the exclusive `canonical-integration` lock, serializing against
 *    integration so a run cannot transition terminal→open (or an open run reach a
 *    branch/worktree state) mid-prune.
 *  - It only ever touches `refs/agent/*` (via the guarded `deleteAgentRef`) + their
 *    worktrees — never canonical or any protected ref (structurally enforced by
 *    `@atlas/git`).
 */
import { existsSync } from "node:fs";
import { isUlid } from "@atlas/contracts";
import { openRepo, deleteAgentRef, type Repo, type WorktreeEntry } from "@atlas/git";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { TERMINAL_STATES } from "../workflows/checkpoints.js";
import { openMigratedStore } from "./store-open.js";
import { resolvePath } from "./backup-config.js";

/**
 * The terminal `agent_runs.status` values — the ONLY runs `git cleanup` may prune.
 * SSOT is the workflow engine's {@link TERMINAL_STATES} (the recovery-state-machine
 * DDL CHECK set: `finalized`, `rejected`, `rolled-back`, `failed`, `cancelled`).
 * We MUST NOT re-enumerate or extend it: `integrated` and `reindexed` are progression
 * CHECKPOINTS, not terminals — a run in either still advances to `finalized`, so
 * pruning its branch/worktree would delete artifacts finalization still needs. This
 * re-export exists only to name the cleanup candidate set at this call site.
 */
export const TERMINAL_RUN_STATES = TERMINAL_STATES;

const TERMINAL_STATES_SQL = TERMINAL_RUN_STATES.map((s) => `'${s}'`).join(", ");

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else throw CliError.usage(`\`git cleanup\`: unknown flag/argument ${a}`);
  }
  return { dryRun };
}

/** A terminal run considered for pruning. */
interface TerminalRun {
  readonly run_id: string;
  readonly status: string;
}

interface PruneDetail {
  runId: string;
  action: "branch-pruned" | "worktree-pruned" | "branch+worktree-pruned";
  reason: string;
}

/** A git operation that failed AND left its resource still present (not verified absent). */
interface PruneFailure {
  runId: string;
  resource: "branch" | "worktree";
  error: string;
}

/** The outcome of attempting to prune one terminal run. */
interface PruneResult {
  detail: PruneDetail | null;
  branch: boolean;
  /** How many ref-bound worktrees were actually removed (≥0; may exceed 1). */
  worktrees: number;
  failures: PruneFailure[];
}

/**
 * Prune one terminal run's branch/worktree. Best-effort per resource (a resource
 * already gone is a no-op, keeping cleanup convergent) but NOT failure-swallowing:
 * a git operation that errors AND leaves the resource still present is collected as
 * a {@link PruneFailure} so the command can report it (only VERIFIED ABSENCE is a
 * successful no-op).
 *
 * SAFETY (finding W2 + finding round-4 #3): a terminal run's worktree is discovered
 * by its VERIFIED git binding — the registered worktree ({@link WorktreeEntry})
 * whose HEAD is attached to THIS run's own `refs/agent/<runId>` — NOT by the ledger's
 * free-form recorded path. The ledger `git_operations` path was the prior discovery
 * key, so a MISSING, STALE, or MISDIRECTED `worktree-applied` row hid a worktree
 * still bound to the ref: cleanup then deleted the branch and ORPHANED that worktree
 * (a broken worktree future cleanup could no longer recognize), or, when the row
 * pointed at another (e.g. open) run's worktree, risked removing an unrelated one.
 * Keying on the branch binding fixes both: only a worktree git reports as bound to
 * the terminal run's ref is a candidate (an open run's worktree binds to its own
 * ref, so it is never matched — cleanup STILL touches terminal-run resources only),
 * and it cannot depend on the ledger row being present or correct.
 *
 * ALL bound worktrees, not one (round-2 finding W4): `@atlas/git` adds a worktree by
 * a DETACHED checkout and then re-attaches HEAD to the agent ref (`repo.addWorktree`),
 * so git does not enforce its usual "a branch is checked out in at most one worktree"
 * rule — DUPLICATE worktrees bound to the same `refs/agent/<runId>` are possible. We
 * therefore remove EVERY worktree bound to the ref (a `find` would have left the rest
 * orphaned).
 *
 * The worktrees are removed BEFORE the ref, and the ref is deleted ONLY once git
 * itself confirms NO worktree still binds to it (round-2 finding W3). Filesystem
 * absence of a worktree dir is NOT proof git deregistered it (a `--force` remove can
 * fail on a locked/unclean worktree yet the admin metadata — and the binding — remain,
 * or the dir can be gone while the registration lingers). So after the removals we
 * RE-LIST git's worktrees (the ground truth) and, if any still bind the ref, we
 * PRESERVE the ref (never delete a ref a live worktree is still checked out on — that
 * is exactly how the orphan arose) and record the surviving binding as an operational
 * failure.
 */
async function pruneRun(
  repo: Repo,
  worktrees: readonly WorktreeEntry[],
  run: TerminalRun,
  dryRun: boolean,
): Promise<PruneResult> {
  // A non-ULID run id can never own a well-formed agent ref/worktree; skip entirely.
  const ref = isUlid(run.run_id) ? `refs/agent/${run.run_id}` : null;
  const failures: PruneFailure[] = [];
  if (ref === null) return { detail: null, branch: false, worktrees: 0, failures };

  // Discover this run's worktree(s) by the AUTHORITATIVE branch binding: every git-
  // registered worktree whose HEAD is attached to THIS run's own agent ref. `branch`
  // is git's own porcelain report, so no path canonicalization is needed — we remove
  // exactly the paths git reports. Duplicate bindings are possible (see doc above).
  const bound = worktrees.filter((w) => w.branch === ref);

  // Worktrees first: a ref checked out into a worktree cannot be deleted until the
  // worktree is removed (else the branch delete orphans it).
  let prunedWorktrees = 0;
  let bindingRemains = false;
  if (bound.length > 0) {
    if (dryRun) {
      prunedWorktrees = bound.length; // report intent; mutate nothing
    } else {
      const removalErrors = new Map<string, string>();
      for (const w of bound) {
        try {
          await repo.removeWorktree(w.path);
        } catch (e) {
          removalErrors.set(w.path, msgOf(e));
        }
      }
      // Re-list from git (the ground truth) — NOT existsSync — so a worktree still
      // registered against the ref is detected even if its directory is gone.
      const stillBound = (await repo.listWorktrees()).filter((w) => w.branch === ref);
      bindingRemains = stillBound.length > 0;
      prunedWorktrees = bound.length - stillBound.length;
      for (const w of stillBound) {
        failures.push({
          runId: run.run_id,
          resource: "worktree",
          error: removalErrors.get(w.path) ?? `worktree ${w.path} still bound to ${ref} after removal`,
        });
      }
    }
  }

  // Then the agent branch (guarded delete — refuses any non-agent ref) — ONLY when no
  // worktree still binds the ref, so a ref checked out into a surviving worktree is
  // never deleted out from under it (round-2 finding W3).
  let prunedBranch = false;
  if (!bindingRemains && (await repo.readRef(ref)) !== null) {
    if (!dryRun) {
      try {
        await deleteAgentRef(repo.dir, ref);
      } catch (e) {
        // Operational failure: only a no-op if the ref is verifiably gone anyway.
        if ((await repo.readRef(ref)) !== null) failures.push({ runId: run.run_id, resource: "branch", error: msgOf(e) });
      }
    }
    prunedBranch = dryRun || (await repo.readRef(ref)) === null;
  }

  if (!prunedBranch && prunedWorktrees === 0) return { detail: null, branch: false, worktrees: prunedWorktrees, failures };
  const action: PruneDetail["action"] =
    prunedBranch && prunedWorktrees > 0 ? "branch+worktree-pruned" : prunedBranch ? "branch-pruned" : "worktree-pruned";
  return {
    detail: { runId: run.run_id, action, reason: `run terminal (${run.status})` },
    branch: prunedBranch,
    worktrees: prunedWorktrees,
    failures,
  };
}

/** Extract a human-readable message from a thrown value. */
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function gitCleanup(ctx: RunContext): Promise<number> {
  const { dryRun } = parseArgs(ctx.argv);
  const vaultPath = resolvePath(ctx, ctx.config.config.vault.path);
  if (!existsSync(vaultPath)) {
    throw new CliError({
      code: "vault-error",
      message: `\`git cleanup\`: the vault repo at ${vaultPath} is missing or unreadable`,
      hint: "Check vault.path in brain.config.yaml.",
      exitCode: EXIT.CONFIG,
    });
  }

  // Serialize against integration under the exclusive canonical-integration lock so
  // a run cannot change state mid-prune. `withLock` throws `locked:canonical-integration`
  // (exit 2, retryable) if an integration holds it.
  return ctx.withLock("canonical-integration", async () => {
    const store = openMigratedStore(ctx);
    try {
      const repo = openRepo(vaultPath);
      const runs = store.db
        .prepare(
          `SELECT run_id, status FROM agent_runs
            WHERE status IN (${TERMINAL_STATES_SQL})
            ORDER BY run_id ASC`,
        )
        .all() as TerminalRun[];

      // git's registered worktree/ref bindings, read ONCE under the lock — the
      // ground truth pruneRun checks each recorded path against (finding W2).
      const worktrees = await repo.listWorktrees();

      const details: PruneDetail[] = [];
      const failures: PruneFailure[] = [];
      let prunedBranches = 0;
      let prunedWorktrees = 0;
      for (const run of runs) {
        const res = await pruneRun(repo, worktrees, run, dryRun);
        failures.push(...res.failures);
        prunedWorktrees += res.worktrees;
        if (res.detail === null) continue;
        details.push(res.detail);
        if (res.branch) prunedBranches++;
      }

      // Best-effort but honest (finding W3): after processing every run, a git
      // operation that failed AND left its resource present is an operational error,
      // not a silent exit-0 no-op. Surface it as `internal` so cleanup never reports
      // success while abandoned branches/worktrees remain.
      if (failures.length > 0) {
        throw new CliError({
          code: "internal",
          message:
            `\`git cleanup\`: ${failures.length} prune operation(s) failed: ` +
            failures.map((f) => `${f.resource} for run ${f.runId} (${f.error})`).join("; "),
          hint: "Re-run `brain git cleanup` after resolving the underlying git error; cleanup is idempotent.",
          exitCode: EXIT.INTERNAL,
        });
      }

      const out = { command: "git cleanup", prunedBranches, prunedWorktrees, details };
      if (ctx.output.mode === "json") emitJson(out);
      else
        ctx.render(
          `${dryRun ? "would prune" : "pruned"}: ${prunedBranches} branch(es), ${prunedWorktrees} worktree(s)`,
        );
      return EXIT.OK;
    } finally {
      store.close();
    }
  });
}

registerCommand("git cleanup", gitCleanup);

export { gitCleanup };
