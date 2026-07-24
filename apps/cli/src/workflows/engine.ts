/**
 * `workflows/engine` — the persisted run lifecycle engine (Task 2.5), the durable
 * driver behind capture (Phase 2) and synthesis (Phase 4). It turns the recovery
 * state machine (`docs/specs/recovery-state-machine.md`) into a small imperative
 * API — `startRun` → `RunHandle.checkpoint`/`fail`/`cancel` — where every transition
 * is exactly ONE atomic write (§2.5 crash-safety invariant).
 *
 * v2 (#338): the §2.8 audit-ledger write protocol + AEAD backup are RETIRED. There
 * is no `run.*` audit event, no `finalizeLedgerWrite`, no durable `audit_intents`,
 * and no backup gate — git (one commit per ChangePlan on `refs/heads/main`) is the
 * only safety mechanism, and `agent_runs` (+ its gating rows) is a plain operational
 * table.
 *
 * ## Atomic write per transition
 * - **Every progression checkpoint** (`planned`, `patched`, `worktree-applied`,
 *   `agent-committed`, `reindexed`): one plain `db.transaction` CAS-asserts the prior
 *   `agent_runs.status`, validates the gating evidence, upserts `agent_runs` + the
 *   gating-artifact rows, and re-asserts the row advanced — a single commit.
 * - **Terminals** (`failed`/`cancelled`): the same plain-transaction CAS on
 *   `agent_runs`.
 * - **`integrated`**: the caller fast-forwards the canonical ref (a plain git FF-CAS)
 *   and hands the result to {@link RunHandle.integrate}, which records
 *   `agent_runs='integrated'` + the `git_operations` integrate row
 *   ({@link recordIntegration}). Crash recovery re-drives non-terminal runs purely
 *   from `agent_runs.status` (the reconciler's run-sweep).
 *
 * ## AbortSignal plumbing
 * Cancellation is cooperative (§ recovery "Cancellation vs. failure"): a run
 * carries an `AbortSignal`; each `checkpoint` throws {@link RunAbortedError}
 * BEFORE it writes if the signal is aborted, so the driver unwinds to
 * `cancel(at)` from the last durable checkpoint (nothing irreversible past it).
 */
import {
  applyLedgerWrite,
  type LedgerStatement,
  type Store,
} from "@atlas/sqlite-store";
import type { Repo } from "@atlas/git";
import { newRunId, type WorkflowState } from "@atlas/contracts";
import { CliError, EXIT } from "../errors/envelope.js";
import {
  agentRunUpsert,
  assertCheckpointTransition,
  assertGatingEvidence,
  assertPersistedState,
  assertPatchPersisted,
  assertResumeArtifactsMatch,
  assertRowAdvancedTo,
  canTerminateFrom,
  changePlanInsert,
  gitOpId,
  gitOpUpsert,
  isCheckpoint,
  patchInsert,
  readAgentRunStatus,
  readGitOp,
  GatingEvidenceError,
  IllegalTransitionError,
  type AgentCommittedArtifacts,
  type IntegratedArtifacts,
  type PatchedArtifacts,
  type PlannedArtifacts,
  type ReindexedArtifacts,
  type WorktreeAppliedArtifacts,
} from "./checkpoints.js";
import {
  beginIdempotent,
  completeIdempotent,
  completeIdempotentStatement,
  type IdempotencyRequest,
  type IdempotencyOutcome,
} from "./idempotency.js";

/** RFC-3339 UTC millisecond timestamp (matches `@atlas/contracts` `Rfc3339Ms`). */
function rfc3339Ms(): string {
  return new Date().toISOString();
}

/** The all-zero placeholder commit for a run with no canonical move yet observed. */
const NO_CANONICAL_COMMIT = "0".repeat(40);

/**
 * The persisted `agent_runs.status` values a transition INTO each checkpoint may
 * legally overwrite (§ recovery `nextStates`, read as prior-states). Each list
 * includes the checkpoint's OWN state so an idempotent crash re-drive of the same
 * checkpoint is a no-op rather than a CAS failure; `null` means "no row yet".
 * Consumed by {@link RunHandle.checkpoint}'s persisted-state CAS (round-2 finding).
 */
const EXPECTED_PRIOR: Record<Exclude<WorkflowState, "integrated">, readonly (WorkflowState | null)[]> = {
  planned: [null, "planned"],
  patched: ["planned", "patched"],
  "worktree-applied": ["patched", "worktree-applied"],
  "agent-committed": ["worktree-applied", "agent-committed"],
  reindexed: ["integrated", "reindexed"],
  // Terminals are governed by terminate(); listed for completeness. v2 (#335):
  // the `review-pending` park + the `rejected` terminal reachable only from it
  // are retired — a run advances agent-committed → integrated directly.
  finalized: ["reindexed", "finalized"],
  rejected: [],
  "rolled-back": ["integrated", "reindexed", "finalized"],
  failed: ["planned", "patched", "worktree-applied", "agent-committed"],
  cancelled: ["planned", "patched", "worktree-applied", "agent-committed"],
} as Record<Exclude<WorkflowState, "integrated">, readonly (WorkflowState | null)[]>;

/** Everything the engine needs to persist a run. v2 (#338): no broker, no audit
 * ledger, no AEAD backup — a run's state machine is plain `agent_runs` + gating
 * rows, and git (one commit per ChangePlan on `refs/heads/main`) is the only safety
 * mechanism. */
