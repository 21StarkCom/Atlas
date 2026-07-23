/**
 * `@atlas/contracts` — the zero-dependency (Zod-only) process-seam leaf.
 *
 * Owns the stable IDs, canonical serialization, ChangePlan envelope, run
 * manifest, audit + authorization Zod mirrors, the provider-error taxonomy, and
 * the shared cross-boundary DTOs (D14). Consumed by the CLI (`domain`
 * re-export), `sqlite-store`, `git`, and both broker daemons; imports no
 * workspace package and never `apps/cli`.
 */

// Stable IDs (D3) + opaque salted IDs (§5.1)
export {
  type ContentId,
  type RenditionId,
  type SourceHandle,
  type OpaqueEntityKind,
  parseSourceHandle,
  serializeContentId,
  serializeRenditionId,
  newRunId,
  isUlid,
  saltedOpaqueId,
  ULID_RE,
  OPAQUE_ID_RE,
} from "./ids.js";

// Canonical serialization (§8.2 `atlas-jcs-v1`)
export { canonicalSerialize, canonicalStringify, CANONICALIZATION_ID } from "./canonical.js";

// Identity-key canonicalization (§2.7 `atlas-identity-key-v1`) + conformance vectors
export {
  type IdentityKeyVector,
  normalizeIdentityKey,
  IDENTITY_KEY_ALGORITHM_ID,
  IDENTITY_KEY_VECTORS,
} from "./identity.js";

// Shared primitive schemas
export {
  Ulid,
  OpaqueId,
  CommitHash,
  Rfc3339Ms,
  Nonce,
  Ed25519Sig,
  Ed25519PubKey,
  P256Sig,
  P256PubKey,
  AuthzSignature,
  PublicKeyString,
  Sha256Digest,
  SchemaVersion1,
} from "./primitives.js";

// ChangePlan envelope (per-op payloads are Phase 2)
export {
  type ChangePlanEnvelope,
  type RiskTier,
  type Reversibility,
  ChangePlanEnvelopeSchema,
  RISK_TIERS,
  REVERSIBILITY,
} from "./changeplan-envelope.js";

// ChangePlan operation payloads + full ChangePlan schema (Task 2.0 — Phase-2 gate)
export {
  type ChangePlan,
  type ChangePlanOperation,
  type ChangePlanOpName,
  type ReservedOpName,
  type OpResult,
  type OpResultStatus,
  ChangePlanSchema,
  ChangePlanOperationSchema,
  CHANGE_PLAN_OPERATION_NAMES,
  CHANGE_PLAN_OPS,
  RESERVED_OPS,
  OP_RESULT_STATUSES,
  isReservedOp,
} from "./changeplan.js";

// Per-operation payload schemas, error-code tuples, and result types (ops/*)
export * from "./ops/index.js";

// Shared generateObject schema registry (provider-interface §1) — the SSOT both
// the @atlas/models client and the in-broker Gemini adapter resolve schemaId against.
export {
  SCHEMA_REGISTRY,
  resolveRegisteredSchema,
  type SchemaRegistry,
} from "./schema-registry.js";

// Run manifest
export {
  type RunManifest,
  type WorkflowState,
  RunManifestSchema,
  WORKFLOW_STATES,
} from "./run-manifest.js";

// Audit + WORM anchor + signer registry + erasure (§5, §6, §9.2, §12)
export {
  type AuditEvent,
  type AuditEventKind,
  type LedgerEventKind,
  type AuditSubject,
  type SignedAuditEvent,
  type AuditAnchor,
  type AuditIdMapEntry,
  type SignerRegistryEntry,
  type TombstoneEvent,
  type SignedEnvelope,
  AuditEventSchema,
  AuditSubjectSchema,
  AuditAnchorSchema,
  AuditIdMapEntrySchema,
  SignerRegistryEntrySchema,
  TombstoneEventSchema,
  SignedEnvelopeSchema,
  AUDIT_EVENT_KINDS,
  LEDGER_EVENT_KINDS,
} from "./audit.js";

// Authorization challenge/response (§7)
export {
  type AuthorizationChallenge,
  type AuthorizationResponse,
  type IntendedEffect,
  AuthorizationChallengeSchema,
  AuthorizationResponseSchema,
  IntendedEffectSchema,
} from "./authorization.js";

// Provider-error taxonomy (union only; adapter is Phase 2)
export {
  type ProviderError,
  type ProviderErrorKind,
  ProviderErrorSchema,
  PROVIDER_ERROR_KINDS,
} from "./provider-errors.js";

// Shared cross-boundary DTOs (D14 — structural types)
export type {
  Sensitivity,
  NoteType,
  LocatorScheme,
  WikiLink,
  Relationship,
  SectionTree,
  ParsedNote,
  VaultError,
  VaultSnapshot,
  RepresentedGap,
  NormalizedRendition,
  Chunk,
} from "./dtos.js";

// Open note-type registry + shared schema-version authority (open type system, spec 2026-07-16)
export {
  resolveType, classificationToSensitivity, isRegisteredType,
  STRICT_TYPES, LOOSE_TYPES, STRICT_BASE_FIELDS, LOOSE_BASE_FIELDS,
  SCHEMA_VERSION, MANAGED_FRONTMATTER,
} from "./type-registry.js";
export type { TypeDef } from "./type-registry.js";
