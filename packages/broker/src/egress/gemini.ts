/**
 * The Gemini provider adapter — lives INSIDE the egress broker (the sole
 * credential holder + sole outbound-network process). It performs ONLY
 * non-mutating extraction/classification/synthesis provider I/O: it has no vault,
 * git, or ledger handle and cannot emit a mutation (provider-interface §6).
 *
 * ## Three-phase surface (so the broker scans the EXACT bytes)
 * The adapter is split into `serialize` → `transmit` → `parse` so the egress
 * server scans the EXACT SERIALIZED HTTP REQUEST BODY immediately before
 * transmission and the EXACT RAW RESPONSE BYTES before they are parsed or released
 * (INVARIANT 2). Scanning a transformed IPC DTO or a re-serialized parsed result
 * would let a secret hide in a transformed field, an unused candidate, or response
 * metadata — so the server hashes and scans the very bytes that cross the wire.
 *   - `serialize(op, req)` — validate the op/model allowlist and build the exact
 *     HTTP body bytes (NO network). A cross-operation or unpriced model is rejected
 *     HERE, before transport (`model_incompatible`, terminal).
 *   - `transmit(serialized, signal)` — the sole outbound round-trip, with bounded
 *     retry, honoring `Retry-After`, refusing credential-carrying redirects. Returns
 *     the raw response bytes + the retry count; on a terminal fault it throws a
 *     `ProviderCallError` carrying sanitized attempt metadata (retries + bytes sent).
 *   - `parse(op, req, rawResponse, schema?)` — map raw bytes to the typed result
 *     (validation/partial_batch live here). The server calls it AFTER the response
 *     scan.
 * The ergonomic `generateText`/`generateObject`/`embed` wrappers compose the three
 * phases (no scan) and exist for the adapter suite.
 *
 * Every failure maps to exactly one `@atlas/contracts` `ProviderError` kind (§5):
 * `authentication` is stable, `retryable:false`, ZERO retries, sanitized (never the
 * key); `rate_limit`/`quota` propagate the provider `Retry-After` into `retryAfter`
 * (ms); `timeout`/`transport`/`partial_batch` are retryable (bounded adapter retry);
 * `validation`/`model_incompatible`/`cancelled` are terminal. The HTTP transport is
 * injectable so the suite drives the full matrix with doubles (no live key).
 */
import type { z } from "zod";
import type {
  EmbedRequest,
  EmbedResult,
  GenerateObjectRequest,
  GenerateTextRequest,
  GenerateTextResult,
  Usage,
} from "./types.js";
import type { EgressOperation } from "./capability.js";
import { ProviderCallError, providerError } from "./provider-error.js";
import { DEFAULT_PROMPT_REGISTRY, resolvePromptOrThrow, type PromptRegistry } from "./prompt-registry.js";

