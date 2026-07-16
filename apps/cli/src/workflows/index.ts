/**
 * `workflows` — the persisted run state machine + reconciler (Task 2.5). The
 * durable engine behind capture (Phase 2) and synthesis (Phase 4), driven by
 * `docs/specs/recovery-state-machine.md`. Barrel of the module's public surface.
 */
export {
  startRun,
  RunHandle,
  RunAbortedError,
  recordIntegration,
  beginIdempotentCommand,
  type WorkflowDeps,
  type RunKind,
  type RunInput,
  type TerminalRun,
  type TerminalExtras,
  type IdempotentStart,
  type RunIntegrator,
  type IntegrationContext,
  type BrokerIntegration,
  type IntegratedResult,
} from "./engine.js";

export {
  TerminalAuditDetailSchema,
  parseTerminalAuditDetail,
  buildTerminalDetail,
  type TerminalAuditDetail,
} from "./terminal-audit-detail.js";

export {
  reconcileRunsOnStartup,
  type ReconcileDeps,
  type ReconcileHooks,
  type ReconcileRunContext,
  type ReconcileRunsReport,
  type RunReconcileOutcome,
  type RecomputePlanResult,
  type RecomputePatchResult,
} from "./reconciler.js";

export {
  assembleRunReport,
  type RunReport,
  type RunArtifacts,
  type RunAuditEvent,
} from "./run-report.js";

export {
  assertCheckpointTransition,
  assertPersistedState,
  assertPlanPersisted,
  assertPatchPersisted,
  assertRowAdvancedTo,
  canTerminateFrom,
  isCheckpoint,
  readPlan,
  sha256Canonical,
  IllegalTransitionError,
  CheckpointCasError,
  GatingEvidenceError,
  CHECKPOINT_STATES,
  TERMINAL_STATES,
  CHECKPOINT_NEXT,
  TERMINABLE_FROM,
  CHECKPOINT_AUDIT,
  type CheckpointState,
  type PlannedArtifacts,
  type PatchedArtifacts,
  type WorktreeAppliedArtifacts,
  type AgentCommittedArtifacts,
  type ReviewPendingArtifacts,
  type IntegratedArtifacts,
  type ReindexedArtifacts,
} from "./checkpoints.js";

export {
  refreshRun,
  RefreshError,
  type SynthesisRefreshDeps,
  type RefreshResult,
} from "./refresh.js";

export {
  decideApprove,
  canReject,
  type ApproveDecision,
  type ApproveInput,
} from "./approve.js";

export {
  approveRun,
  rejectRun,
  ApproveError,
  type ApproveDeps,
  type ApproveOutcome,
} from "./approve-run.js";

export {
  reviewRun,
  verifyRun,
  type ReviewReport,
  type VerifyReport,
  type VerifyDivergence,
} from "./review.js";

export {
  rebuildFromGit,
  type FromGitReport,
  type FromGitGap,
} from "./rebuild-from-git.js";

export {
  makeBrokerIntegrator,
  type BrokerIntegratorAuth,
} from "./broker-integrator.js";

export {
  classifyRollback,
  renditionDependents,
  type RollbackClass,
  type RollbackClassification,
  type RunToRollback,
} from "./rollback.js";

export {
  rollbackRun,
  RollbackError,
  type RollbackDeps,
  type RollbackOutcome,
} from "./rollback-run.js";

export {
  enqueueReverification,
  classifyReanchor,
  reverifyKey,
  REVERIFY_WORKFLOW,
  type RenditionBump,
  type ReverifyJobPayload,
  type ReanchorMatch,
  type ReanchorOutcome,
} from "./reverify.js";

export {
  beginIdempotent,
  completeIdempotent,
  completeIdempotentStatement,
  releaseIdempotent,
  reconcileIdempotency,
  registerWorkflowMigrations,
  openWorkflowStore,
  IdempotencyKeyConflictError,
  IdempotencyInProgressError,
  IdempotencyOwnershipError,
  type IdempotencyRequest,
  type IdempotencyOutcome,
} from "./idempotency.js";
