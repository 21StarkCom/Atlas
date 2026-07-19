/**
 * `retention/handlers` — the EXECUTE side of retention registration (Task 4.10, R1-F13).
 *
 * `retention/jobs.ts` ENQUEUES one job per `retention-matrix.md` class; this module is
 * the workflow→executor half the production registry (`commands/job-handlers.ts`) folds
 * into `buildJobHandlers`. One handler per retention class, each enforcing exactly the
 * matrix row it owns:
 *
 *  | workflow                       | matrix row | what it reclaims                               |
 *  |--------------------------------|-----------:|------------------------------------------------|
 *  | `retention:lancedb-compaction` |         27 | obsolete LanceDB generations (hard delete)     |
 *  | `retention:log-rotation`       |         26 | rotated/aged JSONL logs (hard delete)          |
 *  | `retention:backup-prune`       |         18 | ledger backups beyond keep-N (keep latest)     |
 *  | `retention:quarantine-expiry`  |         31 | TTL-elapsed / over-keep quarantine items       |
 *
 * Three invariants every handler here upholds — the runner contract (`@atlas/jobs`
 * `runner.ts`) + the registry's completeness/laziness gate depend on them:
 *
 *  1. **Lazy dependency resolution.** {@link buildRetentionHandlers} only CLOSES over
 *     `deps`; it dereferences nothing at build time. The registry-completeness gate
 *     builds this map with a stub `deps` and never executes a handler, so touching
 *     `deps.ctx`/`deps.store` outside the closure would crash the gate.
 *  2. **Payload validation is a PERMANENT failure.** Each workflow's payload
 *     (`retention/jobs.ts` builds `{ period }`, plus `{ keep }` for backup-prune) is
 *     `unknown`; a malformed payload throws a `{ kind: "validation" }` error, which the
 *     runner classifies PERMANENT — a bad enqueue fails once, never burning the whole
 *     attempt budget with backoff.
 *  3. **Filesystem/LanceDB-only ⇒ no SQLite `commit` closure.** Every retention class
 *     is filesystem or LanceDB state; none mutates a ledger business table. So handlers
 *     return `{}` (content-addressed arm) and never a `commit` closure — which would
 *     also require a non-empty `sideEffectId` (returning `commit` without one is itself
 *     a permanent failure). SQLite is only ever READ (the LanceDB active-generation
 *     fence), never written from here.
 *
 * Cooperative cancel: the long-running LanceDB pass observes `signal.aborted` at its
 * checkpoints and throws an `AbortError` (runner → `cancelled`), mirroring the idiom in
 * `commands/jobs-test-handler.ts`.
 */
import { z } from "zod";
import type { JobHandler } from "@atlas/jobs";
import type { JobHandlerDeps } from "../commands/job-handlers.js";
import type { RetentionWorkflow } from "./jobs.js";

/** Every retention payload carries the registration `period` (idempotency-key token). */
const BasePayload = z.object({ period: z.string().min(1) });

/** backup-prune additionally carries the keep-N bound (matrix row 18; ≥ 1). */
const BackupPrunePayload = BasePayload.extend({ keep: z.number().int().positive() });

/**
 * Throw a PERMANENT (`validation`) failure for a malformed payload. The runner's
 * `classifyError` maps `kind: "validation"` to a permanent classification, so a bad
 * enqueue fails on the first attempt instead of retrying with backoff to exhaustion.
 */
function invalidPayload(workflow: string, err: z.ZodError): never {
  throw { kind: "validation", message: `${workflow}: invalid payload — ${err.issues.map((i) => i.message).join("; ")}` };
}

/** Throw the cooperative-cancel error the runner reconciles to `cancelled`. */
function throwIfAborted(signal: AbortSignal, where: string): void {
  if (signal.aborted) throw { name: "AbortError", message: `retention cancelled: ${where}` };
}

