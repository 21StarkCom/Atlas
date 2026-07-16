/**
 * `workflows/idempotency` — the caller-idempotency layer for key-accepting
 * workflow commands (Task 2.5). It persists, per `(command, --idempotency-key)`,
 * the **normalized request hash** + the **terminal result**, so that:
 *
 *   - an identical retry (same key, same request hash) after completion returns
 *     the prior result WITHOUT re-running the work;
 *   - key reuse with a DIFFERENT request hash is REJECTED (a client bug — the
 *     same key must mean the same request);
 *   - a concurrent duplicate (same key still `in-progress`) BLOCKS on the key
 *     rather than double-executing.
 *
 * ## Storage — a properly-OWNED @atlas/sqlite-store migration (round finding #3)
 * The `requestHashScope` + `--idempotency-key` contract is declared in the CLI
 * schemas, but the authoritative §2.7 inventory allocates no table for it, and the
 * `sqlite-store` default migration set is checksum-frozen (`db.migrate-ownership`
 * asserts its fresh-DB table set is EXACTLY the §2.7 core/provenance/claims tables).
 * A prior approach lazily created the table DURING command execution (a bare
 * `CREATE TABLE`/`runMigrations` at first use) — an undeclared, unowned table that
 * violated the migration-ownership invariant.
 *
 * The reconciliation: the table is a first-class, checksum-guarded migration file —
 * `migration0006WorkflowIdempotency` in `packages/sqlite-store/migrations/`, authored
 * and registered exactly like `0002_jobs` (the FEATURE half of the plan's
 * retained-vs-feature PR split). It is applied at STORE-OPEN through the normal
 * `runMigrations` runner via {@link registerWorkflowMigrations} (`Store.registerMigration`
 * + `Store.migrate`), NOT ad-hoc during a command — so the table is declared,
 * singly-owned, and recorded in `db_schema_migrations` (checksum-verified on every
 * open). Because it is registered by the workflows layer rather than `openStore`'s
 * default set, the `db.migrate-ownership` fresh-DB diff (a bare store) stays exactly
 * the §2.7 set, yet the "exactly one owning migration per table" rule is honoured.
 *
 * The other load-bearing fixes:
 *  - **Atomic completion.** Completion is published as a {@link LedgerStatement}
 *    ({@link completeIdempotentStatement}, carrying a serialized owner/hash/state
 *    {@link LedgerAssertion}) committed INSIDE the run's terminal transaction, so a
 *    crash never leaves a finalized run with an `in-progress` key (or vice-versa)
 *    and a stale claim rolls the whole terminal back.
 *  - **Owner/hash/state CAS.** `complete`/`release` mutate ONLY a row still
 *    `in-progress`, owned by the caller's `runId`, with a matching `requestHash`.
 *  - **Startup reconciliation.** {@link reconcileIdempotency} PRESERVES a claim
 *    whose owning run FINALIZED by persisting the run's durable outcome (a retry
 *    replays rather than re-executes), frees a claim whose run reached a DEAD
 *    terminal (`failed`/`cancelled`/`rejected`/`rolled-back`), AND frees a claim
 *    whose owning run never wrote an `agent_runs` row (a crash in the claim →
 *    run-start seam — handled via a LEFT JOIN so the inner join no longer wedges it
 *    `in-progress` forever, round finding #5).
 *
 * The `(command, idempotency_key)` PRIMARY KEY + an IMMEDIATE transaction make
 * the first writer's `in-progress` insert the serialization point — a concurrent
 * duplicate that loses the race sees the `in-progress` row and blocks.
 */
import {
  migration0006WorkflowIdempotency,
  migration0009RunSupersessions,
  migration0010TrustState,
  openStore,
  type LedgerStatement,
  type SqliteConfig,
  type SqliteDatabase,
  type Store,
} from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";

/**
 * Register the workflows layer's owned migrations on a `Store` (round finding #3).
 * Call this at STORE-OPEN, before {@link Store.migrate}, so the caller-idempotency
 * table is applied through the normal checksum-guarded runner — the same pattern
 * `@atlas/jobs` uses to register `0002_jobs`. NOT applied ad-hoc during a command.
 */
