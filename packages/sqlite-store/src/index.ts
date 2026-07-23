/**
 * `@atlas/sqlite-store` — the persistence core. Owns `0001_core` (all non-jobs
 * tables) and consumes `VaultSnapshot` from `@atlas/contracts` (never
 * `apps/cli`, D14). Exposes the connection, the gap-tolerant migration runner,
 * transactional projection rebuild, the post-restore rebuild hook registry, and
 * `db verify`.
 */
export { openConnection, openReadonlyLedger, ledgerSchemaState, captureLedgerIdentity } from "./connection.js";
// TEST-ONLY: the inter-open race-injection seam + attempt counter (see
// `test/readonly-open.test.ts`). Production code never imports these.
export {
  __setReadonlyInterOpenHook,
  __setReadonlyPostDbOpenHook,
  __setReadonlyVerifyWindowHook,
  __lastOpenAttempts,
} from "./connection.js";
export type { SqliteConfig, SqliteDatabase, LedgerIdentity, ReadonlyLedger } from "./connection.js";

export {
  bootstrapMigrationsTable,
  migrationChecksum,
  runMigrations,
  MigrationChecksumError,
  DuplicateMigrationError,
} from "./migrate.js";
export type { Migration, MigrationReport, AppliedMigration } from "./migrate.js";

export {
  rebuildProjections,
  registerPostRestoreRebuild,
  runPostRestoreRebuild,
  postRestoreRebuildStepCount,
  _resetPostRestoreRebuild,
  registerProjectionFold,
  projectionFoldCount,
  _resetProjectionFolds,
  registerPreClear,
  preClearStepCount,
  _resetPreClears,
  IDENTITY_NORMALIZER_VERSION,
  DEFAULT_LINK_PREDICATE,
  SCHEMA_PROJECTION_EPOCH,
  SnapshotHasErrorsError,
  DanglingLinkError,
  deriveSlug,
  noteIdentityKeys,
} from "./rebuild.js";
export type {
  RebuildReport,
  RebuildOptions,
  RebuildCtx,
  PostRestoreRebuildStep,
  ProjectionFold,
  PreClearStep,
} from "./rebuild.js";

// 60-B Task 2.2: the shared per-note derivation primitive + the incremental,
// note-scoped `notes`-projection fold (O(delta), caller-supplied resolver).
export { deriveAndPersistNote } from "./note-derivation.js";
export { foldNotesForPaths } from "./fold-notes-for-paths.js";
export { foldNotesV2 } from "./fold-notes-v2.js";

export {
  foldProvenanceManifests,
  MalformedManifestError,
  DanglingSourceError,
} from "./provenance/fold.js";

export {
  foldClaimManifests,
  clearClaimsProjection,
  MalformedClaimError,
  DanglingEvidenceError,
} from "./claims/fold.js";

export { verify, checkQueryPlans } from "./verify.js";
export type { VerifyReport, InvariantViolation, QueryPlanViolation } from "./verify.js";

export { openStore, registerGenerationMigration, registerSyncCursorsMigration } from "./store.js";
export type { Store, Clock } from "./store.js";

export { ProjectionRepo } from "./repos/projections.js";
export type {
  NoteRow,
  IdentityKeyRow,
  NoteLinkRow,
  VaultSchemaMigrationRow,
} from "./repos/projections.js";
export { LedgerRepo, AuditEventConflictError } from "./repos/ledger.js";
export type { AgentRunRow, AuditEventRow } from "./repos/ledger.js";
export { GenerationRepo } from "./repos/generation.js";
export type { NoteFenceRow, GenerationClock } from "./repos/generation.js";

// Ledger finalization + §2.8 cross-store orchestration (Task 1.7).
export { finalizeLedgerWrite, runBackupStep, readCoalesceCovers, READ_COALESCE_THRESHOLD } from "./ledger/finalize.js";
export type { AuditBroker, FinalizeStep, FinalizeResult, RunContext } from "./ledger/finalize.js";
export {
  IntentsRepo,
  applyLedgerWrite,
  payloadHashOf,
  nextDbEventSeq,
  latestRunSeq,
  LedgerAssertionError,
  DB_EVENT_SEQ_BASE,
} from "./ledger/intents.js";
export type {
  AuditEventDraft,
  UnsignedAuditEvent,
  AuditIntentRow,
  AllocatedIntent,
  LedgerStatement,
  LedgerAssertion,
} from "./ledger/intents.js";
export { reconcileInterruptedRuns } from "./ledger/reconcile.js";
export type { ReconcileOptions, ReconcileReport } from "./ledger/reconcile.js";