/**
 * `retention:lancedb-compaction` (matrix row 27) — hard-delete every LanceDB chunk
 * whose generation is not the SQLite-authoritative active set, reclaiming the storage
 * of superseded generations + chunks of removed notes. Retrieval already fenced these
 * out via each note's `active_generation_id`, so this only reclaims space.
 *
 * Runs the snapshot-then-delete under the TABLE-SCOPED exclusive maintenance lock
 * (`tableMaintenanceLock`), the same lock `reconcileIndex` threads, so compaction can
 * never race an activation in this or another process and delete a live generation.
 * When no index is configured/present, it is a clean no-op. LanceDB-only ⇒ returns
 * `{}` (SQLite is read as the fence, never written).
 */
async function runLancedbCompaction(deps: JobHandlerDeps, payload: unknown, signal: AbortSignal): Promise<Record<string, never>> {
  const parsed = BasePayload.safeParse(payload);
  if (!parsed.success) invalidPayload("retention:lancedb-compaction", parsed.error);
  throwIfAborted(signal, "before lancedb compaction");

  // Lazy imports keep `buildRetentionHandlers` free of build-time work (and let a
  // deploy without a LanceDB install still register the handler).
  const lancedb = await import("@lancedb/lancedb");
  const { compactOrphans, openSearchTable, tableMaintenanceLock, SEARCH_CHUNK_TABLE } = await import("@atlas/lancedb-index");
  const { resolvePath } = await import("../commands/backup-config.js");

  const { ctx, store } = deps;
  const cfg = ctx.config.config.indexing;
  const dir = resolvePath(ctx, ctx.config.config.lancedb.dir);

  // Absent dir/table ⇒ nothing configured to compact (the read-only `not-configured`
  // posture the index-ops status path uses).
  let table;
  try {
    const conn = await lancedb.connect(dir);
    if (!(await conn.tableNames()).includes(SEARCH_CHUNK_TABLE)) return {};
    table = await openSearchTable(conn, { chunker_version: cfg.chunker_version, embedding_model: cfg.embedding_model, dimensions: cfg.dimensions });
  } catch {
    return {}; // dir absent/unopenable — no index to compact
  }

  throwIfAborted(signal, "before acquiring the index maintenance lock");
  const lock = tableMaintenanceLock(dir);
  await lock.runExclusive(async () => {
    // Snapshot the SQLite-active set and delete non-active chunks in ONE critical
    // section — no activation can add a live generation between the two (the finding
    // the shared lock closes). Re-check cancel now we hold the lock, before deleting.
    throwIfAborted(signal, "before lancedb delete");
    const activeIds = store.generation.activeGenerationIds();
    await compactOrphans(table, activeIds);
  });
  ctx.log.info("retention.lancedb-compaction", { period: parsed.data.period, jobRunId: ctx.runId });
  return {};
}

/**
 * `retention:log-rotation` (matrix row 26) — the SCHEDULED age/rotation pass for the
 * structured JSONL logs. The diag logger's own rotation is SIZE-triggered and fires
 * only on write, so a quiescent process never rotates and never ages logs out; this
 * job drives `sweepLogRetention`, which age-rotates the active file and HARD-DELETES
 * rotated files past `logs.retention_days` or beyond `logs.max_files`. Filesystem-only
 * ⇒ returns `{}`.
 */
async function runLogRotation(deps: JobHandlerDeps, payload: unknown, signal: AbortSignal): Promise<Record<string, never>> {
  const parsed = BasePayload.safeParse(payload);
  if (!parsed.success) invalidPayload("retention:log-rotation", parsed.error);
  throwIfAborted(signal, "before log rotation");

  const { sweepLogRetention } = await import("../diag/logger.js");
  const { resolvePath } = await import("../commands/backup-config.js");

  const { ctx } = deps;
  const logs = ctx.config.config.logs;
  const result = sweepLogRetention({
    dir: resolvePath(ctx, logs.dir),
    maxFiles: logs.max_files,
    retentionMs: logs.retention_days * 86_400_000,
  });
  ctx.log.info("retention.log-rotation", { period: parsed.data.period, rotated: result.rotated, deleted: result.deleted.length, jobRunId: ctx.runId });
  return {};
}

