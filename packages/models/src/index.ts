/**
 * `@atlas/models` — the typed IPC client for the egress broker
 * (`generateText`/`generateObject`/`embed`), CLI-side capability minting (D19),
 * and CLI-side `model_calls` persistence via `finalizeLedgerWrite` (D6/D18). The
 * Gemini adapter, the provider credential, the outbound network, and the payload
 * scan all live INSIDE the egress broker (`@atlas/broker`) — this package never
 * touches a provider key or the network.
 */

export {
  ModelsClient,
  type Invoker,
  type CallOptions,
  type SignalOrOptions,
  type GenerateObjectClientRequest,
} from "./client.js";

export {
  mintEgressCapability,
  setCapabilityMintSecretResolver,
  CAPABILITY_KEY_ENV,
  DEFAULT_CAPABILITY_KEY_ID,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  SENSITIVITY_ORDER,
  EGRESS_OPERATIONS,
  type CapabilityMintSecretResolver,
  type EgressCapability,
  type EgressLimits,
  type EgressOperation,
  type CapabilitySensitivity,
  type RunBinding,
} from "./capability.js";

export {
  buildModelCallStatement,
  persistModelCalls,
  modelCallId,
  modelCallAuditRecord,
  ModelCallAuditRecordSchema,
  type PersistModelCallsOptions,
  type ModelCallAuditRecord,
} from "./ledger.js";

export {
  DurableReceiptSink,
  loadJournaledReceipts,
  finalizeRunModelCalls,
  type FinalizeRunModelCallsOptions,
} from "./receipt-journal.js";

export {
  ProviderCallError,
  EgressRefusal,
  GenerateTextResultSchema,
  EmbedResultSchema,
  ModelCallReceiptSchema,
  type PromptRef,
  type Usage,
  type GenerateTextRequest,
  type GenerateObjectRequest,
  type EmbedRequest,
  type GenerateTextResult,
  type EmbedResult,
  type ModelCallReceipt,
  type TransmissionOutcome,
  type ReceiptSink,
} from "./types.js";
