/**
 * Tier-0 / projection audit wiring (Task 1.9 / #25).
 *
 * `recordReadonlyRun` appends EXACTLY ONE terminal audit-ref event for an executed
 * read-class run — a `run.readonly` for a Tier-0 read (`inspect`/`status`, and
 * later `query`/`index status`) or a `run.projection` for an executed
 * projection-only rebuild (`db rebuild`, and later `index rebuild`). It funnels
 * through `finalizeLedgerWrite` (plan §2.8), so the single cross-store orchestrator
 * still owns seq allocation, the broker append, the ledger commit, and the
 * fail-closed watermark — a read run cannot invent its own out-of-band audit path.
 *
 * ## Why these two kinds (broker acceptance)
 * The broker's signing entry point REFUSES the canonical-installing kinds
 * (`run.integrated` / `run.rolled_back`) because they assert a canonical ref move
 * that only the protected-ref path may observe. `run.readonly` / `run.projection`
 * are NON-installing terminal kinds, so this best-effort append is exactly the
 * sanctioned way for a read/projection run to anchor itself.
 *
 * ## No `agent_runs` row
 * A read/projection run writes ONLY its audit event (the ledger row) — it never
 * inserts an `agent_runs` row, so it neither inflates `status` open-run counts nor
 * trips the `audit-terminal-event-cardinality` invariant (which pairs terminal
 * *workflow* events with terminal `agent_runs` statuses, a class these are not in).
 *
 * ## Read-run backup coalescing (bounds the read-DoS finding)
 * A `run.readonly` writes its ledger row + audit event but does NOT each force a
 * full encrypted backup: the watermark COALESCES (debounced). Only when the
 * uncovered gap crosses {@link READ_COALESCE_THRESHOLD} does a read run take a
 * covering backup, so cheap high-frequency reads cannot amplify into unbounded
 * backup/storage growth. A `run.projection` (a real projection state change) is
 * NEVER coalesced — it takes its mandatory backup like any other write.
 *
 * ## Kind-dependent strictness (round-2 findings F2 + F3)
 * The two kinds have DIFFERENT failure contracts:
 *
 *   - **`run.readonly`** is best-effort so the pure diagnostic stays available.
 *     EVERY availability failure a Tier-0 read must survive degrades to a
 *     non-persisting run rather than failing the command: a blocked watermark
 *     (`backup-unhealthy`), a broker that is unreachable OR that fails an RPC
 *     mid-append (`broker-unreachable`), and an absent/unmigrated ledger or a
 *     SQLite intent/commit failure (`ledger-unavailable`). In each degraded case
 *     the `pending` audit intent that step 1 durably wrote is PRESERVED, so the
 *     next `reconcileInterruptedRuns` converges it — a degraded read is not lost,
 *     it is deferred.
 *   - **`run.projection`** is STRICT and GATED: a projection rebuild is a real
 *     state change, so its audit must NOT silently degrade. It is refused up-front
 *     when the watermark is blocked, requires a reachable broker + resolvable
 *     custody, and propagates any append/backup failure as a command error. This
 *     guarantees a SUCCESSFUL rebuild always produced exactly one `run.projection`
 *     with a covering backup — never an exit-0 with no audit event.
 */
import {
  finalizeLedgerWrite,
  reconcileInterruptedRuns,
  assertBackupHealthy,
  BackupUnhealthyError,
  type AuditBroker,
  type AuditEventDraft,
  type LedgerBackupConfig,
  type LedgerStatement,
  type SqliteDatabase,
  type Store,
} from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";
import { BrokerClient } from "@atlas/broker";
import { newRunId } from "@atlas/contracts";
import type { RunContext } from "../handlers.js";
import { backupConfig } from "../commands/backup-config.js";
import { openMigratedStore } from "../commands/store-open.js";

/** The two read-class terminal audit kinds this module anchors (plan §2.5). */
export type ReadonlyRunKind = "run.readonly" | "run.projection";

/** The all-zero placeholder commit for a read run (no canonical ref move observed). */
const NO_CANONICAL_MOVE = "0".repeat(40);

