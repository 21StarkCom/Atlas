/**
 * `@atlas/models` — the typed model client (`generateText`/`generateObject`/`embed`)
 * driven over an in-process {@link Invoker}. Post the Phase-2 in-process cutover the
 * default invoker calls the ported {@link GeminiAdapter} DIRECTLY: there is no egress
 * daemon, no capability mint, no per-run byte/token/cost budget, and no egress scan
 * gate — nothing between the notes and the provider but the per-call `maxTokens` cap
 * on the request. The credential is resolved LAZILY on the first provider call.
 *
 * Every call still emits a {@link ReceiptSink} callback (success, refusal, OR
 * provider error) BEFORE it returns/throws, so the CLI writes exactly one
 * `model_calls` ledger row per transmission (D6/D18). A refusal throws
 * {@link EgressRefusal}; a provider fault throws {@link ProviderCallError} (its
 * `kind` drives the jobs runner's retry classification). `generateObject` schemas
 * are referenced by `schemaId` (never a schema body); the caller's Zod schema types
 * the result and re-validates it locally.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { SCHEMA_REGISTRY, Ulid, type SchemaRegistry } from "@atlas/contracts";
import { EgressRefusal } from "./errors.js";
import { ProviderCallError } from "./provider-error.js";
import {
  GeminiAdapter,
  type ProviderAdapter,
  type SerializedRequest,
  type Transport,
} from "./gemini.js";
import {
  GenerateTextResultSchema,
  EmbedResultSchema,
  GenerateTextRequestSchema,
  GenerateObjectRequestSchema,
  EmbedRequestSchema,
  type ModelCallReceipt,
  type ProviderOperation,
  type ReceiptSink,
  type Usage,
  type GenerateTextRequest,
  type GenerateTextResult,
  type EmbedRequest,
  type EmbedResult,
  type PromptRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Lazy credential resolution (Phase-2 cutover).
// ---------------------------------------------------------------------------

/** The env var that overrides the Keychain lookup (env WINS). */
export const GEMINI_API_KEY_ENV = "ATLAS_GEMINI_API_KEY";
/** The macOS Keychain generic-password service name the key is stored under. */
export const GEMINI_KEYCHAIN_SERVICE = "atlas-gemini-api-key";

/**
 * Read the key from the macOS Keychain, or `undefined` if `security`/the item is
 * absent. The `env` mapping (default `process.env`) is threaded straight into the
 * subprocess so the resolver honours the invocation's RunContext env — its `PATH`
 * decides whether `security` is even reachable (the blank-Ubuntu canary blanks it).
 */
function keychainApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", GEMINI_KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    // No `security` binary (blank Ubuntu CI), no such item, or a non-zero exit — all
    // treated as "absent", never a throw (the non-provider path must stay green).
    return undefined;
  }
}

/**
 * Resolve the Gemini API key: `ATLAS_GEMINI_API_KEY` (env override wins) else the
 * macOS Keychain. THROWS when neither is present — call it ONLY on a real provider
 * path, and LAZILY (the first provider call), never at process start / import, so a
 * non-provider command on a blank host never triggers it. The key is held only in
 * the constructed adapter's memory — never written to disk or logged. Reads the
 * supplied `env` mapping (the command's RunContext env), NOT `process.env`, so a
 * test/composition root can drive resolution with flags absent from `process.env`.
 */
export function resolveGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[GEMINI_API_KEY_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const fromKeychain = keychainApiKey(env);
  if (fromKeychain !== undefined) return fromKeychain;
  throw new ProviderCallError({
    kind: "authentication",
    retryable: false,
    message: `no Gemini API key: set ${GEMINI_API_KEY_ENV} or store it in the Keychain (service "${GEMINI_KEYCHAIN_SERVICE}")`,
  });
}

