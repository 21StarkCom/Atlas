/**
 * `@atlas/sqlite-store` — the persistence core. Owns `0001_core` (all non-jobs
 * tables) and consumes `VaultSnapshot` from `@atlas/contracts` (never
 * `apps/cli`, D14). Exposes the connection, the gap-tolerant migration runner,
 * transactional projection rebuild, the post-restore rebuild hook registry, and
 * `db verify`.
 */
export { openConnection } from "./connection.js";
export type { SqliteConfig, SqliteDatabase } from "./connection.js";

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
} from "./rebuild.js";
export type {
  RebuildReport,
  RebuildOptions,
  RebuildCtx,
  PostRestoreRebuildStep,
  ProjectionFold,
  PreClearStep,
} from "./rebuild.js";

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

export { openStore } from "./store.js";
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

export { migration0001Core, CORE_DDL } from "../migrations/0001_core.js";
export { migration0003Provenance, PROVENANCE_DDL } from "../migrations/0003_provenance.js";
export { migration0004Claims, CLAIMS_DDL } from "../migrations/0004_claims.js";

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