/** A minimal injectable HTTP transport (defaults to global `fetch`). */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * In-broker scan hook the server injects into {@link ProviderAdapter.transmit}, so
 * the EXACT RAW RESPONSE BYTES of EVERY attempt — a non-2xx error body, an
 * intermediate retry body, or the final body — are scanned/hashed/quarantined
 * in-broker BEFORE the adapter maps the HTTP status to a `ProviderCallError` or the
 * server parses/releases the body (INVARIANT 2; fixes the "error/retry bodies never
 * scanned" finding). It throws (an `EgressRefusal`) when the scan blocks the body;
 * `transmit` NEVER retries or swallows a scan block — it propagates immediately.
 */
export type ResponseScanHook = (
  rawResponse: Uint8Array,
  meta: { readonly status: number; readonly ok: boolean; readonly attempt: number },
) => Promise<void>;

/** The exact serialized HTTP request the broker scans + hashes before transmission. */
export interface SerializedRequest {
  /** The provider request path (host is fixed by the adapter — never caller-supplied). */
  readonly path: string;
  /** The EXACT serialized HTTP body bytes that will be transmitted. */
  readonly bytes: Uint8Array;
}

/** The raw HTTP response the broker scans + hashes before parsing/releasing. */
export interface TransmittedResponse {
  /** The EXACT raw response body bytes received on the terminal (successful) attempt. */
  readonly rawResponse: Uint8Array;
  /** Retry attempts consumed before the response arrived (0 = first try succeeded). */
  readonly retries: number;
}

/** A parsed provider result + its usage (the typed value released to the CLI). */
export interface ParsedResult {
  readonly result: unknown;
  readonly usage: Usage;
  readonly model: string;
}

/**
 * Sanitized attempt metadata attached to a transmit failure so the broker can
 * populate the receipt's retry count and charge the dispatched call's outbound
 * bytes to the run budget even when the provider ultimately errored (D6/D19).
 */
export interface AttemptMeta {
  readonly retries: number;
  readonly requestBytes: number;
}

/** The provider surface the egress server drives; doubles implement it in tests. */
export interface ProviderAdapter {
  readonly provider: string;
  readonly host: string;
  /**
   * The worst-case number of outbound HTTP attempts a single call may make
   * (`maxRetries + 1`). The broker reserves `requestBytes × maxAttempts` up front so
   * a retry storm cannot exceed the run's byte ceiling, then reconciles to the bytes
   * actually retransmitted. Absent ⇒ 1 (no adapter retry).
   */
  readonly maxAttempts?: number;
  /**
   * Validate the op/model allowlist and build the EXACT serialized HTTP request
   * body (no network). Throws `ProviderCallError("model_incompatible")` for a model
   * that is not on this operation's allowlist (cross-operation or unpriced).
   */
  serialize(operation: EgressOperation, request: GenerateTextRequest | GenerateObjectRequest | EmbedRequest): SerializedRequest;
  /**
   * Transmit already-serialized bytes (the sole outbound round-trip) with bounded
   * retry. Returns the raw response bytes + retry count; a terminal fault throws a
   * `ProviderCallError` whose `attempt` carries the retries + bytes actually sent.
   * The optional `onResponse` scan hook is invoked with the EXACT RAW BYTES of every
   * attempt's response (error, intermediate-retry, or final) BEFORE the status is
   * mapped, so no response body escapes the in-broker scan (INVARIANT 2).
   */
  transmit(serialized: SerializedRequest, signal?: AbortSignal, onResponse?: ResponseScanHook): Promise<TransmittedResponse>;
  /** Parse raw response bytes into the typed result (called AFTER the response scan). */
  parse(
    operation: EgressOperation,
    request: GenerateTextRequest | GenerateObjectRequest | EmbedRequest,
    rawResponse: Uint8Array,
    schema?: z.ZodTypeAny,
  ): ParsedResult;
  /**
   * Ergonomic composed wrappers (serialize→transmit→parse WITHOUT the in-broker
   * scan) — OPTIONAL on the contract because the egress server drives only the trio
   * + {@link costMicros}. `GeminiAdapter` implements them for the adapter suite.
   */
  generateText?(req: GenerateTextRequest, signal?: AbortSignal): Promise<GenerateTextResult & { retries: number }>;
  generateObject?(
    req: GenerateObjectRequest,
    schema: z.ZodTypeAny,
    signal?: AbortSignal,
  ): Promise<{ readonly object: unknown; readonly usage: Usage; readonly model: string; readonly retries: number }>;
  embed?(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult & { retries: number }>;
  /**
   * Deterministic integer micro-USD cost for a completed call's token usage, or
   * `null` when the model is UNPRICED — the broker refuses an unpriced dispatch
   * rather than charging it at zero (D19).
   */
  costMicros(model: string, usage: Usage): number | null;
}

/**
 * Gemini per-model pricing in micro-USD per 1K tokens (V1 flash tier; CONSERVATIVE
 * — deliberately >= the published rate so the D19 cost ceiling can only refuse too
 * early, never let a run overrun). The earlier 75/300/15 figures under-reserved the
 * standard `generateContent` API cost by 10-30x, which made the cost ceiling
 * meaningless (the finding). These reconcile to the official `gemini-3.5-flash`
 * standard-tier pricing rounded UP: input 1500, output 9000; embeddings 150.
 */
const PRICE_PER_1K_MICROS: Record<string, { input: number; output: number }> = {
  "gemini-3.5-flash": { input: 1500, output: 9000 },
  "gemini-embedding-001": { input: 150, output: 0 },
};

/**
 * Fixed per-operation model allowlists (defeats "arbitrary model string in the URL
 * path" + "unknown model priced at zero"). A model is transportable ONLY if it is on
 * the allowlist for the operation it was requested under; cross-operation use (an
 * embedding model in `generateText`, a generation model in `embed`) is refused
 * before transport. The allowlist is exactly the priced set, so membership implies a
 * price.
 */
const GENERATION_MODELS: ReadonlySet<string> = new Set(["gemini-3.5-flash"]);
const EMBEDDING_MODELS: ReadonlySet<string> = new Set(["gemini-embedding-001"]);

/** The allowlist that governs a given operation. */
function allowlistFor(operation: EgressOperation): ReadonlySet<string> {
  return operation === "embed" ? EMBEDDING_MODELS : GENERATION_MODELS;
}

export interface GeminiAdapterConfig {
  readonly apiKey: string;
  readonly transport?: Transport;
  /** Bounded retry attempts for retryable errors (default 2). Auth never retries. */
  readonly maxRetries?: number;
  /** Injectable sleep so the retry machine never blocks a test (default real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Override the API host (default the Generative Language endpoint). */
  readonly host?: string;
  /** Injectable clock (ms) for `Retry-After` HTTP-date math (default `Date.now`). */
  readonly nowMs?: () => number;
  /**
   * The egress-side prompt registry used to resolve `prompt.ref` → task-instruction
   * content that is INCLUDED in the serialized body (and thus scanned). Defaults to
   * {@link DEFAULT_PROMPT_REGISTRY}; an unknown reference fails closed at serialize.
   */
  readonly promptRegistry?: PromptRegistry;
}

const DEFAULT_HOST = "generativelanguage.googleapis.com";
const DEFAULT_MAX_RETRIES = 2;

/** The Gemini adapter (extraction/classification/synthesis — non-mutating I/O only). */
export class GeminiAdapter implements ProviderAdapter {
  readonly provider = "gemini";
  readonly host: string;
  readonly maxAttempts: number;
  private readonly apiKey: string;
  private readonly transport: Transport;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowMs: () => number;
  private readonly promptRegistry: PromptRegistry;

  constructor(cfg: GeminiAdapterConfig) {
    this.apiKey = cfg.apiKey;
    this.host = cfg.host ?? DEFAULT_HOST;
    this.transport = cfg.transport ?? ((url, init) => fetch(url, init));
    this.maxRetries = cfg.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxAttempts = this.maxRetries + 1;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.nowMs = cfg.nowMs ?? (() => Date.now());
    this.promptRegistry = cfg.promptRegistry ?? DEFAULT_PROMPT_REGISTRY;
  }

  costMicros(model: string, usage: Usage): number | null {
    const p = PRICE_PER_1K_MICROS[model];
    if (p === undefined) return null; // unpriced ⇒ the broker refuses the dispatch
    const inMicros = Math.ceil((usage.inputTokens * p.input) / 1000);
    const outMicros = Math.ceil(((usage.outputTokens ?? 0) * p.output) / 1000);
    return inMicros + outMicros;
  }

  /** Validate the op/model allowlist + build the exact HTTP body (no network). */
  serialize(
    operation: EgressOperation,
    request: GenerateTextRequest | GenerateObjectRequest | EmbedRequest,
  ): SerializedRequest {
    const model = request.model;
    if (!allowlistFor(operation).has(model)) {
      throw new ProviderCallError(
        providerError("model_incompatible", {
          message: `model "${model}" is not on the ${operation} allowlist`,
        }),
      );
    }
    let path: string;
    let body: unknown;
    if (operation === "generateText") {
      const req = request as GenerateTextRequest;
      // Resolve the versioned prompt reference to its task-instruction CONTENT and
      // carry it as the system instruction, so the transmitted request includes the
      // prompt AND the prompt bytes are covered by the in-broker exact-payload scan
      // (finding #2). An unknown reference fails closed here — no transport happens.
      const prompt = resolvePromptOrThrow(this.promptRegistry, req.prompt.ref);
      path = `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      body = {
        systemInstruction: { role: "system", parts: [{ text: prompt.content }] },
        contents: [{ role: "user", parts: [{ text: req.input }] }],
        generationConfig: {
          maxOutputTokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
      };
    } else if (operation === "generateObject") {
      const req = request as GenerateObjectRequest;
      const prompt = resolvePromptOrThrow(this.promptRegistry, req.prompt.ref);
      path = `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      body = {
        systemInstruction: { role: "system", parts: [{ text: prompt.content }] },
        contents: [{ role: "user", parts: [{ text: req.input }] }],
        generationConfig: {
          responseMimeType: "application/json",
          ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
      };
    } else {
      const req = request as EmbedRequest;
      path = `/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`;
      body = {
        requests: req.texts.map((t) => ({
          model: `models/${model}`,
          content: { parts: [{ text: t }] },
          outputDimensionality: req.dimensions,
        })),
      };
    }
    return { path, bytes: Buffer.from(JSON.stringify(body), "utf8") };
  }

  /** The sole outbound round-trip: bounded retry, returns raw response bytes + retries. */
  async transmit(serialized: SerializedRequest, signal?: AbortSignal, onResponse?: ResponseScanHook): Promise<TransmittedResponse> {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) {
        throw this.withAttempt(new ProviderCallError(providerError("cancelled", { message: "aborted before request" })), attempt, serialized);
      }
      let http: { bytes: Uint8Array; res: Response };
      try {
        http = await this.callOnce(serialized, signal);
      } catch (err) {
        // A pre-body transport/cancel fault (no HTTP response was received, so there
        // are no bytes to scan) — apply the normal retry/terminal policy.
        if (!(err instanceof ProviderCallError)) throw err;
        if (!err.retryable || attempt >= this.maxRetries) throw this.withAttempt(err, attempt, serialized);
        attempt++;
        await this.backoff(err, attempt, serialized, signal);
        continue;
      }
      if (http.res.ok) return { rawResponse: http.bytes, retries: attempt };
      // Non-2xx: scan the EXACT RAW ERROR/RETRY BYTES in-broker BEFORE mapping the
      // status (the final 2xx body is scanned by the server after transmit returns,
      // so this hook covers exactly the error + intermediate-retry bodies that used
      // to escape scanning). A scan block (EgressRefusal) is NEVER retried/swallowed.
      if (onResponse !== undefined) {
        await onResponse(http.bytes, { status: http.res.status, ok: false, attempt });
      }
      // Non-2xx: the (already-scanned) body is mapped to the ProviderError taxonomy.
      // The EXACT bytes we just scanned are the mapping source (the finding: Gemini
      // reports its application status in the JSON body, not the HTTP statusText).
      const mapped = mapHttpError(http.res, http.bytes, this.nowMs);
      if (!mapped.retryable || attempt >= this.maxRetries) throw this.withAttempt(mapped, attempt, serialized);
      attempt++;
      await this.backoff(mapped, attempt, serialized, signal);
    }
  }

  /**
   * Sleep the error's `Retry-After` (if any) then re-check cancellation before
   * retrying. The wait is ABORTABLE (the finding: a plain `await sleep(delay)` slept
   * the ENTIRE backoff even after the caller aborted — a long `Retry-After` pinned an
   * in-flight call until the timer elapsed). `abortableSleep` wakes the instant the
   * signal aborts, and we then throw `cancelled` rather than retransmitting.
   */
  private async backoff(err: ProviderCallError, attempt: number, serialized: SerializedRequest, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw this.withAttempt(new ProviderCallError(providerError("cancelled", { message: "aborted before retry backoff" })), attempt, serialized);
    }
    const delay = err.retryAfterMs ?? 0;
    if (delay > 0) await this.abortableSleep(delay, signal);
    if (signal?.aborted) {
      throw this.withAttempt(new ProviderCallError(providerError("cancelled", { message: "aborted during retry backoff" })), attempt, serialized);
    }
  }

  /**
   * Sleep `ms`, resolving EARLY the instant `signal` aborts (the caller re-checks
   * `signal.aborted` and throws `cancelled`). Without a signal it is the plain
   * injected sleep. The abort listener is always removed so a completed sleep leaks
   * no handler.
   */
  private abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return this.sleep(ms);
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", done);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      void Promise.resolve(this.sleep(ms)).then(done);
    });
  }

  /** Attach sanitized attempt metadata (retries + bytes sent) to a terminal fault. */
  private withAttempt(err: ProviderCallError, retries: number, serialized: SerializedRequest): ProviderCallError {
    return err.withAttempt({ retries, requestBytes: serialized.bytes.byteLength });
  }

  /** Parse raw response bytes into the typed result (called after the response scan). */
  parse(
    operation: EgressOperation,
    request: GenerateTextRequest | GenerateObjectRequest | EmbedRequest,
    rawResponse: Uint8Array,
    schema?: z.ZodTypeAny,
  ): ParsedResult {
    const json = decodeJson(rawResponse);
    if (operation === "embed") {
      return this.parseEmbed(request as EmbedRequest, json);
    }
    const text = extractText(json);
    if (text === null) throw new ProviderCallError(providerError("validation", { message: "no candidate text in response" }));
    const model = request.model;
    if (operation === "generateText") {
      // Release the provider finish reason (#211): a MAX_TOKENS cut used to release
      // as a successful answer, and thinking-token spend made that the common case.
      const finishReason = extractFinishReason(json);
      const result: GenerateTextResult = {
        text,
        usage: extractUsage(json),
        model,
        ...(finishReason !== undefined ? { finishReason } : {}),
      };
      return { result, usage: extractUsage(json), model };
    }
    // generateObject
    const objFinish = extractFinishReason(json);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Name a MAX_TOKENS cut explicitly — an output-cap truncation is otherwise
      // indistinguishable from model garbage (the #210 "no root-cause signal" class).
      const why = objFinish === "MAX_TOKENS"
        ? "model output truncated at maxOutputTokens (finishReason MAX_TOKENS) — raise the per-call maxTokens"
        : "model output was not valid JSON (malformed/truncated)";
      throw new ProviderCallError(providerError("validation", { message: why }));
    }
    if (schema === undefined) {
      throw new ProviderCallError(providerError("validation", { message: "generateObject requires a schema" }));
    }
    const res = schema.safeParse(parsed);
    if (!res.success) {
      // Issue CODES + PATHS only — NEVER zod's `error.message`, which embeds the raw
      // received value (e.g. enum mismatches). This parse runs BEFORE the ADR-0001
      // released-bytes scan, so interpolating the value would put unscanned
      // model-output bytes into an error message that crosses the seam.
      const issues = res.error.issues
        .slice(0, 5)
        .map((i) => `${i.code}@${i.path.join(".") || "$"}`)
        .join(", ");
      const finishNote = objFinish !== undefined && objFinish !== "STOP" ? ` (finishReason ${objFinish})` : "";
      throw new ProviderCallError(providerError("validation", { message: `model output failed schema: ${issues}${finishNote}` }));
    }
    return { result: res.data, usage: extractUsage(json), model };
  }

  private parseEmbed(req: EmbedRequest, json: unknown): ParsedResult {
    const embeddings = (json as { embeddings?: { values?: number[] }[] }).embeddings;
    if (!Array.isArray(embeddings)) {
      throw new ProviderCallError(providerError("validation", { message: "no embeddings array in response" }));
    }
    const succeeded: number[] = [];
    const vectors: number[][] = [];
    for (let i = 0; i < req.texts.length; i++) {
      const v = embeddings[i]?.values;
      if (Array.isArray(v) && v.length > 0) {
        vectors.push(v);
        succeeded.push(i);
      }
    }
    if (succeeded.length !== req.texts.length) {
      throw new ProviderCallError(providerError("partial_batch", { succeededIndices: succeeded, message: "partial embedding batch" }));
    }
    if (vectors.some((v) => v.length !== req.dimensions)) {
      throw new ProviderCallError(providerError("validation", { message: `embedding dimension drift (expected ${req.dimensions})` }));
    }
    const usage: Usage = { inputTokens: extractUsage(json).inputTokens };
    const result: EmbedResult = { vectors, dimensions: req.dimensions, usage, model: req.model };
    return { result, usage, model: req.model };
  }

  // -------------------------------------------------------------------------
  // Ergonomic wrappers (adapter suite). They compose serialize→transmit→parse
  // WITHOUT the in-broker scan (the server owns the scan around transmit).
  // -------------------------------------------------------------------------

  async generateText(req: GenerateTextRequest, signal?: AbortSignal): Promise<GenerateTextResult & { retries: number }> {
    const s = this.serialize("generateText", req);
    const t = await this.transmit(s, signal);
    const p = this.parse("generateText", req, t.rawResponse);
    const r = p.result as GenerateTextResult;
    return { ...r, retries: t.retries };
  }

  async generateObject(
    req: GenerateObjectRequest,
    schema: z.ZodTypeAny,
    signal?: AbortSignal,
  ): Promise<{ object: unknown; usage: Usage; model: string; retries: number }> {
    const s = this.serialize("generateObject", req);
    const t = await this.transmit(s, signal);
    const p = this.parse("generateObject", req, t.rawResponse, schema);
    return { object: p.result, usage: p.usage, model: p.model, retries: t.retries };
  }

  async embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult & { retries: number }> {
    const s = this.serialize("embed", req);
    const t = await this.transmit(s, signal);
    const p = this.parse("embed", req, t.rawResponse);
    return { ...(p.result as EmbedResult), retries: t.retries };
  }

  /**
   * One HTTP round-trip. Returns the response object PLUS the EXACT RAW BODY BYTES —
   * for a 2xx AND a non-2xx alike, so the caller can scan the exact bytes in-broker
   * (INVARIANT 2) BEFORE mapping the status to the ProviderError taxonomy. Only a
   * fault where NO HTTP response was received (transport failure / cancellation)
   * throws a `ProviderCallError` (there are no bytes to scan in that case).
   */
  private async callOnce(serialized: SerializedRequest, signal?: AbortSignal): Promise<{ bytes: Uint8Array; res: Response }> {
    const url = `https://${this.host}${serialized.path}`;
    let res: Response;
    try {
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: Buffer.from(serialized.bytes),
        // A redirect must NEVER carry the `x-goog-api-key` credential to an
        // unapproved destination — refuse to follow (mapped to transport error).
        redirect: "error",
        ...(signal !== undefined ? { signal } : {}),
      };
      res = await this.transport(url, init);
    } catch (err) {
      if (isAbortError(err)) throw new ProviderCallError(providerError("cancelled", { message: "request aborted" }));
      throw new ProviderCallError(providerError("transport", { message: sanitize(err) }));
    }
    try {
      const buf = await res.arrayBuffer();
      return { bytes: new Uint8Array(buf), res };
    } catch (err) {
      if (isAbortError(err)) throw new ProviderCallError(providerError("cancelled", { message: "response aborted" }));
      throw new ProviderCallError(providerError("transport", { message: "response body could not be read" }));
    }
  }
}