/**
 * `retention:backup-prune` (matrix row 18) — prune ledger backups to
 * `{ keep-forever-latest } ∪ { keep-N most-recent verified }`, honoring in-flight
 * `db restore` pins, and sweep `.tmp-*`/`.snap-*` crash leftovers. The `payload.keep`
 * (from `retention/jobs.ts`) overrides the config keep-N. Filesystem-only ⇒ returns
 * `{}`; reads the AEAD key from platform custody only to authenticate candidate
 * bundles (`pruneRetention` never selects/deletes an unverifiable bundle).
 */
async function runBackupPrune(deps: JobHandlerDeps, payload: unknown, signal: AbortSignal): Promise<Record<string, never>> {
  const parsed = BackupPrunePayload.safeParse(payload);
  if (!parsed.success) invalidPayload("retention:backup-prune", parsed.error);
  throwIfAborted(signal, "before backup prune");

  const { pruneRetention } = await import("@atlas/sqlite-store");
  const { backupConfig } = await import("../commands/backup-config.js");

  const { ctx } = deps;
  // The job's keep bound (matrix row 18) overrides the config default for this run.
  const cfg = { ...backupConfig(ctx), keep: parsed.data.keep };
  pruneRetention(cfg);
  ctx.log.info("retention.backup-prune", { period: parsed.data.period, keep: parsed.data.keep, jobRunId: ctx.runId });
  return {};
}

/**
 * `retention:quarantine-expiry` (matrix row 31) — expire TTL-elapsed quarantine items,
 * trim to keep-N most-recent, and sweep stale `.qtmp-*` crash remnants, all crash-safe
 * (a single directory fsync after the batch of unlinks). Corrupt/tampered bundles are
 * left in place (fail closed) and reported, never used to expire a valid item. The
 * store resolves its TTL/keep bounds + AEAD custody key from config
 * (`quarantineStoreFromContext`). Filesystem-only ⇒ returns `{}`.
 */
async function runQuarantineExpiry(deps: JobHandlerDeps, payload: unknown, signal: AbortSignal): Promise<Record<string, never>> {
  const parsed = BasePayload.safeParse(payload);
  if (!parsed.success) invalidPayload("retention:quarantine-expiry", parsed.error);
  throwIfAborted(signal, "before quarantine expiry");

  const { quarantineStoreFromContext } = await import("../quarantine/config.js");

  const { ctx } = deps;
  const store = quarantineStoreFromContext(ctx);
  const res = store.purge();
  ctx.log.info("retention.quarantine-expiry", {
    period: parsed.data.period,
    expired: res.expired.length,
    trimmed: res.trimmed.length,
    tempsSwept: res.tempsSwept,
    corrupt: res.corrupt.length,
    jobRunId: ctx.runId,
  });
  return {};
}

/**
 * Build the retention workflow→executor map for one `jobs run` drain. Pure and
 * side-effect free: it only closes over `deps`, so it is safe to call before the queue
 * is known non-empty AND safe for the registry-completeness gate to call with a stub
 * `deps`. The key set is exactly `RETENTION_WORKFLOWS` (the completeness gate binds the
 * enqueue side to this map).
 */
export function buildRetentionHandlers(deps: JobHandlerDeps): Record<RetentionWorkflow, JobHandler> {
  return {
    "retention:lancedb-compaction": ({ payload, signal }) => runLancedbCompaction(deps, payload, signal),
    "retention:log-rotation": ({ payload, signal }) => runLogRotation(deps, payload, signal),
    "retention:backup-prune": ({ payload, signal }) => runBackupPrune(deps, payload, signal),
    "retention:quarantine-expiry": ({ payload, signal }) => runQuarantineExpiry(deps, payload, signal),
  };
}