/** The outcome of a {@link recordReadonlyRun} attempt. */
export interface ReadonlyRunResult {
  /** The run's ULID (allocated even when the append was skipped). */
  readonly runId: string;
  /** `true` iff the terminal audit event was appended this call (cardinality: one). */
  readonly recorded: boolean;
  /** The allocated audit seq when recorded, else `null`. */
  readonly seq: number | null;
  /**
   * When `recorded === false`, why the best-effort append degraded to pure
   * (`backup-unhealthy`, `broker-unreachable`, or `ledger-unavailable`). The
   * command still succeeds — the read summary is not gated on the audit.
   */
  readonly degraded?: "backup-unhealthy" | "broker-unreachable" | "ledger-unavailable";
}

/** Everything {@link recordReadonlyRun} needs beyond the run kind + store + broker. */
export interface RecordReadonlyOptions {
  /** The AEAD ledger-backup config (custody resolved CLI-side by the caller). */
  readonly backup: LedgerBackupConfig;
  /** Override the run ULID (defaults to a fresh `newRunId()`). */
  readonly runId?: string;
  /** Injectable clock (RFC-3339 ms). Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /**
   * A step-3 mutation committed ATOMICALLY with this run's audit event inside the
   * §2.8 transaction (Task 1.9 finding 2). `db rebuild` passes the projection
   * replacement here so projections + `run.projection` land (or roll back)
   * together. Only meaningful for `run.projection` (a state-changing run).
   */
  readonly extraCommit?: (db: SqliteDatabase) => void;
  /**
   * STRICT backup (Task 1.9 finding 2): exhausting the bounded backup retries
   * throws instead of silently blocking. Set for `run.projection` so a rebuild
   * cannot report exit 0 without a covering backup.
   */
  readonly strictBackup?: boolean;
  /**
   * The run's serializable step-3 business ledger rows, threaded to
   * `finalizeLedgerWrite` (Task 3.4). Task 1.9's read runs (`inspect`/`status`)
   * write ONLY their audit event (`[]`, the default). `brain query` (the first
   * Tier-0 read that ALSO records business rows) passes its
   * `retrieval_runs`/`retrieval_results`/`model_calls` INSERTs here so they land
   * ATOMICALLY with the single `run.readonly` event — and, crucially, are persisted
   * in the durable intent (finalize step 1), so a broker/ledger outage does not lose
   * them: the `pending` intent preserves the rows and `reconcileInterruptedRuns`
   * replays the COMPLETE step-3 operation. Statements must be idempotent (each
   * INSERT is `OR IGNORE`/`ON CONFLICT DO NOTHING`).
   */
  readonly ledgerWrite?: readonly LedgerStatement[];
}

/** RFC-3339 UTC millisecond timestamp (matches `@atlas/contracts` `Rfc3339Ms`). */
function rfc3339Ms(): string {
  return new Date().toISOString();
}

/**
 * Append exactly one terminal `run.readonly`/`run.projection` audit event for an
 * executed read/projection run, via `finalizeLedgerWrite` (§2.8). Best-effort:
 * a blocked watermark, an unreachable broker, or an unavailable ledger degrades
 * to a non-persisting pure run rather than failing the command.
 */