/**
 * A NON-THROWING presence probe for `status`'s `provider-key-present` check: `true`
 * iff the env var OR the Keychain holds a key. Swallows a missing `security` binary
 * and a missing key — never resolves (or throws) on the blank-Ubuntu path. Reads the
 * supplied `env` mapping (default `process.env`), not the ambient process env.
 */
export function hasGeminiApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const fromEnv = env[GEMINI_API_KEY_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return true;
  return keychainApiKey(env) !== undefined;
}

// ---------------------------------------------------------------------------
// Gated deterministic fake provider (TEST SEAM — never active in production).
// ---------------------------------------------------------------------------

/**
 * Env flag that, together with `ATLAS_TEST_MODE=1`, swaps the real
 * {@link GeminiAdapter} for the deterministic in-process fake below. It exists for
 * the CLI-contract `--json` conformance sweep, which drives the REAL `brain` binary
 * in a child process and therefore cannot inject an adapter object — the pre-cutover
 * harness injected the same deterministic fake into an in-process `EgressService`
 * over a socket; the in-process cutover moves that seam here. STRICTLY test-only: it
 * activates only when BOTH `ATLAS_TEST_MODE` and this flag are `"1"` AND no explicit
 * adapter/transport/key-resolver was supplied, so production (neither env set) never
 * reaches it and never resolves a credential through it.
 */
export const FAKE_PROVIDER_ENV = "ATLAS_FAKE_PROVIDER";

/**
 * Whether the gated fake-provider test seam is active for this config + env. Reads
 * the invoker's `env` mapping (the command's RunContext env), NOT `process.env`, so a
 * child-process CLI drive that passes `ATLAS_TEST_MODE`/`ATLAS_FAKE_PROVIDER` only
 * through `runCli`'s env argument still activates the fake instead of attempting real
 * Keychain / live-Gemini access.
 */
function fakeProviderActive(cfg: InProcessInvokerConfig, env: NodeJS.ProcessEnv): boolean {
  return (
    cfg.adapter === undefined &&
    cfg.transport === undefined &&
    cfg.resolveApiKey === undefined &&
    env.ATLAS_TEST_MODE === "1" &&
    env[FAKE_PROVIDER_ENV] === "1"
  );
}

/** Deterministic pseudo-embedding: identical text ⇒ identical vector (rank-1 recall). */
function fakeHashVector(text: string, dims: number): number[] {
  const v: number[] = [];
  let seed = createHash("sha256").update(text, "utf8").digest();
  while (v.length < dims) {
    for (const b of seed) {
      if (v.length >= dims) break;
      v.push((b - 127.5) / 127.5);
    }
    seed = createHash("sha256").update(seed).digest();
  }
  return v;
}

/**
 * A deterministic in-process fake adapter (embed hashes each text; text ops return
 * `"ok"`; `generateObject` returns `{}`). Byte-for-byte the behaviour the pre-cutover
 * sweep harness's socket adapter had, so the same fixtures rank an exact-text query
 * at 1. Needs no credential and makes no network call.
 */
function createFakeProviderAdapter(): ProviderAdapter {
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: (s, signal) =>
      signal?.aborted
        ? Promise.reject(new ProviderCallError({ kind: "cancelled", retryable: false, message: "aborted before request" }))
        : Promise.resolve({ rawResponse: s.bytes, retries: 0 }),
    parse: (op, req, raw) => {
      const usage: Usage = { inputTokens: 10, outputTokens: 5 };
      if (op === "embed") {
        const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as { texts: string[]; dimensions: number };
        return {
          result: { vectors: parsed.texts.map((t) => fakeHashVector(t, parsed.dimensions)), dimensions: parsed.dimensions, usage, model: req.model },
          usage,
          model: req.model,
        };
      }
      if (op === "generateObject") return { result: {}, usage, model: req.model };
      return { result: { text: "ok", usage, model: req.model }, usage, model: req.model };
    },
    costMicros: (_m: string, u: Usage) => u.inputTokens + (u.outputTokens ?? 0),
  };
}

