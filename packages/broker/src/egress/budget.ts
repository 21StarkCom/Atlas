/**
 * Per-run cost/byte/token budget (D19). The egress broker keeps a running tally
 * per `runId` and enforces the run-bound capability's ceilings on EVERY
 * transmission — bounding a compromised agent's export/spend even through the
 * sanctioned RPC. The tally is broker-primary in-memory state (the broker holds no
 * SQLite, D18); it is authoritative for the life of the daemon. A capability's
 * ceilings are cumulative per run, so successive calls draw down the same budget.
 *
 * ## Atomic reserve → reconcile (closes the check/commit race)
 * Two concurrent connections for the SAME run could both pass a pre-flight `check`
 * before either committed, and together overrun the ceiling while each awaited its
 * provider round-trip. So the budget is charged in TWO synchronous steps with the
 * reservation held ACROSS the await:
 *   1. `reserve(claims, projected)` — atomically (synchronously, before any await)
 *      adds the CONSERVATIVE projected draw (input+output tokens, worst-case retry-
 *      bounded cost, exact request bytes). A concurrent reserve for the same run
 *      immediately sees the held reservation, so the ceiling cannot be raced.
 *   2. `reconcile(runId, reservation, actual)` — after the round-trip, swaps the
 *      projected draw for the ACTUAL usage (or `release` rolls the reservation back
 *      entirely for a call that never dispatched). Every DISPATCHED call charges at
 *      least its outbound bytes, even on a provider error.
 */
import type { EgressCapabilityClaims } from "./capability.js";
import type { BudgetStore, PersistedTally } from "./budget-store.js";

/** The cumulative resources a run has already consumed. */
interface RunTally {
  bytes: number;
  tokens: number;
  costMicros: number;
}

/** An in-flight reservation held across the provider round-trip. */
export interface BudgetReservation {
  readonly runId: string;
  readonly bytes: number;
  readonly tokens: number;
  readonly costMicros: number;
}

/** A refusal reason a pre-flight budget check can raise. */
export type BudgetRefusalCode =
  | "egress.byte_budget_exceeded"
  | "egress.token_budget_exceeded"
  | "egress.cost_budget_exceeded";

/** The verdict of a pre-flight budget reservation (before the provider round-trip). */
export type BudgetVerdict =
  | { readonly ok: true; readonly reservation: BudgetReservation }
  | { readonly ok: false; readonly code: BudgetRefusalCode; readonly reason: string };

/**
 * Per-run budget tracker. `reserve` is the atomic PRE-FLIGHT gate; `reconcile`
 * swaps the reservation for actual usage after a dispatched round-trip; `release`
 * rolls back a reservation for a call that never dispatched (e.g. a response-scan
 * block before any bytes were charged as usage). A never-dispatched call must not
 * leave a phantom draw on the run's budget.
 */
export class RunBudget {
  private readonly tallies = new Map<string, RunTally>();
  private readonly store: BudgetStore | undefined;

  /**
   * @param opts.store optional PERSISTENT backing store (D19). When supplied,
   * tallies are loaded at construction and durably persisted on every committed
   * mutation, so a daemon restart/replacement cannot reset a run's consumed
   * allowance. Absent ⇒ daemon-lifetime in-memory state only.
   */
  constructor(opts: { store?: BudgetStore } = {}) {
    this.store = opts.store;
    if (this.store !== undefined) {
      for (const [runId, t] of Object.entries(this.store.load())) {
        this.tallies.set(runId, { bytes: t.bytes, tokens: t.tokens, costMicros: t.costMicros });
      }
    }
  }

  private tally(runId: string): RunTally {
    let t = this.tallies.get(runId);
    if (t === undefined) {
      t = { bytes: 0, tokens: 0, costMicros: 0 };
      this.tallies.set(runId, t);
    }
    return t;
  }

  /** Durably persist the current tally map (no-op without a store). */
  private persist(): void {
    if (this.store === undefined) return;
    const snapshot: Record<string, PersistedTally> = {};
    for (const [runId, t] of this.tallies) snapshot[runId] = { bytes: t.bytes, tokens: t.tokens, costMicros: t.costMicros };
    this.store.save(snapshot);
  }

