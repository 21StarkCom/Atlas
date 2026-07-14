/**
 * `ProviderCallError` — the throwable form of the `@atlas/contracts` `ProviderError`
 * taxonomy. The Gemini adapter throws it; the egress server serializes its
 * `ProviderError` body across the IPC seam; the `@atlas/models` client re-throws an
 * identical instance so a CLI caller (and the jobs runner's `classifyError`) sees
 * the same discriminated `kind` + retryability locally and remotely.
 *
 * The provider `Retry-After` is propagated into BOTH `retryAfter` (the ms field the
 * `ProviderError` schema carries) and `retryAfterMs` (the CLI error-envelope alias
 * the provider-interface fixes) so either reader resolves the same delay.
 */
import { ProviderErrorSchema, type ProviderError, type ProviderErrorKind } from "@atlas/contracts";

export class ProviderCallError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  /** Provider-directed retry delay in ms (present only for `rate_limit`/`quota`). */
  readonly retryAfter?: number;
  /** CLI error-envelope alias for {@link retryAfter} (provider-interface §5). */
  readonly retryAfterMs?: number;
  /** Input-order indices whose vectors computed (present only for `partial_batch`). */
  readonly succeededIndices?: readonly number[];
  /**
   * Sanitized attempt metadata set by the adapter's `transmit` when a dispatch
   * terminally fails — the retry count consumed and the outbound bytes actually
   * sent. The broker uses it to populate the receipt's `retries` and to charge the
   * dispatched call's bytes to the run budget even on error (D6/D19). NEVER a
   * payload or a secret.
   */
  attempt?: { readonly retries: number; readonly requestBytes: number };

  constructor(body: ProviderError) {
    super(body.message ?? body.kind);
    this.name = "ProviderCallError";
    this.kind = body.kind;
    this.retryable = body.retryable;
    if (body.kind === "rate_limit" || body.kind === "quota") {
      if (body.retryAfter !== undefined) {
        this.retryAfter = body.retryAfter;
        this.retryAfterMs = body.retryAfter;
      }
    }
    if (body.kind === "partial_batch") this.succeededIndices = body.succeededIndices;
  }

  /** Attach sanitized attempt metadata (returns `this` for a fluent throw). */
  withAttempt(attempt: { retries: number; requestBytes: number }): this {
    this.attempt = attempt;
    return this;
  }

  /** The validated `ProviderError` body (what crosses the IPC seam). */
  toBody(): ProviderError {
    return providerError(this.kind, {
      message: this.message,
      ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
      ...(this.succeededIndices !== undefined ? { succeededIndices: [...this.succeededIndices] } : {}),
    });
  }
}

/**
 * Build a validated `ProviderError` body. `retryable` is FIXED per kind by the
 * schema (never caller-chosen); this fills it deterministically and drops fields a
 * kind does not carry, then validates against the SSOT schema so a malformed
 * mapping is a hard error, not a silent wire corruption.
 */
export function providerError(
  kind: ProviderErrorKind,
  opts: { message?: string; retryAfter?: number; succeededIndices?: number[] } = {},
): ProviderError {
  const retryable = !(kind === "validation" || kind === "authentication" || kind === "cancelled" || kind === "model_incompatible");
  const base: Record<string, unknown> = { kind, retryable };
  if (opts.message !== undefined) base.message = opts.message;
  if ((kind === "rate_limit" || kind === "quota") && opts.retryAfter !== undefined) base.retryAfter = opts.retryAfter;
  if (kind === "partial_batch") base.succeededIndices = opts.succeededIndices ?? [];
  return ProviderErrorSchema.parse(base);
}

/** Rebuild a `ProviderCallError` from a wire `ProviderError` body (client side). */
export function providerCallErrorFromBody(raw: unknown): ProviderCallError {
  return new ProviderCallError(ProviderErrorSchema.parse(raw));
}
