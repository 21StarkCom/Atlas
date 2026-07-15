/**
 * The production {@link Embedder} adapter (Task 3.2, round-2 finding 4).
 *
 * `indexNote` consumes a typed {@link Embedder} seam: a batch embed that returns a
 * discriminated success/failure and NEVER throws across the boundary, so a
 * permanent provider fault becomes the required typed, repairable
 * `embedding-failed` outcome (and a retryable one becomes `embedding-retryable`).
 * But the real `@atlas/models` `ModelsClient.embed` returns an `EmbedResult` and
 * **throws** `ProviderCallError` on a provider fault. This adapter bridges the two:
 * it calls the client, returns `{ ok: true, vectors }` on success, and CATCHES a
 * provider fault, mapping its `kind` / `retryable` / `retryAfterMs` onto the typed
 * failure outcome. Without this seam a real permanent failure would reject
 * (throw) instead of surfacing as a repairable outcome.
 *
 * ## Matching the real `ModelsClient.embed` signature (round-3 finding 4/6)
 * The real API is `ModelsClient.embed(request, capability, options?)` — a
 * run-bound {@link https EgressCapability} is a REQUIRED second argument (D19), and
 * the third is per-call options (`AbortSignal` / `declaredSensitivity`). The
 * adapter's {@link EmbedClient} therefore has that exact 3-arg shape, and
 * {@link embedderFromClient} is a **capability-closing adapter**: it closes over the
 * capability the caller minted for the run and threads it (plus any options) into
 * every `embed` call, exposing the flat `(texts) => EmbedOutcome` seam `indexNote`
 * consumes. Its acceptance test drives a REAL `ModelsClient` (over a fake transport)
 * with a REAL minted capability, so the seam is exercised against the true API, not
 * a 1-arg stand-in.
 *
 * ## D14 — no `@atlas/models` import in production
 * `@atlas/lancedb-index` must not import `@atlas/models` / `@atlas/broker` (D14).
 * So the adapter is **structural**: it accepts anything shaped like the embed call
 * ({@link EmbedClient}) — the capability type is an opaque generic `Cap` this
 * package never inspects — and recognizes a thrown provider fault by its STABLE
 * public shape — the `@atlas/contracts` `ProviderErrorKind` taxonomy that
 * `ProviderCallError` carries (`name === "ProviderCallError"`, a `kind` in
 * `PROVIDER_ERROR_KINDS`, a boolean `retryable`) — via {@link asProviderFault},
 * without naming the class. The test imports the real `ProviderCallError`/
 * `ModelsClient`/`mintEgressCapability` to prove the path end-to-end; production
 * wiring (apps/cli, the composition root) passes a real `ModelsClient` bound to it.
 */
import { PROVIDER_ERROR_KINDS, type ProviderErrorKind } from "@atlas/contracts";
import type { IndexingConfig } from "./generation.js";
import type { EmbedOutcome, Embedder } from "./activate.js";

/**
 * The structural slice of `ModelsClient.embed` this adapter needs (D14: no concrete
 * `@atlas/models` import — the CLI passes the real client). Its shape matches the
 * real signature EXACTLY: `embed(request, capability, options?)`. `Cap`/`Options`
 * are opaque generics threaded straight through to the client — this package never
 * inspects a capability. Returns `{ vectors }` (an `EmbedResult` superset); throws
 * `ProviderCallError` on a provider fault.
 */
export interface EmbedClient<Cap = unknown, Options = unknown> {
  embed(
    req: {
      readonly model: string;
      readonly texts: readonly string[];
      readonly dimensions: number;
    },
    capability: Cap,
    options?: Options,
  ): Promise<{ readonly vectors: readonly (readonly number[])[] }>;
}

/** The stable public shape of a thrown `@atlas/models` `ProviderCallError`. */
interface ProviderFault {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly message?: string;
  readonly retryAfterMs?: number;
}

/**
 * Recognize a thrown value as a provider fault by its stable public shape (the
 * `@atlas/contracts` taxonomy `ProviderCallError` exposes) — WITHOUT importing the
 * class (D14). Returns the fault view, or `null` for anything else (which the
 * caller rethrows: a programming error must not masquerade as an embed failure).
 */
export function asProviderFault(err: unknown): ProviderFault | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; kind?: unknown; retryable?: unknown; message?: unknown; retryAfterMs?: unknown };
  const kindOk = typeof e.kind === "string" && (PROVIDER_ERROR_KINDS as readonly string[]).includes(e.kind);
  const shapeOk = kindOk && typeof e.retryable === "boolean";
  // Accept either the exact class name or the full duck-typed shape, so a
  // re-thrown/cross-realm instance still classifies.
  if (!shapeOk && e.name !== "ProviderCallError") return null;
  if (!kindOk || typeof e.retryable !== "boolean") return null;
  return {
    kind: e.kind as ProviderErrorKind,
    retryable: e.retryable,
    ...(typeof e.message === "string" ? { message: e.message } : {}),
    ...(typeof e.retryAfterMs === "number" ? { retryAfterMs: e.retryAfterMs } : {}),
  };
}

/**
 * Build the production {@link Embedder} over a real embed client — a
 * **capability-closing adapter** (round-3 finding 6). The caller mints a run-bound
 * egress capability (D19) and passes it here; the returned `Embedder` closes over
 * it (and any per-call `options`) and threads them into every
 * `client.embed(request, capability, options)` — matching the real
 * `ModelsClient.embed` signature. Batches all chunk texts in input order, applies
 * the D7 `dimensions` + `embedding_model` from `cfg`, and converts a thrown
 * `ProviderCallError` into the typed {@link EmbedOutcome} failure — so a permanent
 * fault (`authentication`, `validation`, `model_incompatible`, `cancelled`)
 * surfaces as a repairable typed outcome, and a retryable fault
 * (`rate_limit`/`quota`/`timeout`/`transport`/`partial_batch`) carries its
 * `retryAfterMs`. A non-provider throw (a bug) is rethrown unchanged.
 */
export function embedderFromClient<Cap, Options = unknown>(
  client: EmbedClient<Cap, Options>,
  capability: Cap,
  cfg: IndexingConfig,
  options?: Options,
): Embedder {
  return async (texts: readonly string[]): Promise<EmbedOutcome> => {
    try {
      const result = await client.embed(
        {
          model: cfg.embedding_model,
          texts: [...texts],
          dimensions: cfg.dimensions,
        },
        capability,
        options,
      );
      return { ok: true, vectors: result.vectors };
    } catch (err) {
      const fault = asProviderFault(err);
      if (fault === null) throw err; // not a provider fault → a real bug, do not swallow
      return {
        ok: false,
        retryable: fault.retryable,
        kind: fault.kind,
        ...(fault.message !== undefined ? { message: fault.message } : {}),
        ...(fault.retryAfterMs !== undefined ? { retryAfterMs: fault.retryAfterMs } : {}),
      };
    }
  };
}