  /**
   * Atomically reserve the CONSERVATIVE projected draw. `projected` is the pre-call
   * UPPER BOUND: exact serialized request bytes, input+output token estimate, and a
   * retry-bounded worst-case cost. Runs synchronously (no await between the ceiling
   * check and the reservation), so a concurrent reserve for the same run cannot slip
   * between check and commit. Refuses BEFORE reserving when the projected cumulative
   * draw would exceed a ceiling — nothing is added on refusal.
   */
  reserve(
    claims: EgressCapabilityClaims,
    projected: { bytes: number; tokens: number; costMicros: number },
  ): BudgetVerdict {
    // With a persistent store the reservation is a CROSS-PROCESS transactional
    // read-modify-write (D19, finding #3): the ceiling is checked against the CURRENT
    // on-disk tally re-read inside an interprocess lock, so two concurrent daemons
    // sharing the state file cannot both reserve from a stale total and jointly
    // overrun a single ceiling. Without a store it is the in-memory fast path.
    if (this.store === undefined) return this.reserveInMemory(this.tally(claims.runId), claims, projected, () => this.persist());
    return this.store.transact<BudgetVerdict>((tallies) => {
      const cur = tallies[claims.runId] ?? { bytes: 0, tokens: 0, costMicros: 0 };
      const verdict = this.checkCeiling(cur, claims, projected);
      if (!verdict.ok) return { result: verdict, commit: null }; // refusal touches nothing
      const next = { bytes: cur.bytes + projected.bytes, tokens: cur.tokens + projected.tokens, costMicros: cur.costMicros + projected.costMicros };
      tallies[claims.runId] = next;
      this.tallies.set(claims.runId, { ...next }); // keep the in-memory view coherent
      return { result: verdict, commit: tallies };
    });
  }

  /** The ceiling check (no mutation) shared by the in-memory and transactional paths. */
  private checkCeiling(
    cur: { bytes: number; tokens: number; costMicros: number },
    claims: EgressCapabilityClaims,
    projected: { bytes: number; tokens: number; costMicros: number },
  ): BudgetVerdict {
    if (cur.bytes + projected.bytes > claims.maxBytes) {
      return { ok: false, code: "egress.byte_budget_exceeded", reason: `run ${claims.runId}: ${cur.bytes}+${projected.bytes} bytes exceeds maxBytes ${claims.maxBytes}` };
    }
    if (cur.tokens + projected.tokens > claims.maxTokens) {
      return { ok: false, code: "egress.token_budget_exceeded", reason: `run ${claims.runId}: ${cur.tokens}+${projected.tokens} tokens exceeds maxTokens ${claims.maxTokens}` };
    }
    if (cur.costMicros + projected.costMicros > claims.costCeiling) {
      return { ok: false, code: "egress.cost_budget_exceeded", reason: `run ${claims.runId}: ${cur.costMicros}+${projected.costMicros} micros exceeds costCeiling ${claims.costCeiling}` };
    }
    return { ok: true, reservation: { runId: claims.runId, bytes: projected.bytes, tokens: projected.tokens, costMicros: projected.costMicros } };
  }

  private reserveInMemory(
    t: RunTally,
    claims: EgressCapabilityClaims,
    projected: { bytes: number; tokens: number; costMicros: number },
    persist: () => void,
  ): BudgetVerdict {
    const verdict = this.checkCeiling(t, claims, projected);
    if (!verdict.ok) return verdict;
    t.bytes += projected.bytes;
    t.tokens += projected.tokens;
    t.costMicros += projected.costMicros;
    persist();
    return verdict;
  }

  /**
   * Swap a held reservation for the ACTUAL usage of a dispatched call. The net
   * effect leaves the tally at `previous - projected + actual`. Actual bytes are
   * always the exact serialized request bytes (unchanged from the reservation);
   * tokens/cost drop from the worst-case projection to what the provider reported
   * (0 on a provider error that returned no usage — but the bytes still stand).
   */
  reconcile(
    reservation: BudgetReservation,
    actual: { bytes: number; tokens: number; costMicros: number },
  ): void {
    this.mutate(reservation.runId, (t) => {
      t.bytes += actual.bytes - reservation.bytes;
      t.tokens += actual.tokens - reservation.tokens;
      t.costMicros += actual.costMicros - reservation.costMicros;
    });
  }

  /** Roll a reservation back entirely — for a call that never dispatched. */
  release(reservation: BudgetReservation): void {
    this.mutate(reservation.runId, (t) => {
      t.bytes -= reservation.bytes;
      t.tokens -= reservation.tokens;
      t.costMicros -= reservation.costMicros;
    });
  }

  /**
   * Apply a delta to a run's tally, transactionally across processes when a store is
   * present (reconcile/release also swap the SHARED on-disk total, not a stale
   * in-memory copy — so a concurrent daemon's next reserve sees the true remaining
   * budget). The in-memory view is kept coherent for `snapshot`.
   */
  private mutate(runId: string, apply: (t: RunTally) => void): void {
    if (this.store === undefined) {
      const t = this.tally(runId);
      apply(t);
      this.clampNonNegative(t);
      this.persist();
      return;
    }
    this.store.transact((tallies) => {
      const t: RunTally = { ...(tallies[runId] ?? { bytes: 0, tokens: 0, costMicros: 0 }) };
      apply(t);
      this.clampNonNegative(t);
      tallies[runId] = t;
      this.tallies.set(runId, { ...t });
      return { result: undefined, commit: tallies };
    });
  }

  private clampNonNegative(t: RunTally): void {
    if (t.bytes < 0) t.bytes = 0;
    if (t.tokens < 0) t.tokens = 0;
    if (t.costMicros < 0) t.costMicros = 0;
  }

  /** Read-only view of a run's cumulative usage (diagnostics/tests). */
  snapshot(runId: string): Readonly<RunTally> {
    return { ...this.tally(runId) };
  }
}
