/**
 * `workflows/checkpoints` — the durable-checkpoint model for the run state
 * machine (Task 2.5), driven by `docs/specs/recovery-state-machine.md` (the
 * normative SSOT). This module owns the **transition graph** and the **single
 * atomic write per transition** that records a checkpoint's gating artifacts +
 * hashes; `engine.ts` orchestrates it and `reconciler.ts` recovers from it.
 *
 * ## Why the artifacts live in the ledger tables (not new columns)
 * `agent_runs` (0001_core) carries only `status`, `failed_checkpoint`,
 * `checkpoint_seq`, `tier`, and timestamps — the migration is IMMUTABLE (§2.7)
 * and Task 2.5 adds no migration. The gating artifacts/hashes each transition
 * records therefore live in the run's OTHER `0001_core` ledger tables, written
 * in the SAME SQLite transaction as the `agent_runs` status change so the whole
 * transition is one atomic commit (§2.5 "single atomic write per transition"):
 *
 *   - `planned`  → `change_plans` row (`plan_hash`, `tier`, `confidence`) + a
 *     `git_operations` `base` row recording `baseRef` (the canonical HEAD the
 *     plan was computed against).
 *   - `patched`  → `patches` row (`patch_hash`, changed lines/sections).
 *   - `worktree-applied` / `agent-committed` / `integrated` / `reindexed` →
 *     `git_operations` rows keyed by `op_type` (the dictionary explicitly leaves
 *     `op_type` open: "branch|commit|integrate|rollback|…"), encoding
 *     `worktreePath`/`treeHash`/`commitSha`/`canonicalSha`/`indexGeneration`.
 *
 * Every artifact the reconciler needs to re-derive a run's position (§ recovery
 * table idempotency checks) is thus durably present after exactly one commit.
 * A kill -9 mid-transition either lands the whole transition or none of it.
 *
 * The normative workflow-state SET is consumed from `@atlas/contracts`
 * (`WORKFLOW_STATES`) — never re-enumerated here (plan §2.5 module discipline).
 * The transition GRAPH is owned here (the manifest schema explicitly defers it:
 * "the full workflow-state machine + transitions live in … the `workflows`
 * module").
 */
import { createHash } from "node:crypto";
import { canonicalSerialize, WORKFLOW_STATES, type WorkflowState } from "@atlas/contracts";
import type { SqliteDatabase } from "@atlas/sqlite-store";
import type { LedgerStatement } from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";

/** A `git_operations.op_type` this module writes to encode a checkpoint artifact. */
export type GitOpType = "base" | "worktree-applied" | "agent-committed" | "integrated" | "reindexed";

/** The progression checkpoints (non-terminal), in order. v2 (#335): the
 * `review-pending` park is retired — a run advances agent-committed → integrated. */
export const CHECKPOINT_STATES = [
  "planned",
  "patched",
  "worktree-applied",
  "agent-committed",
  "integrated",
  "reindexed",
] as const satisfies readonly WorkflowState[];

export type CheckpointState = (typeof CHECKPOINT_STATES)[number];

/** The success terminal. */
export const SUCCESS_TERMINAL = "finalized" as const;

/** The class-terminal `agent_runs.status` values (the DDL CHECK set). */
export const TERMINAL_STATES = [
  "finalized",
  "rejected",
  "rolled-back",
  "failed",
  "cancelled",
] as const satisfies readonly WorkflowState[];

/**
 * The legal forward transitions between progression checkpoints (§ recovery
 * table `nextStates`, terminals excluded — those are governed by
 * {@link canTerminateFrom} / {@link REJECTABLE_FROM}). `finalized` has no
 * successor (a true sink).
 */
export const CHECKPOINT_NEXT: Readonly<Record<CheckpointState, readonly WorkflowState[]>> = {
  planned: ["patched"],
  patched: ["worktree-applied"],
  "worktree-applied": ["agent-committed"],
  "agent-committed": ["integrated"],
  integrated: ["reindexed"],
  reindexed: ["finalized"],
};

/**
 * Checkpoints a run may be `failed@`/`cancelled@` FROM. Past `integrated` a
 * canonical mutation is durable and recovery is forward-only — no
 * `failed@integrated`/`cancelled@integrated`/…`reindexed`/…`finalized` exists
 * (§ recovery "Checkpoint-suffixed terminals").
 */
export const TERMINABLE_FROM = [
  "planned",
  "patched",
  "worktree-applied",
  "agent-committed",
] as const satisfies readonly CheckpointState[];