export interface WorkflowDeps {
  readonly store: Store;
  /**
   * The git plumbing client — used for best-effort worktree cleanup on
   * `fail`/`cancel` (§ recovery "Worktree cleanup"). Optional: without it,
   * cleanup is deferred to {@link reconcileRunsOnStartup}'s orphan sweep.
   */
  readonly repo?: Repo;
  /** Injectable clock (RFC-3339 ms). */
  readonly now?: () => string;
}

/** The kind of run — recorded in `agent_runs.operation` (ingest|enrich|reconcile|maintain|…). */
export type RunKind = string;

/** The facts a run starts with. */
export interface RunInput {
  /** `agent_runs.operation`. */
  readonly operation: RunKind;
  /** Override the run ULID (e.g. an idempotent re-drive). Defaults to a fresh one. */
  readonly runId?: string;
  /** The historical target note id (scalar; no FK). */
  readonly targetNoteId?: string | null;
  /** Cooperative-cancellation signal (§ recovery). */
  readonly signal?: AbortSignal;
  /** The canonical commit the run's opening state references (default zero). */
  readonly canonicalCommit?: string;
  /**
   * Explicit opt-in to re-drive an EXISTING run id (default `false`). A fresh
   * `startRun` on an id that already has an `agent_runs` row is rejected unless
   * this is set (round-2 finding: no accidental second run under a live id).
   */
  readonly resume?: boolean;
}

/** The terminal outcome of a `fail`/`cancel`. */
export interface TerminalRun {
  readonly runId: string;
  /** The `agent_runs.status` written (`failed` | `cancelled`). */
  readonly state: "failed" | "cancelled" | "rejected";
  /** The checkpoint the run terminated FROM (`failed@<checkpoint>` suffix). */
  readonly from: WorkflowState;
  readonly reason?: string;
}

/**
 * Extra rows + audit detail folded into a run's SINGLE terminal event/transaction
 * (D6). A model-transmitting run that terminates passes its `model_calls` INSERTs as
 * {@link TerminalExtras.ledgerWrite} and the allowlisted per-call audit records as
 * `detail.modelCalls`, so the N transmissions attach to the run's one `run.*`
 * terminal — never a per-call `run.*` event and never a second `finalizeLedgerWrite`.
 * The statements MUST be idempotent (they are replayed with the terminal on crash
 * recovery); the terminal-specific detail fields (`failedAt`/`cancelledAt`/`reason`)
 * always win over a same-named `detail` key.
 */
export interface TerminalExtras {
  /** Idempotent business rows committed atomically with the terminal. */
  readonly ledgerWrite?: readonly LedgerStatement[];
}

/** The canonical-ref-advance context handed to a {@link RunIntegrator}. */
export interface IntegrationContext {
  readonly runId: string;
  /** The agent-branch commit to install into canonical (from `agent-committed`). */
  readonly commitSha: string;
  /** The canonical ref being advanced (recorded at `planned`). */
  readonly canonicalRef: string;
  /** The canonical base the run branched from (the ff old-value). */
  readonly baseRef: string;
}

/** What the caller's ref-advance returns for a canonical install. v2 (#338): the
 * FF-CAS git commit only — no audit `seq`, no `refs/audit/runs` head. */
export interface BrokerIntegration {
  readonly canonicalRef: string;
  /** The commit now installed at the canonical ref head. */
  readonly canonicalSha: string;
}

/**
 * The ref-advance step the caller (capture/synthesis) performs for the
 * `integrated` checkpoint: fast-forward the canonical ref to the agent commit
 * under CAS and return the observed result. v2 (#338): a plain git FF-CAS — no
 * audit append, no attestation key.
 */
export type RunIntegrator = (ctx: IntegrationContext) => Promise<BrokerIntegration>;

/** Options for {@link RunHandle.integrate}. */
export interface IntegrateOptions {
  /**
   * Extra op-specific keys a producer wants to associate with the integration.
   * v2 (#338): there is no durable `run.integrated` event to carry them (the audit
   * ledger is retired), so this is accepted-but-inert — kept for signature
   * compatibility with producers that still pass a finalization-intent payload.
   */
  readonly extraDetail?: Readonly<Record<string, unknown>>;
}

/**
 * Extra effects folded into {@link RunHandle.finalize}'s single terminal
 * transaction. The 60-B sync cycle finalizes its `sync_cursors` advance, the
 * reconciled pending-quarantine set, and the single `index:reconcile` enqueue
 * atomically with the run's `finalized` terminal — all-or-nothing with the
 * cursor, exactly the §2.8 step-3 shape.
 */
export interface FinalizeExtras {
  /** Idempotent statements applied with the terminal (same contract as {@link TerminalExtras.ledgerWrite}). */
  readonly ledgerWrite?: readonly LedgerStatement[];
  /** Imperative writes on the SAME connection inside the terminal transaction (e.g. a jobs `enqueue`). */
  readonly extraCommit?: (db: Store["db"]) => void;
  /**
   * Explicit opt-in for the EMPTY-ChangePlan success terminal: finalize straight
   * from `planned` (60-B all-quarantined sync cycle — every changed path was
   * quarantined-and-recorded, so there is no integrate, no canonical move, and
   * no `reindexed`). The run is a successfully finalized run with an empty plan,
   * not a failure. Without this flag the `reindexed`-only CAS is unchanged.
   */
  readonly fromEmptyPlan?: boolean;
}