// Encrypted backup / verify / restore (Task 1.7).
export {
  takeBackup,
  verifyBackup,
  decryptBackup,
  readBundleHeader,
  listBackups,
  pruneRetention,
  resolveBackupRef,
  registerKnownSchemaHead,
} from "./backup/backup.js";
export type { LedgerBackupConfig, BackupResult, CatalogEntry } from "./backup/backup.js";
export { restoreBackup, forceUnblock, recoverInterruptedRestore } from "./backup/restore.js";
export type { RestoreOptions, RestoreResult, RestoreStep, RestoreRecovery } from "./backup/restore.js";
export {
  WatermarkRepo,
  watermarkHealth,
  assertBackupHealthy,
  BackupUnhealthyError,
  BACKUP_UNHEALTHY_CODE,
  BACKUP_UNHEALTHY_EXIT,
} from "./backup/watermark.js";
export type { WatermarkHealth, BackupWatermarkRow } from "./backup/watermark.js";
export {
  seal,
  open as openBackupBundle,
  contentHashOf,
  BackupIntegrityError,
  BUNDLE_MAGIC,
  BUNDLE_VERSION,
  AEAD_KEY_BYTES,
} from "./backup/aead.js";
export type { Bundle, BundleHeader } from "./backup/aead.js";

export { migration0001Core, CORE_DDL } from "../migrations/0001_core.js";
export { migration0003Provenance, PROVENANCE_DDL } from "../migrations/0003_provenance.js";
export { migration0004Claims, CLAIMS_DDL } from "../migrations/0004_claims.js";
export { migration0005LedgerFinalize, LEDGER_FINALIZE_DDL } from "../migrations/0005_ledger_finalize.js";
// Feature migration (Task 2.5) — NOT in openStore's default retained set; the
// workflows layer registers it at store-open (see 0006's header / round finding #3).
export { migration0006WorkflowIdempotency, WORKFLOW_IDEMPOTENCY_DDL } from "../migrations/0006_workflow_idempotency.js";
export { migration0008IndexConfigRevision, INDEX_CONFIG_REVISION_DDL } from "../migrations/0008_index_config_revision.js";
// Feature migration (Task 4.5 §refresh) — NOT in openStore's default retained set; the
// workflows layer registers it at store-open alongside 0006 (see 0009's header).
export { migration0009RunSupersessions, RUN_SUPERSESSIONS_DDL } from "../migrations/0009_run_supersessions.js";
// Feature migration (Task 4.8 trust projection) — registered by the workflows layer at store-open.
export { migration0010TrustState, TRUST_STATE_DDL } from "../migrations/0010_trust_state.js";
export { migration0011RunInputs, RUN_INPUTS_DDL } from "../migrations/0011_run_inputs.js";
export { migration0012SyncCursors, SYNC_CURSORS_DDL } from "../migrations/0012_sync_cursors.js";
export { migration0013LinksV2, LINKS_V2_DDL } from "../migrations/0013_links_v2.js";
export { migration0014EvidenceV2, EVIDENCE_V2_DDL } from "../migrations/0014_evidence_v2.js";

export { ProvenanceRepo, captureId } from "./repos/provenance.js";
export type {
  ContentBlobRow,
  SourceCaptureRow,
  SourceRenditionRow,
  NoteSourceRow,
  RenditionComponents,
} from "./repos/provenance.js";

export { ClaimsRepo, payloadHash, evidenceIdFor, SENTINEL_NONE } from "./repos/claims.js";
export type {
  ClaimRow,
  ClaimEvidenceRow,
  AttachEvidenceInput,
  EvidenceVerification,
} from "./repos/claims.js";