/** `true` iff a `fail`/`cancel` FROM `state` is legal per the recovery contract. */
export function canTerminateFrom(state: WorkflowState): state is CheckpointState {
  return (TERMINABLE_FROM as readonly WorkflowState[]).includes(state);
}

/** Raised on any transition the recovery contract does not permit (illegal edge). */
export class IllegalTransitionError extends CliError {
  constructor(from: WorkflowState | null, to: WorkflowState, detail?: string) {
    super({
      code: "illegal-transition",
      message:
        `illegal run-state transition ${from ?? "<start>"} → ${to}` +
        (detail ? ` (${detail})` : ""),
      hint: "The run lifecycle is fixed by docs/specs/recovery-state-machine.md; only its legal edges are permitted.",
      exitCode: EXIT.INTERNAL,
    });
    this.name = "IllegalTransitionError";
  }
}

/**
 * Raised when a transition's persisted expected-state CAS fails — the durable
 * `agent_runs.status` is not the state the caller believed the run was in. This
 * is the crash-safe guard against a stale/concurrent {@link RunHandle} regressing
 * an already-advanced or terminal row (round-2 finding): every transition asserts
 * the persisted prior state, not merely its own in-memory `#state`.
 */
export class CheckpointCasError extends CliError {
  constructor(runId: string, expected: WorkflowState | null, actual: WorkflowState | null, to: WorkflowState) {
    super({
      code: "checkpoint-cas-failed",
      message:
        `run ${runId}: cannot transition to ${to} — persisted state is ${actual ?? "<none>"}, ` +
        `expected ${expected ?? "<none>"} (stale or concurrent run handle)`,
      hint: "The run advanced (or terminated) under a different handle; re-read the run before driving it.",
      exitCode: EXIT.INTERNAL,
    });
    this.name = "CheckpointCasError";
  }
}

/**
 * Raised when a checkpoint's gating artifact/hash evidence is absent or does not
 * chain onto the prior checkpoint's persisted evidence (§ recovery "required
 * artifacts + hashes" / "gated on …"). Every progression checkpoint validates the
 * complete gating evidence before its single atomic write commits (round-2
 * finding: gates must be enforced, not merely documented).
 */
export class GatingEvidenceError extends CliError {
  constructor(state: WorkflowState, detail: string) {
    super({
      code: "gating-evidence-invalid",
      message: `run-state ${state} gating evidence invalid: ${detail}`,
      hint: "A checkpoint may only commit when its required artifacts/hashes chain onto the prior checkpoint.",
      exitCode: EXIT.INTERNAL,
    });
    this.name = "GatingEvidenceError";
  }
}

/**
 * Assert a checkpoint transition `from → to` is legal, throwing
 * {@link IllegalTransitionError} otherwise. `from === null` is the initial
 * write and only `planned` is legal from it (the state set's entry point).
 */
export function assertCheckpointTransition(from: WorkflowState | null, to: WorkflowState): void {
  if (!(WORKFLOW_STATES as readonly string[]).includes(to)) {
    throw new IllegalTransitionError(from, to, "unknown target state");
  }
  if (from === null) {
    if (to !== "planned") throw new IllegalTransitionError(from, to, "a run must enter at 'planned'");
    return;
  }
  if (!isCheckpoint(from)) {
    // `from` is already terminal — a true sink has no outgoing edge.
    throw new IllegalTransitionError(from, to, "the source state is terminal");
  }
  const legal = CHECKPOINT_NEXT[from];
  if (!legal.includes(to)) throw new IllegalTransitionError(from, to);
}

/** Narrow a state to a progression checkpoint. */
export function isCheckpoint(state: WorkflowState): state is CheckpointState {
  return (CHECKPOINT_STATES as readonly string[]).includes(state);
}

// ── hashing ────────────────────────────────────────────────────────────────