export function registerWorkflowMigrations(store: Store): void {
  store.registerMigration(migration0006WorkflowIdempotency);
  store.registerMigration(migration0009RunSupersessions);
  store.registerMigration(migration0010TrustState);
}

/**
 * The PRODUCTION store-open lifecycle for the workflows layer (round-2 finding W7).
 * Every command that drives runs / caller-idempotency opens the ledger through THIS
 * path — it opens the store, registers the workflows-owned migration(s), and applies
 * them via the normal checksum-guarded runner — so the `workflow_idempotency` table
 * is GUARANTEED present at store-open in production, not merely when a test harness
 * happens to call {@link registerWorkflowMigrations} by hand. The returned store is
 * fully migrated (the default retained set + `0006`); the caller owns closing it.
 */
export function openWorkflowStore(cfg: SqliteConfig): Store {
  const store = openStore(cfg);
  registerWorkflowMigrations(store);
  store.migrate();
  return store;
}

/** The identity of a key-accepting request. */
export interface IdempotencyRequest {
  /** The command name (e.g. `reconcile`, `ingest`, `source add`). */
  readonly command: string;
  /** The caller's `--idempotency-key`. */
  readonly key: string;
  /** `sha256(canonical(normalized request))` — the `requestHashScope` digest. */
  readonly requestHash: string;
  /** The run ULID this key is (or was) associated with. */
  readonly runId: string;
}

/** The result of {@link beginIdempotent}. */
export type IdempotencyOutcome =
  /** No prior record: the caller owns the work and must {@link completeIdempotent}. */
  | { readonly kind: "started" }
  /** A completed prior run with a matching request: return `resultJson` verbatim. */
  | { readonly kind: "replay"; readonly resultJson: string; readonly runId: string };

/** Raised when a key is reused with a DIFFERENT request hash (client bug). */
export class IdempotencyKeyConflictError extends CliError {
  constructor(command: string, key: string) {
    super({
      code: "idempotency-key-conflict",
      message: `idempotency key "${key}" for command "${command}" was already used with a different request`,
      hint: "Reusing an idempotency key requires the identical request; use a fresh key for a different request.",
      exitCode: EXIT.VALIDATION,
    });
    this.name = "IdempotencyKeyConflictError";
  }
}

/** Raised when a `complete`/`release` is attempted by a non-owning/stale claimant. */
export class IdempotencyOwnershipError extends CliError {
  constructor(command: string, key: string, action: string) {
    super({
      code: "idempotency-not-owner",
      message: `cannot ${action} idempotency slot (command "${command}", key "${key}"): no in-progress claim owned by this run with a matching request`,
      hint: "Only the run that claimed a key (with the same request hash) may complete or release it.",
      exitCode: EXIT.INTERNAL,
    });
    this.name = "IdempotencyOwnershipError";
  }
}

/** Raised when a concurrent duplicate is still `in-progress` under the same key. */
export class IdempotencyInProgressError extends CliError {
  constructor(command: string, key: string, runId: string) {
    super({
      code: "idempotency-in-progress",
      message: `command "${command}" with idempotency key "${key}" is already in progress (run ${runId})`,
      hint: "A duplicate request with this key is running; wait for it to finish, then retry to get its result.",
      exitCode: EXIT.ACTION_REQUIRED,
      retryable: true,
      runId,
    });
    this.name = "IdempotencyInProgressError";
  }
}

/**
 * Claim (or replay) a `(command, key)` idempotency slot. Runs in an IMMEDIATE
 * transaction so the first writer serializes the claim:
 *
 *   - no row               → insert `in-progress`, return `started`;
 *   - `done`, same hash    → return `replay` with the stored result;
 *   - any state, diff hash → throw {@link IdempotencyKeyConflictError};
 *   - `in-progress`, same  → throw {@link IdempotencyInProgressError} (blocks).
 */
