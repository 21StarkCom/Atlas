/**
 * Egress provider request/result types + the per-transmission receipt (D6/D18).
 *
 * These are the versioned framed-JSON shapes validated by `@atlas/contracts`-style
 * Zod schemas on both sides of the egress IPC seam (provider-interface §2). They
 * live in `@atlas/broker` (the egress side owns the adapter that produces them) and
 * are re-exported by `@atlas/models` for callers. The Gemini adapter maps every
 * failure to a `@atlas/contracts` `ProviderError`; the broker maps a refusal to an
 * {@link EgressRefusal}. Either way a {@link ModelCallReceipt} is produced for the
 * transmission so the CLI writes exactly one `model_calls` ledger row (egress has
 * no SQLite, D18).
 */
import { z } from "zod";
import { Sha256Digest } from "@atlas/contracts";
import { EGRESS_OPERATIONS, SENSITIVITY_ORDER } from "./capability.js";

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
// Provider requests (the exact serialized payload scanned in-broker + sent out).
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
    /** A registry key resolved to a Zod schema on BOTH sides — never a schema body over IPC. */
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
  .object({ text: z.string(), usage: UsageSchema, model: z.string().min(1) })
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

/** Whether a transmission succeeded, was refused in-broker, or hit a provider error. */
export const TRANSMISSION_OUTCOMES = ["success", "refused", "error"] as const;
export type TransmissionOutcome = (typeof TRANSMISSION_OUTCOMES)[number];

export const ModelCallReceiptSchema = z
  .object({
    runId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    operation: z.enum(EGRESS_OPERATIONS),
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
    /** The effectiveSensitivity the broker evaluated for the payload (declared value in Phase 2). */
    effectiveSensitivity: z.enum(SENSITIVITY_ORDER).optional(),
  })
  .strict();
export type ModelCallReceipt = z.infer<typeof ModelCallReceiptSchema>;
