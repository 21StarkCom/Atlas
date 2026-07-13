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

/** Human-readable, sanitized diagnostic (never a secret) carried by any variant. */
const message = z.string().optional();
/** Provider-directed retry delay (ms), propagated from a `Retry-After` header. */
const retryAfter = z.number().int().nonnegative().optional();

/**
 * `ProviderErrorSchema` is a DISCRIMINATED UNION over `kind` (fixes R3-F: a flat
 * permissive object let a `partial_batch` omit `succeededIndices`, let unrelated
 * kinds carry it, and let any kind pick an arbitrary `retryable`). Each variant
 * encodes exactly the retryability + payload the provider-interface mapping rules
 * (provider-interface §5) fix for that kind:
 *
 * - `retryable` is a LITERAL per kind — the mapping is not caller-chosen:
 *   `rate_limit | quota | timeout | transport | partial_batch` ⇒ `true`;
 *   `authentication | validation | model_incompatible | cancelled` ⇒ `false`.
 * - `retryAfter` (ms) is accepted ONLY on `rate_limit` / `quota` (the two kinds
 *   that propagate a provider `Retry-After`); every other variant omits it.
 * - `succeededIndices` (input-order indices whose vectors computed) is REQUIRED
 *   on `partial_batch` and accepted on NO other kind — a partial batch is never
 *   persisted as complete (provider-interface §3), so the caller always learns
 *   which indices to re-drive.
 *
 * `.strict()` on every member means a stray field (e.g. `succeededIndices` on a
 * `timeout`) is a hard rejection, not a silently-stripped key.
 */
export const ProviderErrorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("validation"), retryable: z.literal(false), message }).strict(),
  z.object({ kind: z.literal("authentication"), retryable: z.literal(false), message }).strict(),
  z.object({ kind: z.literal("quota"), retryable: z.literal(true), retryAfter, message }).strict(),
  z.object({ kind: z.literal("rate_limit"), retryable: z.literal(true), retryAfter, message }).strict(),
  z.object({ kind: z.literal("timeout"), retryable: z.literal(true), message }).strict(),
  z.object({ kind: z.literal("transport"), retryable: z.literal(true), message }).strict(),
  z.object({ kind: z.literal("cancelled"), retryable: z.literal(false), message }).strict(),
  z
    .object({
      kind: z.literal("partial_batch"),
      retryable: z.literal(true),
      succeededIndices: z.array(z.number().int().nonnegative()),
      message,
    })
    .strict(),
  z.object({ kind: z.literal("model_incompatible"), retryable: z.literal(false), message }).strict(),
]);

export type ProviderError = z.infer<typeof ProviderErrorSchema>;
