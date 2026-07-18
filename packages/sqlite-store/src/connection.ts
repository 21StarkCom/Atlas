/**
 * `connection` — the `better-sqlite3` handle factory for `@atlas/sqlite-store`.
 *
 * Every connection is opened per the data-dictionary binding conventions
 * (dictionary §0): **WAL** journalling and **`PRAGMA foreign_keys = ON`** so the
 * composite FKs (`MATCH SIMPLE`) and `ON DELETE` retention matrix are enforced.
 * `STRICT` tables need no pragma — it is declared per table in the DDL.
 */
import Database from "better-sqlite3";
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";

/** The `better-sqlite3` database handle type (re-exported for consumers). */
export type SqliteDatabase = Database.Database;

/** Connection configuration consumed by {@link openConnection}. */
export interface SqliteConfig {
  /** Filesystem path to the SQLite database, or `:memory:` for an ephemeral db. */
  readonly path: string;
  /**
   * Open read-only (no migrations/writes). WAL is still requested but a
   * read-only handle cannot change the journal mode of a fresh file.
   */
  readonly readonly?: boolean;
  /** Busy-timeout in ms for lock contention (default 5000). */
  readonly busyTimeoutMs?: number;
}

/**
 * Open a configured `better-sqlite3` connection. Applies the two mandatory
 * pragmas (WAL, FKs on) plus a busy timeout. The caller owns the handle
 * lifecycle (`db.close()`); {@link openStore} wraps this.
 */