/** The result of a completed {@link RunHandle.integrate}. */
export interface IntegratedResult {
  readonly canonicalRef: string;
  readonly canonicalSha: string;
}

/** Raised when a `checkpoint` is attempted on an aborted run (cooperative cancel). */
export class RunAbortedError extends Error {
  constructor(readonly runId: string, readonly at: WorkflowState | null) {
    super(`run ${runId} was aborted at ${at ?? "<start>"}; unwind to cancel(${at ?? "planned"})`);
    this.name = "RunAbortedError";
  }
}

/**
 * A live run handle. Not thread-safe: a single driver advances one run
 * sequentially. `state` reflects the last durably-committed checkpoint.
 */
export class RunHandle {
  #state: WorkflowState | null = null;

  constructor(
    private readonly deps: WorkflowDeps,
    readonly runId: string,
    readonly operation: RunKind,
    private readonly input: RunInput,
  ) {}

  /** The last durably-committed workflow state (`null` before `planned`). */
  get state(): WorkflowState | null {
    return this.#state;
  }

  /**
   * Hydrate `#state` from the DURABLE `agent_runs.status` (round finding #7). Called
   * by {@link startRun} on `resume:true` so a resumed handle reflects the run's real
   * position — not `null` — which is what lets a run resume from BEYOND `planned`
   * (a `null` handle could only legally drive `planned`). Returns the loaded state.
   */
  hydrateFromDurable(): WorkflowState | null {
    this.#state = readAgentRunStatus(this.deps.store.db, this.runId);
    return this.#state;
  }

  /** The run's cooperative-cancellation signal, if any. */
  get signal(): AbortSignal | undefined {
    return this.input.signal;
  }

  private now(): string {
    return (this.deps.now ?? rfc3339Ms)();
  }