/** `sha256:<hex>` over the canonical (RFC-8785 JCS) bytes of `v` — the repo idiom. */
export function sha256Canonical(v: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalSerialize(v)).digest("hex")}`;
}

// ── typed checkpoint artifacts ───────────────────────────────────────────────

/** The `planned` gating artifacts: the plan + its hash + the base it was computed against. */
export interface PlannedArtifacts {
  readonly planId: string;
  /** Advisory risk tier (v2 #335: tier-1 captures / tier-2 synthesis; no tier-3). */
  readonly tier: 1 | 2;
  readonly confidence: number;
  readonly summary: string;
  /** `sha256(canonical(ChangePlan))` — recomputed by the reconciler's idempotency check. */
  readonly planHash: string;
  /** The canonical ref the plan branched from + its resolved commit sha (`baseRef`). */
  readonly canonicalRef: string;
  readonly baseRef: string;
}

/** The `patched` gating artifacts (gated on the stored `planHash`). */
export interface PatchedArtifacts {
  readonly patchId: string;
  readonly planId: string;
  readonly noteId: string;
  readonly changedLines: number;
  readonly changedSections: number;
  /** `sha256(canonical(patches))`. */
  readonly patchHash: string;
  /**
   * The `planHash` this patch was materialized against — REQUIRED (round-3
   * finding #5): the `patched` transition always asserts it equals the run's
   * durably-stored `planHash`, and that `planId` is the run's own plan. Patches
   * are a pure function of the plan — a mismatch is `patch-nondeterministic`, and
   * a `planId` owned by another run must never let this run advance.
   */
  readonly planHash: string;
}

/** The `worktree-applied` gating artifacts (gated on `patchHash`). */
export interface WorktreeAppliedArtifacts {
  readonly worktreePath: string;
  /** Hash of the applied working tree. */
  readonly treeHash: string;
  /** The agent ref the worktree's HEAD is attached to. */
  readonly agentRef: string;
}

/** The `agent-committed` gating artifacts (gated on `treeHash`). v2 (#335): every
 * committed run integrates directly — there is no Tier-3 review park to route to. */
export interface AgentCommittedArtifacts {
  readonly commitSha: string;
  readonly treeHash: string;
  readonly agentRef: string;
  /** Advisory only (captures tier-1, synthesis tier-2); never routes to a review park. */
  readonly tier: 1 | 2;
}

/**
 * The `integrated` gating artifacts. The canonical fast-forward (ref advance) is
 * performed by the CALLER (capture / synthesis); this checkpoint records the
 * resulting `agent_runs='integrated'` + git-op state. v2 (#338): a plain git FF-CAS,
 * no audit `seq`/append — see {@link recordIntegration} in engine.ts.
 */
export interface IntegratedArtifacts {
  readonly canonicalRef: string;
  readonly canonicalSha: string;
}

/** The `reindexed` gating artifacts (gated on `canonicalSha`). */
export interface ReindexedArtifacts {
  readonly indexGeneration: number;
  readonly canonicalSha: string;
}

// ── ledger-statement builders (idempotent step-3 writes) ─────────────────────

/**
 * Build the idempotent `LedgerStatement[]` that upserts an `agent_runs` row to a
 * NON-terminal checkpoint `status`. Written either as a plain transaction (no
 * audit) or inside `finalizeLedgerWrite`'s replayable `ledgerWrite` (audit
 * checkpoints), so a crash-recovery replay writes it exactly once.
 */
export function agentRunUpsert(args: {
  runId: string;
  operation: string;
  status: WorkflowState;
  tier?: number | null;
  targetNoteId?: string | null;
  startedAt: string;
  now: string;
  finishedAt?: string | null;
  failedCheckpoint?: string | null;
  /**
   * Persisted expected-state CAS (round-2 finding). When set to the state list the
   * run must currently be in, the `ON CONFLICT DO UPDATE` only fires while the
   * DURABLE `agent_runs.status` is one of them — an advanced or terminal row is
   * never regressed by a stale handle's write (the update silently no-ops; the
   * caller detects the no-op via {@link assertPersistedState} run in the same
   * transaction). Omit for the initial `planned` INSERT (from `null`), which has
   * no conflict to guard.
   */
  expectedFrom?: readonly WorkflowState[];
  /**
   * Attach a SERIALIZED affected-row CAS (round finding #2): after the guarded
   * upsert runs, assert `agent_runs.status` is NOW exactly `status`. Because the
   * assertion travels with the statement (in `write_json`), a crash-recovery replay
   * enforces the SAME CAS the live step-3 did — an audit event is never completed
   * against a row the `expectedFrom` guard could not advance. Set for the
   * audit-emitting `agent_runs` writes whose post-write CAS previously lived only in
   * a non-serialized `extraCommit` closure.
   */
  assertAdvanced?: boolean;
}): LedgerStatement {
  // Guard semantics (round-2 finding W1): `undefined` = NO guard (the initial
  // `planned` INSERT-from-null, which has no conflict to gate). A PRESENT-but-EMPTY
  // `[]` is the FALSE-CONFLICT guard (` WHERE 0`) — the write may only succeed via
  // its INSERT (no existing row); any ON CONFLICT is refused, so a concurrent
  // duplicate can never overwrite or bump the row. A non-empty set CASes to those
  // exact prior states.
  const guard = args.expectedFrom === undefined
    ? ""
    : args.expectedFrom.length > 0
      ? ` WHERE agent_runs.status IN (${args.expectedFrom.map((_, i) => `@cas${i}`).join(", ")})`
      : ` WHERE 0`;
  const casParams: Record<string, unknown> = {};
  (args.expectedFrom ?? []).forEach((s, i) => (casParams[`cas${i}`] = s));
  return {
    sql: `INSERT INTO agent_runs
            (run_id, operation, status, failed_checkpoint, checkpoint_seq, target_note_id, tier,
             started_at, updated_at, finished_at)
          VALUES (@run_id, @operation, @status, @failed_checkpoint, 0, @target_note_id, @tier,
                  @started_at, @now, @finished_at)
          ON CONFLICT(run_id) DO UPDATE SET
            status = excluded.status,
            failed_checkpoint = excluded.failed_checkpoint,
            checkpoint_seq = agent_runs.checkpoint_seq + 1,
            tier = COALESCE(excluded.tier, agent_runs.tier),
            updated_at = excluded.updated_at,
            finished_at = excluded.finished_at${guard}`,
    params: {
      run_id: args.runId,
      operation: args.operation,
      status: args.status,
      failed_checkpoint: args.failedCheckpoint ?? null,
      target_note_id: args.targetNoteId ?? null,
      tier: args.tier ?? null,
      started_at: args.startedAt,
      now: args.now,
      finished_at: args.finishedAt ?? null,
      ...casParams,
    },
    ...(args.assertAdvanced
      ? {
          // Affected-row assertion (round-2 finding W1): the guarded upsert must
          // change EXACTLY ONE row. A blocked ON CONFLICT (0 rows) is rejected even
          // when the row already sits at `@status` because a different handle wrote
          // it — so a no-op UPDATE can never falsely complete a duplicate terminal
          // (or planned) audit event. Serialized in `write_json`, so a crash-recovery
          // replay enforces the same one-row CAS the live step-3 did.
          expectChanges: 1,
          assert: {
            sql: `SELECT 1 FROM agent_runs WHERE run_id = @run_id AND status = @status`,
            params: { run_id: args.runId, status: args.status },
            message: `run ${args.runId} did not advance to ${args.status} (persisted-state CAS blocked — stale or concurrent handle)`,
          },
        }
      : {}),
  };
}

/**
 * Idempotent insert of a `change_plans` row (the `planned` gating artifact).
 * `ON CONFLICT DO NOTHING` makes an identical replay a no-op; a CONFLICTING
 * replay (a `plan_id` already owned with different content, or by another run) is
 * caught by {@link assertPlanPersisted}, which runs inside the SAME transition
 * transaction and rejects any byte-for-byte mismatch (round-3 finding #5).
 */
export function changePlanInsert(runId: string, a: PlannedArtifacts, now: string): LedgerStatement {
  return {
    sql: `INSERT INTO change_plans (plan_id, run_id, tier, confidence, summary, plan_hash, created_at)
          VALUES (@plan_id, @run_id, @tier, @confidence, @summary, @plan_hash, @now)
          ON CONFLICT(plan_id) DO NOTHING`,
    params: {
      plan_id: a.planId,
      run_id: runId,
      tier: a.tier,
      confidence: a.confidence,
      summary: a.summary,
      plan_hash: a.planHash,
      now,
    },
    // Serialized immutable-artifact assertion (round finding #2/#5): after the
    // idempotent insert, the persisted `change_plans` row for this `plan_id` MUST be
    // owned by THIS run with byte-identical content. `ON CONFLICT DO NOTHING` would
    // otherwise silently ignore a `plan_id` already owned by another run (or the same
    // id with different content); this assert — enforced on BOTH the live path and
    // crash-recovery replay — rejects that instead of completing the run.planned
    // audit event against a foreign/divergent plan.
    assert: {
      sql: `SELECT 1 FROM change_plans
              WHERE plan_id = @plan_id AND run_id = @run_id AND plan_hash = @plan_hash
                AND tier = @tier AND confidence = @confidence AND summary = @summary`,
      params: { plan_id: a.planId, run_id: runId, plan_hash: a.planHash, tier: a.tier, confidence: a.confidence, summary: a.summary },
      message: `change_plans row for ${a.planId} is absent, owned by another run, or has divergent content (immutable-artifact conflict)`,
    },
  };
}

/**
 * Idempotent insert of a `patches` row (the `patched` gating artifact). As with
 * {@link changePlanInsert}, `ON CONFLICT DO NOTHING` replays cleanly only when the
 * persisted row is byte-for-byte identical — {@link assertPatchPersisted} (same
 * transaction) rejects a conflicting `patch_id` reuse (round-3 finding #5).
 */
export function patchInsert(a: PatchedArtifacts, now: string): LedgerStatement {
  return {
    sql: `INSERT INTO patches (patch_id, plan_id, note_id, changed_lines, changed_sections, patch_hash, created_at)
          VALUES (@patch_id, @plan_id, @note_id, @changed_lines, @changed_sections, @patch_hash, @now)
          ON CONFLICT(patch_id) DO NOTHING`,
    params: {
      patch_id: a.patchId,
      plan_id: a.planId,
      note_id: a.noteId,
      changed_lines: a.changedLines,
      changed_sections: a.changedSections,
      patch_hash: a.patchHash,
      now,
    },
  };
}

/**
 * Idempotent insert of a `git_operations` row encoding a git-side checkpoint
 * artifact. `(run_id, op_type)` is treated as the natural key (one row per git
 * checkpoint per run); a replay updates in place so the row is written exactly
 * once regardless of retries.
 */
export function gitOpUpsert(args: {
  gitOpId: string;
  runId: string;
  opType: GitOpType;
  refName: string;
  commitSha?: string | null;
  now: string;
}): LedgerStatement {
  return {
    sql: `INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at)
          VALUES (@git_op_id, @run_id, @op_type, @ref_name, @commit_sha, @now)
          ON CONFLICT(git_op_id) DO UPDATE SET
            ref_name = excluded.ref_name,
            commit_sha = excluded.commit_sha`,
    params: {
      git_op_id: args.gitOpId,
      run_id: args.runId,
      op_type: args.opType,
      ref_name: args.refName,
      commit_sha: args.commitSha ?? null,
      now: args.now,
    },
  };
}

/** Deterministic `git_operations.git_op_id` for a run's checkpoint (one per op_type). */
export function gitOpId(runId: string, opType: GitOpType): string {
  return `${runId}:${opType}`;
}

// ── read helpers (reconciler idempotency checks) ─────────────────────────────

/** A decoded `git_operations` artifact row. */
export interface GitOpArtifact {
  readonly opType: string;
  readonly refName: string;
  readonly commitSha: string | null;
}

/** Read a run's `git_operations` artifact for `opType`, or `undefined`. */
export function readGitOp(db: SqliteDatabase, runId: string, opType: GitOpType): GitOpArtifact | undefined {
  const row = db
    .prepare(`SELECT op_type, ref_name, commit_sha FROM git_operations WHERE git_op_id = ?`)
    .get(gitOpId(runId, opType)) as { op_type: string; ref_name: string; commit_sha: string | null } | undefined;
  return row ? { opType: row.op_type, refName: row.ref_name, commitSha: row.commit_sha } : undefined;
}

/** Read a run's stored `plan_hash` (the `planned` idempotency evidence), or `undefined`. */
export function readPlanHash(db: SqliteDatabase, runId: string): string | undefined {
  const row = db
    .prepare(`SELECT plan_hash FROM change_plans WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(runId) as { plan_hash: string } | undefined;
  return row?.plan_hash;
}

