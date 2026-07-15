/**
 * The index **maintenance exclusion lock** (Task 3.2, round-2 findings 2 & 3,
 * round-3 finding 1).
 *
 * Activation and the destructive maintenance operations that reclaim storage
 * (retirement + orphan compaction) MUST NOT interleave. Without exclusion, a
 * classic TOCTOU corrupts the index:
 *   - retirement reads the active generation, another worker activates a NEWER
 *     one, retirement resumes and deletes "every generation except mine" —
 *     including the now-live newer one (finding 2); and
 *   - compaction snapshots the active set, a generation is activated (or an
 *     in-progress generation is written then activated) after the snapshot, and
 *     compaction deletes chunks the live index still points at (finding 3).
 * A simple re-read does not close the window — the state can change again between
 * the re-read and the delete. So the whole *snapshot-then-mutate* critical section
 * (and the write→verify→activate→retire sequence that could add a generation the
 * snapshot must not miss) runs under a single exclusion lock.
 *
 * ## Two dangers, two layers (round-3 finding 1)
 * The race has an **in-process** form (the concurrently-scheduled async workers of
 * one reconcile/repair process cooperatively interleave at `await` points) AND a
 * **cross-process** form (two `atlas` CLI invocations — e.g. a `reconcile` and a
 * `repair`, or two `repair`s — running at once over the same LanceDB table). An
 * in-process async mutex closes only the first; a separate command in another
 * process shares no memory and would interleave activation with another's
 * retirement/compaction and delete the SQLite-active generation. So the
 * table-scoped lock ({@link tableMaintenanceLock}) enforces BOTH:
 *   1. a **process-wide in-process async mutex**, keyed by the canonical table
 *      location, so every caller in one process that does not manually inject a
 *      shared lock STILL serializes (no NOOP default); and
 *   2. an **inter-process advisory lockfile** in the table directory
 *      (`O_CREAT|O_EXCL`, stale-steal on a crashed holder), so a second CLI process
 *      blocks until the first releases.
 * The write path REQUIRES a lock: `indexNote`/`reconcileIndex` take either an
 * injected shared lock or a `lockLocation` from which they derive the table lock —
 * there is no silent single-process-only default.
 */
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Serializes async critical sections. All maintenance over one table shares one. */
export interface IndexMaintenanceLock {
  /**
   * Run `fn` while holding the lock; queued callers wait (FIFO) until it releases.
   * The lock is released even if `fn` throws, so a failed pass never wedges the
   * index. Returns whatever `fn` returns.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Create a fresh in-process async mutex. Acquisition is FIFO: each `runExclusive`
 * chains onto the tail of a promise queue, so a caller cannot barge ahead of one
 * that asked first. Errors propagate to the caller and still release the lock.
 */
export function createIndexMaintenanceLock(): IndexMaintenanceLock {
  // The tail of the queue: resolves when the current holder releases. Starts
  // already-resolved (lock free).
  let tail: Promise<void> = Promise.resolve();
  return {
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      // Reserve our slot: capture the current tail to wait on, and install a new
      // tail that later callers will wait on (resolved by us on release).
      let release!: () => void;
      const ours = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waitFor = tail;
      tail = tail.then(() => ours);
      await waitFor; // block until every earlier holder released
      try {
        return await fn();
      } finally {
        release(); // hand the lock to the next queued caller
      }
    },
  };
}

/** The advisory lockfile name written into a table's LanceDB directory. */
export const INDEX_MAINTENANCE_LOCKFILE = ".atlas-index-maintenance.lock";

/** Inter-process acquire tuning (mirrors the egress budget-store lock discipline). */
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 60_000;
const LOCK_SPIN_MS = 15;

/** The absolute advisory-lockfile path for a table LanceDB directory. */
export function indexMaintenanceLockPath(location: string): string {
  return join(resolve(location), INDEX_MAINTENANCE_LOCKFILE);
}

/**
 * Process-wide registry of in-process mutexes, keyed by the CANONICAL table
 * location, so two `indexNote`/`reconcileIndex` callers in the same process that
 * did NOT manually share a lock instance still serialize through the same mutex
 * (the round-3 "callers that do not manually coordinate a mutex" gap).
 */
const IN_PROCESS_TABLE_LOCKS = new Map<string, IndexMaintenanceLock>();

/**
 * Acquire the inter-process advisory lock via an `O_CREAT|O_EXCL` lockfile,
 * spinning ASYNCHRONOUSLY (never blocking the event loop) until it is free. A
 * lockfile older than {@link STALE_LOCK_MS} is treated as abandoned by a crashed
 * holder and stolen, so a dead process can't deadlock the survivor. Returns the
 * release function. The in-process mutex already serializes same-process callers,
 * so contention here is only against OTHER processes.
 */
async function acquireFileLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        closeSync(fd);
        rmSync(lockPath, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Steal a stale lock left by a crashed holder.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // holder released it between our open and stat — retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(
          `index maintenance lock ${lockPath} could not be acquired within ${LOCK_ACQUIRE_TIMEOUT_MS}ms ` +
            `(another atlas process is holding it)`,
        );
      }
      await sleep(LOCK_SPIN_MS);
    }
  }
}

/** Non-blocking sleep for the async acquire spin. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The table-scoped maintenance lock for a LanceDB table directory — the REQUIRED,
 * shared lock the write path uses when a caller does not inject one (round-3
 * finding 1). Every critical section runs under BOTH the process-wide in-process
 * mutex for `location` AND the inter-process advisory lockfile in that directory,
 * so it serializes concurrent async workers in one process AND concurrent `atlas`
 * commands across processes. All callers over the same directory (in any process)
 * share the same lockfile; all callers in one process share the same mutex.
 */
export function tableMaintenanceLock(location: string): IndexMaintenanceLock {
  const key = resolve(location);
  let inProc = IN_PROCESS_TABLE_LOCKS.get(key);
  if (inProc === undefined) {
    inProc = createIndexMaintenanceLock();
    IN_PROCESS_TABLE_LOCKS.set(key, inProc);
  }
  const mutex = inProc;
  const lockPath = join(key, INDEX_MAINTENANCE_LOCKFILE);
  return {
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      // In-process mutex FIRST (serialize same-process workers), THEN the
      // inter-process lockfile — a fixed order, so nested acquisition can't deadlock
      // (the write path never nests runExclusive).
      return mutex.runExclusive(async () => {
        if (!existsSync(key)) mkdirSync(key, { recursive: true, mode: 0o700 });
        const release = await acquireFileLock(lockPath);
        try {
          return await fn();
        } finally {
          release();
        }
      });
    },
  };
}

/** A lock that never blocks — for a single sequential call with no concurrency
 * (e.g. an internal test). Correct only when nothing else touches the table
 * concurrently; the write path never uses it (it requires a real table/shared lock). */
export const NOOP_INDEX_LOCK: IndexMaintenanceLock = {
  runExclusive: (fn) => fn(),
};