export function openConnection(cfg: SqliteConfig): Database.Database {
  const db = new Database(cfg.path, { readonly: cfg.readonly ?? false });
  // WAL: concurrent readers during a writer; the Online-Backup API (Task 1.7)
  // depends on it. An in-memory db reports "memory" — harmless.
  if (!cfg.readonly) db.pragma("journal_mode = WAL");
  // FKs ON for every connection (dictionary §0) — enforced, not advisory.
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${cfg.busyTimeoutMs ?? 5000}`);
  return db;
}

// ---------------------------------------------------------------------------
// Read-only ledger opener (console watch SP-1, Phase 1 Task 4). `apps/cli` must
// NOT depend on better-sqlite3, so the read connection + its identity primitive
// live here and cross the seam as the typed {@link ReadonlyLedger} handle.
// ---------------------------------------------------------------------------

/**
 * The identity of the exact ledger BYTES a {@link ReadonlyLedger} is reading —
 * pinned to a companion OS descriptor, NOT `stat(path)`. `device`/`inode` come
 * from `fstat` on the retained fd, so an atomic `rename`/replace of the path
 * after open cannot redirect the identity (the restore-safety property).
 */
export interface LedgerIdentity {
  /** `st_dev` of the open file. */
  readonly device: number;
  /** `st_ino` of the open file. */
  readonly inode: number;
  /** The latest applied migration id (`db_schema_migrations` head), `""` if none. */
  readonly schemaHead: string;
}

/**
 * A read-only ledger handle: the `better-sqlite3` connection and its captured
 * {@link LedgerIdentity}. A companion Node fd (the restore-safety mechanism) is
 * held PRIVATELY by the store in a module-owned {@link fdRegistry} `WeakMap` — it is
 * deliberately NOT a public field, so a consumer cannot `closeSync` it (which would
 * free the descriptor for reuse and make {@link captureLedgerIdentity} fstat an
 * unrelated file). The descriptor is store-owned: only {@link ReadonlyLedger.close}
 * releases it. Callers store the WHOLE handle (never a bare `db`) and always call
 * `close()` on any unsuccessful attach or re-attach.
 */
export interface ReadonlyLedger {
  /** The read-only connection (a write through it throws `SQLITE_READONLY`). */
  readonly db: SqliteDatabase;
  /** Identity captured at open, from the held (store-private) fd. */
  readonly identity: LedgerIdentity;
  /** Close BOTH the db and the store-private companion fd. Idempotent. */
  close(): void;
}

/**
 * Module-owned custody of each {@link ReadonlyLedger}'s companion fd. Keeping the
 * descriptor OUT of the public interface (store-owned-descriptor contract) means a
 * consumer physically cannot close it; only {@link ReadonlyLedger.close} does. The
 * entry is retained after close but INVALIDATED (`closed = true`), so a post-close
 * {@link captureLedgerIdentity} fails fast on the flag instead of `fstat`ing a raw
 * descriptor number the OS may have recycled onto an unrelated file (fd-reuse).
 */
const fdRegistry = new WeakMap<ReadonlyLedger, FdSlot>();

/**
 * The store-private fd custody entry. `fd` is the live companion descriptor; `closed`
 * is flipped by {@link ReadonlyLedger.close}. Once `closed`, the numeric descriptor
 * MUST NOT be `fstat`ed again — the OS is free to reuse that number for an unrelated
 * newly-opened file, so a post-close {@link captureLedgerIdentity} would otherwise
 * report a stranger's identity instead of failing. The slot is invalidated (not the
 * value merely stale) at close so the discriminant is `closed`, never the raw fd.
 */
interface FdSlot {
  readonly fd: number;
  closed: boolean;
}

/** The latest applied migration id, or `""` when `db_schema_migrations` is empty/absent. */
function schemaHeadOf(db: SqliteDatabase): string {
  try {
    const row = db.prepare(`SELECT id FROM db_schema_migrations ORDER BY id DESC LIMIT 1`).get() as
      | { id: string }
      | undefined;
    return row?.id ?? "";
  } catch {
    // `db_schema_migrations` absent (created-but-unmigrated file) — no head yet.
    return "";
  }
}

/** Whether a table exists in the connection's schema. */
function tableExists(db: SqliteDatabase, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
  );
}

/**
 * `"ready"` iff the ledger has completed migrations — both the runner-owned
 * `db_schema_migrations` (with at least one applied row) AND the `audit_events`
 * table exist. `"absent"` for a created-but-unmigrated file (the poll race
 * `watch`'s attach must treat as detached, never a fatal mid-snapshot
 * missing-table throw).
 */
export function ledgerSchemaState(db: SqliteDatabase): "ready" | "absent" {
  if (!tableExists(db, "db_schema_migrations")) return "absent";
  if (!tableExists(db, "audit_events")) return "absent";
  const row = db.prepare(`SELECT COUNT(*) AS n FROM db_schema_migrations`).get() as { n: number };
  return row.n > 0 ? "ready" : "absent";
}

/** Capacity ceiling for the fd/db stability retry (an atomic replace mid-open). */
const OPEN_STABILITY_ATTEMPTS = 5;

/**
 * TEST-ONLY injection seam (see `test/readonly-open.test.ts`). When set, the hook
 * fires ONCE per open attempt, immediately BEFORE the `better-sqlite3` open (after
 * the fd-table snapshot) — the A→B window: a replacement fired here makes the
 * connection bind to B while the path later carries whatever the test swaps in.
 * Production never sets it. It is the deterministic harness for the inter-open ABA
 * race (there is no other way to inject a replacement between synchronous opens).
 */
let interOpenHook: ((path: string) => void) | null = null;

/** Install/clear the {@link interOpenHook}. Returns the previous hook. TEST-ONLY. */
export function __setReadonlyInterOpenHook(fn: ((path: string) => void) | null): ((path: string) => void) | null {
  const prev = interOpenHook;
  interOpenHook = fn;
  return prev;
}

/**
 * TEST-ONLY injection seam firing ONCE per open attempt in the second gap — BETWEEN
 * the `better-sqlite3` open and the identity verification. It is the window that
 * completes an A→B→A replacement: the db already bound to B, and this fires the
 * swap BACK to A so `stat(path)` and the held fd both identify A again while the
 * connection is still reading B. Production never sets it.
 */
let postDbOpenHook: ((path: string) => void) | null = null;

/** Install/clear the {@link postDbOpenHook}. Returns the previous hook. TEST-ONLY. */
export function __setReadonlyPostDbOpenHook(fn: ((path: string) => void) | null): ((path: string) => void) | null {
  const prev = postDbOpenHook;
  postDbOpenHook = fn;
  return prev;
}

/**
 * TEST-ONLY injection seam firing ONCE per open attempt INSIDE the verify window —
 * BETWEEN the companion-fd open and the identity checks. A replacement fired here
 * leaves the companion fd on the pre-swap file while `stat(path)` sees the post-swap
 * file; the `stat(path) == connection-incarnation` requirement catches it and forces
 * a retry. Production never sets it.
 */
let verifyWindowHook: ((path: string) => void) | null = null;

/** Install/clear the {@link verifyWindowHook}. Returns the previous hook. TEST-ONLY. */
export function __setReadonlyVerifyWindowHook(fn: ((path: string) => void) | null): ((path: string) => void) | null {
  const prev = verifyWindowHook;
  verifyWindowHook = fn;
  return prev;
}

/** Attempts the last {@link openReadonlyLedger} took (1 = stable first try). TEST-ONLY. */
export let __lastOpenAttempts = 0;

/** The 16-byte magic every non-empty SQLite main database file starts with. */
const SQLITE_HEADER_MAGIC = "SQLite format 3\u0000";

/**
 * The identity (`fstat`) of the main-database file a just-opened `better-sqlite3`
 * connection ACTUALLY holds open — SQLite's own descriptor, discovered by diffing
 * the process fd table (`/dev/fd`, present on both darwin and linux) across the
 * connection open. `better-sqlite3` exposes no OS fd, but the descriptors it opened
 * are exactly the ones that appeared during the open call (this module is fully
 * synchronous, so nothing else can interleave an open on this thread). Among the
 * new descriptors, the main db file is the regular file bearing the SQLite header
 * magic (a `-wal`/`-shm`/journal sidecar carries a different magic; a directory fd
 * from `readdirSync` is not a regular file). A created-but-unmigrated EMPTY file has
 * no header yet, so a zero-length regular file is accepted as the fallback candidate
 * when no magic match exists. Returns `null` if no unambiguous candidate is found.
 *
 * "New" is judged against the snapshot by (number, dev, ino) — NOT number alone.
 * Number-only filtering has a reuse hole (wing finding, round 6): close a
 * pre-snapshot fd concurrently, let SQLite's open reuse that number (wrongly
 * filtered as pre-existing), and a foreign same-magic open becomes the SOLE
 * candidate — a false accept. With file-identity pairs, the reused number carries a
 * DIFFERENT inode than the snapshot recorded, so the true connection descriptor
 * still surfaces as new; the foreign fd makes it TWO candidates → ambiguous → null
 * → retry. Fail-closed, never mis-bound.
 *
 * ACCEPTED RESIDUAL (round 7, explicit): a SAME-inode reuse — a pre-snapshot fd
 * already open ON THE REPLACEMENT FILE closing in the open gap, SQLite reusing its
 * exact number for the same inode, plus a concurrent foreign same-magic open —
 * would still filter the true descriptor. Every ingredient requires a colluding
 * thread INSIDE this process (holding descriptors on the attacker's file and
 * closing/opening with syscall-precise timing between two synchronous statements on
 * the main thread). This module runs single-threaded and fully synchronous between
 * snapshot and discovery; nothing in the process opens SQLite-format files from
 * worker threads. An in-process adversary with that capability can corrupt the
 * process state directly and is out of the threat model — the boundary this
 * primitive defends is EXTERNAL path replacement (restore/rename races), which no
 * swap sequence defeats. Each retry takes a FRESH snapshot, so no stale entry
 * survives an attempt. The poll loop additionally re-reads identity every tick and
 * treats divergence as re-attach.
 *
 * This is the identity primitive tied to SQLite's actual opened incarnation: unlike
 * any `stat(path)`/probe-connection scheme, no sequence of atomic path replacements
 * (A→B→A, however many swaps, whenever they land) can make it describe a file other
 * than the one the connection reads. Reads use positioned `readSync` (pread), which
 * does not move SQLite's file offset.
 */
function connectionDbFileStat(fdsBefore: ReadonlyMap<number, FdFileId>): ReturnType<typeof fstatSync> | null {
  let magicMatch: ReturnType<typeof fstatSync> | null = null;
  let emptyMatch: ReturnType<typeof fstatSync> | null = null;
  let magicCount = 0;
  let emptyCount = 0;
  for (const name of readdirSync("/dev/fd")) {
    const n = Number(name);
    if (!Number.isInteger(n)) continue;
    let st: ReturnType<typeof fstatSync>;
    try {
      st = fstatSync(n);
    } catch {
      continue; // raced closed (e.g. the enumerating dir fd) — not a candidate
    }
    const prior = fdsBefore.get(n);
    if (prior !== undefined && prior.dev === st.dev && prior.ino === st.ino) {
      continue; // genuinely pre-existing: same number AND same file identity
    }
    if (!st.isFile()) continue;
    if (st.size === 0) {
      emptyMatch = st;
      emptyCount++;
      continue;
    }
    const header = Buffer.alloc(SQLITE_HEADER_MAGIC.length);
    try {
      if (readSync(n, header, 0, header.length, 0) < header.length) continue;
    } catch {
      continue;
    }
    if (header.toString("latin1") === SQLITE_HEADER_MAGIC) {
      magicMatch = st;
      magicCount++;
    }
  }
  if (magicCount === 1) return magicMatch;
  if (magicCount === 0 && emptyCount === 1) return emptyMatch;
  return null; // none, or ambiguous — caller retries / fails closed
}

/** The file identity a snapshot records per descriptor number. */
interface FdFileId {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Snapshot the process's currently-open descriptors as (number → dev+ino). The
 * enumeration itself opens a transient directory fd which is closed before this
 * returns — left in the map, its (now free) number would be reused by the very open
 * we are trying to observe and wrongly filtered as "pre-existing". So each entry is
 * validated with `fstat` (numbers already closed by snapshot end are dropped) AND
 * carries the file identity, so a later reuse of a snapshot number by a DIFFERENT
 * file is still recognized as new (see {@link connectionDbFileStat}).
 */
function fdTableSnapshot(): Map<number, FdFileId> {
  const out = new Map<number, FdFileId>();
  for (const name of readdirSync("/dev/fd")) {
    const n = Number(name);
    if (!Number.isInteger(n)) continue;
    try {
      const st = fstatSync(n);
      out.set(n, { dev: st.dev, ino: st.ino });
    } catch {
      continue; // transient (e.g. the enumerating dir fd) — closed already
    }
  }
  return out;
}

/**
 * Open the ledger READ-ONLY (no migrate/checkpoint/write) and pin its identity to a
 * store-private companion fd. Race-safe against an atomic replace anywhere in the
 * open window — INCLUDING any A→B→A replacement sequence — because identity is not
 * inferred from `stat(path)` or a probe connection's content at all:
 *
 *  1. snapshot the process fd table, then open the `better-sqlite3` connection
 *     `readonly: true` (a missing path throws SQLITE_CANTOPEN here);
 *  2. diff the fd table to find the main-db descriptor SQLite itself holds
 *     ({@link connectionDbFileStat}) — the connection's REAL opened incarnation,
 *     immune to any path swap by construction;
 *  3. open the companion fd (`fs.openSync(path, "r")`) and require BOTH the
 *     companion fd's `fstat` AND the current `stat(path)` to match the connection's
 *     incarnation (dev+ino). A swap between the db open and the companion open makes
 *     the companion diverge from the connection (retry); a swap after the companion
 *     open makes `stat(path)` diverge (retry). A hybrid handle — connection on B,
 *     identity naming A — is structurally impossible: the identity anchor (companion
 *     fd) is only accepted when it fstat-equals SQLite's own descriptor.
 *
 * There is deliberately NO content hashing: the previous design serialized the whole
 * database per open (O(database size), and racy against concurrent commits between
 * the two serializations); dev+ino equality against SQLite's own descriptor is exact
 * and O(1). Residual: after a successful open, the path may be re-pointed at another
 * file — by design; identity stays pinned to the opened incarnation via the held fd,
 * and the poll loop detects the divergence by re-reading identity.
 *
 * The verified companion fd is retained (store-private in {@link fdRegistry}) for
 * the connection lifetime; `close()` releases both. A write through the returned
 * connection throws `SQLITE_READONLY`.
 */
export function openReadonlyLedger(path: string): ReadonlyLedger {
  // A missing path fails HERE with a distinguishable ENOENT (not SQLITE_CANTOPEN).
  statSync(path);
  for (let attempt = 0; attempt < OPEN_STABILITY_ATTEMPTS; attempt++) {
    __lastOpenAttempts = attempt + 1;
    // (1) fd-table snapshot, then the read-only connection — no WAL switch, no write.
    const fdsBefore = fdTableSnapshot();
    // TEST-ONLY: fire the pre-db-open race hook (the A→B window: db binds to B next).
    interOpenHook?.(path);
    const db = openConnection({ path, readonly: true });
    // TEST-ONLY: fire the swap-back hook (completes A→B→A while db still reads B).
    postDbOpenHook?.(path);
    // (2) The connection's ACTUAL opened file, from SQLite's own descriptor.
    const conn = connectionDbFileStat(fdsBefore);
    let fd = -1;
    let stable = false;
    try {
      if (conn !== null) {
        // (3) Companion fd + current path must BOTH name the connection's incarnation.
        fd = openSync(path, "r");
        // TEST-ONLY: fire a mid-verify swap; the stat(path) check below must catch it.
        verifyWindowHook?.(path);
        const heldStat = fstatSync(fd);
        const pathStat = statSync(path);
        stable =
          heldStat.dev === conn.dev &&
          heldStat.ino === conn.ino && // companion fd == the connection's opened file
          pathStat.dev === conn.dev &&
          pathStat.ino === conn.ino; // path (right now) == that same incarnation
      }
    } catch {
      stable = false;
    }
    if (stable) {
      return makeReadonlyLedger(db, fd);
    }
    // Mismatch/replace mid-open — discard this attempt (close BOTH, no leak) and retry.
    db.close();
    if (fd !== -1) closeSync(fd);
  }
  throw new Error(
    `openReadonlyLedger: could not bind a stable fd/connection identity for ${path} after ${OPEN_STABILITY_ATTEMPTS} attempts (atomic replace churn)`,
  );
}

/** Wrap a verified (db, fd) pair into a {@link ReadonlyLedger} with captured identity. */
function makeReadonlyLedger(db: SqliteDatabase, fd: number): ReadonlyLedger {
  const heldStat = fstatSync(fd);
  const identity: LedgerIdentity = {
    device: heldStat.dev,
    inode: heldStat.ino,
    schemaHead: schemaHeadOf(db),
  };
  const slot: FdSlot = { fd, closed: false };
  const ledger: ReadonlyLedger = {
    db,
    identity,
    close(): void {
      if (slot.closed) return;
      // Invalidate the custody slot BEFORE releasing the descriptor so a concurrent
      // (or subsequent) captureLedgerIdentity sees `closed`, never a number the OS
      // may have already recycled onto an unrelated file.
      slot.closed = true;
      try {
        db.close();
      } finally {
        closeSync(fd);
      }
    },
  };
  // Store-private custody of the fd — never exposed on the handle.
  fdRegistry.set(ledger, slot);
  return ledger;
}

/**
 * Re-capture the ledger identity from the handle's RETAINED (store-private)
 * companion fd (never a fresh `stat(path)`). After an atomic replace of the path,
 * the still-open fd refers to the original inode, so the returned identity stays
 * pinned to the bytes the connection is actually reading — the restore-safety
 * property `watch`'s poll loop depends on. `schemaHead` is re-read from the live
 * connection. A `close()`d handle's fd is gone, so this fails `EBADF`.
 */
export function captureLedgerIdentity(ledger: ReadonlyLedger): LedgerIdentity {
  const slot = fdRegistry.get(ledger);
  if (slot === undefined) throw new Error("captureLedgerIdentity: not a store-owned ReadonlyLedger");
  // Fail-closed on a closed handle — NEVER fstat the raw number, which the OS may
  // have recycled onto an unrelated file (fd-reuse), yielding a stranger's identity.
  if (slot.closed) throw new Error("captureLedgerIdentity: ledger is closed");
  const heldStat = fstatSync(slot.fd);
  return { device: heldStat.dev, inode: heldStat.ino, schemaHead: schemaHeadOf(ledger.db) };
}
