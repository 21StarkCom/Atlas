/**
 * `ledger/intents` — the §2.8 step-1 durable intent + audit `seq` allocation.
 *
 * The intent txn is the **serialization point** (plan §2.8): allocating the
 * monotonic `seq` inside one IMMEDIATE transaction means two concurrent writers
 * take the SQLite write lock in turn and can never collide on a `seq`. The intent
 * row persists the canonical UNSIGNED event so {@link IntentsRepo} — and, on
 * crash recovery, `reconcileInterruptedRuns` — can re-drive the broker append
 * (§2.8 step 2) with byte-stable content, idempotent on `(runId, seq)`.
 *
 * ## Two disjoint seq spaces (why `db.*` uses a high range)
 * The git-anchored audit chain the broker enforces is **gapless** (`seq === last
 * + 1`). Only `run.*` events reach the broker, so their `seq` must stay a
 * contiguous run. The D6 ledger-internal events (`db.backup` / `db.restore` /
 * `db.force_unblock`) carry **no git event** (contract §11) — if they consumed
 * the same counter they would punch gaps into the git chain and the next broker
 * append would be refused. They are therefore allocated from a disjoint HIGH
 * range ({@link DB_EVENT_SEQ_BASE}) that the `run.*` counter never reaches, so the
 * two never collide on the shared `audit_events.seq` primary key.
 */
import { createHash } from "node:crypto";
import { canonicalSerialize, canonicalStringify, type AuditEvent } from "@atlas/contracts";
import type { SqliteDatabase } from "../connection.js";

/**
 * A ledger audit event as the caller drafts it: everything except `seq` (the
 * intent txn allocates it) and `prevAuditHead` (the broker fills + signs it, F4).
 */
export type AuditEventDraft = Omit<AuditEvent, "seq" | "prevAuditHead">;

/** The unsigned event once its `seq` is allocated (what the broker signs, sans `prevAuditHead`). */
export type UnsignedAuditEvent = Omit<AuditEvent, "prevAuditHead">;

/**
 * A single serializable step-3 ledger write. `finalizeLedgerWrite` persists the
 * run's whole `LedgerStatement[]` in the intent (`write_json`) so
 * `reconcileInterruptedRuns` can replay the COMPLETE step-3 operation — the run's
 * business rows AND the audit row — after a crash, not just the audit row (§2.8).
 * Statements should be idempotent (e.g. `INSERT OR IGNORE` / upsert) so a replay
 * is safe; the reconciler only replays intents still `pending` (never committed),
 * so a clean re-drive writes each row exactly once.
 */
export interface LedgerStatement {
  readonly sql: string;
  readonly params?: readonly unknown[] | Record<string, unknown>;
  /**
   * An optional post-execution guard, enforced by {@link applyLedgerWrite}
   * transactionally in BOTH the live §2.8 step-3 AND the crash-recovery drain
   * ({@link reconcileInterruptedRuns} replays this via `write_json`). `assert.sql`
   * is a `SELECT` that MUST return at least one row after `sql` runs; if it returns
   * NONE, {@link LedgerAssertionError} is thrown and the whole step-3 transaction
   * rolls back. Because the assertion is serialized with the statement, a replay
   * enforces the exact same affected-row / immutable-artifact CAS the live path did
   * — closing the round finding #2 gap where the post-write CAS lived only in a
   * non-serialized `extraCommit` closure and was skipped on startup replay.
   */
  readonly assert?: LedgerAssertion;
  /**
   * An optional AFFECTED-ROW assertion (round-2 finding W1): the number of rows
   * `sql` must change when it runs. Enforced by {@link applyLedgerWrite} in BOTH
   * the live step-3 AND the crash-recovery replay. Unlike {@link assert} (a
   * post-state SELECT), this proves THIS statement's DML actually mutated the
   * expected number of rows — so a guarded `ON CONFLICT DO UPDATE … WHERE` whose
   * predicate blocked the update (0 rows changed) is rejected EVEN WHEN the row is
   * already at the target status because a DIFFERENT handle wrote it (a no-op
   * UPDATE must never masquerade as a successful advance, e.g. a duplicate
   * terminal). Typically `1` for a single-row guarded upsert.
   */
  readonly expectChanges?: number;
}

/** A serializable post-write guard for a {@link LedgerStatement} (round finding #2). */
export interface LedgerAssertion {
  /** A `SELECT` that MUST return ≥1 row after the statement ran; else the write is rejected. */
  readonly sql: string;
  readonly params?: readonly unknown[] | Record<string, unknown>;
  /** The human-readable reason surfaced on failure. */
  readonly message: string;
}

/**
 * Raised when a {@link LedgerStatement}'s serialized {@link LedgerAssertion} guard
 * finds its required row absent — the transactional affected-row / immutable-artifact
 * CAS failed (a stale/concurrent advance, or a divergent replay). Thrown inside the
 * step-3 transaction so the whole write rolls back; the crash-recovery drain treats
 * it as a non-fatal per-intent conflict (leaves the intent pending, never falsely
 * completes the audit event) rather than a corrupt-store abort.
 */
