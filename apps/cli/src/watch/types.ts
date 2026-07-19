/**
 * `watch/types` — the shared type surface of the `brain watch` engine (SP-1
 * Phase 3). Pure declarations: the parsed flag set, the per-incarnation dedup
 * baselines, the two attachment states, and the event-line shapes the emitters
 * build. Everything here mirrors the plan's Phase 3 Task 2 interfaces verbatim;
 * `watch.schema.json` is the wire contract these lines must validate against.
 */
import type { SqliteDatabase, LedgerIdentity, ReadonlyLedger } from "@atlas/sqlite-store";
import type { JobListRow } from "@atlas/jobs";
import type { AuditChainProbe } from "../audit/anchor-check.js";
import type { SnapshotShape } from "../health/snapshot.js";

/** The validated `watch` flag set (`parseWatchFlags`). */
export interface WatchOpts {
  /** Present iff `--since-seq` (≥ −1); mutually exclusive with `once`. */
  sinceSeq?: number;
  once: boolean;
  pollMs: number;
  heartbeatSeconds: number;
}

/** One `audit_events` row as the stream reads it (`payload_hash` never selected). */
export interface AuditEventRow {
  seq: number;
  runId: string;
  eventType: string;
  gitHead: string | null;
  createdAt: string;
}

/**
 * The `--since-seq` replay window — an IMMUTABLE snapshot of rows captured inside
 * the attach transaction, never a `(sinceSeq, upperSeq)` bound re-queried later.
 * A row committing into range after the txn closes is delivered by the live diff.
 */
export interface ReplayWindow {
  sinceSeq: number;
  rows: AuditEventRow[];
}

/** A `watch.error` line (§7.1). */
export interface WatchErrorLine {
  v: 1;
  event: "watch.error";
  at: string;
  source: "ledger" | "broker" | "egress" | "internal";
  code: string;
  message: string;
}

/** Any single NDJSON event line of the stream (validated by `watch.schema.json`). */
export type WatchEvent = Record<string, unknown>;

/**
 * A daemon baseline retains the probe OUTCOME, not a lossy boolean: a fault is
 * "unknown", not "unreachable", so a fault→success sequence does not fabricate a
 * `reachable:false→true` transition (it emitted its `watch.error` instead).
 */
export type DaemonBaseline =
  | { known: true; reachable: boolean }
  | { known: false };

/** The §7.2 `daemons` snapshot object (point-in-time hello view). */
export interface DaemonSnapshot {
  broker: { socketPath: string; reachable: boolean };
  egress: { socketPath: string; reachable: boolean };
}

/** hello snapshot = the `status` shape + daemon probes (§7.2). */
export type WatchSnapshot = SnapshotShape & { daemons: DaemonSnapshot };

/** The exact public config payload the `watch.hello` `config` field serializes (§7.1). */
export interface WatchConfigView {
  pollMs: number;
  heartbeatSeconds: number;
}

/**
 * The per-incarnation dedup state — reset and re-seeded on every (re-)attach,
 * NEVER carried across (a restore rewind can legitimately re-issue seqs; a stale
 * set would suppress the new rows forever).
 */
export interface SourceBaselines {
  /** Low-space (`run.%`) contiguous committed prefix, −1 if none. */
  auditContiguousPrefix: number;
  /** Low-space seqs already emitted (or baseline-seen) above the prefix. */
  auditSparseEmitted: Set<number>;
  /** Non-`run.%` (db.* + evidence.retry_enqueued) seen seqs, incarnation-scoped. */
  highSpaceEmitted: Set<number>;
  /** Seen `call_id`s, incarnation-scoped. */
  modelCallEmitted: Set<string>;
  /**
   * The FULL projected row per jobId — diff on the whole projection, not a
   * subset: a change confined to workflow/maxAttempts/lastError still triggers
   * a `job` event; tracking a subset would silently drop it.
   */
  jobsMap: Map<string, JobListRow>;
  backupRow: { watermarkSeq: number; healthy: boolean; lastBackupAt: string | null; updatedAt: string } | null;
  /** Full initial probe outcome per daemon — the first transition's comparand. */
  daemonState: { broker: DaemonBaseline; egress: DaemonBaseline };
  /** Initial-attach `fault` outcomes, emitted as watch.error right AFTER hello. */
  pendingDaemonFaults: WatchErrorLine[];
}

/** An attached ledger — the poller's whole world for one incarnation. */
export interface AttachedLedger {
  attached: true;
  /** The ledger path echoed in hello `ledger.path` — held here, not global state. */
  path: string;
  /** The hello `config` payload — captured at attach. */
  config: WatchConfigView;
  /** The store handle (connection + store-held identity fd). */
  ledger: ReadonlyLedger;
  /** The read-only poller connection (=== `ledger.db`; kept for call-site clarity). */
  connection: SqliteDatabase;
  identity: LedgerIdentity;
  snapshot: WatchSnapshot;
  baselines: SourceBaselines;
  /** `PRAGMA data_version` observed inside the attach transaction. */
  dataVersion: number;
  /** Present iff `--since-seq`; immutable captured rows. */
  replay?: ReplayWindow;
  /** hello `auditHeadSeq`: `min(sinceSeq, prefix)` during replay, else the prefix; −1 if none. */
  resumeCursor: number;
}

/** The ledger-absent (or present-but-unmigrated) state — no connection, no cursor. */
export interface DetachedLedger {
  attached: false;
  /** Echoed in the detached hello `ledger.path`. */
  path: string;
  /** Detached hello still carries config. */
  config: WatchConfigView;
  /** Detached hello carries daemons only (§7.2). */
  snapshot: { daemons: DaemonSnapshot };
  /** Last-known probe outcome — the detached loop's transition comparand. */
  daemonState: { broker: DaemonBaseline; egress: DaemonBaseline };
  /** Initial detached-probe faults, flushed after the detached hello. */
  pendingDaemonFaults: WatchErrorLine[];
}

export type Attachment = AttachedLedger | DetachedLedger;

/** Everything `attachLedger` needs beyond the path + opts. */
export interface AttachContext {
  anchorPath: string;
  env: NodeJS.ProcessEnv;
  broker: AuditChainProbe | null;
  brokerSocket: string;
  egressSocket: string;
}

/** The awaitable line emitter (Phase 3: `emitJson`; Phase 4 swaps in the blocking writer). */
export type EmitLine = (line: unknown) => Promise<void>;

/** RFC-3339 ms UTC — the `at` emission clock every event line carries. */
export function nowIso(): string {
  return new Date().toISOString();
}