/** Decode raw response bytes to JSON; a non-JSON body is a validation fault. */
function decodeJson(raw: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new ProviderCallError(providerError("validation", { message: "response body was not valid JSON" }));
  }
}

/**
 * The Google API `error` envelope the (already-scanned) non-2xx body carries:
 * `{ "error": { "code", "message", "status" } }` where `status` is a canonical
 * `google.rpc.Code` name (e.g. `INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`).
 */
function parseGeminiErrorStatus(raw: Uint8Array): string | undefined {
  try {
    const body = JSON.parse(Buffer.from(raw).toString("utf8")) as { error?: { status?: unknown } };
    const status = body.error?.status;
    return typeof status === "string" ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a non-2xx Gemini response to the ProviderError taxonomy (adapter-owned),
 * driven by the canonical `error.status` in the ALREADY-SCANNED body first and the
 * HTTP status only as a fallback (the finding: inferring quota from `statusText`
 * and mapping EVERY 400 to `model_incompatible` is wrong — a 400 `INVALID_ARGUMENT`
 * is a malformed request → `validation`, and quota/rate-limit are distinguished by
 * `RESOURCE_EXHAUSTED` vs the retry hint, not by the status line text).
 */
function mapHttpError(res: Response, raw: Uint8Array, nowMs: () => number): ProviderCallError {
  const status = res.status;
  const appStatus = parseGeminiErrorStatus(raw);
  const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"), nowMs);

  // Canonical google.rpc.Code takes precedence over the raw HTTP status.
  switch (appStatus) {
    case "UNAUTHENTICATED":
    case "PERMISSION_DENIED":
      return new ProviderCallError(providerError("authentication", { message: "authentication failed" }));
    case "INVALID_ARGUMENT":
    case "FAILED_PRECONDITION":
    case "OUT_OF_RANGE":
      return new ProviderCallError(providerError("validation", { message: `provider rejected the request (${appStatus})` }));
    case "NOT_FOUND":
    case "UNIMPLEMENTED":
      return new ProviderCallError(providerError("model_incompatible", { message: `provider does not support the request (${appStatus})` }));
    case "RESOURCE_EXHAUSTED":
      return new ProviderCallError(providerError("quota", retryAfter !== undefined ? { retryAfter } : {}));
    case "DEADLINE_EXCEEDED":
      return new ProviderCallError(providerError("timeout", { message: "provider deadline exceeded" }));
    case "UNAVAILABLE":
    case "ABORTED":
      return new ProviderCallError(providerError("transport", { message: `provider unavailable (${appStatus})` }));
    default:
      break;
  }

  // Fallback on the HTTP status when the body carries no canonical status.
  if (status === 401 || status === 403) {
    return new ProviderCallError(providerError("authentication", { message: "authentication failed" }));
  }
  if (status === 429) {
    // 429 without RESOURCE_EXHAUSTED is a plain rate-limit; both propagate Retry-After.
    return new ProviderCallError(providerError("rate_limit", retryAfter !== undefined ? { retryAfter } : {}));
  }
  if (status === 400) {
    // A bare 400 with no canonical status is a malformed request → validation, NOT
    // model_incompatible (that is reserved for an unsupported model/operation).
    return new ProviderCallError(providerError("validation", { message: "provider rejected the request (HTTP 400)" }));
  }
  if (status === 404) {
    return new ProviderCallError(providerError("model_incompatible", { message: "provider rejected the request (HTTP 404)" }));
  }
  if (status === 408 || status === 504) {
    return new ProviderCallError(providerError("timeout", { message: `provider timeout (HTTP ${status})` }));
  }
  return new ProviderCallError(providerError("transport", { message: `provider transport error (HTTP ${status})` }));
}

/** Parse a `Retry-After` header (seconds OR HTTP-date) into ms. */
function parseRetryAfterMs(header: string | null, nowMs: () => number): number | undefined {
  if (header === null) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - nowMs());
  return undefined;
}

/**
 * Extract the first candidate's concatenated ANSWER text, or `null` if none.
 * Parts flagged `thought: true` (Gemini 3.5 thinking traces) are internal
 * reasoning, not the answer — they are dropped, never released to the CLI.
 */
function extractText(json: unknown): string | null {
  const parts = (json as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] }).candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((p) => p.thought !== true).map((p) => p.text ?? "").join("");
  return text.length > 0 ? text : null;
}

/** Extract the first candidate's provider finish reason, if present. */
function extractFinishReason(json: unknown): string | undefined {
  const fr = (json as { candidates?: { finishReason?: unknown }[] }).candidates?.[0]?.finishReason;
  return typeof fr === "string" && fr.length > 0 ? fr : undefined;
}

/** Extract token usage from the `usageMetadata`, defaulting missing counts to 0. */
function extractUsage(json: unknown): Usage {
  const m = (json as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } }).usageMetadata;
  const inputTokens = m?.promptTokenCount ?? 0;
  const outputTokens = m?.candidatesTokenCount;
  // Thinking tokens are BILLED output (Gemini 3.5 spends them inside maxOutputTokens);
  // excluding them under-charged receipts/cost/budget ~25x on thinking-heavy calls,
  // defeating D19's conservative-pricing intent (#211).
  const thoughtTokens = m?.thoughtsTokenCount ?? 0;
  return outputTokens !== undefined ? { inputTokens, outputTokens: outputTokens + thoughtTokens } : { inputTokens };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Reduce an arbitrary thrown value to a short, non-secret diagnostic. */
function sanitize(err: unknown): string {
  return err instanceof Error ? err.name : "transport failure";
}