export class LedgerAssertionError extends Error {
  constructor(readonly detail: string) {
    super(`ledger-write assertion failed: ${detail}`);
    this.name = "LedgerAssertionError";
  }
}

function runStatement(
  db: SqliteDatabase,
  sql: string,
  params?: readonly unknown[] | Record<string, unknown>,
): { changes: number } {
  const stmt = db.prepare(sql);
  if (params === undefined) return stmt.run();
  if (Array.isArray(params)) return stmt.run(...(params as unknown[]));
  return stmt.run(params as Record<string, unknown>);
}

function checkAssertion(db: SqliteDatabase, a: LedgerAssertion): void {
  const stmt = db.prepare(a.sql);
  const row = a.params === undefined
    ? stmt.get()
    : Array.isArray(a.params)
      ? stmt.get(...(a.params as unknown[]))
      : stmt.get(a.params as Record<string, unknown>);
  if (row === undefined) throw new LedgerAssertionError(a.message);
}

/** Execute a run's serializable step-3 writes on `db` (inside the step-3 txn). */
export function applyLedgerWrite(db: SqliteDatabase, statements: readonly LedgerStatement[]): void {
  for (const st of statements) {
    const info = runStatement(db, st.sql, st.params);
    // Serialized affected-row assertion (round-2 finding W1): a guarded upsert whose
    // ON CONFLICT WHERE-predicate blocked the update changes ZERO rows even when the
    // row already sits at the target status (written by another handle) — the
    // post-state SELECT below cannot tell the two apart, so a duplicate terminal
    // could falsely complete. Rejecting on the mutated-row COUNT closes that gap, on
    // the live path AND on crash-recovery replay (this travels in `write_json`).
    if (st.expectChanges !== undefined && info.changes !== st.expectChanges) {
      throw new LedgerAssertionError(
        `expected ${st.expectChanges} affected row(s) but ${info.changes} changed (guarded write blocked — stale or concurrent handle)`,
      );
    }
    // Serialized post-write guard (round finding #2): enforced identically on the
    // live path and on crash-recovery replay, so an audit event is never completed
    // against a row the CAS could not advance.
    if (st.assert) checkAssertion(db, st.assert);
  }
}

/** An `audit_intents` row. */
export interface AuditIntentRow {
  readonly run_id: string;
  readonly seq: number;
  readonly payload_hash: string;
  readonly event_json: string;
  /** The run's serializable step-3 business writes (JSON `LedgerStatement[]`). */
  readonly write_json: string;
  readonly state: "pending" | "done";
  readonly created_at: string;
  readonly updated_at: string;
}

/** The result of {@link IntentsRepo.allocate}. */
export interface AllocatedIntent {
  readonly seq: number;
  readonly payloadHash: string;
  /** The canonical unsigned event (with `seq`) the broker will sign in step 2. */
  readonly event: UnsignedAuditEvent;
}

/**
 * The disjoint base for D6 ledger-internal (`db.*`) event seqs. `run.*` seqs grow
 * from 0 and never reach this, so the two spaces share `audit_events.seq` without
 * ever colliding (see the module header).
 */
export const DB_EVENT_SEQ_BASE = 1_000_000_000_000;

/** The canonical payload hash stored in both `audit_intents` and `audit_events`. */
export function payloadHashOf(event: UnsignedAuditEvent): string {
  return createHash("sha256").update(canonicalSerialize(event)).digest("hex");
}

