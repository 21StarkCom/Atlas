/**
 * `@atlas/models` public types. The request/result/receipt shapes + the provider
 * error/refusal classes are OWNED by the egress side (`@atlas/broker`, which holds
 * the adapter that produces them); this module re-exports them so a CLI caller
 * depends only on `@atlas/models` for the whole typed IPC surface.
 */
export type {
  PromptRef,
  Usage,
  GenerateTextRequest,
  GenerateObjectRequest,
  EmbedRequest,
  GenerateTextResult,
  EmbedResult,
  ModelCallReceipt,
  TransmissionOutcome,
} from "@atlas/broker";

export {
  GenerateTextResultSchema,
  EmbedResultSchema,
  ModelCallReceiptSchema,
} from "@atlas/broker";

export { ProviderCallError, EgressRefusal } from "@atlas/broker";

export type {
  EgressCapability,
  EgressLimits,
  EgressOperation,
  CapabilitySensitivity,
} from "@atlas/broker";

/** A sink the client calls for EVERY transmission (success, refusal, or provider
 * error) so the CLI writes exactly one `model_calls` row per call (D6/D18). */
export type ReceiptSink = (receipt: import("@atlas/broker").ModelCallReceipt) => void | Promise<void>;