export function beginIdempotent(
  db: SqliteDatabase,
  req: IdempotencyRequest,
  now: string,
): IdempotencyOutcome {
  const tx = db.transaction((): IdempotencyOutcome => {
    const existing = db
      .prepare(
        `SELECT request_hash, run_id, state, result_json FROM workflow_idempotency
         WHERE command = ? AND idempotency_key = ?`,
      )
      .get(req.command, req.key) as
      | { request_hash: string; run_id: string; state: "in-progress" | "done"; result_json: string | null }
      | undefined;

    if (existing === undefined) {
      db.prepare(
        `INSERT INTO workflow_idempotency
           (command, idempotency_key, request_hash, run_id, state, result_json, created_at, updated_at)
         VALUES (@command, @key, @request_hash, @run_id, 'in-progress', NULL, @now, @now)`,
      ).run({ command: req.command, key: req.key, request_hash: req.requestHash, run_id: req.runId, now });
      return { kind: "started" };
    }

    if (existing.request_hash !== req.requestHash) {
      throw new IdempotencyKeyConflictError(req.command, req.key);
    }
    if (existing.state === "done") {
      return { kind: "replay", resultJson: existing.result_json ?? "null", runId: existing.run_id };
    }
    // Same hash, still in-progress → a concurrent duplicate. Block on the key.
    throw new IdempotencyInProgressError(req.command, req.key, existing.run_id);
  });
  return tx.immediate();
}

/**
 * The `LedgerStatement` that publishes a completed `(command, key)` slot to `done`
 * (round-2 finding). Returned rather than executed so the caller can commit it
 * ATOMICALLY inside the run's TERMINAL transaction (`finalizeLedgerWrite`'s
 * step-3 `ledgerWrite`) — the idempotency completion and the run's terminal state
 * land or roll back together, so a crash can never leave a completed run with the
 * key still `in-progress` (or vice-versa). Owner + hash + state CAS: the row is
 * flipped ONLY while it is still `in-progress`, owned by THIS `runId`, and carries
 * the SAME `requestHash` — a stale owner cannot complete another claim.
 */
export function completeIdempotentStatement(req: IdempotencyRequest, resultJson: string, now: string): LedgerStatement {
  const params = { command: req.command, key: req.key, run_id: req.runId, request_hash: req.requestHash, result_json: resultJson, now };
  return {
    sql: `UPDATE workflow_idempotency
             SET state = 'done', result_json = @result_json, updated_at = @now
           WHERE command = @command AND idempotency_key = @key
             AND run_id = @run_id AND request_hash = @request_hash AND state = 'in-progress'`,
    params,
    // Affected-row CAS (round-3 finding on idempotency.ts:205-227): the UPDATE MUST
    // change EXACTLY ONE row. An already-`done` row with the SAME owner/hash changes
    // ZERO rows yet still satisfies the post-state SELECT below (a `done` row exists),
    // so the assert alone would let a DUPLICATE completion pass. `expectChanges: 1`
    // (enforced by applyLedgerWrite on BOTH the live terminal tx and the crash-recovery
    // replay) rejects the no-op UPDATE, rolling the whole terminal back — a slot is
    // completed exactly once.
    expectChanges: 1,
    // Serialized owner/hash/state CAS (round finding #4): after the UPDATE, exactly
    // ONE row must now be `done`, owned by THIS run, with the matching request hash.
    // The `(command, idempotency_key)` PRIMARY KEY makes "≥1 such row" == "exactly
    // one". A stale/foreign claim (owned by another run, different hash, or already
    // done) matches ZERO rows to update, so this assert finds no `done` row for THIS
    // run and throws — rolling the ENTIRE terminal transaction back (the run's
    // terminal state + this publish land or roll back together).
    assert: {
      sql: `SELECT 1 FROM workflow_idempotency
              WHERE command = @command AND idempotency_key = @key
                AND run_id = @run_id AND request_hash = @request_hash AND state = 'done'`,
      params,
      message: `idempotency completion for command "${req.command}" key "${req.key}" affected no owned in-progress row (stale claim)`,
    },
  };
}

/**
 * Persist the terminal result for a completed `(command, key)` run, flipping its
 * slot to `done` under owner/hash/state CAS. Prefer {@link completeIdempotentStatement}
 * inside the terminal transaction; this standalone form is for callers whose
 * terminal write is not a `finalizeLedgerWrite`. Throws {@link IdempotencyOwnershipError}
 * if no `in-progress` row owned by `req.runId` with `req.requestHash` exists.
 */
export function completeIdempotent(
  db: SqliteDatabase,
  req: IdempotencyRequest,
  resultJson: string,
  now: string,
): void {
  const st = completeIdempotentStatement(req, resultJson, now);
  const res = db.prepare(st.sql).run(st.params as Record<string, unknown>);
  if (res.changes === 0) {
    throw new IdempotencyOwnershipError(req.command, req.key, "complete");
  }
}