  private throwIfAborted(next: WorkflowState): void {
    if (this.input.signal?.aborted) throw new RunAbortedError(this.runId, this.#state);
    void next;
  }

  /**
   * Advance to a progression checkpoint, persisting its gating artifacts in one
   * atomic write. Throws {@link IllegalTransitionError} on an illegal edge and
   * {@link RunAbortedError} if the run's signal is aborted.
   *
   * v2 (#338): no checkpoint emits an audit event — every transition is one plain
   * `agent_runs` + gating-rows transaction. `integrated` is NOT driven here — it
   * rides {@link RunHandle.integrate} (the canonical FF-CAS the caller performs).
   * Passing `"integrated"` throws (use `integrate`).
   */
  async checkpoint(
    state: "planned",
    artifacts: PlannedArtifacts,
  ): Promise<void>;
  async checkpoint(state: "patched", artifacts: PatchedArtifacts): Promise<void>;
  async checkpoint(state: "worktree-applied", artifacts: WorktreeAppliedArtifacts): Promise<void>;
  async checkpoint(state: "agent-committed", artifacts: AgentCommittedArtifacts): Promise<void>;
  async checkpoint(state: "reindexed", artifacts: ReindexedArtifacts): Promise<void>;
  async checkpoint(state: WorkflowState, artifacts: unknown): Promise<void> {
    if (state === "integrated") {
      throw new IllegalTransitionError(this.#state, state, "use integrate() for the canonical-installing integrated checkpoint");
    }
    this.throwIfAborted(state);
    // Same-checkpoint replay is immutable (round finding #7): re-driving the
    // checkpoint the run is ALREADY durably at is a no-op — it never re-emits the
    // audit event, increments `checkpoint_seq`, or overwrites gating evidence. This
    // makes a RESUMED run's replay of its last durable checkpoint safe, and must
    // precede the transition-graph check (which would otherwise reject e.g.
    // planned→planned as an illegal self-edge).
    if (readAgentRunStatus(this.deps.store.db, this.runId) === state) {
      // Immutable, not blind (round-2 finding W3): validate the supplied artifacts
      // match the run's durable evidence before the no-op return, so a resumed replay
      // cannot smuggle divergent artifacts past the graph check.
      assertResumeArtifactsMatch(this.deps.store.db, this.runId, state, artifacts);
      this.#state = state;
      return;
    }
    assertCheckpointTransition(this.#state, state);

    const db = this.deps.store.db;
    const expected = EXPECTED_PRIOR[state];
    const now = this.now();
    // `planned` is an INSERT-from-null: pass the PRESENT-but-EMPTY false-conflict
    // guard (round-2 finding W1) so a concurrent duplicate `planned` can only ever
    // INSERT (never overwrite/bump an existing row via ON CONFLICT). Every other
    // checkpoint CASes to its exact prior non-null states.
    const casFrom: readonly WorkflowState[] =
      state === "planned" ? [] : expected.filter((s): s is WorkflowState => s !== null);
    const statements: LedgerStatement[] = [
      agentRunUpsert({
        runId: this.runId,
        operation: this.operation,
        status: state,
        tier: tierOf(state, artifacts),
        targetNoteId: this.input.targetNoteId ?? null,
        startedAt: now,
        now,
        // Guard the ON CONFLICT UPDATE branch on the persisted prior state (round-3
        // finding #2). `planned`'s INSERT-from-`null` has no conflict to hit, so the
        // guard only affects a `planned` RE-drive (row already at `planned`); every
        // other checkpoint's advance is CAS-gated to its exact prior state.
        expectedFrom: casFrom,
      }),
      ...gatingStatements(this.runId, state, artifacts, now),
    ];

    // One plain transaction (v2 #338: no audit event on any checkpoint) asserts the
    // persisted prior state (CAS) + gating evidence, applies the transition, THEN
    // re-asserts the row advanced (affected-row CAS) and the immutable patch
    // artifact — a stale or concurrent handle cannot regress an advanced/terminal
    // row, and a checkpoint never commits with disagreeing gating evidence
    // (round-2/round-3 findings).
    const commit = db.transaction(() => {
      assertPersistedState(db, this.runId, state, expected);
      assertGatingEvidence(db, this.runId, state, artifacts);
      applyLedgerWrite(db, statements);
      assertRowAdvancedTo(db, this.runId, state);
      if (state === "patched") assertPatchPersisted(db, artifacts as PatchedArtifacts);
    });
    commit();
    this.#state = state;
  }

  /**
   * Drive the `integrated` checkpoint. v2 (#338): the caller `perform`s a plain git
   * fast-forward of the canonical ref to the agent commit under CAS — no audit
   * append, no durable intent, no attestation key. This method then:
   *
   *   1. **FF-CAS the canonical ref.** `perform(ctx)` advances the canonical ref to
   *      the agent commit and returns `{canonicalRef, canonicalSha}`.
   *   2. **Validate + record.** Verify the returned ref/sha bind to the run's
   *      recorded `planned` ref + `agent-committed` sha, verify authoritative canonical
   *      containment (by ancestry), then one plain transaction sets
   *      `agent_runs='integrated'` (CAS from `agent-committed`) + records the
   *      `integrated` git op.
   *
   * A crash after the FF but before the SQLite record leaves canonical advanced with
   * no `integrated` row; {@link resolveIntegrationCrash} (and the startup reconciler's
   * run-sweep) re-derives `integrated` purely from authoritative canonical containment
   * — git is the sole source of truth. v2 (#335): every committed run integrates
   * directly — the Tier-3 review park is retired.
   */
  async integrate(perform: RunIntegrator, opts?: IntegrateOptions): Promise<IntegratedResult> {
    this.throwIfAborted("integrated");
    assertCheckpointTransition(this.#state, "integrated");
    const db = this.deps.store.db;
    void opts; // v2 (#338): extraDetail is accepted-but-inert (no durable event to carry it).

    const committed = readGitOp(db, this.runId, "agent-committed");
    const base = readGitOp(db, this.runId, "base");
    if (!committed?.commitSha) throw new GatingEvidenceError("integrated", "no agent-committed commit to integrate");
    if (!base) throw new GatingEvidenceError("integrated", "no recorded planned base");
    // Persisted-state CAS: only an agent-committed (or already-integrated re-drive) run integrates.
    assertPersistedState(db, this.runId, "integrated", ["agent-committed", "integrated"]);

    const now = this.now();
    const write = integrationLedgerWrite({
      runId: this.runId,
      operation: this.operation,
      targetNoteId: this.input.targetNoteId ?? null,
      canonicalRef: base.refName,
      commitSha: committed.commitSha,
      now,
    });

    // The caller fast-forwards the canonical ref to the agent commit under CAS
    // (v2 #338: a plain git FF, no audit append).
    let result: BrokerIntegration;
    try {
      result = await perform({
        runId: this.runId,
        commitSha: committed.commitSha,
        canonicalRef: base.refName,
        baseRef: base.commitSha ?? NO_CANONICAL_COMMIT,
      });
    } catch (err) {
      // AMBIGUOUS failure: `perform` may have advanced the canonical ref BEFORE
      // throwing (a lost response). Inspect the AUTHORITATIVE ref state — if canonical
      // now contains the agent commit, the FF landed and we complete the `integrated`
      // record forward; otherwise nothing installed and the run re-drives from
      // `agent-committed` (no durable intent to clean up — git is the only state).
      const resolved = await this.resolveIntegrationCrash(committed.commitSha, base.refName, write, now);
      if (resolved) {
        this.#state = "integrated";
        return resolved;
      }
      throw err;
    }

    // Validate the ref-advance result, then record `integrated`.
    // Require the returned ref to equal the ref recorded at `planned`, and the
    // returned sha to equal the agent commit from `agent-committed` — only then is
    // containment of THAT exact commit meaningful.
    if (result.canonicalRef !== base.refName) {
      throw new GatingEvidenceError("integrated", `canonicalRef ${result.canonicalRef} ≠ the run's recorded ref ${base.refName}`);
    }
    if (result.canonicalSha !== committed.commitSha) {
      throw new GatingEvidenceError("integrated", `canonicalSha ${result.canonicalSha} ≠ the agent commit ${committed.commitSha} (unchanged-base/foreign-commit install refused)`);
    }
    if (this.deps.repo) {
      // Authoritative containment (round-2 finding W4): the canonical ref must
      // CONTAIN the installed commit — tested by ancestry, not tip-EQUALITY, so a
      // commit that is a valid ancestor of a canonical tip advanced by a later run is
      // not falsely rejected. The commit tested is the agent commit itself (bound above).
      const canonicalNow = await this.deps.repo.readRef(base.refName);
      if (canonicalNow === null || !(await this.deps.repo.isAncestor(committed.commitSha, canonicalNow))) {
        throw new GatingEvidenceError("integrated", `canonical ref ${base.refName} (${canonicalNow ?? "<none>"}) does not contain the integrated ${committed.commitSha}`);
      }
    }
    finishIntegration(this.deps.store, {
      runId: this.runId,
      operation: this.operation,
      targetNoteId: this.input.targetNoteId ?? null,
      // Record the DURABLE ref + agent commit (not the performer-echoed values).
      canonicalRef: base.refName,
      canonicalSha: committed.commitSha,
      write,
      now,
    });
    this.#state = "integrated";
    return { canonicalRef: base.refName, canonicalSha: committed.commitSha };
  }

  /**
   * Classify an integration crash (a `perform` that threw) against the
   * AUTHORITATIVE canonical-ref state, and either complete integration forward or
   * leave the run for a re-drive. Returns the {@link IntegratedResult} when canonical
   * genuinely advanced to the agent commit (a durable git mutation), or `null` when
   * nothing installed (the run re-drives from `agent-committed`). With no repo,
   * containment is unprovable ⇒ `null` (the caller re-throws so the startup
   * reconciler, which always has a repo, resolves it).
   */
  private async resolveIntegrationCrash(
    commitSha: string,
    canonicalRef: string,
    write: readonly LedgerStatement[],
    now: string,
  ): Promise<IntegratedResult | null> {
    if (!this.deps.repo) return null; // cannot prove containment → re-throw for the reconciler
    const head = await this.deps.repo.readRef(canonicalRef);
    // Containment by ANCESTRY, not tip-equality (round-2 finding W4): canonical
    // genuinely installed the commit iff `commitSha` is an ancestor of (or equal to)
    // the current canonical head — a head advanced by a subsequent run still contains
    // it. Absent containment → the FF did not land → nothing installed, re-drive.
    if (head === null || !(await this.deps.repo.isAncestor(commitSha, head))) return null;
    finishIntegration(this.deps.store, {
      runId: this.runId,
      operation: this.operation,
      targetNoteId: this.input.targetNoteId ?? null,
      canonicalRef,
      canonicalSha: commitSha,
      write,
      now,
    });
    return { canonicalRef, canonicalSha: commitSha };
  }

  /**
   * Fail the run from its current checkpoint (`failed@<checkpoint>`, `run.failed`).
   * An optional `completion` — a {@link completeIdempotentStatement} from a
   * `beginIdempotentCommand` claim — is committed ATOMICALLY inside the terminal
   * transaction (round finding #4): the terminal state + the idempotency publish
   * land or roll back together, and a stale claim rolls the whole terminal back.
   *
   * `extras` folds a run's additional business rows + audit detail into the SAME
   * terminal transaction + SINGLE terminal event. A model-transmitting run that
   * FAILS uses this to record its `model_calls` rows (`extras.ledgerWrite`) and the
   * allowlisted per-call audit records (`extras.detail.modelCalls`) atomically with
   * `run.failed` — so the D6 "one `run.*` per run, N `model_calls` rows, no per-call
   * event" invariant holds without a second `finalizeLedgerWrite` (which would emit a
   * second audit event).
   */
  fail(at: WorkflowState, reason: string, completion?: LedgerStatement, extras?: TerminalExtras): Promise<TerminalRun> {
    return this.terminate("failed", at, reason, completion, extras);
  }

  /** Cancel the run cooperatively from its current checkpoint (`cancelled@<checkpoint>`). */
  cancel(at: WorkflowState, completion?: LedgerStatement, extras?: TerminalExtras): Promise<TerminalRun> {
    return this.terminate("cancelled", at, undefined, completion, extras);
  }

  /**
   * The atomic SUCCESS-terminal API (round-2 finding W2): advance `reindexed →
   * finalized` and, in the SAME transaction, publish the caller-idempotency slot to
   * `done` with the EXACT command result. It writes the terminal `agent_runs` state
   * + the optional `completion` {@link LedgerStatement} (a
   * {@link IdempotentStart.completeStatement}). Because the completion carries the
   * arbitrary result verbatim and lands ATOMICALLY with `finalized`, a retry replays
   * the ORIGINAL result — its shape is never reconstructed from run artifacts.
   *
   * v2 (#338): no §2.8 step-4 backup gate — the audit ledger + AEAD backup are
   * retired; git is the only safety mechanism, and the finalized state is durable
   * once the plain transaction commits.
   */
  async finalize(completion?: LedgerStatement, extras?: FinalizeExtras): Promise<{ runId: string; state: "finalized" }> {
    const db = this.deps.store.db;
    // CAS ONLY from `reindexed` (round-3 finding on engine.ts:635-667): an
    // `integrated → finalized` would SKIP the required `reindexed` checkpoint, so
    // `integrated` is NOT an accepted prior. `finalized` is listed only so an
    // already-finalized run is recognised as a true SINK (handled below) — never
    // re-written (which would bump `checkpoint_seq` and re-publish the completion).
    // `fromEmptyPlan` (explicit opt-in) additionally admits `planned`: the 60-B
    // all-quarantined sync cycle finalizes an EMPTY-ChangePlan run that never
    // integrates — no canonical move happened, so skipping `integrated`/`reindexed`
    // asserts nothing false; the stateTable records the planned→finalized edge.
    const from: WorkflowState[] = extras?.fromEmptyPlan ? ["planned", "reindexed", "finalized"] : ["reindexed", "finalized"];
    const cur = assertPersistedState(db, this.runId, "finalized", from);
    const now = this.now();

    if (cur === "finalized") {
      // True sink: do NOT re-write the terminal (no checkpoint_seq bump, no completion
      // re-publish). An idempotent repeat converges without mutating the row.
      this.#state = "finalized";
      return { runId: this.runId, state: "finalized" };
    }

    // Advance `reindexed → finalized` + publish the caller-idempotency result in ONE
    // plain transaction.
    const commit = db.transaction(() => {
      applyLedgerWrite(db, [
        agentRunUpsert({
          runId: this.runId,
          operation: this.operation,
          status: "finalized",
          targetNoteId: this.input.targetNoteId ?? null,
          startedAt: now,
          now,
          finishedAt: now,
          expectedFrom: extras?.fromEmptyPlan ? ["planned"] : ["reindexed"],
          assertAdvanced: true,
        }),
        // Atomic terminal-result publication for the SUCCESS terminal (round-2
        // finding W2): the exact result lands with `finalized` under the serialized
        // owner/hash/state CAS, or the whole finalize rolls back on a stale claim.
        ...(completion ? [completion] : []),
        // Producer effects that must be all-or-nothing with the terminal (60-B:
        // the sync cursor advance + reconciled pending set). Same idempotency
        // contract as TerminalExtras.ledgerWrite.
        ...(extras?.ledgerWrite ?? []),
      ]);
      // Imperative same-connection writes inside the SAME transaction (60-B: the
      // single index:reconcile enqueue, which needs the bound EnqueueContext).
      extras?.extraCommit?.(db);
      assertRowAdvancedTo(db, this.runId, "finalized");
    });
    commit();
    this.#state = "finalized";
    return { runId: this.runId, state: "finalized" };
  }

  private async terminate(
    status: "failed" | "cancelled",
    at: WorkflowState,
    reason?: string,
    completion?: LedgerStatement,
    extras?: TerminalExtras,
  ): Promise<TerminalRun> {
    // fail/cancel are only reachable from a terminable checkpoint, and only
    // from the run's CURRENT state (you terminate where you are). v2 (#335):
    // the `rejected` terminal (reachable only from the retired review-pending
    // park) is gone.
    if (this.#state !== null && this.#state !== at) {
      throw new IllegalTransitionError(this.#state, status, `cannot terminate at ${at} from ${this.#state}`);
    }
    if (!canTerminateFrom(at)) {
      throw new IllegalTransitionError(at, status, "past integration a run is not fail/cancel-reversible (forward recovery only)");
    }

    const now = this.now();
    const db = this.deps.store.db;
    // Persisted-state CAS for the terminal (round-3 finding #2). A terminal is only
    // reachable from the checkpoint it terminates FROM, so the durable state must be
    // exactly `at`; the guarded upsert's SERIALIZED affected-row assert
    // (assertAdvanced) makes the CAS atomic with the write, so a run that advanced
    // under another handle is never regressed. v2 (#338): one plain transaction, no
    // audit event.
    const commit = db.transaction(() => {
      assertPersistedState(db, this.runId, status, [at]);
      applyLedgerWrite(db, [
        agentRunUpsert({
          runId: this.runId,
          operation: this.operation,
          status,
          // The `agent_runs` CHECK pins `failed_checkpoint` non-null IFF status is
          // `failed`/`cancelled` — always the from-checkpoint here.
          failedCheckpoint: at,
          targetNoteId: this.input.targetNoteId ?? null,
          startedAt: now,
          now,
          finishedAt: now,
          expectedFrom: [at],
          assertAdvanced: true,
        }),
        // Atomic terminal-result publication (round finding #4): the idempotency
        // completion (with its serialized owner/hash/state CAS) commits inside the
        // SAME terminal transaction, so the terminal state + the publish land or roll
        // back together, and a stale claim rolls the whole terminal back.
        ...(completion ? [completion] : []),
        // Additional idempotent business rows (e.g. a model-transmitting run's
        // `model_calls`) committed atomically with the terminal.
        ...(extras?.ledgerWrite ?? []),
      ]);
      assertRowAdvancedTo(db, this.runId, status);
    });
    commit();

    // Worktree cleanup (§ recovery): a failed/cancelled run retains no worktree
    // (nothing durable was integrated). Best-effort with a lent repo; otherwise the
    // reconciler's orphan sweep collects it.
    await cleanupWorktree(this.deps, this.runId);

    this.#state = status;
    return { runId: this.runId, state: status, from: at, ...(reason !== undefined ? { reason } : {}) };
  }
}

/**
 * Begin a run and return a {@link RunHandle}. v2 (#338): the audit ledger is
 * retired, so `startRun` emits NO `run.started` event — a run's first durable
 * artifact is its `planned` `agent_runs` row.
 */
export async function startRun(deps: WorkflowDeps, input: RunInput): Promise<RunHandle> {
  const runId = input.runId ?? newRunId();
  const handle = new RunHandle(deps, runId, input.operation, input);

  if (input.resume === true) {
    // Resume an EXISTING run (round finding #7): HYDRATE the handle's `#state` from
    // the durable `agent_runs.status` so the run can resume from BEYOND `planned`
    // (a `null` handle could only drive `planned`). Same-checkpoint replay is then
    // made immutable by `checkpoint()` itself.
    const durable = handle.hydrateFromDurable();
    if (durable === null) {
      // No `agent_runs` row ⇒ the run never reached `planned`. v2 (#338): a run's
      // first durable artifact IS the `planned` row (no `run.started` audit event
      // precedes it), so there is nothing to resume — refuse it rather than silently
      // minting a phantom handle.
      throw new CliError({
        code: "run-not-resumable",
        message: `run ${runId} is unknown (no agent_runs row); nothing to resume`,
        hint: "Resume re-drives an interrupted run; start a fresh run (new id) instead.",
        exitCode: EXIT.VALIDATION,
      });
    }
    if (!isCheckpoint(durable)) {
      // A terminal (or finalized) run is a sink — there is nothing to resume.
      throw new CliError({
        code: "run-not-resumable",
        message: `run ${runId} is at terminal state ${durable}; a terminal run cannot be resumed`,
        hint: "Resume only re-drives an interrupted, non-terminal run; a finished run has no next step.",
        exitCode: EXIT.VALIDATION,
      });
    }
    // Compare the resumed input identity against the DURABLE run (round-3 finding on
    // engine.ts:758-793): a resume must re-drive the SAME run, so the supplied
    // `operation` must equal the durably-recorded one — a mismatch is a wrong-id /
    // tampered resume, not a legitimate re-drive.
    const durableRow = deps.store.db.prepare(`SELECT operation FROM agent_runs WHERE run_id = ?`).get(runId) as
      | { operation: string }
      | undefined;
    if (durableRow && durableRow.operation !== input.operation) {
      throw new CliError({
        code: "run-not-resumable",
        message: `run ${runId} resume operation "${input.operation}" ≠ durable operation "${durableRow.operation}"`,
        hint: "Resume re-drives the SAME run; the operation must match the durable run's operation.",
        exitCode: EXIT.VALIDATION,
      });
    }
    return handle;
  }

  // Fresh run: reject re-using an existing run id (round-2 finding) — a fresh
  // `startRun` on an id that already has an `agent_runs` row would race the existing
  // run's state. v2 (#338): a run's first durable artifact is its `planned`
  // `agent_runs` row (the audit `run.started` event is retired), so "already started"
  // is exactly "an `agent_runs` row exists".
  const existing = deps.store.db.prepare(`SELECT 1 FROM agent_runs WHERE run_id = ?`).get(runId);
  if (existing) {
    throw new CliError({
      code: "run-id-in-use",
      message: `run ${runId} already exists; pass resume:true to re-drive it`,
      hint: "A fresh run must use a new id; resuming an interrupted run is an explicit opt-in.",
      exitCode: EXIT.VALIDATION,
    });
  }
  return handle;
}

// ── caller-idempotency for key-accepting workflow commands ───────────────────

/** The outcome of {@link beginIdempotentCommand}: the replayed prior result or a fresh claim. */
export type IdempotentStart<R> =
  | { readonly kind: "replay"; readonly result: R }
  | {
      readonly kind: "fresh";
      /**
       * Build the completion as a {@link LedgerStatement} to commit INSIDE the run's
       * TERMINAL transaction (round-3 finding #6) — pass it in the terminal
       * `finalizeLedgerWrite`'s `ledgerWrite` so the terminal state + the published
       * result land or roll back together. A crash can then never leave a finalized
       * run with an `in-progress` key (or vice-versa).
       */
      readonly completeStatement: (result: R, at?: string) => LedgerStatement;
      /**
       * Convenience STANDALONE publish for a caller whose terminal write is not a
       * `finalizeLedgerWrite`. Prefer {@link completeStatement} inside the terminal
       * transaction; this is not atomic with the run's terminal state.
       */
      readonly complete: (result: R) => void;
    };

/**
 * The caller-idempotency layer (§ Task 2.5): persist the normalized request hash
 * + terminal result per `(command, --idempotency-key)`. An identical retry
 * returns the prior result; key reuse with DIFFERENT input is rejected; a
 * concurrent duplicate blocks on the persisted key.
 *
 * Usage: call before doing the work. `replay` ⇒ return `result` (do nothing).
 * `fresh` ⇒ do the work, then include `completeStatement(result)` in the run's
 * terminal `finalizeLedgerWrite` so the result is published ATOMICALLY with the
 * terminal state (round-3 finding #6).
 */
export function beginIdempotentCommand<R>(
  store: Store,
  req: IdempotencyRequest,
  now: () => string = rfc3339Ms,
): IdempotentStart<R> {
  const outcome: IdempotencyOutcome = beginIdempotent(store.db, req, now());
  if (outcome.kind === "replay") {
    return { kind: "replay", result: JSON.parse(outcome.resultJson) as R };
  }
  return {
    kind: "fresh",
    completeStatement: (result: R, at?: string) => completeIdempotentStatement(req, JSON.stringify(result ?? null), at ?? now()),
    complete: (result: R) => completeIdempotent(store.db, req, JSON.stringify(result ?? null), now()),
  };
}

// ── integration recording (the `integrated` git-op + agent_runs CAS) ─────────

/**
 * Record the `integrated` checkpoint. The caller (or the reconciler's integrate
 * hook) already fast-forwarded the canonical ref (→ `canonicalSha`); this writes the
 * CLI-side state in ONE plain transaction: `agent_runs='integrated'` (CAS-guarded)
 * + the `git_operations` integrate row. Idempotent — a re-drive after a crash writes
 * each row exactly once. v2 (#338): no audit event, no durable intent.
 */
export function recordIntegration(
  store: Store,
  args: {
    runId: string;
    operation: string;
    targetNoteId?: string | null;
    artifacts: IntegratedArtifacts;
    now: string;
  },
): void {
  finishIntegration(store, {
    runId: args.runId,
    operation: args.operation,
    targetNoteId: args.targetNoteId ?? null,
    canonicalRef: args.artifacts.canonicalRef,
    canonicalSha: args.artifacts.canonicalSha,
    write: integrationLedgerWrite({
      runId: args.runId,
      operation: args.operation,
      targetNoteId: args.targetNoteId ?? null,
      canonicalRef: args.artifacts.canonicalRef,
      commitSha: args.artifacts.canonicalSha,
      now: args.now,
    }),
    now: args.now,
  });
}

/**
 * The `LedgerStatement[]` for an `integrated` transition — the `agent_runs` advance
 * + the `git_operations` integrate row. `agent_runs` is CAS-guarded from
 * `agent-committed`/`integrated` so a stale handle cannot regress it.
 */
function integrationLedgerWrite(args: {
  runId: string;
  operation: string;
  targetNoteId: string | null;
  canonicalRef: string;
  commitSha: string;
  now: string;
}): LedgerStatement[] {
  return [
    agentRunUpsert({
      runId: args.runId,
      operation: args.operation,
      status: "integrated",
      targetNoteId: args.targetNoteId,
      startedAt: args.now,
      now: args.now,
      expectedFrom: ["agent-committed", "integrated"],
    }),
    gitOpUpsert({
      gitOpId: gitOpId(args.runId, "integrated"),
      runId: args.runId,
      opType: "integrated",
      refName: args.canonicalRef,
      commitSha: args.commitSha,
      now: args.now,
    }),
  ];
}

/**
 * Land the `integrated` state (idempotent) in ONE plain transaction: apply the
 * `agent_runs` advance + `git_operations` integrate row, then assert the row is now
 * `integrated` (affected-row CAS) so a stale handle cannot record `integrated`
 * against a run that regressed/terminated — the whole tx rolls back otherwise. Both
 * the live {@link RunHandle.integrate} and the reconciler funnel through here.
 */
function finishIntegration(
  store: Store,
  args: {
    runId: string;
    operation: string;
    targetNoteId: string | null;
    canonicalRef: string;
    canonicalSha: string;
    write: readonly LedgerStatement[];
    now: string;
  },
): void {
  const { runId } = args;
  const db = store.db;
  const tx = db.transaction(() => {
    applyLedgerWrite(db, [...args.write]);
    assertRowAdvancedTo(db, runId, "integrated");
  });
  tx();
}

// ── internal helpers ─────────────────────────────────────────────────────────

/** Build the gating-artifact `LedgerStatement[]` for a no-audit/planned checkpoint. */
function gatingStatements(
  runId: string,
  state: WorkflowState,
  artifacts: unknown,
  now: string,
): LedgerStatement[] {
  switch (state) {
    case "planned": {
      const a = artifacts as PlannedArtifacts;
      return [
        changePlanInsert(runId, a, now),
        gitOpUpsert({ gitOpId: gitOpId(runId, "base"), runId, opType: "base", refName: a.canonicalRef, commitSha: a.baseRef, now }),
      ];
    }
    case "patched":
      return [patchInsert(artifacts as PatchedArtifacts, now)];
    case "worktree-applied": {
      const a = artifacts as WorktreeAppliedArtifacts;
      return [gitOpUpsert({ gitOpId: gitOpId(runId, "worktree-applied"), runId, opType: "worktree-applied", refName: a.worktreePath, commitSha: a.treeHash, now })];
    }
    case "agent-committed": {
      const a = artifacts as AgentCommittedArtifacts;
      return [gitOpUpsert({ gitOpId: gitOpId(runId, "agent-committed"), runId, opType: "agent-committed", refName: a.agentRef, commitSha: a.commitSha, now })];
    }
    case "reindexed": {
      const a = artifacts as ReindexedArtifacts;
      return [gitOpUpsert({ gitOpId: gitOpId(runId, "reindexed"), runId, opType: "reindexed", refName: `index-generation:${a.indexGeneration}`, commitSha: a.canonicalSha, now })];
    }
    default:
      return [];
  }
}

/** Extract the tier a checkpoint carries (planned/agent-committed), else null. */
function tierOf(state: WorkflowState, artifacts: unknown): number | null {
  if (state === "planned") return (artifacts as PlannedArtifacts).tier;
  if (state === "agent-committed") return (artifacts as AgentCommittedArtifacts).tier;
  return null;
}

/** Best-effort worktree removal for a terminated run (lent repo only). */
async function cleanupWorktree(deps: WorkflowDeps, runId: string): Promise<void> {
  const repo = deps.repo;
  if (!repo) return;
  const row = deps.store.db
    .prepare(`SELECT ref_name FROM git_operations WHERE git_op_id = ?`)
    .get(gitOpId(runId, "worktree-applied")) as { ref_name: string } | undefined;
  if (!row) return;
  try {
    await repo.removeWorktree(row.ref_name);
  } catch {
    // Swallow: the worktree may already be gone; the reconciler's orphan sweep
    // is the durable backstop. Cleanup must never fail a recorded terminal.
  }
}

/** Re-exported so callers can classify a broker/ledger failure at the CLI boundary. */
export { CliError, EXIT };
