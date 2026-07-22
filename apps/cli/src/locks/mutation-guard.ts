/**
 * The vault-mutation guard (Phase-2 task 2.3, plan §Phase-2 task 3).
 *
 * Every derived-store WRITER — mutating commands (`source add`, `note add`,
 * `ingest --apply`, `enrich/reconcile/maintain --apply`, `evidence resolve`),
 * `sync`, `db migrate|rebuild`, `index rebuild`, and `jobs run` — runs its whole
 * mutation order (grounding → apply → commit → projection+index refresh) under the
 * brain-owned advisory vault lock, so no two writers ever touch the vault + derived
 * stores concurrently. Read commands NEVER take it.
 *
 * This module is the shared entry the synthesis/capture command handlers use.
 * `sync`, `db`, `index`, and `jobs` already take their scope directly via
 * `ctx.withLock` (see their handlers); the standalone mutating commands funnel
 * through {@link withVaultMutation} so the lock scope + the apply-time external
 * `index.lock` preflight are enforced in ONE place.
 *
 * Two failure modes, both exit 2, kept DISTINCT on purpose:
 *  - the advisory vault lock is held by another live writer ⇒ `locked:<scope>`
 *    (from {@link LockManager.withLock}; no queueing — the loser fails fast);
 *  - a pre-existing EXTERNAL git `index.lock` at apply time ⇒ `git-index-locked`
 *    (a separate preflight; some other git process is mid-write, so committing now
 *    would race it or fail halfway). We refuse BEFORE any mutation runs.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CliError, EXIT } from "../errors/envelope.js";
import type { RunContext } from "../handlers.js";
import type { LockScope } from "./manager.js";

/**
 * Resolve the git directory for a working tree at `vaultPath`. Handles both a
 * normal `.git` directory and a `.git` FILE (`gitdir: <path>`, as a linked
 * worktree carries). Falls back to `<vaultPath>/.git` if the marker is unreadable
 * — the preflight then simply checks the conventional location.
 */
function gitDirOf(vaultPath: string): string {
  const dotGit = join(vaultPath, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const marker = readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(marker);
    if (match) {
      const target = match[1]!.trim();
      return isAbsolute(target) ? target : join(vaultPath, target);
    }
  } catch {
    /* fall through to the conventional location */
  }
  return dotGit;
}

/**
 * A pre-existing external git `index.lock` at apply time is a DISTINCT preflight
 * failure (exit 2) — separate from the advisory vault lock. Refuse before any
 * mutation so a concurrent (or crashed) git process is never raced.
 */
export function assertNoExternalGitIndexLock(vaultPath: string): void {
  const indexLock = join(gitDirOf(vaultPath), "index.lock");
  if (existsSync(indexLock)) {
    throw new CliError({
      code: "git-index-locked",
      message: "A git `index.lock` is present in the vault repository.",
      hint: "Another git process is mid-write (or a previous one crashed). Wait for it to finish, or remove `.git/index.lock` if it is stale.",
      exitCode: EXIT.CONFIG,
      retryable: true,
      details: { indexLock },
    });
  }
}

/**
 * Synchronous sleep used by the test-only apply barrier below. Uses `Atomics.wait`
 * so the parked process yields the CPU (it holds the vault lock the whole time).
 */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A DETERMINISTIC apply barrier for the `locks.mutation-order` proofs (rows d2/d3
 * + the apply-boundary index.lock row). Gated ENTIRELY by env vars production
 * never sets (same discipline as the env-gated jobs test handler) — a no-op unless
 * `ATLAS_TEST_MUTATION_GATE_FILE` is present. When armed, it runs at the pre-apply
 * boundary (lock held, grounding done, nothing committed yet):
 *   - touches `ATLAS_TEST_MUTATION_STARTED_FILE` (with this pid) so the test knows
 *     the real invocation is parked HOLDING the vault lock;
 *   - blocks until the gate file appears, so a concurrent real invocation can prove
 *     it loses the lock (exit 2) while this one holds it across commit + refresh.
 * A hard deadline caps the wait so a mis-driven test can never wedge forever.
 */
function maybeApplyBarrier(env: NodeJS.ProcessEnv): void {
  const gate = env.ATLAS_TEST_MUTATION_GATE_FILE;
  if (gate === undefined) return;
  const started = env.ATLAS_TEST_MUTATION_STARTED_FILE;
  if (started !== undefined) writeFileSync(started, String(process.pid), "utf8");
  const deadlineMs = Number(env.ATLAS_TEST_MUTATION_GATE_TIMEOUT_MS ?? "30000");
  const start = Date.now();
  while (!existsSync(gate)) {
    if (Date.now() - start >= deadlineMs) break;
    sleepMs(25);
  }
}

/**
 * Run a vault MUTATION under the advisory vault lock, held across the WHOLE
 * mutation order (grounding → apply → commit → projection+index refresh). A writer
 * that cannot take the lock exits 2 (no queueing) — the `locked:<scope>` error from
 * `withLock` propagates unchanged.
 *
 * `fn` receives a `preApply` callback it MUST thread INTO the underlying
 * capture/synthesis workflow so the workflow invokes it at the TRUE post-grounding
 * boundary — after the pure grounding (capture normalize/scan, synthesis
 * retrieval + model planning) but before the first durable mutation, on every
 * synthesis CAS-rebase retry. That callback re-runs the external-git-`index.lock`
 * preflight, so an `index.lock` an external Git process creates DURING our
 * (possibly long) grounding is still caught before we mutate — a single check at
 * lock entry, or one fired before grounding, would miss it (round-2/round-3
 * finding). We ALSO run the preflight once at lock entry as a cheap early refusal.
 *
 * `scope` defaults to the broadest `vault-maintenance`, so a standalone mutating
 * command is mutually exclusive with EVERY other derived-store writer (the four
 * scopes form one total containment chain — any pair conflicts cross-process).
 */
export async function withVaultMutation<T>(
  ctx: RunContext,
  vaultPath: string,
  fn: (preApply: () => void) => Promise<T> | T,
  scope: LockScope = "vault-maintenance",
): Promise<T> {
  return ctx.withLock(scope, async () => {
    // Cheap early refusal, before any grounding.
    assertNoExternalGitIndexLock(vaultPath);
    const preApply = (): void => {
      // Test-only barrier FIRST (a no-op in production): parking here holds the lock
      // so a concurrent invocation can prove it loses, and lets a test plant an
      // external `index.lock` that the re-check below must then catch.
      maybeApplyBarrier(ctx.env);
      // Re-check at the real pre-apply Git boundary: an external `index.lock` may
      // have appeared while we ground (retrieval/model/normalize), so the single
      // lock-entry check above is not sufficient on its own.
      assertNoExternalGitIndexLock(vaultPath);
    };
    return fn(preApply);
  });
}
