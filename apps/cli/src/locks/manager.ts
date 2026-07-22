/**
 * The lock manager (Task 1.8 / #24).
 *
 * Named, file-backed exclusive locks with a global acquisition order (plan §2.5):
 *
 *     vault-maintenance ⊐ ledger-maintenance ⊐ jobs-runner ⊐ canonical-integration
 *
 * The `⊐` chain defines the ONLY legal nesting order within a single process:
 * broader scopes are acquired before narrower ones, so no two processes can take
 * the same pair in opposite orders — the classic deadlock is structurally
 * impossible. Acquiring out of order is a programmer error (exit 4 internal), not
 * a runtime lock conflict.
 *
 * Each held lock is a file `<scope>.lock` under the lock dir carrying the owner's
 * `{ scope, pid, startedAt }`. A second acquirer of a scope held by a LIVE pid
 * fails with `locked:<scope>` (exit 2) carrying the holder's pid + start time.
 * Stale locks (dead holder pid) are NOT auto-reclaimed on acquire — reclamation
 * is explicit via `doctor --reclaim-locks` (see {@link LockManager.reclaimLocks}),
 * so a crash never silently races two writers.
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "../errors/envelope.js";

/** The four named lock scopes, in global order (broadest → narrowest). */
export const LOCK_SCOPES = [
  "vault-maintenance",
  "ledger-maintenance",
  "jobs-runner",
  "canonical-integration",
] as const;

export type LockScope = (typeof LOCK_SCOPES)[number];

/** Global-order rank: lower = broader = acquired first. */
export function lockRank(scope: LockScope): number {
  return LOCK_SCOPES.indexOf(scope);
}

/**
 * `a` subsumes `b` when `a` is broader-or-equal in the containment chain
 * (`vault-maintenance ⊐ ledger-maintenance ⊐ jobs-runner ⊐ canonical-integration`).
 * A broader scope's exclusion region strictly CONTAINS every narrower one — e.g.
 * `vault-maintenance` subsumes a `canonical-integration` mutation, which is why
 * "no ordinary workflow run may hold a canonical mutation while vault-maintenance
 * runs" (design §process-concurrency).
 */
export function subsumes(a: LockScope, b: LockScope): boolean {
  return lockRank(a) <= lockRank(b);
}

/**
 * The normative cross-process conflict matrix (design §process-concurrency):
 * two DIFFERENT processes cannot simultaneously hold `held` and `wanted` when
 * either subsumes the other. The four exclusive scopes form a single total
 * containment chain, so every ordered pair is comparable and therefore conflicts;
 * a held broader lock excludes every narrower acquisition and vice-versa. (Only
 * the read-only `shared` tier — not a managed lock here — coexists.) Encoded via
 * `subsumes` rather than a hard-coded `true` so the relation stays honest if an
 * incomparable scope is ever added.
 */
export function scopesConflict(held: LockScope, wanted: LockScope): boolean {
  return subsumes(held, wanted) || subsumes(wanted, held);
}

/** The on-disk owner record for a held lock. */
export interface LockOwner {
  scope: LockScope;
  pid: number;
  /** ISO-8601 UTC acquisition time. */
  startedAt: string;
}

/** Options for {@link createLockManager}. All injectable so tests stay deterministic. */
export interface LockManagerOptions {
  /** Directory holding `<scope>.lock` files. Created if absent. */
  dir: string;
  /** This process's pid. Defaults to `process.pid`. */
  pid?: number;
  /** Current time source. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /** Liveness probe for a holder pid. Defaults to a real `process.kill(pid, 0)` check. */
  isAlive?: (pid: number) => boolean;
  /**
   * Max time (ms) to wait for a LIVE holder of the acquire guard before failing
   * fast with `locked:acquire-guard`. Defaults to 5000. Injectable so tests can
   * exercise contention without a multi-second wait.
   */
  guardWaitMs?: number;
}

const LOCK_SUFFIX = ".lock";

/** Real liveness probe: `process.kill(pid, 0)` — ESRCH ⇒ dead, EPERM ⇒ alive-but-foreign. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Synchronous sleep (the guard's acquire path is sync). Uses `Atomics.wait`. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockFile(dir: string, scope: LockScope): string {
  return join(dir, `${scope}${LOCK_SUFFIX}`);
}

function readOwner(file: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockOwner;
  } catch {
    return null;
  }
}

function readGuardPid(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** A locked-scope failure: `locked:<scope>` (exit 2), carrying the live holder's identity. */
function lockedError(owner: LockOwner): CliError {
  return new CliError({
    code: `locked:${owner.scope}`,
    message: `The ${owner.scope} lock is held by another process.`,
    hint: `Wait for the holder to finish, or run \`brain doctor --reclaim-locks\` if its pid is dead.`,
    exitCode: EXIT.CONFIG,
    retryable: true,
    details: { scope: owner.scope, holderPid: owner.pid, startedAt: owner.startedAt },
  });
}