// ---------------------------------------------------------------------------
// The in-process invoke seam.
// ---------------------------------------------------------------------------

/** The minimal run binding a transmission attributes to (the receipt's `runId`). */
export interface RunBinding {
  readonly runId: string;
}

/** The typed provider request carried in an invoke — discriminated by `operation`. */
export const EgressRequestBodySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("generateText"), request: GenerateTextRequestSchema }).strict(),
  z.object({ operation: z.literal("generateObject"), request: GenerateObjectRequestSchema }).strict(),
  z.object({ operation: z.literal("embed"), request: EmbedRequestSchema }).strict(),
]);
export type EgressRequestBody = z.infer<typeof EgressRequestBodySchema>;

/**
 * The invoke params: the run binding + the typed provider request. Post-cutover
 * these carry NO capability and NO declared sensitivity — the provider path drops
 * the retired egress wrapper entirely.
 */
export const EgressInvokeParamsSchema = z
  .object({
    // The run binding is a canonical ULID (@atlas/contracts `Ulid`), NOT any nonempty
    // string. A traversal-shaped value like "../x" is rejected at the boundary BEFORE
    // key resolution or transport, so it can never reach the provider and then fail
    // downstream in `DurableReceiptSink` (whose `journalPath` refuses a non-filename-safe
    // runId) — which would transmit-then-lose the durable receipt row.
    runId: Ulid,
    body: EgressRequestBodySchema,
  })
  .strict();
export type EgressInvokeParams = z.infer<typeof EgressInvokeParamsSchema>;

/** The typed result of an invoke: the outcome + the receipt (when produced). */
export type EgressInvokeResult =
  | { readonly ok: true; readonly result: unknown; readonly receipt: ModelCallReceipt }
  | { readonly ok: false; readonly refusal: EgressRefusal; readonly receipt?: ModelCallReceipt }
  | { readonly ok: false; readonly providerError: ProviderCallError; readonly receipt: ModelCallReceipt };

/**
 * The transport the client drives. Post-cutover this is the in-process invoker; the
 * optional `signal` carries cooperative cancellation straight into the adapter.
 */
export type Invoker = (params: EgressInvokeParams, signal?: AbortSignal) => Promise<EgressInvokeResult>;

/** Config for {@link createInProcessInvoker}. All fields are for tests/DI. */
export interface InProcessInvokerConfig {
  /** Override the provider adapter (tests pass a stubbed-transport adapter). */
  readonly adapter?: ProviderAdapter;
  /** Override the `generateObject` schema registry (tests inject an overlay). */
  readonly schemaRegistry?: Readonly<Record<string, z.ZodTypeAny>>;
  /** Override the lazy API-key resolver (defaults to {@link resolveGeminiApiKey}). */
  readonly resolveApiKey?: () => string;
  /** Injected HTTP transport for the default adapter (defaults to global `fetch`). */
  readonly transport?: Transport;
  /**
   * The environment mapping the provider path reads for the fake-provider gate and
   * the default key resolver — pass the command's `ctx.env`, NOT `process.env`, so a
   * child-process CLI drive whose flags live only in `runCli`'s env argument resolves
   * correctly (defaults to `process.env` when a composition root omits it).
   */
  readonly env?: NodeJS.ProcessEnv;
}

