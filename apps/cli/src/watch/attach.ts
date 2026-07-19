/**
 * `watch/attach` — the atomic attach (SP-1 Phase 3 Task 2): open the ledger
 * read-only, probe the daemons + broker OUTSIDE any transaction, then capture one
 * consistent point (snapshot, baselines, identity, `data_version`, and — under
 * `--since-seq` — the IMMUTABLE replay rows) from a single brief read transaction
 * on the connection that becomes the steady-state poller. Consistency between the
 * async broker probe and the synchronous capture rides the SINGLE shared
 * `captureConsistent` protocol (`health/snapshot.ts`).
 *
 * Ledger absence has TWO distinguishable shapes, both → `DetachedLedger`:
 * (i) missing path (the opener's distinguishable ENOENT); (ii) file present but
 * unmigrated (`ledgerSchemaState === "absent"` — the created-but-not-yet-migrated
 * poll race). A schema-absent open never proceeds into snapshot queries (missing
 * tables would become a fatal exit-4); it is classified detached and re-polled.
 * EVERY unsuccessful attach closes any connection it opened — no leaked read
 * handles across the detached re-probe loop.
 */
import {
  openReadonlyLedger,
  ledgerSchemaState,
  captureLedgerIdentity,
  type SqliteDatabase,
} from "@atlas/sqlite-store";
import { listAllJobs } from "@atlas/jobs";
import { resolveAnchorProbe } from "../audit/anchor-check.js";
import { probeDaemon, type DaemonProbe } from "../health/probe.js";
import { deriveSnapshot, captureConsistent, DEFAULT_ATTACH_RETRIES } from "../health/snapshot.js";
import {
  nowIso,
  type AttachContext,
  type AttachedLedger,
  type Attachment,
  type AuditEventRow,
  type DaemonBaseline,
  type DaemonSnapshot,
  type DetachedLedger,
  type EmitLine,
  type ReplayWindow,
  type SourceBaselines,
  type WatchErrorLine,
  type WatchOpts,
} from "./types.js";

/** The high/low seq-space boundary — mirrors `@atlas/sqlite-store` `ledger/intents.ts`. */
export const DB_EVENT_SEQ_BASE = 1_000_000_000_000;

