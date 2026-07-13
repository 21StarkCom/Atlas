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
export { BrokerClient } from "./client.js";

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
  type ProtectedRefs,
  type RefAdvanceRequest,
  type RefAdvanceResult,
  type SourceCaptureRequest,
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
  BROKER_METHODS,
  type BrokerMethod,
  type BrokerRequest,
  type BrokerResponse,
  type RequestParse,
} from "./protocol.js";
