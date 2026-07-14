/**
 * `workflows/engine` — the persisted run lifecycle engine (Task 2.5), the durable
 * driver behind capture (Phase 2) and synthesis (Phase 4). It turns the recovery
 * state machine (`docs/specs/recovery-state-machine.md`) into a small imperative
 * API — `startRun` → `RunHandle.checkpoint`/`fail`/`cancel`/`reject` — where every
 * transition is exactly ONE atomic write (§2.5 crash-safety invariant) and every
 * audit-emitting transition funnels through `finalizeLedgerWrite` (§2.8).
 *
 * ## Atomic write per transition
 * - **No-audit checkpoints** (`patched`, `worktree-applied`, `agent-committed`,
 *   `review-pending`, `reindexed`): one `db.transaction` upserts `agent_runs` +
 *   the gating-artifact rows together — a single commit.
 * - **Audit checkpoints** (`planned` → `run.planned`; terminals `run.failed` /
 *   `run.cancelled` / `run.rejected`): `finalizeLedgerWrite`'s step-3 CAS commits
 *   the `agent_runs` change + gating rows + the `audit_events` row atomically. A
 *   crash between §2.8 steps 1–3 leaves a `pending` intent that
 *   `reconcileInterruptedRuns` (store-level) converges idempotently on
 *   `(runId, seq)` — replaying the SAME `ledgerWrite`, so the checkpoint lands.
 * - **`integrated`** (`run.integrated`, a canonical-INSTALLING kind the broker
 *   signing path refuses): the caller performs the broker ref-advance + audit
 *   append and hands the result to {@link RunHandle.integrate}, which records the
 *   step-3 CAS ({@link recordIntegration}).
 *
 * ## AbortSignal plumbing
 * Cancellation is cooperative (§ recovery "Cancellation vs. failure"): a run
 * carries an `AbortSignal`; each `checkpoint` throws {@link RunAbortedError}
 * BEFORE it writes if the signal is aborted, so the driver unwinds to
 * `cancel(at)` from the last durable checkpoint (nothing irreversible past it).
 */
import {
  finalizeLedgerWrite,
  applyLedgerWrite,
  runBackupStep,
  IntentsRepo,
  type AuditBroker,
  type AuditEventDraft,
  type LedgerBackupConfig,
  type LedgerStatement,
  type Store,
  type UnsignedAuditEvent,
} from "@atlas/sqlite-store";
import type { Repo } from "@atlas/git";
import { newRunId, type AuditEventKind, type AuditSubject, type WorkflowState } from "@atlas/contracts";
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
  readPlannedTier,
  GatingEvidenceError,
  IllegalTransitionError,
  CHECKPOINT_AUDIT,
  type AgentCommittedArtifacts,
  type IntegratedArtifacts,
  type PatchedArtifacts,
  type PlannedArtifacts,
  type ReindexedArtifacts,
  type ReviewPendingArtifacts,
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
  "review-pending": ["agent-committed", "review-pending"],
  reindexed: ["integrated", "reindexed"],
  // Terminals are governed by terminate()/reject(); listed for completeness.
  finalized: ["reindexed", "finalized"],
  rejected: ["review-pending"],
  "rolled-back": ["integrated", "reindexed", "finalized"],
  failed: ["planned", "patched", "worktree-applied", "agent-committed", "review-pending"],
  cancelled: ["planned", "patched", "worktree-applied", "agent-committed", "review-pending"],
} as Record<Exclude<WorkflowState, "integrated">, readonly (WorkflowState | null)[]>;

/** Everything the engine needs to persist + audit a run. */
export interface WorkflowDeps {
  readonly store: Store;
  /** The `finalizeLedgerWrite` broker seam (signs + appends non-installing events). */
  readonly broker: AuditBroker;
  /** AEAD ledger-backup config (§2.8 step 4). */
  readonly backup: LedgerBackupConfig;
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
  /** Audit subjects (opaque salted ids) attached to this run's events. */
  readonly subjects?: readonly AuditSubject[];
  /** The canonical commit the run's opening events reference (default zero). */
  readonly canonicalCommit?: string;
  /**
   * Explicit opt-in to re-drive an EXISTING run id (default `false`). A fresh
   * `startRun` on an id that already has an `agent_runs` row is rejected unless
   * this is set (round-2 finding: no accidental second run under a live id).
   */
  readonly resume?: boolean;
}

/** The terminal outcome of a `fail`/`cancel`/`reject`. */
export interface TerminalRun {
  readonly runId: string;
  /** The `agent_runs.status` written (`failed` | `cancelled` | `rejected`). */
  readonly state: "failed" | "cancelled" | "rejected";
  /** The checkpoint the run terminated FROM (`failed@<checkpoint>` suffix). */
  readonly from: WorkflowState;
  readonly reason?: string;
  /** The allocated audit `seq` for the terminal event. */
  readonly seq: number;
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
  /**
   * The allocated UNSIGNED `run.integrated` event (with its `seq`). The performer
   * signs it with the attestation key + `prevAuditHead`, then hands it to the
   * broker's protected-ref advance so the appended event is byte-consistent with
   * the durable intent (idempotent on `(runId, seq)`).
   */
  readonly event: UnsignedAuditEvent;
}