function sha256Hex(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Build the in-process {@link Invoker} that calls the Gemini adapter directly.
 * The adapter (and thus the credential) is constructed LAZILY on the FIRST call
 * — never at factory creation / import — so a non-provider command that never
 * invokes the model never resolves the key (blank-Ubuntu CI stays green).
 *
 * There is NO capability check, NO per-run budget, and NO scan gate here (all
 * retired-security, removed in the Phase-2 cutover). The only surviving control is
 * the per-call `maxTokens` on the request itself. A malformed model / provider fault
 * still yields a run-attributable receipt so the `model_calls` row is written.
 */
export function createInProcessInvoker(cfg: InProcessInvokerConfig = {}): Invoker {
  const schemaRegistry = cfg.schemaRegistry ?? (SCHEMA_REGISTRY as Readonly<Record<string, z.ZodTypeAny>>);
  const env = cfg.env ?? process.env;
  let adapter = cfg.adapter;
  const adapterFor = (): ProviderAdapter => {
    // Lazy first-use construction: resolve the key ONLY now (never at import).
    if (adapter === undefined) {
      if (fakeProviderActive(cfg, env)) {
        // Gated test seam — no credential resolved, no network. Still lazy.
        adapter = createFakeProviderAdapter();
      } else {
        const apiKey = (cfg.resolveApiKey ?? (() => resolveGeminiApiKey(env)))();
        adapter = new GeminiAdapter({ apiKey, ...(cfg.transport !== undefined ? { transport: cfg.transport } : {}) });
      }
    }
    return adapter;
  };

  return async (params: EgressInvokeParams, signal?: AbortSignal): Promise<EgressInvokeResult> => {
    // (0) Validate the invoke params at the boundary BEFORE any key resolution or
    // transport — restoring the runtime check the socket protocol used to supply. A
    // malformed maxTokens/dimensions/runId, an extra field, or a mismatched
    // operation/request shape is a terminal `validation` error that never reaches the
    // adapter and never resolves a credential (no transmission ⇒ no receipt/ledger row).
    const validation = EgressInvokeParamsSchema.safeParse(params);
    if (!validation.success) {
      const issues = validation.error.issues
        .slice(0, 5)
        .map((i) => `${i.code}@${i.path.join(".") || "$"}`)
        .join(", ");
      throw new ProviderCallError({ kind: "validation", retryable: false, message: `invalid invoke params: ${issues}` });
    }
    params = validation.data;
    const a = adapterFor();
    const body = params.body;
    const operation = body.operation as ProviderOperation;
    const model = body.request.model;

    const receipt = (over: Partial<ModelCallReceipt> & { outcome: ModelCallReceipt["outcome"]; requestHash: string }): ModelCallReceipt => ({
      runId: params.runId,
      provider: a.provider,
      model,
      operation,
      requestHash: over.requestHash,
      destination: a.host,
      inputTokens: over.inputTokens ?? 0,
      outputTokens: over.outputTokens ?? 0,
      costMicros: over.costMicros ?? 0,
      latencyMs: over.latencyMs ?? 0,
      retries: over.retries ?? 0,
      outcome: over.outcome,
      ...(over.responseHash !== undefined ? { responseHash: over.responseHash } : {}),
      ...(over.reasonCode !== undefined ? { reasonCode: over.reasonCode } : {}),
    });

    // (1) Serialize the exact request bytes (validates the op/model allowlist). A
    // disallowed/unpriced/cross-operation model is a terminal provider error BEFORE
    // any transport — so there are no serialized bytes to hash. Derive a deterministic
    // "unbound" hash over the COMPLETE attempted request (operation + the full typed
    // request body), not just runId/operation/model: two distinct failed calls in the
    // same run (e.g. different inputs, same bad model) must NOT collapse to one
    // `model_calls` row under `modelCallId`'s `(runId, requestHash)` ON CONFLICT.
    let serialized: SerializedRequest;
    const unboundHash = sha256Hex(Buffer.from(`unbound:${params.runId}:${JSON.stringify(body)}`, "utf8"));
    try {
      serialized = a.serialize(operation, body.request);
    } catch (err) {
      if (err instanceof ProviderCallError) {
        return { ok: false, providerError: err, receipt: receipt({ outcome: "error", reasonCode: err.kind, requestHash: unboundHash }) };
      }
      throw err;
    }
    const requestHash = sha256Hex(serialized.bytes);

    // (2) Resolve the generateObject schema before dispatch (a pointless dispatch for
    // an unresolvable schema is a terminal validation error).
    let schema: z.ZodTypeAny | undefined;
    if (body.operation === "generateObject") {
      schema = schemaRegistry[body.request.schemaId];
      if (schema === undefined) {
        const e = new ProviderCallError({ kind: "validation", retryable: false, message: `unknown schemaId "${body.request.schemaId}"` });
        return { ok: false, providerError: e, receipt: receipt({ outcome: "error", reasonCode: e.kind, requestHash }) };
      }
    }

    // (3) The provider round-trip (no in-process scan hook).
    const started = Number(process.hrtime.bigint() / 1_000_000n);
    let transmitted: { rawResponse: Uint8Array; retries: number };
    try {
      transmitted = await a.transmit(serialized, signal);
    } catch (err) {
      if (err instanceof ProviderCallError) {
        const latencyMs = Number(process.hrtime.bigint() / 1_000_000n) - started;
        return { ok: false, providerError: err, receipt: receipt({ outcome: "error", reasonCode: err.kind, requestHash, latencyMs, retries: err.attempt?.retries ?? 0 }) };
      }
      throw err;
    }
    const latencyMs = Number(process.hrtime.bigint() / 1_000_000n) - started;
    const retries = transmitted.retries;
    const responseHash = sha256Hex(transmitted.rawResponse);

    // (4) Parse the raw response into the typed result.
    let usage: Usage;
    let result: unknown;
    try {
      const parsed = a.parse(operation, body.request, transmitted.rawResponse, schema);
      usage = parsed.usage;
      result = parsed.result;
    } catch (err) {
      if (err instanceof ProviderCallError) {
        return { ok: false, providerError: err, receipt: receipt({ outcome: "error", reasonCode: err.kind, requestHash, responseHash, latencyMs, retries }) };
      }
      throw err;
    }

    // (5) Success — emit the success receipt.
    const costMicros = a.costMicros(model, usage) ?? 0;
    return {
      ok: true,
      result,
      receipt: receipt({
        outcome: "success",
        requestHash,
        responseHash,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens ?? 0,
        costMicros,
        latencyMs,
        retries,
      }),
    };
  };
}

// ---------------------------------------------------------------------------
// The typed client.
// ---------------------------------------------------------------------------

/** Per-call options that do not belong on the provider request itself. */
export interface CallOptions {
  readonly signal?: AbortSignal;
}

/**
 * The optional 3rd argument to every model method. The provider-interface signature
 * is `(req, run, signal?: AbortSignal)`, so a bare {@link AbortSignal} MUST work; the
 * {@link CallOptions} object is also accepted. Both are normalized by
 * {@link toCallOptions}.
 */
export type SignalOrOptions = AbortSignal | CallOptions;

/** Normalize the accepted `signal?: AbortSignal | CallOptions` argument into {@link CallOptions}. */
function toCallOptions(arg?: SignalOrOptions): CallOptions {
  if (arg === undefined) return {};
  // An AbortSignal is duck-typed (instanceof is unreliable across realms): it has an
  // `aborted` boolean + `addEventListener`. CallOptions has neither at the top level.
  if (typeof (arg as AbortSignal).aborted === "boolean" && typeof (arg as AbortSignal).addEventListener === "function") {
    return { signal: arg as AbortSignal };
  }
  return arg as CallOptions;
}

/** A schema-constrained `generateObject` request: a Zod schema + its registry id. */
export interface GenerateObjectClientRequest<T> {
  readonly model: string;
  readonly prompt: PromptRef;
  readonly input: string;
  /** The caller's Zod schema — types `T` and re-validates the returned object locally. */
  readonly schema: z.ZodType<T>;
  /** The shared-registry key that resolves the schema on the invoke side. */
  readonly schemaId: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export class ModelsClient {
  private readonly schemaRegistry: SchemaRegistry;

  /**
   * `receiptSink` is MANDATORY (D6/D18): every transmission — success, refusal, OR
   * provider error — hands its receipt to the sink BEFORE the call returns/throws, so
   * the CLI writes exactly one `model_calls` row per call. A pre-aborted call that
   * never dispatches produces no transmission and thus no receipt.
   */
  constructor(
    private readonly invoker: Invoker,
    private readonly receiptSink: ReceiptSink,
    opts: { schemaRegistry?: SchemaRegistry } = {},
  ) {
    this.schemaRegistry = opts.schemaRegistry ?? SCHEMA_REGISTRY;
  }

  /** Free-form generation. `run` binds the transmission's receipt to a run id;
   * `signal` may be a bare `AbortSignal` or the {@link CallOptions} superset. */
  async generateText(
    req: GenerateTextRequest,
    run: RunBinding,
    signalOrOpts?: SignalOrOptions,
  ): Promise<GenerateTextResult> {
    const opts = toCallOptions(signalOrOpts);
    this.assertNotAborted(opts.signal);
    const outcome = await this.invoker(
      { runId: run.runId, body: { operation: "generateText", request: req } },
      opts.signal,
    );
    const value = await this.settle(outcome);
    return GenerateTextResultSchema.parse(value);
  }

  /** Schema-constrained generation. Returns the caller's `z.infer<T>` after a local
   * re-validation of the invoke-validated object. */
  async generateObject<T>(
    req: GenerateObjectClientRequest<T>,
    run: RunBinding,
    signalOrOpts?: SignalOrOptions,
  ): Promise<T> {
    const opts = toCallOptions(signalOrOpts);
    this.assertNotAborted(opts.signal);
    // The client and the invoke side MUST resolve the SAME schema for `schemaId`
    // (only the id crosses the seam). Reject a caller whose supplied Zod schema is not
    // the identically-registered one — reference identity is the guarantee (the caller
    // passes the registry's own schema object, `schema: SCHEMA_REGISTRY[schemaId]`).
    const registered = this.schemaRegistry[req.schemaId];
    if (registered === undefined) {
      throw new ProviderCallError({ kind: "validation", retryable: false, message: `unknown schemaId "${req.schemaId}" (not in the shared schema registry)` });
    }
    if ((registered as z.ZodTypeAny) !== (req.schema as z.ZodTypeAny)) {
      throw new ProviderCallError({ kind: "validation", retryable: false, message: `schema does not match the registered schema for schemaId "${req.schemaId}"` });
    }
    const outcome = await this.invoker(
      {
        runId: run.runId,
        body: {
          operation: "generateObject",
          request: {
            model: req.model,
            prompt: req.prompt,
            input: req.input,
            schemaId: req.schemaId,
            ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
        },
      },
      opts.signal,
    );
    const value = await this.settle(outcome);
    return req.schema.parse(value);
  }

  /** Batch embeddings; N vectors in input order. A `partial_batch` provider error
   * names the succeeded indices — the caller re-drives only the missing ones. */
  async embed(req: EmbedRequest, run: RunBinding, signalOrOpts?: SignalOrOptions): Promise<EmbedResult> {
    const opts = toCallOptions(signalOrOpts);
    this.assertNotAborted(opts.signal);
    const outcome = await this.invoker(
      { runId: run.runId, body: { operation: "embed", request: req } },
      opts.signal,
    );
    const value = await this.settle(outcome);
    return EmbedResultSchema.parse(value);
  }

  /**
   * Preflight cancellation: an already-aborted call must NOT transmit. It produces no
   * transmission and no receipt — the caller gets a terminal `cancelled` error.
   */
  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ProviderCallError({ kind: "cancelled", retryable: false, message: "aborted before request" });
    }
  }

  /** Emit the receipt (mandatory, if the invoke produced one) then resolve/throw. */
  private async settle(outcome: EgressInvokeResult): Promise<unknown> {
    if (outcome.receipt !== undefined) {
      await this.receiptSink(outcome.receipt);
    }
    if (outcome.ok) return outcome.result;
    if ("providerError" in outcome) throw outcome.providerError;
    throw outcome.refusal;
  }
}

export { EgressRefusal, ProviderCallError };