export async function recordReadonlyRun(
  kind: ReadonlyRunKind,
  cmd: string,
  store: Store,
  broker: AuditBroker,
  opts: RecordReadonlyOptions,
): Promise<ReadonlyRunResult> {
  const runId = opts.runId ?? newRunId();
  const now = opts.now ?? rfc3339Ms;

  const event: AuditEventDraft = {
    schemaVersion: 1,
    eventId: newRunId(),
    kind,
    occurredAt: now(),
    runId,
    subjects: [],
    canonicalCommit: NO_CANONICAL_MOVE,
    // Allowlisted metadata only (§2.5): the command name, never a payload.
    detail: { command: cmd },
  };

  const finalize = (): Promise<{ seq: number }> =>
    finalizeLedgerWrite(store, broker, {
      runId,
      event,
      // A pure read/projection run writes ONLY its audit event (`[]`, the default).
      // `brain query` (Task 3.4) supplies retrieval_runs/retrieval_results/model_calls
      // INSERTs here so they land atomically with the single `run.readonly` event and
      // are preserved in the durable intent for reconcile on a broker/ledger outage.
      ledgerWrite: opts.ledgerWrite ?? [],
      backup: opts.backup,
      now,
      ...(opts.extraCommit ? { extraCommit: opts.extraCommit } : {}),
      ...(opts.strictBackup ? { strictBackup: opts.strictBackup } : {}),
      // Coalesce ONLY Tier-0 reads; a projection is a real state change and is
      // NEVER coalesced (finalize enforces the kind check + shared policy). The
      // flag is a boolean, not a callback, so a caller cannot coalesce a state
      // change or bypass its mandatory backup.
      coalesceReadonly: kind === "run.readonly",
    });

  // `run.projection` is STRICT: any failure (blocked watermark, broker RPC, or a
  // SQLite intent/commit error) PROPAGATES so a rebuild that mutated projections
  // cannot exit 0 with no covering audit event (round-2 finding F2).
  if (kind === "run.projection") {
    const { seq } = await finalize();
    return { runId, recorded: true, seq };
  }

  // `run.readonly` degrades to a pure (non-persisting) run on EVERY availability
  // failure so the read summary stays available (round-2 finding F3). The
  // `pending` intent step 1 wrote is preserved for `reconcileInterruptedRuns`.
  try {
    const { seq } = await finalize();
    return { runId, recorded: true, seq };
  } catch (e) {
    return { runId, recorded: false, seq: null, degraded: classifyReadonlyDegrade(e) };
  }
}

/**
 * Classify a `run.readonly` finalize failure into a degrade reason (round-2
 * finding F3). A blocked watermark is `backup-unhealthy`; a better-sqlite3 error
 * (its `code` starts `SQLITE_`) means the ledger intent/commit failed
 * (`ledger-unavailable`); anything else is a broker RPC/transport failure
 * (`broker-unreachable`). Every case preserves the pending intent for recovery.
 */
function classifyReadonlyDegrade(e: unknown): NonNullable<ReadonlyRunResult["degraded"]> {
  if (e instanceof BackupUnhealthyError) return "backup-unhealthy";
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("SQLITE_")) return "ledger-unavailable";
  return "broker-unreachable";
}

/**
 * CLI wiring for a read/projection audit run: resolve the backup custody config +
 * connect the broker socket, then append via {@link recordReadonlyRun}. Strictness
 * is kind-dependent (round-2 findings F2 + F3):
 *
 *   - **`run.readonly`** — every failure a Tier-0 read must survive degrades to a
 *     pure (non-persisting) run rather than failing the command: broker socket
 *     unreachable (`broker-unreachable`), ledger DB / custody key unavailable
 *     (`ledger-unavailable`), a broker RPC failure mid-append, or a blocked
 *     watermark (`backup-unhealthy`). The pending intent is preserved for recovery.
 *   - **`run.projection`** — STRICT: a missing custody key, an unreachable broker,
 *     or any append/backup failure THROWS a `CliError`, so a rebuild that mutated
 *     projections cannot report false success without exactly one covering
 *     `run.projection`.
 *
 * Pass an already-open `store` (the `db rebuild` path reuses its rebuild store);
 * the caller owns closing a lent store. Omit it and this opens its own ledger
 * store (WITHOUT migrating — the ledger must already be migrated) and closes it.
 */
/**
 * Pre-flight gate for a STRICT projection-audit run (round-2 finding F2): prove
 * the terminal `run.projection` CAN land BEFORE the projection mutation, so a
 * rebuild never rewrites projections and then discovers it cannot audit them.
 * Throws a mapped `CliError` when custody is missing, the backup watermark is
 * blocked, or the broker is unreachable. Consumed by `db rebuild`.
 */
