/**
 * `@atlas/models` — the typed model client (`generateText`/`generateObject`/`embed`)
 * driven over an IN-PROCESS Gemini adapter, plus CLI-side `model_calls` persistence
 * via `finalizeLedgerWrite` (D6/D18). Post the Phase-2 cutover the adapter, the
 * provider credential, and the outbound network all live HERE, in-process — there is
 * no egress daemon, no capability mint, no per-run budget, and no egress scan gate.
 * The credential is resolved LAZILY on the first provider call. This package no
 * longer imports `the retired egress broker`.
 */

export {
  ModelsClient,
  createInProcessInvoker,
  resolveGeminiApiKey,
  hasGeminiApiKey,
  GEMINI_API_KEY_ENV,
  GEMINI_KEYCHAIN_SERVICE,
  EgressInvokeParamsSchema,
  EgressRequestBodySchema,
  type Invoker,
  type InProcessInvokerConfig,
  type CallOptions,
  type SignalOrOptions,
  type GenerateObjectClientRequest,
  type RunBinding,
  type EgressInvokeParams,
  type EgressRequestBody,
  type EgressInvokeResult,
} from "./client.js";

export {
  GeminiAdapter,
  type GeminiAdapterConfig,
  type Transport,
  type ProviderAdapter,
  type SerializedRequest,
  type TransmittedResponse,
  type ParsedResult,
  type ResponseScanHook,
  type AttemptMeta,
} from "./gemini.js";

export {
  ProviderCallError,
  providerError,
  providerCallErrorFromBody,
} from "./provider-error.js";

export {
  DEFAULT_PROMPT_REGISTRY,
  MapPromptRegistry,
  PROMPT_REFS,
  resolvePromptOrThrow,
  type PromptRegistry,
  type ResolvedPrompt,
} from "./prompt-registry.js";

export {
  EgressRefusal,
  egressExitCodeFor,
  EGRESS_ERROR_CATALOG,
  type EgressCode,
  type ExitCode,
} from "./errors.js";

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
  GenerateTextResultSchema,
  EmbedResultSchema,
  ModelCallReceiptSchema,
  PROVIDER_OPERATIONS,
  SENSITIVITY_ORDER,
  type PromptRef,
  type Usage,
  type ProviderOperation,
  type GenerateTextRequest,
  type GenerateObjectRequest,
  type EmbedRequest,
  type GenerateTextResult,
  type EmbedResult,
  type ModelCallReceipt,
  type TransmissionOutcome,
  type ReceiptSink,
} from "./types.js";