/** Read a run's stored `patch_hash` (the `patched` gating evidence), or `undefined`. */
export function readPatchHash(db: SqliteDatabase, runId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT p.patch_hash AS patch_hash FROM patches p
         JOIN change_plans c ON c.plan_id = p.plan_id
        WHERE c.run_id = ? ORDER BY p.created_at DESC LIMIT 1`,
    )
    .get(runId) as { patch_hash: string } | undefined;
  return row?.patch_hash;
}

/** Read the durable `agent_runs.status` for `runId`, or `null` if no row exists yet. */
export function readAgentRunStatus(db: SqliteDatabase, runId: string): WorkflowState | null {
  const row = db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as
    | { status: WorkflowState }
    | undefined;
  return row?.status ?? null;
}

/**
 * Assert the DURABLE `agent_runs.status` for `runId` is one of `expected`
 * (`null` in the list means "no row yet"), throwing {@link CheckpointCasError}
 * otherwise. Run INSIDE the transition's transaction (before its write) so the
 * persisted-state CAS is atomic with the state change — a stale/concurrent handle
 * that believes the run is elsewhere cannot regress an advanced or terminal row
 * (round-2 finding). Returns the observed persisted state.
 */
export function assertPersistedState(
  db: SqliteDatabase,
  runId: string,
  to: WorkflowState,
  expected: readonly (WorkflowState | null)[],
): WorkflowState | null {
  const actual = readAgentRunStatus(db, runId);
  if (!expected.includes(actual)) {
    throw new CheckpointCasError(runId, expected.find((e) => e !== null) ?? null, actual, to);
  }
  return actual;
}

/**
 * Validate that a checkpoint's required gating evidence is durably present and
 * chains onto the prior checkpoint (§ recovery "gated on …"), throwing
 * {@link GatingEvidenceError} otherwise. Enforced inside the transition's atomic
 * write so a checkpoint can never commit with disagreeing evidence (round-2
 * finding). The checks per state:
 *
 *  - `patched` → the run's stored `planHash` exists and matches the patch's
 *    declared `planHash` (patches are a pure function of the plan).
 *  - `worktree-applied` → the run's stored `patchHash` exists (gated on `patched`).
 *  - `agent-committed` → the recorded `worktree-applied` `treeHash` matches the
 *    commit's declared `treeHash`, and its `tier` matches the planned tier
 *    (advisory only; v2 has no review park to route to).
 *  - `reindexed` → the recorded `integrated` `canonicalSha` matches.
 */
export function assertGatingEvidence(
  db: SqliteDatabase,
  runId: string,
  state: WorkflowState,
  artifacts: unknown,
): void {
  switch (state) {
    case "patched": {
      const a = artifacts as PatchedArtifacts;
      // Ownership + hash chaining (round-3 finding #5): the patch must declare the
      // run's OWN plan (`planId`) and the plan hash it was materialized against
      // must equal the run's durably-stored `planHash`. A run can neither advance
      // against another run's plan nor with a stale/foreign plan hash.
      const plan = readPlan(db, runId);
      if (!plan) throw new GatingEvidenceError(state, "no stored plan — run is not planned");
      if (a.planId !== plan.planId) {
        throw new GatingEvidenceError(state, `patch planId ${a.planId} ≠ run's plan ${plan.planId} (plan not owned by this run)`);
      }
      if (a.planHash !== plan.planHash) {
        throw new GatingEvidenceError(state, `patch planHash ${a.planHash} ≠ stored ${plan.planHash}`);
      }
      return;
    }
    case "worktree-applied": {
      if (!readPatchHash(db, runId)) throw new GatingEvidenceError(state, "no stored patchHash — run is not patched");
      return;
    }
    case "agent-committed": {
      const a = artifacts as AgentCommittedArtifacts;
      const wt = readGitOp(db, runId, "worktree-applied");
      if (!wt) throw new GatingEvidenceError(state, "no recorded worktree-applied artifact");
      if (wt.commitSha !== a.treeHash) {
        throw new GatingEvidenceError(state, `commit treeHash ${a.treeHash} ≠ applied tree ${wt.commitSha}`);
      }
      const tier = readPlannedTier(db, runId);
      if (tier !== null && tier !== a.tier) {
        throw new GatingEvidenceError(state, `agent-committed tier ${a.tier} ≠ planned tier ${tier}`);
      }
      return;
    }
    case "reindexed": {
      const a = artifacts as ReindexedArtifacts;
      const integrated = readGitOp(db, runId, "integrated");
      if (!integrated) throw new GatingEvidenceError(state, "no recorded integrated canonicalSha");
      if (integrated.commitSha !== a.canonicalSha) {
        throw new GatingEvidenceError(state, `reindex canonicalSha ${a.canonicalSha} ≠ integrated ${integrated.commitSha}`);
      }
      return;
    }
    default:
      return; // planned has no prior checkpoint to gate on.
  }
}

