/**
 * Provider-error taxonomy (Task 1.1 — union type only; the model adapter that
 * produces these lands in Phase 2). This is the SSOT for the error *shape*; the
 * per-provider mapping lives with the adapter.
 */
import { z } from "zod";

/** The closed set of provider-error kinds. */
export const PROVIDER_ERROR_KINDS = [
  "validation",
  "authentication",
  "quota",
  "rate_limit",
  "timeout",
  "transport",
  "cancelled",
  "partial_batch",
  "model_incompatible",
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/**
 * Each variant carries `{retryable, retryAfter?}`. `retryAfter` is milliseconds
 * to wait before retrying, only meaningful when `retryable` is true.
 */
export const ProviderErrorSchema = z.object({
  kind: z.enum(PROVIDER_ERROR_KINDS),
  retryable: z.boolean(),
  retryAfter: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});

export type ProviderError = z.infer<typeof ProviderErrorSchema>;