/** What the caller's broker ref-advance returns for a `run.integrated`. */
export interface BrokerIntegration {
  readonly canonicalRef: string;
  /** The commit now installed at the canonical ref head. */
  readonly canonicalSha: string;
  /** The audit `seq` the broker anchored the `run.integrated` event at. */
  readonly seq: number;
  /** `refs/audit/runs` head after the append. */
  readonly auditHead: string;
}

/**
 * The broker ref-advance step the caller (capture/synthesis, which hold the
 * authorization) performs for the `integrated` checkpoint. Given the allocated
 * unsigned `run.integrated` event, it advances the canonical ref + appends the
 * event and returns the observed result.
 */
export type RunIntegrator = (ctx: IntegrationContext) => Promise<BrokerIntegration>;

/** The result of a completed {@link RunHandle.integrate}. */
export interface IntegratedResult {
  readonly canonicalRef: string;
  readonly canonicalSha: string;
  readonly seq: number;
  readonly payloadHash: string;
  readonly auditHead: string;
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

  private baseEvent(kind: AuditEventKind, detail: Record<string, unknown>): AuditEventDraft {
    return {
      schemaVersion: 1,
      eventId: newRunId(),
      kind,
      occurredAt: this.now(),
      runId: this.runId,
      subjects: (this.input.subjects ?? []) as AuditSubject[],
      canonicalCommit: this.input.canonicalCommit ?? NO_CANONICAL_COMMIT,
      detail,
    };
  }