/**
 * Assert a SAME-CHECKPOINT replay's supplied artifacts match the run's DURABLE
 * evidence (round-2 finding W3). Re-driving the checkpoint a run is already at must
 * be IMMUTABLE — but "immutable" means the replay carries the SAME artifacts, not
 * that any artifacts are silently accepted. A resumed run replaying its last
 * checkpoint with DIVERGENT artifacts (a different plan/patch/tree/commit) is a
 * client bug or tamper and must be rejected, not no-op'd through. Dispatches to the
 * byte-for-byte immutable-artifact asserts already used on the forward path.
 */
export function assertResumeArtifactsMatch(
  db: SqliteDatabase,
  runId: string,
  state: WorkflowState,
  artifacts: unknown,
): void {
  // The agent ref is canonical per run (`refs/agent/<runId>`, @atlas/git) — a
  // DERIVABLE identity every checkpoint that carries `agentRef` must match on resume
  // (round-3 finding on checkpoints.ts:643-685: agentRef was ignored). The
  // worktree-applied checkpoint records no agent-ref row, so it is validated against
  // this derivable convention; agent-committed validates it against the durable
  // `agent-committed` git op's `ref_name` too.
  const expectedAgentRef = `refs/agent/${runId}`;
  switch (state) {
    case "planned": {
      const a = artifacts as PlannedArtifacts;
      assertPlanPersisted(db, runId, a);
      // Base evidence was ignored before (round-3 finding): the `planned` checkpoint
      // also durably records the canonical ref + base sha in a `base` git op — a resume
      // replay must carry the SAME base, or it is a divergent/tampered replay.
      const base = readGitOp(db, runId, "base");
      if (!base || base.refName !== a.canonicalRef || base.commitSha !== a.baseRef) {
        throw new GatingEvidenceError(state, `resume base evidence diverges (ref ${a.canonicalRef}/${base?.refName ?? "<none>"}, base ${a.baseRef}/${base?.commitSha ?? "<none>"})`);
      }
      return;
    }
    case "patched": {
      const a = artifacts as PatchedArtifacts;
      const plan = readPlan(db, runId);
      if (!plan || a.planId !== plan.planId || a.planHash !== plan.planHash) {
        throw new GatingEvidenceError(state, `resume patch artifacts diverge from the durable plan (${a.planId}/${a.planHash})`);
      }
      assertPatchPersisted(db, a);
      return;
    }
    case "worktree-applied": {
      const a = artifacts as WorktreeAppliedArtifacts;
      const wt = readGitOp(db, runId, "worktree-applied");
      if (!wt || wt.refName !== a.worktreePath || wt.commitSha !== a.treeHash) {
        throw new GatingEvidenceError(state, `resume worktree artifacts diverge from durable evidence`);
      }
      // agentRef was ignored before (round-3 finding): validate the derivable ref.
      if (a.agentRef !== expectedAgentRef) {
        throw new GatingEvidenceError(state, `resume agentRef ${a.agentRef} ≠ the run's agent ref ${expectedAgentRef}`);
      }
      return;
    }
    case "agent-committed": {
      const a = artifacts as AgentCommittedArtifacts;
      const c = readGitOp(db, runId, "agent-committed");
      if (!c || c.commitSha !== a.commitSha) {
        throw new GatingEvidenceError(state, `resume commit ${a.commitSha} diverges from durable ${c?.commitSha ?? "<none>"}`);
      }
      // treeHash, tier and agentRef were ignored before (round-3 finding). The commit's
      // tree must equal the applied `worktree-applied` tree; the tier must equal the
      // planned tier; the agent ref must equal the durably-recorded ref.
      const wt = readGitOp(db, runId, "worktree-applied");
      if (!wt || wt.commitSha !== a.treeHash) {
        throw new GatingEvidenceError(state, `resume treeHash ${a.treeHash} ≠ applied tree ${wt?.commitSha ?? "<none>"}`);
      }
      const tier = readPlannedTier(db, runId);
      if (tier !== null && tier !== a.tier) {
        throw new GatingEvidenceError(state, `resume tier ${a.tier} ≠ planned tier ${tier}`);
      }
      if (c.refName !== a.agentRef) {
        throw new GatingEvidenceError(state, `resume agentRef ${a.agentRef} ≠ durable ${c.refName}`);
      }
      return;
    }
    case "reindexed": {
      const a = artifacts as ReindexedArtifacts;
      const g = readGitOp(db, runId, "reindexed");
      if (!g || g.commitSha !== a.canonicalSha) {
        throw new GatingEvidenceError(state, `resume reindex canonicalSha ${a.canonicalSha} diverges from durable ${g?.commitSha ?? "<none>"}`);
      }
      // indexGeneration was ignored before (round-3 finding): the reindexed git op's
      // ref_name durably encodes `index-generation:<N>`; the resume must match it.
      if (g.refName !== `index-generation:${a.indexGeneration}`) {
        throw new GatingEvidenceError(state, `resume indexGeneration ${a.indexGeneration} ≠ durable ${g.refName}`);
      }
      return;
    }
    default:
      return;
  }
}