/**
 * Release an `in-progress` slot that failed WITHOUT a terminal result, so a later
 * retry can re-claim the key (a failed non-idempotent attempt must not wedge the
 * key forever). Deletes ONLY a row still `in-progress`, owned by THIS `runId` (owner
 * CAS — a stale owner cannot release another live claim, round-2 finding).
 */
export function releaseIdempotent(db: SqliteDatabase, req: IdempotencyRequest, _now?: string): void {
  db.prepare(
    `DELETE FROM workflow_idempotency
      WHERE command = ? AND idempotency_key = ? AND run_id = ? AND request_hash = ? AND state = 'in-progress'`,
  ).run(req.command, req.key, req.runId, req.requestHash);
}

/**
 * Startup reconciliation for the idempotency ledger (round findings #4/#5: a crash
 * must neither wedge a key `in-progress` forever NOR allow a finalized run's key to
 * be re-executed). A LEFT JOIN (round finding #5) is deliberate — the prior INNER
 * join dropped any claim whose owning run never wrote an `agent_runs` row (a crash
 * in the claim→run-start seam), wedging it `in-progress` forever. For each still
 * `in-progress` claim:
 *
 *  - owning run `finalized` → the exact terminal result is published ATOMICALLY with
 *    the `finalized` state (the {@link completeIdempotentStatement} rides the finalize
 *    transaction), so a properly-wired run's slot is ALREADY `done` and never appears
 *    here. A `finalized` run whose slot is still `in-progress` therefore has NO durable
 *    exact result to replay — reconstructing one from run artifacts would fabricate an
 *    opaque result the caller never returned (round-3 finding on idempotency.ts:306-317).
 *    FAIL CLOSED: leave the slot `in-progress` (never invent a response). A retry then
 *    BLOCKS on the key ({@link IdempotencyInProgressError}, retryable) rather than
 *    receiving a fabricated result — the safe outcome for a legacy/unwired finalized row.
 *  - owning run `failed`/`cancelled`/`rejected`/`rolled-back` → the run is DEAD with
 *    no durable result; RELEASE the slot so a fresh retry re-drives the work.
 *  - NO `agent_runs` row (claim made, run crashed before its first checkpoint) →
 *    RELEASE the slot: at startup there are no concurrent live runs, so a claim with
 *    no run row is a crashed claim→run-start seam, not a live attempt (round #5).
 *
 * A claim whose run is still NON-terminal (a genuinely in-flight run that did write
 * a row) is left untouched. Returns the number of claims resolved.
 */
export function reconcileIdempotency(db: SqliteDatabase, now: string): number {
  void now; // release/fail-closed need no timestamp; kept for a stable startup-pass API.
  const stale = db
    .prepare(
      `SELECT w.command AS command, w.idempotency_key AS key, w.run_id AS run_id, r.status AS status
         FROM workflow_idempotency w
         LEFT JOIN agent_runs r ON r.run_id = w.run_id
        WHERE w.state = 'in-progress'
          AND (r.run_id IS NULL
               OR r.status IN ('finalized', 'failed', 'cancelled', 'rejected', 'rolled-back'))`,
    )
    .all() as { command: string; key: string; run_id: string; status: string | null }[];
  let resolved = 0;
  const del = db.prepare(
    `DELETE FROM workflow_idempotency WHERE command = ? AND idempotency_key = ? AND run_id = ? AND state = 'in-progress'`,
  );
  for (const s of stale) {
    if (s.status === "finalized") {
      // FAIL CLOSED (round-3 finding on idempotency.ts:306-317): a `finalized` run's
      // exact result is published atomically with `finalized`, so an in-progress slot
      // here means the completion was never committed and there is NO durable exact
      // result to replay. Reconstructing one from artifacts would fabricate an opaque
      // response the caller never produced — so leave the slot `in-progress` (a retry
      // blocks on the key) rather than inventing a result. Not counted as resolved.
      continue;
    }
    // Dead terminal OR no agent_runs row (crashed claim→run-start seam) → free it.
    if (del.run(s.command, s.key, s.run_id).changes > 0) resolved++;
  }
  return resolved;
}