  /**
   * Advance to a progression checkpoint, persisting its gating artifacts in one
   * atomic write. Throws {@link IllegalTransitionError} on an illegal edge and
   * {@link RunAbortedError} if the run's signal is aborted.
   *
   * `integrated` is NOT driven here — it rides {@link RunHandle.integrate} (its
   * canonical-installing audit event is produced by the broker ref-advance the
   * caller performs). Passing `"integrated"` throws (use `integrate`).
   */
  async checkpoint(
    state: "planned",
    artifacts: PlannedArtifacts,
  ): Promise<void>;
  async checkpoint(state: "patched", artifacts: PatchedArtifacts): Promise<void>;
  async checkpoint(state: "worktree-applied", artifacts: WorktreeAppliedArtifacts): Promise<void>;
  async checkpoint(state: "agent-committed", artifacts: AgentCommittedArtifacts): Promise<void>;
  async checkpoint(state: "review-pending", artifacts: ReviewPendingArtifacts): Promise<void>;
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
    const auditKind = CHECKPOINT_AUDIT[state];
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
        // Serialize the affected-row CAS into write_json for the audit path so a
        // crash-recovery replay enforces it too (round finding #2) — the no-audit
        // path additionally asserts it live below.
        assertAdvanced: auditKind !== undefined,
      }),
      ...gatingStatements(this.runId, state, artifacts, now),
    ];

    if (auditKind) {
      // Audit checkpoint (`planned`). Pre-flight the persisted-state CAS + gating
      // BEFORE the broker append so a stale handle that lost the CAS never anchors
      // a `run.planned` event (the append is step 2, before the step-3 commit). The
      // step-3 CAS (affected-row) + the immutable change_plans ownership are now
      // SERIALIZED into `ledgerWrite` as statement asserts (round finding #2), so the
      // reconciler's crash-recovery replay of `write_json` enforces the SAME CAS the
      // live path did — the transition (agent_runs, gating rows, audit_events, intent
      // flip) commits or rolls back as one atomic write (§2.5; findings #2/#5), and a
      // replay can no longer complete the audit event against a non-advanced row.
      assertPersistedState(db, this.runId, state, expected);
      assertGatingEvidence(db, this.runId, state, artifacts);
      await finalizeLedgerWrite(this.deps.store, this.deps.broker, {
        runId: this.runId,
        event: this.baseEvent(auditKind, plannedDetail(state, artifacts)),
        ledgerWrite: statements,
        backup: this.deps.backup,
        now: this.now.bind(this),
      });
    } else {
      // No-audit checkpoint: one transaction asserts the persisted prior state
      // (CAS) + gating evidence, applies the transition, THEN re-asserts the row
      // advanced (affected-row CAS) and the immutable patch artifact — a stale or
      // concurrent handle cannot regress an advanced/terminal row, and a checkpoint
      // never commits with disagreeing gating evidence (round-2/round-3 findings).
      const commit = db.transaction(() => {
        assertPersistedState(db, this.runId, state, expected);
        assertGatingEvidence(db, this.runId, state, artifacts);
        applyLedgerWrite(db, statements);
        assertRowAdvancedTo(db, this.runId, state);
        if (state === "patched") assertPatchPersisted(db, artifacts as PatchedArtifacts);
      });
      commit();
    }
    this.#state = state;
  }

  /**
   * Drive the `integrated` checkpoint durably (§ recovery `integrated`, three
   * distinct effects). `run.integrated` is a canonical-INSTALLING kind the generic
   * signing path REFUSES (it asserts a canonical ref move only the broker's
   * protected-ref path may attest), so integration cannot ride `finalizeLedgerWrite`
   * — the caller performs the broker ref-advance + append via `perform`, holding
   * the authorization. This method makes that seam crash-safe (round-2 finding):
   *
   *   1. **Durable intent (§2.8 step 1) — BEFORE the ref move.** Allocate the
   *      `run.integrated` audit `seq` + persist the `pending` `audit_intents` row
   *      (its `event_json` + the step-3 `write_json`). Now the `canonicalSha`/`seq`
   *      evidence and the replayable step-3 exist durably before anything installs.
   *   2. **Broker advance + append (§2.8 step 2).** `perform(ctx)` signs the
   *      allocated event, advances the canonical ref, and appends `run.integrated`
   *      — returning `{canonicalRef, canonicalSha, seq, auditHead}`.
   *   3. **Validate + step-3 CAS.** Verify the returned `seq` equals the allocated
   *      one, the canonical ref now CONTAINS `canonicalSha` (containment evidence),
   *      and the payload hash is consistent; then one transaction sets
   *      `agent_runs='integrated'` (CAS from `agent-committed`), records the
   *      `integrated` git op, inserts the `audit_events` row, and flips the intent
   *      to `done`.
   *
   * A crash after step 2 but before step 3 leaves a `pending` intent whose event is
   * ALREADY anchored — `reconcileInterruptedRuns` replays step 3 idempotently
   * (the broker replays the anchored `(runId,seq)` before its kind gate). A crash
   * between steps 1 and 2 leaves an un-anchored `pending` `run.integrated` intent,
   * which the startup reconciler's pre-pass drops so the run re-drives from
   * `agent-committed` (§ recovery case (a)). Tier-3 runs must reach `integrated`
   * only through `review-pending` — a direct `agent-committed → integrated` on a
   * Tier-3 run is refused here.
   */
  async integrate(perform: RunIntegrator): Promise<IntegratedResult> {
    this.throwIfAborted("integrated");
    assertCheckpointTransition(this.#state, "integrated");
    const db = this.deps.store.db;

    const committed = readGitOp(db, this.runId, "agent-committed");
    const base = readGitOp(db, this.runId, "base");
    if (!committed?.commitSha) throw new GatingEvidenceError("integrated", "no agent-committed commit to integrate");
    if (!base) throw new GatingEvidenceError("integrated", "no recorded planned base");
    const tier = readPlannedTier(db, this.runId);
    if (tier === 3 && this.#state === "agent-committed") {
      throw new IllegalTransitionError("agent-committed", "integrated", "Tier-3 must be approved via review-pending before integration");
    }
    // Persisted-state CAS: only an agent-committed (or already-integrated re-drive) run integrates.
    assertPersistedState(db, this.runId, "integrated", ["agent-committed", "review-pending", "integrated"]);

    const now = this.now();
    // `run.integrated` asserts "canonical now points at this commit" — its
    // `canonicalCommit` MUST be the installed commit (the broker binds the event to
    // the exact commit being installed), not the run's opening canonicalCommit.
    const draft: AuditEventDraft = {
      ...this.baseEvent("run.integrated", { baseRef: base.commitSha ?? NO_CANONICAL_COMMIT }),
      canonicalCommit: committed.commitSha,
    };
    const write = integrationLedgerWrite({
      runId: this.runId,
      operation: this.operation,
      targetNoteId: this.input.targetNoteId ?? null,
      canonicalRef: base.refName,
      commitSha: committed.commitSha,
      now,
    });

    // Step 1: durable pending intent (seq + payloadHash + replayable step-3).
    const allocated = new IntentsRepo(db).allocate(this.runId, draft, write, now);

    // Step 2: the caller advances the canonical ref + appends run.integrated.
    let result: BrokerIntegration;
    try {
      result = await perform({
        runId: this.runId,
        commitSha: committed.commitSha,
        canonicalRef: base.refName,
        baseRef: base.commitSha ?? NO_CANONICAL_COMMIT,
        event: allocated.event,
      });
    } catch (err) {
      // AMBIGUOUS failure (round-3 finding #1): `perform` may have appended the
      // audit event and/or advanced the canonical ref BEFORE throwing (a lost
      // response). Unconditionally dropping the intent here could orphan a durable
      // canonical mutation or an anchored event with no SQLite evidence. Inspect
      // the AUTHORITATIVE broker + ref state to classify the crash: if the event is
      // anchored (⇒ its append, which precedes the canonical CAS, completed) or the
      // canonical ref advanced, complete the §2.8 step-3 CAS forward; only when
      // nothing installed (definitively un-anchored + canonical unmoved) is the
      // intent dropped for a clean re-drive.
      const resolved = await this.resolveIntegrationCrash(allocated, committed.commitSha, base.refName, now);
      if (resolved) {
        this.#state = "integrated";
        return resolved;
      }
      throw err;
    }

    // Step 3: validate the broker result, then the atomic §2.8 step-3 CAS.
    if (result.seq !== allocated.seq) {
      throw new GatingEvidenceError("integrated", `broker seq ${result.seq} ≠ allocated ${allocated.seq}`);
    }
    // Bind the result to the run's DURABLE integration intent (round-3 finding on
    // engine.ts:483-500). A performer that returns the UNCHANGED base sha, or a
    // DIFFERENT canonical ref, could otherwise pass a bare ancestry test (the base is
    // an ancestor of any canonical tip; another ref may legitimately contain some
    // commit) and falsely finalize an integration that never installed THIS run's
    // commit. Require the returned ref to equal the ref recorded at `planned`, and the
    // returned sha to equal the agent commit from `agent-committed` — only then is
    // containment of THAT exact commit meaningful.
    if (result.canonicalRef !== base.refName) {
      throw new GatingEvidenceError("integrated", `broker canonicalRef ${result.canonicalRef} ≠ the run's recorded ref ${base.refName}`);
    }
    if (result.canonicalSha !== committed.commitSha) {
      throw new GatingEvidenceError("integrated", `broker canonicalSha ${result.canonicalSha} ≠ the agent commit ${committed.commitSha} (unchanged-base/foreign-commit install refused)`);
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
      seq: allocated.seq,
      payloadHash: allocated.payloadHash,
      // Record the DURABLE ref + agent commit (not the performer-echoed values).
      canonicalRef: base.refName,
      canonicalSha: committed.commitSha,
      auditHead: result.auditHead,
      write,
      now,
    });
    this.#state = "integrated";
    return { canonicalRef: base.refName, canonicalSha: committed.commitSha, seq: allocated.seq, payloadHash: allocated.payloadHash, auditHead: result.auditHead };
  }

  /**
   * Classify an integration crash (a `perform` that threw) against the
   * AUTHORITATIVE broker + canonical-ref state, and either complete integration
   * forward or drop the un-anchored intent (round-3 finding #1). Returns the
   * {@link IntegratedResult} when the run must roll forward (event anchored ⇒ the
   * append completed; or canonical advanced ⇒ durable mutation), or `null` when
   * nothing installed (the intent is dropped so the run re-drives). NEVER drops on
   * a transient/unknown broker error — that error is re-thrown with the intent
   * PRESERVED so the startup reconciler resolves it.
   */
  private async resolveIntegrationCrash(
    allocated: { seq: number; payloadHash: string; event: UnsignedAuditEvent },
    commitSha: string,
    canonicalRef: string,
    now: string,
  ): Promise<IntegratedResult | null> {
    const db = this.deps.store.db;
    // Probe the broker: an ALREADY-ANCHORED run.integrated event replays
    // idempotently (returns {seq, head}); an UN-anchored one is refused
    // `broker.audit_kind_not_signable` (canonical-installing kinds are only
    // producible by the protected-ref path). Any OTHER error is transient/unknown
    // — we cannot prove the event un-anchored, so PRESERVE the intent and surface
    // the failure (never drop).
    let anchored: { seq: number; head: string } | null;
    try {
      anchored = await this.deps.broker.signAndAppendAuditEvent(allocated.event);
    } catch (probeErr) {
      if (!isAuditKindNotSignable(probeErr)) throw probeErr; // transient → preserve intent
      anchored = null; // definitively un-anchored
    }

    if (anchored) {
      // Anchored ⇒ the broker's append (which PRECEDES its canonical CAS, see
      // packages/broker/src/refs.ts) completed. But an anchored event is NOT proof
      // the canonical CAS succeeded: the append/CAS split means the event can be on
      // `refs/audit/runs` while canonical stayed put (a CAS failure / lost response
      // mid-advance). Recording `integrated` with a fabricated `canonicalSha =
      // commitSha` here would claim an install that never happened (round finding
      // #1). Require AUTHORITATIVE canonical containment before recording: only when
      // the canonical ref genuinely resolves to the agent commit do we complete the
      // §2.8 step-3 CAS forward. Otherwise PRESERVE the pending intent (return null →
      // integrate() re-throws) so the startup reconciler resolves it once the
      // authoritative ref/broker state is observable — never fabricate the sha.
      if (!this.deps.repo) return null; // cannot prove containment → preserve + re-throw
      const head = await this.deps.repo.readRef(canonicalRef);
      // Authoritative containment by ANCESTRY, not tip-equality (round-2 finding W4):
      // canonical genuinely installed the commit iff `commitSha` is an ancestor of
      // (or equal to) the current canonical head — a head advanced by a subsequent
      // run still contains it. Absent containment → append succeeded but canonical
      // did not install → preserve the pending intent (return null → integrate()
      // re-throws) for the startup reconciler; never fabricate the sha.
      if (head === null || !(await this.deps.repo.isAncestor(commitSha, head))) return null;
      const canonicalSha = commitSha;
      const write = integrationLedgerWrite({
        runId: this.runId,
        operation: this.operation,
        targetNoteId: this.input.targetNoteId ?? null,
        canonicalRef,
        commitSha,
        now,
      });
      finishIntegration(this.deps.store, {
        runId: this.runId,
        operation: this.operation,
        targetNoteId: this.input.targetNoteId ?? null,
        seq: allocated.seq,
        payloadHash: allocated.payloadHash,
        canonicalRef,
        canonicalSha,
        auditHead: anchored.head,
        write,
        now,
      });
      return { canonicalRef, canonicalSha, seq: allocated.seq, payloadHash: allocated.payloadHash, auditHead: anchored.head };
    }

    // Un-anchored: the broker appends BEFORE its canonical CAS, so an un-anchored
    // event guarantees the canonical ref did not advance — nothing installed. Drop
    // the abandoned intent so the run re-drives integration from agent-committed
    // with a fresh seq (the seq was never anchored, so the chain stays gapless).
    dropPendingIntent(db, this.runId, allocated.seq);
    return null;
  }

  /**
   * Fail the run from its current checkpoint (`failed@<checkpoint>`, `run.failed`).
   * An optional `completion` — a {@link completeIdempotentStatement} from a
   * `beginIdempotentCommand` claim — is committed ATOMICALLY inside the terminal
   * transaction (round finding #4): the terminal state + the idempotency publish
   * land or roll back together, and a stale claim rolls the whole terminal back.
   */
  fail(at: WorkflowState, reason: string, completion?: LedgerStatement): Promise<TerminalRun> {
    return this.terminate("failed", "run.failed", at, reason, completion);
  }

  /** Cancel the run cooperatively from its current checkpoint (`cancelled@<checkpoint>`). */
  cancel(at: WorkflowState, completion?: LedgerStatement): Promise<TerminalRun> {
    return this.terminate("cancelled", "run.cancelled", at, undefined, completion);
  }

  /** Reject a `review-pending` run at review (`rejected`, `run.rejected`). */
  async reject(reason: string, completion?: LedgerStatement): Promise<TerminalRun> {
    if (this.#state !== "review-pending") {
      throw new IllegalTransitionError(this.#state, "rejected", "rejected is only reachable from review-pending");
    }
    return this.terminate("rejected", "run.rejected", "review-pending", reason, completion);
  }

  /**
   * The atomic SUCCESS-terminal API (round-2 finding W2): advance `reindexed →
   * finalized` and, in the SAME transaction, publish the caller-idempotency slot to
   * `done` with the EXACT command result. `run.integrated` is the exactly-once
   * success audit event, so `finalize` emits none — it only writes the terminal
   * `agent_runs` state + the optional `completion` {@link LedgerStatement} (a
   * {@link IdempotentStart.completeStatement}). Because the completion carries the
   * arbitrary result verbatim and lands ATOMICALLY with `finalized`, a retry replays
   * the ORIGINAL result — its shape is never reconstructed from run artifacts (which
   * would drop fields not derivable from them).
   *
   * The §2.8 step-4 backup gate is enforced first (the state table gates `finalized`
   * on backup coverage): if the covering backup does not succeed, `finalized` is NOT
   * written and a retryable error is thrown — the run stays `reindexed`.
   */
  async finalize(completion?: LedgerStatement): Promise<{ runId: string; state: "finalized" }> {
    const db = this.deps.store.db;
    // CAS ONLY from `reindexed` (round-3 finding on engine.ts:635-667): an
    // `integrated → finalized` would SKIP the required `reindexed` checkpoint, so
    // `integrated` is NOT an accepted prior. `finalized` is listed only so an
    // already-finalized run is recognised as a true SINK (handled below) — never
    // re-written (which would bump `checkpoint_seq` and re-publish the completion).
    const cur = assertPersistedState(db, this.runId, "finalized", ["reindexed", "finalized"]);
    const now = this.now();

    if (cur === "finalized") {
      // True sink: do NOT re-write the terminal (no checkpoint_seq bump, no completion
      // re-publish). Only ensure the finalized terminal is backup-covered before
      // reporting success — an idempotent repeat converges without mutating the row.
      await this.assertFinalizeBackedUp();
      this.#state = "finalized";
      return { runId: this.runId, state: "finalized" };
    }

    // Advance `reindexed → finalized` + publish the caller-idempotency result in ONE
    // transaction, THEN take the covering backup (round-3 finding on engine.ts:637-667).
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
          expectedFrom: ["reindexed"],
          assertAdvanced: true,
        }),
        // Atomic terminal-result publication for the SUCCESS terminal (round-2
        // finding W2): the exact result lands with `finalized` under the serialized
        // owner/hash/state CAS, or the whole finalize rolls back on a stale claim.
        ...(completion ? [completion] : []),
      ]);
      assertRowAdvancedTo(db, this.runId, "finalized");
    });
    commit();
    this.#state = "finalized";
    // Post-write backup coverage (round-3 finding on engine.ts:637-667): the backup is
    // taken AFTER the terminal + result transaction commits, so the verified snapshot
    // INCLUDES the finalized state and the published result — a restore can never
    // recover a `reindexed` run missing its terminal outcome. Success is reported ONLY
    // once that covering backup verifies; a fault leaves the run finalized-but-uncovered
    // and throws retryable, and a retry re-drives the backup via the sink path above.
    await this.assertFinalizeBackedUp();
    return { runId: this.runId, state: "finalized" };
  }

  /**
   * Take (and verify) the §2.8 step-4 backup that must cover a finalized run, throwing
   * a retryable {@link CliError} if the covering backup does not succeed (round-3
   * finding on engine.ts:637-667). Called AFTER the finalized terminal commits so the
   * snapshot includes it.
   */
  private async assertFinalizeBackedUp(): Promise<void> {
    const backedUp = await runBackupStep(this.deps.store, this.deps.backup, 2, this.now.bind(this));
    if (!backedUp) {
      throw new CliError({
        code: "finalize-backup-uncovered",
        message: `run ${this.runId} finalized but its §2.8 step-4 covering backup did not succeed`,
        hint: "A finalized run requires a verified covering backup; retry once the backup fault clears.",
        exitCode: EXIT.INTERNAL,
        retryable: true,
      });
    }
  }

  private async terminate(
    status: "failed" | "cancelled" | "rejected",
    auditKind: AuditEventKind,
    at: WorkflowState,
    reason?: string,
    completion?: LedgerStatement,
  ): Promise<TerminalRun> {
    if (status === "rejected") {
      if (at !== "review-pending") throw new IllegalTransitionError(this.#state, "rejected", "rejected is only reachable from review-pending");
    } else {
      // fail/cancel are only reachable from a terminable checkpoint, and only
      // from the run's CURRENT state (you terminate where you are).
      if (this.#state !== null && this.#state !== at) {
        throw new IllegalTransitionError(this.#state, status, `cannot terminate at ${at} from ${this.#state}`);
      }
      if (!canTerminateFrom(at)) {
        throw new IllegalTransitionError(at, status, "past integration a run is not fail/cancel-reversible (forward recovery only)");
      }
    }

    const now = this.now();
    // Terminal-specific detail field (round finding #8): the contract requires
    // `run.failed` → `failedAt`, `run.cancelled` → `cancelledAt`. `run.rejected`
    // records only the reason (its from-checkpoint is always `review-pending`).
    const detail: Record<string, unknown> = {};
    if (status === "failed") detail.failedAt = at;
    else if (status === "cancelled") detail.cancelledAt = at;
    if (reason !== undefined) detail.reason = reason;
    const db = this.deps.store.db;
    // Persisted-state CAS for the terminal (round-3 finding #2). A terminal is only
    // reachable from the checkpoint it terminates FROM, so the durable state must be
    // exactly `at`. Pre-flight this BEFORE the broker append so a stale handle that
    // lost the CAS never anchors a terminal audit event; the guarded upsert's
    // SERIALIZED affected-row assert (assertAdvanced) then makes the CAS atomic with
    // the step-3 commit AND enforces it on crash-recovery replay of `write_json`
    // (round finding #2), so a run that advanced under another handle is never
    // regressed — live OR on replay.
    assertPersistedState(db, this.runId, status, [at]);
    const result = await finalizeLedgerWrite(this.deps.store, this.deps.broker, {
      runId: this.runId,
      event: this.baseEvent(auditKind, detail),
      ledgerWrite: [
        agentRunUpsert({
          runId: this.runId,
          operation: this.operation,
          status,
          // The `agent_runs` CHECK pins `failed_checkpoint` non-null IFF status is
          // `failed`/`cancelled`. `rejected` is a distinct terminal — it records
          // the from-checkpoint in the run.rejected audit `detail`, not the column.
          failedCheckpoint: status === "rejected" ? null : at,
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
      ],
      backup: this.deps.backup,
      now: this.now.bind(this),
    });

    // Worktree cleanup (§ recovery): a failed/cancelled/rejected run retains no
    // worktree (nothing durable was integrated). Best-effort with a lent repo;
    // otherwise the reconciler's orphan sweep collects it.
    await cleanupWorktree(this.deps, this.runId);

    this.#state = status;
    return { runId: this.runId, state: status, from: at, seq: result.seq, ...(reason !== undefined ? { reason } : {}) };
  }
}

/**
 * Begin a run. Emits the non-terminal `run.started` progress event (§2.5) and
 * returns a {@link RunHandle}. No `agent_runs` row exists until the first
 * `planned` checkpoint (§ recovery: the `planned` write is "from null/run.started").
 */
export async function startRun(deps: WorkflowDeps, input: RunInput): Promise<RunHandle> {
  const runId = input.runId ?? newRunId();
  const handle = new RunHandle(deps, runId, input.operation, input);

  if (input.resume === true) {
    // Resume an EXISTING run (round finding #7). `resume:true` must do more than
    // bypass the duplicate-id check: it (1) HYDRATES the handle's `#state` from the
    // durable `agent_runs.status` so the run can resume from BEYOND `planned` (a
    // `null` handle could only drive `planned`), and (2) SUPPRESSES a second
    // `run.started` — the run already started; re-emitting would duplicate the audit
    // event. Same-checkpoint replay is then made immutable by `checkpoint()` itself.
    const durable = handle.hydrateFromDurable();
    if (durable === null) {
      // No `agent_runs` row. Resume is legal ONLY for a run that genuinely started
      // and crashed BEFORE its `planned` write (round-2 finding W3): such a run has
      // durable `run.started` evidence but no row. A resume with NEITHER a row NOR a
      // run.started event is a completely UNKNOWN run — refuse it rather than
      // silently minting a phantom handle.
      if (!hasRunStartedEvidence(deps.store.db, runId)) {
        throw new CliError({
          code: "run-not-resumable",
          message: `run ${runId} is unknown (no agent_runs row and no run.started evidence); nothing to resume`,
          hint: "Resume re-drives an interrupted run; start a fresh run (new id) instead.",
          exitCode: EXIT.VALIDATION,
        });
      }
      // Known pre-planned crash: resume with a null handle (it drives `planned`) and
      // SUPPRESS a second run.started (already durably emitted).
      return handle;
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
  // `startRun` on an id that already has an `agent_runs` row would emit a second
  // `run.started` and race the existing run's state.
  const existing = deps.store.db.prepare(`SELECT 1 FROM agent_runs WHERE run_id = ?`).get(runId);
  if (existing) {
    throw new CliError({
      code: "run-id-in-use",
      message: `run ${runId} already exists; pass resume:true to re-drive it`,
      hint: "A fresh run must use a new id; resuming an interrupted run is an explicit opt-in.",
      exitCode: EXIT.VALIDATION,
    });
  }
  // A fresh start must ALSO reject an id that has durable `run.started` evidence but
  // no `agent_runs` row yet — a crash BEFORE `planned` (round-2 finding W3). Emitting
  // a second run.started here would duplicate the opening audit event; the crashed
  // run must be resumed (resume:true), not restarted fresh.
  if (hasRunStartedEvidence(deps.store.db, runId)) {
    throw new CliError({
      code: "run-id-in-use",
      message: `run ${runId} already emitted run.started (crashed before planned); pass resume:true to re-drive it`,
      hint: "A run that started but has no agent_runs row yet must be resumed, not restarted fresh.",
      exitCode: EXIT.VALIDATION,
    });
  }
  const now = deps.now ?? rfc3339Ms;
  await finalizeLedgerWrite(deps.store, deps.broker, {
    runId,
    event: {
      schemaVersion: 1,
      eventId: newRunId(),
      kind: "run.started",
      occurredAt: now(),
      runId,
      subjects: (input.subjects ?? []) as AuditSubject[],
      canonicalCommit: input.canonicalCommit ?? NO_CANONICAL_COMMIT,
      detail: { operation: input.operation },
    },
    ledgerWrite: [], // run.started writes only its audit event (no agent_runs row yet).
    backup: deps.backup,
    now,
  });
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

// ── integration recording (bespoke §2.8 step-3 CAS for run.integrated) ───────

/**
 * Record the `integrated` checkpoint's step-3 CAS. The broker already advanced
 * the canonical ref (→ `canonicalSha`) and appended the `run.integrated` event
 * at `seq`; this writes the CLI-side ledger consistently in ONE transaction:
 * the `audit_intents` row (done), the `audit_events` row (idempotent on `seq`),
 * `agent_runs='integrated'`, and the `git_operations` integrate row. Idempotent
 * — a re-drive after a crash writes each row exactly once.
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
    seq: args.artifacts.seq,
    payloadHash: args.artifacts.payloadHash,
    canonicalRef: args.artifacts.canonicalRef,
    canonicalSha: args.artifacts.canonicalSha,
    auditHead: args.artifacts.auditHead,
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
 * Land the `integrated` step-3 CAS by REPLAYING the intent's EXACT persisted
 * `write_json` (round-3 finding on reconciler.ts:738-747), rather than reconstructing
 * the ledger write from the run's current (mutable, possibly-diverged) `agent_runs`
 * metadata. The persisted `write` is the byte-stable operation captured at §2.8 step 1,
 * so recovery applies the SAME transaction the live path would have — even if the
 * run's `operation`/`target_note_id` rows have since changed. `payloadHash` is validated
 * against the allocated event's hash by the caller (the recomputed event hash MUST
 * equal the stored `payload_hash`) before this records the audit row.
 */
export function recordIntegrationFromIntent(
  store: Store,
  args: {
    runId: string;
    seq: number;
    payloadHash: string;
    canonicalRef: string;
    canonicalSha: string;
    auditHead: string;
    write: readonly LedgerStatement[];
    now: string;
  },
): void {
  finishIntegration(store, {
    runId: args.runId,
    // operation/targetNoteId are unused when `write` is supplied verbatim (the
    // persisted statements already carry them); pass placeholders finishIntegration
    // ignores in favor of `write`.
    operation: "",
    targetNoteId: null,
    seq: args.seq,
    payloadHash: args.payloadHash,
    canonicalRef: args.canonicalRef,
    canonicalSha: args.canonicalSha,
    auditHead: args.auditHead,
    write: args.write,
    now: args.now,
  });
}

/**
 * The replayable step-3 `LedgerStatement[]` for an `integrated` transition —
 * persisted in the intent's `write_json` so `reconcileInterruptedRuns` can land
 * the complete step-3 (agent_runs + git op) after a crash between append and CAS.
 * `agent_runs` is CAS-guarded from `agent-committed`/`review-pending`/`integrated`
 * so a stale handle cannot regress it.
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
      expectedFrom: ["agent-committed", "review-pending", "integrated"],
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
 * The §2.8 step-3 CAS for `integrated` (idempotent). One transaction: flip/insert
 * the `audit_intents` row to `done` (recording the durable `seq`/`payloadHash`),
 * insert the `audit_events` row (idempotent on `seq`; a conflicting payload hash
 * throws), and apply the replayable step-3 ledger writes. Both the live
 * {@link RunHandle.integrate} and the reconciler funnel through here.
 */
function finishIntegration(
  store: Store,
  args: {
    runId: string;
    operation: string;
    targetNoteId: string | null;
    seq: number;
    payloadHash: string;
    canonicalRef: string;
    canonicalSha: string;
    auditHead: string;
    write: readonly LedgerStatement[];
    now: string;
  },
): void {
  const { runId, seq, payloadHash, auditHead, now } = args;
  const db = store.db;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO audit_intents (run_id, seq, payload_hash, event_json, write_json, state, created_at, updated_at)
       VALUES (@run_id, @seq, @payload_hash, COALESCE((SELECT event_json FROM audit_intents WHERE run_id=@run_id AND seq=@seq), ''),
               COALESCE((SELECT write_json FROM audit_intents WHERE run_id=@run_id AND seq=@seq), '[]'), 'done', @now, @now)
       ON CONFLICT(run_id, seq) DO UPDATE SET state = 'done', updated_at = @now`,
    ).run({ run_id: runId, seq, payload_hash: payloadHash, now });

    store.ledger.insertAuditEvent({
      seq,
      run_id: runId,
      event_type: "run.integrated",
      payload_hash: payloadHash,
      git_head: auditHead,
      created_at: now,
    });

    applyLedgerWrite(db, [...args.write]);
    // Affected-row CAS (round-3 finding #2): the integrated upsert is guarded on
    // `agent-committed`/`review-pending`/`integrated`; assert the row is now
    // `integrated` so a stale handle cannot record run.integrated against a run
    // that regressed/terminated — the whole step-3 tx rolls back otherwise.
    assertRowAdvancedTo(db, runId, "integrated");
  });
  tx();
}

/**
 * `true` iff a run has durable `run.started` evidence — a committed `audit_events`
 * row OR a `pending` `audit_intents` row of kind `run.started` (round-2 finding W3).
 * A run.started is written before the first `planned` row, so this is how a
 * crash-BEFORE-planned run is recognised: it has run.started evidence but no
 * `agent_runs` row. Used to refuse both an UNKNOWN resume (no row + no evidence) and
 * a fresh restart of an already-started id (evidence + no row).
 */
function hasRunStartedEvidence(db: Store["db"], runId: string): boolean {
  const ev = db.prepare(`SELECT 1 FROM audit_events WHERE run_id = ? AND event_type = 'run.started'`).get(runId);
  if (ev !== undefined) return true;
  const intent = db
    .prepare(`SELECT 1 FROM audit_intents WHERE run_id = ? AND event_json LIKE '%"kind":"run.started"%'`)
    .get(runId);
  return intent !== undefined;
}

/** Delete a still-`pending` `(runId, seq)` intent (an un-anchored, abandoned allocation). */
function dropPendingIntent(db: Store["db"], runId: string, seq: number): void {
  db.prepare(`DELETE FROM audit_intents WHERE run_id = ? AND seq = ? AND state = 'pending'`).run(runId, seq);
}

/**
 * `true` iff `err` is the broker's refusal to sign a canonical-installing audit
 * kind (`broker.audit_kind_not_signable`) — the authoritative signal that a
 * `run.integrated` event is NOT anchored. Duck-typed on `.code` so the workflows
 * layer needs no static `@atlas/broker` import (the acyclic-seam discipline).
 */
function isAuditKindNotSignable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "broker.audit_kind_not_signable";
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
    case "review-pending":
      return []; // gated on the agent-committed commitSha already recorded.
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

/** Allowlisted detail for the `run.planned` event (identifiers + hashes only, §2.5). */
function plannedDetail(state: WorkflowState, artifacts: unknown): Record<string, unknown> {
  if (state === "planned") {
    const a = artifacts as PlannedArtifacts;
    return { planHash: a.planHash, tier: a.tier, baseRef: a.baseRef };
  }
  return {};
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
