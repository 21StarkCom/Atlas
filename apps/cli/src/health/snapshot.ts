/**
 * `health/snapshot` — the SYNCHRONOUS live-state derivation shared by `status`
 * and (Phase 3) `watch` (console watch SP-1, Phase 1 Task 1b). Extracted verbatim
 * from `commands/status.ts` so both surfaces compute the same shape from one
 * place. It is fed a PRE-RESOLVED {@link AnchorProbe} (the async broker RPC is
 * resolved by the caller BEFORE any transaction) so the whole derivation runs
 * inside a `better-sqlite3` read transaction with no `await`.
 *
 * The audited-read `run.readonly` append stays in `status.ts` — `watch` must NOT
 * inherit it (§5.1).
 */
import { watermarkHealth, type SqliteDatabase, type ReadonlyLedger } from "@atlas/sqlite-store";
import { deriveAnchorVerdict, type AnchorProbe } from "../audit/anchor-check.js";

/** The terminal workflow states (§2.5) — every OTHER state counts as an open run. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "finalized",
  "rejected",
  "rolled-back",
  "failed",
  "cancelled",
]);

/** The synchronous live-state shape (`status --json`'s summary, minus `command`). */
export interface SnapshotShape {
  openRuns: Record<string, number>;
  jobs: { queued: number; failed: number };
  quarantineCount: number;
  backup: { watermarkSeq: number; coveredSeq: number; healthy: boolean };
  audit: { headSeq: number; head: string; anchorOk: boolean; anchorSource: "git" | "sqlite-only" };
}

/** Everything {@link deriveSnapshot} needs — the probe is resolved BEFORE the transaction. */
export interface SnapshotContext {
  /** The read connection (opened read-only for `watch`; the migrated store's db for `status`). */
  conn: SqliteDatabase;
  anchorPath: string;
  env: NodeJS.ProcessEnv;
  /** The broker chain-status probe, already resolved by the caller (never re-run here). */
  probe: AnchorProbe;
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/**
 * The count of quarantined notes. Guarded by `tableExists` so a pre-migration DB
 * (no `notes` table yet) reports 0 instead of throwing.
 */
function quarantineCount(db: SqliteDatabase): number {
  if (!tableExists(db, "notes")) return 0;
  const r = db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE quarantined = 1`).get() as { n: number };
  return r.n;
}

/** Non-terminal `agent_runs` grouped by state; `{}` when there are none. */
function openRuns(db: SqliteDatabase): Record<string, number> {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM agent_runs GROUP BY status`).all() as {
    status: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!TERMINAL_STATES.has(r.status)) out[r.status] = r.n;
  }
  return out;
}

/** Queued/failed jobs — 0/0 until the `0002_jobs` migration lands. */
function jobCounts(db: SqliteDatabase): { queued: number; failed: number } {
  if (!tableExists(db, "jobs")) return { queued: 0, failed: 0 };
  const q = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ('pending','ready','running')`).get() as {
    n: number;
  };
  const f = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'failed'`).get() as { n: number };
  return { queued: q.n, failed: f.n };
}

/**
 * Derive the full live-state snapshot SYNCHRONOUSLY (no `await`). Safe to call
 * inside a read transaction. The audit verdict uses the already-resolved probe via
 * the synchronous {@link deriveAnchorVerdict}.
 */
export function deriveSnapshot(ctx: SnapshotContext): SnapshotShape {
  const { conn, anchorPath, env, probe } = ctx;
  const wm = watermarkHealth(conn);
  const anchor = deriveAnchorVerdict(conn, anchorPath, env, probe);
  return {
    openRuns: openRuns(conn),
    jobs: jobCounts(conn),
    quarantineCount: quarantineCount(conn),
    backup: {
      // The subsystem uses −1 as the "nothing covered" sentinel; the committed
      // schema requires seq/coveredSeq ≥ 0, so clamp for the summary surface.
      watermarkSeq: Math.max(0, wm.seq),
      coveredSeq: Math.max(0, wm.coveredSeq),
      healthy: wm.healthy,
    },
    audit: {
      headSeq: anchor.headSeq,
      head: anchor.head,
      anchorOk: anchor.ok,
      anchorSource: anchor.source,
    },
  };
}

/** Default bound on the attach consistency retry (`ATLAS_WATCH_ATTACH_RETRIES`). */
export const DEFAULT_ATTACH_RETRIES = 3;

/** Read `PRAGMA data_version` (bumps on any commit by ANOTHER connection). */
function dataVersion(db: SqliteDatabase): number {
  return db.pragma("data_version", { simple: true }) as number;
}

/**
 * The SINGLE implementation of the probe-vs-capture consistency protocol (console
 * watch SP-1, Phase 1 Task 1 / Phase 3 Task 2). The broker probe is an async RPC
 * while the SQLite capture is synchronous, so the two observations can straddle a
 * commit and emit a false skew. This coordinates them:
 *
 *  1. read `data_version`;
 *  2. resolve the probe via `probeFn` (async, outside any transaction);
 *  3. in ONE synchronous read transaction, re-read `data_version` FIRST — if it
 *     moved, abort and retry; otherwise run the `capture` callback on the stable
 *     read.
 *
 * Retries on change up to `opts.retries` attempts (default {@link
 * DEFAULT_ATTACH_RETRIES}); exhaustion throws a bounded-retry error. On a stable
 * read it collapses to exactly the resolve-then-capture one-liner, so `status`'s
 * golden output is unchanged.
 *
 * The `ledger` parameter is the EXACT shared {@link ReadonlyLedger} contract — the
 * SAME handle type `status` (via {@link openReadonlyLedger}) and `watch`'s attach
 * both pass. This is the SINGLE implementation of the consistency protocol; neither
 * surface re-implements it, and neither passes an ad-hoc `{db}` wrapper.
 */
export async function captureConsistent<T>(
  ledger: ReadonlyLedger,
  probeFn: () => Promise<AnchorProbe>,
  capture: (conn: SqliteDatabase) => T,
  opts: { retries?: number } = {},
): Promise<{ probe: AnchorProbe; captured: T }> {
  const attempts = Math.max(1, opts.retries ?? DEFAULT_ATTACH_RETRIES);
  const db = ledger.db;
  for (let i = 0; i < attempts; i++) {
    const before = dataVersion(db);
    const probe = await probeFn();
    const captured = db.transaction((): { value: T } | null => {
      if (dataVersion(db) !== before) return null; // ledger moved under the probe — retry
      return { value: capture(db) };
    })();
    if (captured !== null) return { probe, captured: captured.value };
  }
  throw new Error(
    `captureConsistent: ledger data_version kept changing across ${attempts} attempt(s) (bounded-retry-exhausted)`,
  );
}
