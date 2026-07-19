/**
 * `@atlas/broker` — the integration broker: sole protected-ref mutator.
 *
 * Owns challenge mint/verify, Ed25519 authorization verification, protected-ref
 * CAS advance (ancestry + signature + audit re-verification), the narrowly
 * scoped `integrateSourceCapture`, signed audit-ref append with a monotonic seq
 * + WORM anchor, and the client library. Acyclic seam: this package NEVER
 * imports `@atlas/sqlite-store` (§2.8; `broker.no-ledger-dep.test`).
 */

// Client library (the CLI/ledger side consumes this).
export { BrokerClient, type AuditChainStatus } from "./client.js";

// In-process service + config (the daemon + tests wire this).
export {
  BrokerService,
  type BrokerServiceConfig,
  type AttestationKey,
  type PrivilegedOpResult,
} from "./service.js";

// Socket server (the daemon entry point uses this).
export { startBrokerServer, type BrokerServer } from "./server.js";

// Authorization core.
export {
  Authorizer,
  buildSigningPayload,
  TEST_SIGNER_ID,
  type PrivilegedOpDescriptor,
  type VerifyContext,
  type ExpectedAuthorization,
} from "./authorize.js";

// Protected-ref primitives.
export {
  ProtectedRefWriter,
  isCaptureAllowedPath,
  isNoteAddAllowedPath,
  type CaptureScope,
  type ProtectedRefs,
  type RefAdvanceRequest,
  type RefAdvanceResult,
  type SourceCaptureRequest,
  type SignAndSourceCaptureRequest,
  type SignAndAdvanceRequest,
  type AuthorizedOp,
} from "./refs.js";

// Audit append + WORM anchor.
export {
  AuditLog,
  type AppendResult,
  type PublicKeyResolver,
  type AttestationTrustRoot,
} from "./audit-append.js";
export { WormAnchor, rfc3339Ms } from "./anchor.js";

// Nonce store.
export { NonceStore, DEFAULT_NONCE_TTL_SECONDS } from "./nonce.js";

// Config loading (production path).
export {
  loadBrokerConfigFromEnv,
  loadSignerRegistry,
  deriveSignerRegistryFromKeyFiles,
  loadAttestationKey,
  defaultAnchorPath,
  DEFAULT_CANONICAL_REF,
  DEFAULT_PROTECTED_REFS,
  DEFAULT_ATTESTATION_SIGNER_ID,
  DEFAULT_APPROVER_SIGNER_ID,
  SIGNATURE_AUTHORIZABLE_OPS,
} from "./keys.js";

// Crypto helpers (the test signer + provisioning fixtures consume these).
export {
  generateEd25519,
  signBytes,
  verifyBytes,
  signRaw,
  verifyRaw,
  signEnvelope,
  verifyEnvelope,
  serializePublicKey,
  parsePublicKey,
  parsePublicKeyFlexible,
  serializePrivateKey,
  parsePrivateKey,
  parsePrivateKeyFlexible,
  type GeneratedKeyPair,
} from "./crypto.js";

// Error taxonomy.
export {
  BrokerRefusal,
  AUTHZ_ERROR_CATALOG,
  BROKER_ERROR_CATALOG,
  exitCodeFor,
  type AuthzCode,
  type BrokerCode,
  type RefusalCode,
  type ExitCode,
} from "./errors.js";

// Wire protocol.
export {
  encodeFrame,
  FrameDecoder,
  validateRequest,
  validateResponse,
  validateResult,
  isBadRequestRefusal,
  badRequestRefusal,
  BROKER_METHODS,
  type BrokerMethod,
  type BrokerRequest,
  type BrokerResponse,
  type RequestParse,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Egress broker (D13(c)/D17/D18/D19): sole credential + sole outbound-network
// process. Scans the exact serialized payload both directions, enforces the
// run-bound capability + per-run budget, and returns a receipt (no SQLite here).
// ---------------------------------------------------------------------------

export {
  mintEgressCapability,
  verifyCapability,
  sensitivityRank,
  SENSITIVITY_ORDER,
  EGRESS_OPERATIONS,
  DEFAULT_CAPABILITY_KEY_ID,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  EgressCapabilitySchema,
  EgressCapabilityClaimsSchema,
  type EgressCapability,
  type EgressCapabilityClaims,
  type EgressLimits,
  type EgressOperation,
  type CapabilitySensitivity,
  type RunBinding,
  type CapabilityVerdict,
} from "./egress/capability.js";

export {
  EgressService,
  startEgressServer,
  type EgressServer,
  type EgressServiceConfig,
  type InvokeOutcome,
} from "./egress/server.js";

export { EgressClient, type EgressInvokeResult } from "./egress/client.js";

export {
  GeminiAdapter,
  type ProviderAdapter,
  type Transport,
  type GeminiAdapterConfig,
  type SerializedRequest,
  type TransmittedResponse,
  type ParsedResult,
  type AttemptMeta,
  type ResponseScanHook,
} from "./egress/gemini.js";

export { RunBudget, type BudgetVerdict, type BudgetRefusalCode, type BudgetReservation } from "./egress/budget.js";

export { FileBudgetStore, type BudgetStore, type PersistedTally } from "./egress/budget-store.js";

export { scanEgressPayload, type ScanDirection } from "./egress/scan.js";

export {
  SealedSpoolQuarantineSink,
  sealSpoolEnvelope,
  openSpoolEnvelope,
  SPOOL_MAGIC,
  SPOOL_VERSION,
  type SealedSpoolQuarantineOptions,
  type SealedSpoolEnvelope,
  type OpenedSpoolItem,
} from "./egress/spool-quarantine.js";

export {
  ProviderCallError,
  providerError,
  providerCallErrorFromBody,
} from "./egress/provider-error.js";

export { DEFAULT_SCHEMA_REGISTRY, resolveSchema } from "./egress/schema-registry.js";

export {
  DEFAULT_PROMPT_REGISTRY,
  MapPromptRegistry,
  PROMPT_REFS,
  resolvePromptOrThrow,
  type PromptRegistry,
  type ResolvedPrompt,
} from "./egress/prompt-registry.js";

export {
  validateEgressRequest,
  validateEgressResponse,
  EgressInvokeParamsSchema,
  EgressRequestBodySchema,
  type EgressInvokeParams,
  type EgressRequestBody,
  type EgressResponse,
} from "./egress/protocol.js";

export {
  PromptRefSchema,
  UsageSchema,
  GenerateTextRequestSchema,
  GenerateObjectRequestSchema,
  EmbedRequestSchema,
  GenerateTextResultSchema,
  EmbedResultSchema,
  ModelCallReceiptSchema,
  TRANSMISSION_OUTCOMES,
  type PromptRef,
  type Usage,
  type GenerateTextRequest,
  type GenerateObjectRequest,
  type EmbedRequest,
  type GenerateTextResult,
  type EmbedResult,
  type ModelCallReceipt,
  type TransmissionOutcome,
} from "./egress/types.js";

export {
  EgressRefusal,
  EGRESS_ERROR_CATALOG,
  egressExitCodeFor,
  type EgressCode,
} from "./egress/errors.js";