/** The manager API returned by {@link createLockManager}. */
export interface LockManager {
  /**
   * Acquire `scope`, run `fn`, and release the lock (even if `fn` throws).
   * Throws `locked:<scope>` (exit 2) if a live holder owns it, or an internal
   * order violation (exit 4) if `scope` is not strictly narrower than every lock
   * this process already holds.
   */
  withLock<T>(scope: LockScope, fn: () => Promise<T> | T): Promise<T>;
  /** Scopes currently held by THIS manager instance, in acquisition order. */
  heldScopes(): LockScope[];
  /**
   * Remove lock files whose holder pid is dead. Returns the reclaimed scopes.
   * Backs `doctor --reclaim-locks`.
   */
  reclaimLocks(): LockScope[];
  /** Inspect the on-disk owner of `scope`, or null if unlocked. */
  inspect(scope: LockScope): LockOwner | null;
}

/**
 * Build a {@link LockManager} over `dir`. The manager tracks its own held scopes
 * to enforce the global nesting order intra-process.
 */
export function createLockManager(options: LockManagerOptions): LockManager {
  const { dir } = options;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date().toISOString());
  const isAlive = options.isAlive ?? defaultIsAlive;
  const guardWaitMs = options.guardWaitMs ?? 5000;
  const held: LockScope[] = [];

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true });
  }

  const GUARD = ".acquire.guard";

  /**
   * Run `fn` while holding a short-lived exclusive guard file, so the multi-file
   * conflict scan + own-file create in {@link acquire} are ATOMIC against other
   * processes racing to acquire a conflicting scope. The guard is created with
   * `wx` (exclusive) and always removed.
   *
   * Reclamation is SAFETY-critical: a guard owned by a LIVE process is NEVER
   * removed — doing so would let two acquirers run their scan+create concurrently
   * and defeat the atomic cross-scope conflict check. We reclaim ONLY after
   * positively establishing stale ownership (the recorded holder pid is dead,
   * unreadable, or absent). Against a live holder we wait briefly (real sleep, not
   * a busy spin) since a legitimate scan+create is sub-millisecond; if it stays
   * held past a bounded budget the holder is anomalously slow, so we fail fast
   * with a retryable guard-contention error rather than force our way in.
   */
  function withGuard<T>(fn: () => T): T {
    ensureDir();
    const guard = join(dir, GUARD);
    const WAIT_STEP_MS = 2;
    const MAX_WAIT_MS = guardWaitMs;
    let waited = 0;
    for (;;) {
      try {
        writeFileSync(guard, String(pid), { flag: "wx" });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const holderPid = Number(readGuardPid(guard));
        // Reclaim ONLY after positively proving a valid owner PID is dead. An
        // EMPTY/UNREADABLE guard is NEVER reclaimed during acquisition: a live
        // creator may be between the exclusive `wx` create and its PID write (the
        // content is written a beat after the file exists), so an empty guard is
        // "owner not yet published", not "stale". Treating it as stale would let a
        // second acquirer delete a live creator's guard and run its scan+create
        // concurrently — defeating the atomic cross-scope conflict check. So we wait
        // for the owner to either publish its PID (then the live-holder branch takes
        // over) or, if it truly never does, we fail fast on the bounded budget.
        const holderStale = holderPid > 0 && !isAlive(holderPid);
        if (holderStale) {
          // Positively stale (a readable, dead owner PID): safe to reclaim.
          rmSync(guard, { force: true });
          continue;
        }
        // Live holder OR not-yet-published owner: never reclaim. Wait a beat, then
        // retry the exclusive create.
        if (waited >= MAX_WAIT_MS) {
          throw new CliError({
            code: "locked:acquire-guard",
            message: "The lock acquisition guard is held by another live process.",
            hint: "Retry shortly; another `brain` process is mid-acquire.",
            exitCode: EXIT.CONFIG,
            retryable: true,
            details: { holderPid },
          });
        }
        sleepMs(WAIT_STEP_MS);
        waited += WAIT_STEP_MS;
      }
    }
    try {
      return fn();
    } finally {
      rmSync(guard, { force: true });
    }
  }

  function assertOrder(scope: LockScope): void {
    // Global order: `scope` must be strictly narrower than every lock held here.
    for (const h of held) {
      if (lockRank(scope) <= lockRank(h)) {
        throw CliError.internal(
          `lock order violation: cannot acquire \`${scope}\` (rank ${lockRank(scope)}) while holding \`${h}\` (rank ${lockRank(h)}); the global order is ${LOCK_SCOPES.join(" ⊐ ")}`,
        );
      }
    }
  }

  function acquire(scope: LockScope): void {
    assertOrder(scope);
    // The whole check-and-set runs under the acquire guard so the cross-scope
    // conflict scan and the own-file create are atomic against a racing acquirer.
    withGuard(() => {
      // Scan every held lock file for a CONFLICTING scope owned by another live
      // process. The conflict matrix (see `scopesConflict`) — not just an
      // identical scope name — decides: a live `canonical-integration` holder
      // blocks `vault-maintenance`, a live `vault-maintenance` holder blocks
      // `canonical-integration`, etc. Our own held locks (same pid) are the legal
      // broad→narrow nesting and never conflict with ourselves.
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(LOCK_SUFFIX)) continue;
        const heldScope = entry.slice(0, -LOCK_SUFFIX.length) as LockScope;
        if (!LOCK_SCOPES.includes(heldScope)) continue;
        if (!scopesConflict(heldScope, scope)) continue;
        const file = join(dir, entry);
        const owner = readOwner(file);
        if (!owner) {
          // Unreadable/corrupt lock file: treat as a held lock of unknown owner.
          throw new CliError({
            code: `locked:${heldScope}`,
            message: `The ${heldScope} lock file exists but is unreadable.`,
            hint: `Run \`brain doctor --reclaim-locks\` to clear a stale lock.`,
            exitCode: EXIT.CONFIG,
            retryable: true,
            details: { scope: heldScope },
          });
        }
        if (owner.pid === pid) continue; // our own outer lock (legal nesting)
        // A dead holder is NOT auto-reclaimed on acquire — reclamation is explicit
        // via `doctor --reclaim-locks`, so a crash never silently races two
        // writers. The block is unconditional whether the holder is alive or dead.
        throw lockedError(owner);
      }
      const file = lockFile(dir, scope);
      const owner: LockOwner = { scope, pid, startedAt: now() };
      // `wx` = exclusive create; the scan above already rejected a conflicting
      // holder, and the guard serializes us against a concurrent same-scope racer.
      try {
        writeFileSync(file, JSON.stringify(owner), { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          const raced = readOwner(file);
          throw raced ? lockedError(raced) : lockedError(owner);
        }
        throw e;
      }
      held.push(scope);
    });
  }

  function release(scope: LockScope): void {
    const i = held.lastIndexOf(scope);
    if (i >= 0) held.splice(i, 1);
    // Only remove a lock file we own (matching pid), so a reclaimed-then-retaken
    // lock owned by another process is never deleted from under it.
    const file = lockFile(dir, scope);
    const owner = readOwner(file);
    if (owner && owner.pid === pid) rmSync(file, { force: true });
  }

  return {
    async withLock<T>(scope: LockScope, fn: () => Promise<T> | T): Promise<T> {
      acquire(scope);
      try {
        return await fn();
      } finally {
        release(scope);
      }
    },
    heldScopes: () => [...held],
    reclaimLocks(): LockScope[] {
      if (!existsSync(dir)) return [];
      const reclaimed: LockScope[] = [];
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(LOCK_SUFFIX)) continue;
        const scope = entry.slice(0, -LOCK_SUFFIX.length) as LockScope;
        if (!LOCK_SCOPES.includes(scope)) continue;
        const file = join(dir, entry);
        const owner = readOwner(file);
        // Reclaim when the file is unreadable or the holder pid is dead.
        if (!owner || !isAlive(owner.pid)) {
          rmSync(file, { force: true });
          reclaimed.push(scope);
        }
      }
      return reclaimed;
    },
    inspect: (scope: LockScope) => readOwner(lockFile(dir, scope)),
  };
}

// ---------------------------------------------------------------------------
// Default process-wide manager (the produced `withLock` in the plan interface).
// ---------------------------------------------------------------------------

let defaultManager: LockManager | null = null;

/**
 * Configure the process-wide lock manager (called once by `runCli` from config).
 * Idempotent-by-replacement: the last configuration wins.
 */
export function configureLocks(options: LockManagerOptions): LockManager {
  defaultManager = createLockManager(options);
  return defaultManager;
}

/** The active default manager. Throws if `configureLocks` has not been called. */
export function lockManager(): LockManager {
  if (!defaultManager) {
    throw CliError.internal("lock manager used before configureLocks()");
  }
  return defaultManager;
}

/** The plan-interface `withLock<T>(scope, fn)`, bound to the default manager. */
export function withLock<T>(scope: LockScope, fn: () => Promise<T> | T): Promise<T> {
  return lockManager().withLock(scope, fn);
}
