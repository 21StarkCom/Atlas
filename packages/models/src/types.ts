/**
 * `@atlas/models` provider request/result types + the per-transmission receipt
 * (D6/D18). These shapes are now DEFINED here (Phase-2 in-process cutover): the
 * Gemini adapter runs in-process in this package, so the request/result/receipt
 * contracts live with it. Previously these were owned by `the retired egress broker` and
 * re-exported; that dependency is retired so `the retired egress broker` can be deleted in
 * Phase 3 with nothing dangling.
 *
 * A {@link ModelCallReceipt} is produced for EVERY transmission (success, provider
 * error, or refusal) so the CLI writes exactly one `model_calls` ledger row per
 * call. {@link ModelCallReceiptSchema} is a SURVIVOR — `model_calls` persistence
 * (`./ledger.js`, `./receipt-journal.js`) depends on it.
 */
import { z } from "zod";
import { Sha256Digest } from "@atlas/contracts";

/**
 * The three non-mutating provider operations. Defined locally (the retired egress
 * capability envelope owned the previous `EGRESS_OPERATIONS`; that type is dropped
 * with the broker). Used by the adapter's serialize/parse and the receipt schema.
 */
export const PROVIDER_OPERATIONS = ["generateText", "generateObject", "embed"] as const;
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

/**
 * Sensitivity classes (most- to least-restrictive order). Retained ONLY so the
 * receipt's optional `effectiveSensitivity` field keeps its enum validation; the
 * per-run sensitivity-ceiling enforcement (a capability concern) is dropped in the
 * in-process cutover.
 */
export const SENSITIVITY_ORDER = ["public", "internal", "confidential", "restricted"] as const;

/** A prompt reference — an id + version (`prompts/<name>@<n>`), never a raw inline prompt. */
export const PromptRefSchema = z.object({ ref: z.string().min(1) }).strict();
export type PromptRef = z.infer<typeof PromptRefSchema>;

/** Token usage (provider-interface §2). `outputTokens` is absent for `embed`. */
export const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;

// ---------------------------------------------------------------------------
// Provider requests (the exact serialized payload sent out).
// ---------------------------------------------------------------------------

export const GenerateTextRequestSchema = z
  .object({
    model: z.string().min(1),
    prompt: PromptRefSchema,
    input: z.string(),
    maxTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();
export type GenerateTextRequest = z.infer<typeof GenerateTextRequestSchema>;

export const GenerateObjectRequestSchema = z
  .object({
    model: z.string().min(1),
    prompt: PromptRefSchema,
    input: z.string(),
    /** A registry key resolved to a Zod schema on BOTH sides — never a schema body. */
    schemaId: z.string().min(1),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();
export type GenerateObjectRequest = z.infer<typeof GenerateObjectRequestSchema>;

export const EmbedRequestSchema = z
  .object({
    model: z.string().min(1),
    texts: z.array(z.string()).min(1),
    dimensions: z.number().int().positive(),
  })
  .strict();
export type EmbedRequest = z.infer<typeof EmbedRequestSchema>;

// ---------------------------------------------------------------------------
// Provider results.
// ---------------------------------------------------------------------------

export const GenerateTextResultSchema = z
  .object({
    text: z.string(),
    usage: UsageSchema,
    model: z.string().min(1),
    // Provider finish reason (e.g. "STOP", "MAX_TOKENS"), released so callers can
    // detect truncation instead of treating a cut fragment as a complete answer
    // (#211). Optional: absent when the provider omitted it (and in older fixtures).
    finishReason: z.string().min(1).optional(),
  })
  .strict();
export type GenerateTextResult = z.infer<typeof GenerateTextResultSchema>;

export const EmbedResultSchema = z
  .object({
    vectors: z.array(z.array(z.number())),
    dimensions: z.number().int().positive(),
    usage: UsageSchema,
    model: z.string().min(1),
  })
  .strict();
export type EmbedResult = z.infer<typeof EmbedResultSchema>;

// ---------------------------------------------------------------------------
// Per-transmission receipt (D18): allowlisted audit fields ONLY — request/response
// hashes, destination, model, tokens, latency, cost, retries. NEVER a raw payload.
// ---------------------------------------------------------------------------

/** Whether a transmission succeeded, was refused, or hit a provider error. */
export const TRANSMISSION_OUTCOMES = ["success", "refused", "error"] as const;
export type TransmissionOutcome = (typeof TRANSMISSION_OUTCOMES)[number];

export const ModelCallReceiptSchema = z
  .object({
    runId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    operation: z.enum(PROVIDER_OPERATIONS),
    /** sha256 of the exact serialized request payload (the idempotency key component). */
    requestHash: Sha256Digest,
    /** sha256 of the exact serialized response payload; absent when no response was produced. */
    responseHash: Sha256Digest.optional(),
    /** The provider endpoint host (allowlisted; e.g. `generativelanguage.googleapis.com`). */
    destination: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** Integer micro-USD cost attributed to this transmission. */
    costMicros: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    /** Adapter retry attempts consumed before the terminal outcome. */
    retries: z.number().int().nonnegative(),
    outcome: z.enum(TRANSMISSION_OUTCOMES),
    /** Stable refusal/error code when `outcome !== "success"` (egress code or provider-error kind). */
    reasonCode: z.string().min(1).optional(),
    /** The effectiveSensitivity evaluated for the payload (retained field; unset in-process). */
    effectiveSensitivity: z.enum(SENSITIVITY_ORDER).optional(),
  })
  .strict();
export type ModelCallReceipt = z.infer<typeof ModelCallReceiptSchema>;

/** A sink the client calls for EVERY transmission (success, refusal, or provider
 * error) so the CLI writes exactly one `model_calls` row per call (D6/D18). */
export type ReceiptSink = (receipt: ModelCallReceipt) => void | Promise<void>;