/** `PRAGMA data_version` (bumps on any commit by ANOTHER connection). */
export function readDataVersion(db: SqliteDatabase): number {
  return db.pragma("data_version", { simple: true }) as number;
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** Resolve the bounded attach-consistency retry count (`ATLAS_WATCH_ATTACH_RETRIES`). */
function attachRetries(env: NodeJS.ProcessEnv): number {
  const raw = env.ATLAS_WATCH_ATTACH_RETRIES;
  const n = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ATTACH_RETRIES;
}

/** The outcome of one daemon's initial probe, folded into baseline + snapshot + faults. */
interface ProbedDaemon {
  baseline: DaemonBaseline;
  snapshot: { socketPath: string; reachable: boolean };
  fault?: WatchErrorLine;
}

/**
 * Probe one daemon socket and fold the TYPED outcome: a clean probe stores the
 * `{known:true, reachable}` transition comparand; a `fault` stores `{known:false}`
 * (NOT `reachable:false` — that would fabricate a phantom `false→true` transition
 * on the next success) and queues a non-fatal `watch.error` flushed right after
 * the hello. The snapshot's point-in-time view shows `reachable:false` either way.
 */
async function probeOne(name: "broker" | "egress", socketPath: string): Promise<ProbedDaemon> {
  const p: DaemonProbe = await probeDaemon(socketPath);
  if (p.status === "reachable") return { baseline: { known: true, reachable: true }, snapshot: { socketPath, reachable: true } };
  if (p.status === "unreachable") return { baseline: { known: true, reachable: false }, snapshot: { socketPath, reachable: false } };
  return {
    baseline: { known: false },
    snapshot: { socketPath, reachable: false },
    fault: {
      v: 1,
      event: "watch.error",
      at: nowIso(),
      source: name,
      code: p.code,
      message: `daemon probe fault at ${socketPath}: ${p.message}`,
    },
  };
}

/** Probe both daemons; returns the snapshot object, baselines, and pending faults. */
export async function probeDaemons(ctx: AttachContext): Promise<{
  daemons: DaemonSnapshot;
  daemonState: { broker: DaemonBaseline; egress: DaemonBaseline };
  pendingDaemonFaults: WatchErrorLine[];
}> {
  const [broker, egress] = await Promise.all([
    probeOne("broker", ctx.brokerSocket),
    probeOne("egress", ctx.egressSocket),
  ]);
  const faults: WatchErrorLine[] = [];
  if (broker.fault) faults.push(broker.fault);
  if (egress.fault) faults.push(egress.fault);
  return {
    daemons: { broker: broker.snapshot, egress: egress.snapshot },
    daemonState: { broker: broker.baseline, egress: egress.baseline },
    pendingDaemonFaults: faults,
  };
}

/** Seed the low-space (`run.%`) contiguous prefix + baseline-seen sparse set (§9.1). */
function seedLowSpace(db: SqliteDatabase): { prefix: number; sparse: Set<number> } {
  const rows = db
    .prepare(`SELECT seq FROM audit_events WHERE event_type LIKE 'run.%' AND seq < ? ORDER BY seq ASC`)
    .all(DB_EVENT_SEQ_BASE) as { seq: number }[];
  let prefix = -1;
  const sparse = new Set<number>();
  for (const r of rows) {
    if (r.seq === prefix + 1) prefix = r.seq;
    else sparse.add(r.seq); // above a gap — baseline-seen, not re-emitted; a later gap-fill still emits
  }
  return { prefix, sparse };
}

/** Build the per-incarnation baselines from one consistent read (inside the attach txn). */
function seedBaselines(
  db: SqliteDatabase,
  daemons: { daemonState: SourceBaselines["daemonState"]; pendingDaemonFaults: WatchErrorLine[] },
): SourceBaselines {
  const { prefix, sparse } = seedLowSpace(db);
  const high = db
    .prepare(`SELECT seq FROM audit_events WHERE event_type NOT LIKE 'run.%'`)
    .all() as { seq: number }[];
  const calls = tableExists(db, "model_calls")
    ? (db.prepare(`SELECT call_id FROM model_calls`).all() as { call_id: string }[])
    : [];
  const jobs = tableExists(db, "jobs") ? listAllJobs(db) : [];
  const wm = db
    .prepare(`SELECT seq, healthy, last_backup_at, updated_at FROM backup_watermark WHERE id = 1`)
    .get() as { seq: number; healthy: number; last_backup_at: string | null; updated_at: string } | undefined;
  return {
    auditContiguousPrefix: prefix,
    auditSparseEmitted: sparse,
    highSpaceEmitted: new Set(high.map((r) => r.seq)),
    modelCallEmitted: new Set(calls.map((r) => r.call_id)),
    jobsMap: new Map(jobs.map((j) => [j.jobId, j])),
    backupRow: wm
      ? { watermarkSeq: wm.seq, healthy: wm.healthy === 1, lastBackupAt: wm.last_backup_at, updatedAt: wm.updated_at }
      : null,
    daemonState: daemons.daemonState,
    pendingDaemonFaults: daemons.pendingDaemonFaults,
  };
}

/** Capture the immutable `--since-seq` replay rows INSIDE the attach transaction. */
function captureReplayRows(db: SqliteDatabase, sinceSeq: number): AuditEventRow[] {
  const rows = db
    .prepare(
      `SELECT seq, run_id, event_type, git_head, created_at FROM audit_events
       WHERE event_type LIKE 'run.%' AND seq > ? AND seq < ? ORDER BY seq ASC`,
    )
    .all(sinceSeq, DB_EVENT_SEQ_BASE) as {
    seq: number;
    run_id: string;
    event_type: string;
    git_head: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({ seq: r.seq, runId: r.run_id, eventType: r.event_type, gitHead: r.git_head, createdAt: r.created_at }));
}

/** Build the `DetachedLedger` shape (missing file OR present-but-unmigrated). */
async function detached(path: string, opts: WatchOpts, ctx: AttachContext): Promise<DetachedLedger> {
  const probes = await probeDaemons(ctx);
  return {
    attached: false,
    path,
    config: { pollMs: opts.pollMs, heartbeatSeconds: opts.heartbeatSeconds },
    snapshot: { daemons: probes.daemons },
    daemonState: probes.daemonState,
    pendingDaemonFaults: probes.pendingDaemonFaults,
  };
}

/**
 * The atomic attach. Returns an `AttachedLedger` on success, a `DetachedLedger`
 * when the ledger file is missing or unmigrated. Any other failure closes the
 * opened handle and rethrows (the caller maps it).
 */
export async function attachLedger(path: string, opts: WatchOpts, ctx: AttachContext): Promise<Attachment> {
  let handle;
  try {
    handle = openReadonlyLedger(path);
  } catch (e) {
    // The opener's DISTINGUISHABLE missing-path error (statSync ENOENT) → detached.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return detached(path, opts, ctx);
    throw e;
  }
  try {
    if (ledgerSchemaState(handle.db) === "absent") {
      // Present-but-unmigrated: never run snapshot/baseline queries (missing tables
      // would be a fatal exit-4 fault); classify detached and re-poll.
      handle.close();
      return detached(path, opts, ctx);
    }
    // Both daemon probes resolve BEFORE the transaction, alongside the broker probe.
    const probes = await probeDaemons(ctx);
    // `probeFn` writes the resolved probe into `resolved` (the status.ts pattern) so
    // the SYNCHRONOUS deriveSnapshot inside the same stable transaction reads it.
    let resolved: Awaited<ReturnType<typeof resolveAnchorProbe>> = { kind: "unreachable" };
    const captured = await captureConsistent(
      handle,
      async () => (resolved = await resolveAnchorProbe(ctx.broker, ctx.env)),
      (conn) => {
        // One consistent point — ALL captured inside this single read transaction:
        // identity (fstat on the store-held fd — the exact bytes this connection
        // reads, immune to an atomic path swap), the hello snapshot, the four
        // source baselines, data_version, and the immutable replay rows.
        const identity = captureLedgerIdentity(handle);
        const dataVersion = readDataVersion(conn);
        const baselines = seedBaselines(conn, probes);
        const snap = deriveSnapshot({ conn, anchorPath: ctx.anchorPath, env: ctx.env, probe: resolved });
        const replay: ReplayWindow | undefined =
          opts.sinceSeq !== undefined ? { sinceSeq: opts.sinceSeq, rows: captureReplayRows(conn, opts.sinceSeq) } : undefined;
        return { identity, dataVersion, baselines, snap, replay };
      },
      { retries: attachRetries(ctx.env) },
    );
    const { identity, dataVersion, baselines, snap, replay } = captured.captured;
    const snapshot = { ...snap, daemons: probes.daemons };
    const prefix = baselines.auditContiguousPrefix;
    const resumeCursor = replay ? Math.min(replay.sinceSeq, prefix) : prefix;
    const att: AttachedLedger = {
      attached: true,
      path,
      config: { pollMs: opts.pollMs, heartbeatSeconds: opts.heartbeatSeconds },
      ledger: handle,
      connection: handle.db,
      identity,
      snapshot,
      baselines,
      dataVersion,
      resumeCursor,
      ...(replay !== undefined ? { replay } : {}),
    };
    return att;
  } catch (e) {
    // No leaked read handles across the detached re-probe loop.
    handle.close();
    throw e;
  }
}

/**
 * The sole constructor of a `watch.hello` line — reads ONLY the Attachment (path,
 * config, snapshot, resumeCursor/replay), no global or ambient state (§7.1).
 */
export async function emitHello(att: Attachment, emit: EmitLine): Promise<void> {
  if (att.attached) {
    await emit({
      v: 1,
      event: "watch.hello",
      at: nowIso(),
      pid: process.pid,
      ledger: { attached: true, path: att.path },
      snapshot: att.snapshot,
      resume: { auditHeadSeq: att.resumeCursor },
      ...(att.replay !== undefined ? { replay: { sinceSeq: att.replay.sinceSeq, events: att.replay.rows.length } } : {}),
      config: att.config,
    });
  } else {
    // Detached: daemons-only snapshot; resume/replay ABSENT — no fabricated cursor.
    await emit({
      v: 1,
      event: "watch.hello",
      at: nowIso(),
      pid: process.pid,
      ledger: { attached: false, path: att.path },
      snapshot: { daemons: att.snapshot.daemons },
      config: att.config,
    });
  }
}

/** Flush the initial-attach probe faults as `watch.error` lines, right after the hello (§7.1). */
export async function flushPendingDaemonFaults(att: Attachment, emit: EmitLine): Promise<void> {
  const faults = att.attached ? att.baselines.pendingDaemonFaults : att.pendingDaemonFaults;
  for (const f of faults.splice(0)) await emit(f);
}