export async function assertReadAuditReady(ctx: RunContext, store: Store): Promise<void> {
  // Custody: a missing/malformed AEAD key throws a `key-unavailable` CliError.
  backupConfig(ctx);

  // Fail-closed gate: refuse before mutating if a verified backup cannot cover it.
  try {
    assertBackupHealthy(store.db);
  } catch (e) {
    if (e instanceof BackupUnhealthyError) {
      throw new CliError({
        code: e.code,
        message: e.message,
        hint: "Run `db backup` (or `db backup --force-unblock` / `db restore`) to clear the block, then retry.",
        exitCode: EXIT.CONFIG,
        cause: e,
      });
    }
    throw e;
  }

  // Broker reachability: a projection run cannot degrade, so an unreachable broker
  // is a hard error here rather than a mutation with no audit event.
  let probe: BrokerClient;
  try {
    probe = await BrokerClient.connect(ctx.config.config.broker.socket_path);
  } catch (e) {
    throw new CliError({
      code: "broker-unreachable",
      message: `the broker is unreachable at ${ctx.config.config.broker.socket_path}: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Start the broker daemon before `db rebuild` (a projection rebuild must record exactly one run.projection).",
      exitCode: EXIT.INTERNAL,
      cause: e,
    });
  }
  probe.close();
}

/** Extra wiring a `run.projection` / audited-read run threads through {@link runReadAudit}. */
export interface RunReadAuditOptions {
  /** Step-3 mutation committed atomically with the audit event (finding 2). */
  readonly extraCommit?: (db: SqliteDatabase) => void;
  /** Throw (not silently block) if the covering backup exhausts its retries (finding 2). */
  readonly strictBackup?: boolean;
  /**
   * Serializable step-3 business ledger rows persisted atomically with the single
   * terminal audit event (Task 3.4 — `brain query`'s retrieval/model_calls INSERTs).
   * Preserved in the durable intent, so a degraded read defers (never loses) them.
   */
  readonly ledgerWrite?: readonly LedgerStatement[];
  /**
   * Correlate the terminal audit event with a caller-owned run id (Task 3.4). When
   * set, this exact id anchors the `run.readonly` event AND the correlated ledger
   * rows (`agent_runs`/`retrieval_runs`/`model_calls`), so the whole run shares one
   * id — e.g. `query` passes `ctx.runId`, the invocation ULID also bound into every
   * `model_calls` receipt. Omit to mint a fresh id (`inspect`/`status`).
   */
  readonly runId?: string;
}

export async function runReadAudit(
  ctx: RunContext,
  kind: ReadonlyRunKind,
  cmd: string,
  store?: Store,
  opts: RunReadAuditOptions = {},
): Promise<ReadonlyRunResult> {
  const runId = opts.runId ?? newRunId();
  // A read that WRITES business rows (Task 3.4 `brain query`'s `ledgerWrite`) is STRICT,
  // like a projection (round-2 finding F1): its `run.readonly` + correlated rows are
  // load-bearing, so a setup/reconcile/finalize fault FAILS the command rather than
  // degrading to a silent best-effort skip. A PURE diagnostic read (`inspect`/`status`,
  // empty `ledgerWrite`) stays best-effort — its summary is never gated on the audit.
  const strict = kind === "run.projection" || (opts.ledgerWrite?.length ?? 0) > 0;

  const degradeOrThrow = (
    reason: NonNullable<ReadonlyRunResult["degraded"]>,
    err: CliError,
  ): ReadonlyRunResult => {
    if (strict) throw err;
    return { runId, recorded: false, seq: null, degraded: reason };
  };

  // Resolve the AEAD backup custody config.
  let backup: LedgerBackupConfig;
  try {
    backup = backupConfig(ctx);
  } catch (e) {
    return degradeOrThrow(
      "ledger-unavailable",
      e instanceof CliError
        ? e
        : new CliError({ code: "key-unavailable", message: `backup custody unavailable: ${String(e)}`, exitCode: EXIT.CONFIG, cause: e }),
    );
  }

  // Open our own store unless the caller lent one. NEVER create or migrate here:
  // `openMigratedStore` fails fast when the ledger DB is absent or unmigrated and
  // — crucially — never lets better-sqlite3 CREATE an empty database file before
  // degrading (round-2 finding F5 + round-3 finding 6). A read/projection-audit
  // run requires an already-migrated ledger; a diagnostic must not conjure one.
  let ownStore: Store | null = null;
  let activeStore: Store;
  if (store) {
    activeStore = store;
  } else {
    try {
      ownStore = openMigratedStore(ctx);
      activeStore = ownStore;
    } catch (e) {
      return degradeOrThrow(
        "ledger-unavailable",
        e instanceof CliError
          ? e
          : new CliError({ code: "db-unavailable", message: `the ledger store is unavailable: ${e instanceof Error ? e.message : String(e)}`, hint: "Run `brain db migrate` first.", exitCode: EXIT.CONFIG, cause: e }),
      );
    }
  }

  // Connect the broker socket.
  let broker: BrokerClient;
  try {
    broker = await BrokerClient.connect(ctx.config.config.broker.socket_path);
  } catch (e) {
    ownStore?.close();
    return degradeOrThrow(
      "broker-unreachable",
      new CliError({ code: "broker-unreachable", message: `the broker is unreachable at ${ctx.config.config.broker.socket_path}: ${e instanceof Error ? e.message : String(e)}`, hint: "Is the broker daemon running?", exitCode: EXIT.INTERNAL, cause: e }),
    );
  }

  const recordOpts: RecordReadonlyOptions = {
    backup,
    runId,
    ...(opts.extraCommit ? { extraCommit: opts.extraCommit } : {}),
    ...(opts.strictBackup ? { strictBackup: opts.strictBackup } : {}),
    ...(opts.ledgerWrite ? { ledgerWrite: opts.ledgerWrite } : {}),
  };

  try {
    // RECONCILE BEFORE ALLOCATING (round-3 finding 3). A prior broker/ledger outage
    // can leave a `pending` intent at sequence N (durably allocated, never
    // committed). The audit chain is gapless, so a fresh run that allocated N+1
    // would be REFUSED by the broker forever until N converges. Draining any
    // interrupted run here first re-drives N to `done` (idempotent on `(runId, seq)`)
    // so the new event lands on a contiguous chain. For a projection run a reconcile
    // failure is fatal (strict); for a Tier-0 read it degrades (the read summary is
    // never gated on the audit). The backup config is passed so an uncovered `done`
    // cut is re-driven too (coalesced-read gaps are honored, not force-backed-up).
    try {
      await reconcileInterruptedRuns(activeStore, broker, { backup });
    } catch (e) {
      if (strict) {
        if (e instanceof CliError) throw e;
        throw new CliError({
          code: "reconcile-failed",
          message: `could not reconcile interrupted runs before the projection audit: ${e instanceof Error ? e.message : String(e)}`,
          hint: "A projection rebuild must record exactly one run.projection; resolve the ledger/broker fault and retry.",
          exitCode: EXIT.INTERNAL,
          cause: e,
        });
      }
      return { runId, recorded: false, seq: null, degraded: classifyReadonlyDegrade(e) };
    }

    // For a projection run any finalize failure propagates (strict); the CliError
    // maps the SQLite/broker/backup class to the right exit code for the caller.
    if (strict) {
      try {
        return await recordReadonlyRun(kind, cmd, activeStore, broker, recordOpts);
      } catch (e) {
        if (e instanceof CliError) throw e;
        const code = (e as { code?: unknown }).code;
        throw new CliError({
          code: typeof code === "string" ? code : "projection-audit-failed",
          message: `the projection audit event could not be recorded: ${e instanceof Error ? e.message : String(e)}`,
          hint: "A projection rebuild must record exactly one run.projection; resolve the ledger/broker/backup fault and retry.",
          exitCode: EXIT.INTERNAL,
          cause: e,
        });
      }
    }
    return await recordReadonlyRun(kind, cmd, activeStore, broker, recordOpts);
  } finally {
    broker.close();
    ownStore?.close();
  }
}