export class IntentsRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * The next `run.*` (git-anchored) seq: one past the highest already allocated
   * across `audit_intents` (pending or done) and the committed run-space
   * `audit_events`. Both are consulted so a crash between step 1 and step 3
   * cannot re-issue a seq the intent already claimed.
   *
   * The run space is a NUMERIC RANGE (`seq < DB_EVENT_SEQ_BASE`), so both arms
   * partition by the range — never by event-type prefix. A `NOT LIKE 'db.%'`
   * filter here counted the ledger-internal `evidence.retry_enqueued` (allocated
   * at BASE+n by `nextDbEventSeq`) into the run space, after which every
   * broker-anchored run was refused `broker.audit_seq_nonmonotonic` (the broker
   * signs only `lastSeq + 1`). The intents arm is range-filtered too so an intent
   * stranded in the internal range by the pre-fix allocator cannot re-poison this.
   */
  nextRunSeq(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), -1) AS m FROM (
           SELECT seq FROM audit_intents WHERE seq < ${DB_EVENT_SEQ_BASE}
           UNION ALL
           SELECT seq FROM audit_events WHERE seq < ${DB_EVENT_SEQ_BASE}
         )`,
      )
      .get() as { m: number };
    return row.m + 1;
  }

  /**
   * Step 1: allocate the next `run.*` seq and durably record the `pending`
   * intent, all inside ONE IMMEDIATE transaction (the serialization point).
   */
  allocate(
    runId: string,
    draft: AuditEventDraft,
    ledgerWrite: readonly LedgerStatement[],
    now: string,
  ): AllocatedIntent {
    const tx = this.db.transaction((): AllocatedIntent => {
      const seq = this.nextRunSeq();
      const event: UnsignedAuditEvent = { ...draft, seq };
      const payloadHash = payloadHashOf(event);
      const eventJson = canonicalStringify(event);
      const writeJson = JSON.stringify(ledgerWrite);
      this.db
        .prepare(
          `INSERT INTO audit_intents
             (run_id, seq, payload_hash, event_json, write_json, state, created_at, updated_at)
           VALUES (@run_id, @seq, @payload_hash, @event_json, @write_json, 'pending', @now, @now)`,
        )
        .run({ run_id: runId, seq, payload_hash: payloadHash, event_json: eventJson, write_json: writeJson, now });
      return { seq, payloadHash, event };
    });
    return tx.immediate();
  }

  /**
   * Flip an intent to `done`. Meant to run INSIDE the step-3 ledger-commit
   * transaction (alongside the run's rows + the `audit_events` insert), so the
   * intent and the committed event land atomically.
   */
  markDone(runId: string, seq: number, now: string): void {
    this.db
      .prepare(
        `UPDATE audit_intents SET state = 'done', updated_at = @now WHERE run_id = @run_id AND seq = @seq`,
      )
      .run({ run_id: runId, seq, now });
  }

  /** All still-`pending` intents, oldest seq first (recovery order). */
  listPending(): AuditIntentRow[] {
    return this.db
      .prepare(`SELECT * FROM audit_intents WHERE state = 'pending' ORDER BY seq ASC`)
      .all() as AuditIntentRow[];
  }

  get(runId: string, seq: number): AuditIntentRow | undefined {
    return this.db
      .prepare(`SELECT * FROM audit_intents WHERE run_id = ? AND seq = ?`)
      .get(runId, seq) as AuditIntentRow | undefined;
  }

  /** Parse a stored `event_json` back into the unsigned event the broker signs. */
  static parseEvent(row: AuditIntentRow): UnsignedAuditEvent {
    return JSON.parse(row.event_json) as UnsignedAuditEvent;
  }

  /** Parse a stored `write_json` back into the run's serializable step-3 writes. */
  static parseWrite(row: AuditIntentRow): LedgerStatement[] {
    return JSON.parse(row.write_json ?? "[]") as LedgerStatement[];
  }
}

/**
 * Allocate the next D6 ledger-internal seq from the disjoint high range
 * ({@link DB_EVENT_SEQ_BASE}). These never reach the broker (contract §11), so they must not
 * perturb the gapless `run.*` chain. The range is shared across ALL ledger-internal event kinds
 * (`db.backup`/`db.restore`/`db.force_unblock` AND `evidence.retry_enqueued`), so the allocator
 * counts every non-`run.*` event — narrowing to `db.%` would collide a second `evidence.*` event
 * onto the base seq of the first.
 */
export function nextDbEventSeq(db: SqliteDatabase): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), ?) AS m FROM audit_events WHERE event_type NOT LIKE 'run.%'`)
    .get(DB_EVENT_SEQ_BASE - 1) as { m: number };
  return row.m + 1;
}

/**
 * The highest committed `run.*` ledger seq (−1 if none) — the backup cut point.
 * Partitioned by the seq RANGE, not event-type prefix: `evidence.retry_enqueued`
 * lives in the internal range and must never become the cut point.
 */
export function latestRunSeq(db: SqliteDatabase): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), -1) AS m FROM audit_events WHERE seq < ${DB_EVENT_SEQ_BASE}`)
    .get() as { m: number };
  return row.m;
}

/** The lowest still-`pending` intent seq, or `null` if none are pending. */
export function lowestPendingSeq(db: SqliteDatabase): number | null {
  const row = db
    .prepare(`SELECT MIN(seq) AS m FROM audit_intents WHERE state = 'pending'`)
    .get() as { m: number | null };
  return row.m ?? null;
}

/**
 * The highest seq a backup may CLAIM to cover WITHOUT falsely covering a run
 * whose step-3 commit has not landed (round-3 finding 2). Finalizations serialize
 * only during seq allocation, so after allocation runs can interleave: seq N may
 * commit + be backed up while an EARLIER seq M<N is still `pending` (anchored but
 * absent from SQLite). A backup that advanced the watermark to N would then falsely
 * claim coverage through M. The safe cut is therefore the highest committed run seq
 * that is strictly below the lowest pending intent — never covering a gap. Returns
 * −1 (the "nothing covered" sentinel, finding 3) when nothing is safely coverable.
 */
export function safeBackupCutSeq(db: SqliteDatabase): number {
  const committed = latestRunSeq(db);
  const pending = lowestPendingSeq(db);
  if (pending === null) return committed;
  return Math.min(committed, pending - 1);
}