/** Read a run's planned tier (`change_plans.tier`), or `null` if not yet planned. */
export function readPlannedTier(db: SqliteDatabase, runId: string): number | null {
  const row = db
    .prepare(`SELECT tier FROM change_plans WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(runId) as { tier: number } | undefined;
  return row?.tier ?? null;
}

/** A run's persisted plan identity (the `patched` ownership evidence). */
export interface StoredPlan {
  readonly planId: string;
  readonly planHash: string;
  readonly tier: number;
}

/** Read a run's stored plan (`change_plans`), or `undefined` if not yet planned. */
export function readPlan(db: SqliteDatabase, runId: string): StoredPlan | undefined {
  const row = db
    .prepare(`SELECT plan_id, plan_hash, tier FROM change_plans WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(runId) as { plan_id: string; plan_hash: string; tier: number } | undefined;
  return row ? { planId: row.plan_id, planHash: row.plan_hash, tier: row.tier } : undefined;
}

// ── in-transaction immutable-artifact assertions (round-3 finding #5) ─────────

/**
 * Assert the persisted `change_plans` row for the run's plan is byte-for-byte the
 * intended one — owned by THIS run, with matching `plan_hash`/`tier`/`confidence`/
 * `summary`. Run INSIDE the `planned` transition transaction (after the idempotent
 * insert), so a `plan_id` already owned by a DIFFERENT run — or the same id with
 * different content — is rejected instead of silently ignored by `ON CONFLICT DO
 * NOTHING` (round-3 finding #5: conflict replays must match byte-for-byte or fail).
 */
export function assertPlanPersisted(db: SqliteDatabase, runId: string, a: PlannedArtifacts): void {
  const row = db
    .prepare(`SELECT run_id, tier, confidence, summary, plan_hash FROM change_plans WHERE plan_id = ?`)
    .get(a.planId) as
    | { run_id: string; tier: number; confidence: number; summary: string; plan_hash: string }
    | undefined;
  if (!row) throw new GatingEvidenceError("planned", `change_plans row for ${a.planId} did not persist`);
  if (row.run_id !== runId) {
    throw new GatingEvidenceError("planned", `plan ${a.planId} is owned by run ${row.run_id}, not ${runId}`);
  }
  if (row.plan_hash !== a.planHash || row.tier !== a.tier || row.confidence !== a.confidence || row.summary !== a.summary) {
    throw new GatingEvidenceError("planned", `plan ${a.planId} already persisted with different content (immutable-artifact conflict)`);
  }
}

/**
 * Assert the persisted `patches` row for `a.patchId` is byte-for-byte the intended
 * one — same `plan_id`/`note_id`/`patch_hash`/counts. Run INSIDE the `patched`
 * transition transaction so a reused `patch_id` carrying DIFFERENT content is
 * rejected rather than silently ignored (round-3 finding #5).
 */
export function assertPatchPersisted(db: SqliteDatabase, a: PatchedArtifacts): void {
  const row = db
    .prepare(`SELECT plan_id, note_id, changed_lines, changed_sections, patch_hash FROM patches WHERE patch_id = ?`)
    .get(a.patchId) as
    | { plan_id: string; note_id: string; changed_lines: number; changed_sections: number; patch_hash: string }
    | undefined;
  if (!row) throw new GatingEvidenceError("patched", `patches row for ${a.patchId} did not persist`);
  if (
    row.plan_id !== a.planId ||
    row.note_id !== a.noteId ||
    row.patch_hash !== a.patchHash ||
    row.changed_lines !== a.changedLines ||
    row.changed_sections !== a.changedSections
  ) {
    throw new GatingEvidenceError("patched", `patch ${a.patchId} already persisted with different content (immutable-artifact conflict)`);
  }
}

/**
 * Assert the DURABLE `agent_runs.status` for `runId` is NOW exactly `state` —
 * the post-write half of the persisted-state CAS (round-3 finding #2). Run INSIDE
 * the transition transaction AFTER the guarded {@link agentRunUpsert}: if the
 * `ON CONFLICT … WHERE status IN (expectedFrom)` guard blocked the update (a stale
 * handle racing a run that advanced), the row is unchanged and this throws
 * {@link CheckpointCasError}, rolling the whole transition (state + gating rows +
 * any audit_events row) back together — so an audit-emitting transition cannot
 * regress a run whose durable state changed after the pre-flight check.
 */
export function assertRowAdvancedTo(db: SqliteDatabase, runId: string, state: WorkflowState): void {
  const actual = readAgentRunStatus(db, runId);
  if (actual !== state) {
    throw new CheckpointCasError(runId, state, actual, state);
  }
}
