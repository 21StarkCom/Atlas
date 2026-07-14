/**
 * Broker-owned PERSISTENT per-run budget state (D19). The per-run cost/byte/token
 * tally is the actual export/spend boundary; if it lived only in daemon memory, a
 * restart (or a launched replacement daemon) would reset every tally and let the
 * same run-bound capability regain its FULL ceilings — a compromised agent could
 * exhaust budget, force/await a restart, and repeat (the finding). This store makes
 * a run's consumed allowance survive restart/replay.
 *
 * It is `atlas-egress`-owned state (the broker holds NO SQLite, D18), so it is a
 * simple file: one JSON object `{ [runId]: {bytes,tokens,costMicros} }`, written
 * atomically (temp-then-rename, `0600`) on every committed mutation and loaded once
 * at construction. Writes are SYNCHRONOUS so a tally is durable before the reserve
 * that committed it returns (the reservation is the pre-flight gate — it must not be
 * possible to dispatch against a tally a crash could roll back).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** The durable per-run tally shape (mirrors the in-memory `RunTally`). */
export interface PersistedTally {
  bytes: number;
  tokens: number;
  costMicros: number;
}

/**
 * The outcome of a transactional read-modify-write: the caller's `result`, plus the
 * tally map to `commit` (durably persist) — or `null` to commit NOTHING (a refusal
 * that must not touch the shared state).
 */
export interface BudgetTransaction<T> {
  readonly result: T;
  readonly commit: Record<string, PersistedTally> | null;
}

/** The persistence seam `RunBudget` writes through (injectable; file-backed default). */
export interface BudgetStore {
  /** Load all persisted run tallies (empty when none / first run). */
  load(): Record<string, PersistedTally>;
  /** Durably persist the FULL tally map (atomic). Called synchronously on each mutation. */
  save(tallies: Record<string, PersistedTally>): void;
  /**
   * Atomic cross-process READ-MODIFY-WRITE under an exclusive interprocess lock
   * (D19, finding #3). `fn` receives the CURRENT on-disk tallies (re-read INSIDE the
   * lock — never a stale in-memory snapshot) and returns the caller's result plus the
   * map to commit (or `null` to commit nothing). Two concurrent daemons sharing this
   * state file therefore serialize their reservations and CANNOT reserve from stale
   * totals or overwrite each other — the combined draw honours a single ceiling.
   */
  transact<T>(fn: (tallies: Record<string, PersistedTally>) => BudgetTransaction<T>): T;
}

/** A file-backed {@link BudgetStore} at `path` (broker-owned, `0600`, atomic writes). */
export class FileBudgetStore implements BudgetStore {
  constructor(private readonly path: string) {}

  load(): Record<string, PersistedTally> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) return {};
      const out: Record<string, PersistedTally> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const t = v as Partial<PersistedTally>;
        if (typeof t?.bytes === "number" && typeof t?.tokens === "number" && typeof t?.costMicros === "number") {
          out[k] = { bytes: t.bytes, tokens: t.tokens, costMicros: t.costMicros };
        }
      }
      return out;
    } catch {
      // A corrupt/partial state file fails CLOSED to "everything consumed is unknown"
      // ONLY at the persistence layer; the safe default is to keep whatever parses.
      // An unreadable file returns {} — but the caller (RunBudget) treats a missing
      // tally as fully-available, so we must not silently zero a real file. Rethrow
      // so an operator sees the corruption rather than a silent budget reset.
      throw new Error(`egress budget state at ${this.path} is unreadable/corrupt — refusing to silently reset run allowances`);
    }
  }

  save(tallies: Record<string, PersistedTally>): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.budget-${randomBytes(8).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify(tallies), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  transact<T>(fn: (tallies: Record<string, PersistedTally>) => BudgetTransaction<T>): T {
    const release = this.acquireLock();
    try {
      const tallies = this.load(); // fresh on-disk read INSIDE the lock (never stale)
      const { result, commit } = fn(tallies);
      if (commit !== null) this.save(commit);
      return result;
    } finally {
      release();
    }
  }

  /**
   * Acquire an exclusive interprocess lock via an `O_CREAT|O_EXCL` lockfile, spinning
   * (with a synchronous `Atomics.wait` sleep) until it is free. A lockfile older than
   * {@link STALE_LOCK_MS} is treated as abandoned (a crashed holder) and stolen, so a
   * dead daemon cannot deadlock the survivor. Returns the release function.
   */
  private acquireLock(): () => void {
    const lockPath = `${this.path}.lock`;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        return () => {
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
        if (Date.now() > deadline) throw new Error(`egress budget lock ${lockPath} could not be acquired within ${LOCK_ACQUIRE_TIMEOUT_MS}ms`);
        sleepSync(LOCK_SPIN_MS);
      }
    }
  }
}

const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 10_000;
const LOCK_SPIN_MS = 5;

/** Synchronous sleep (blocks the current thread) via `Atomics.wait` — no busy-burn. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
