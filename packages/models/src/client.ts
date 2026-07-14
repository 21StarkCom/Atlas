/**
 * `@atlas/models` — the typed IPC client for the egress broker (provider-interface
 * §1). It is a client ONLY: `generateText`/`generateObject`/`embed` frame a
 * capability-bound request, send it over the egress socket, and return the typed
 * result. The Gemini adapter, the credential, the outbound network, and the
 * payload scan all live INSIDE the egress broker — this module never touches a
 * provider key or the network directly.
 *
 * Every call emits a {@link ReceiptSink} callback (success, refusal, OR provider
 * error) BEFORE it returns/throws, so the CLI writes exactly one `model_calls`
 * ledger row per transmission (D6/D18). A refusal throws {@link EgressRefusal}; a
 * provider fault throws {@link ProviderCallError} (its `kind` drives the jobs
 * runner's retry classification). Schemas are referenced by `schemaId` over IPC
 * (never a schema body); the caller's Zod schema types the result and re-validates
 * it locally.
 */
import type { z } from "zod";
import { SCHEMA_REGISTRY, type SchemaRegistry } from "@atlas/contracts";
import {
  EgressClient,
  EgressRefusal,
  ProviderCallError,
  GenerateTextResultSchema,
  EmbedResultSchema,
  type EgressCapability,
  type EgressInvokeResult,
  type GenerateTextRequest,
  type GenerateTextResult,
  type EmbedRequest,
  type EmbedResult,
  type PromptRef,
  type CapabilitySensitivity,
} from "@atlas/broker";
import type { ReceiptSink } from "./types.js";

/**
 * The transport the client drives: an in-process service adapter or a socket client.
 * The optional `signal` carries cooperative cancellation to the broker (a request-id
 * cancel frame over IPC, backed by a server-side `AbortController`).
 */
export type Invoker = (
  params: import("@atlas/broker").EgressInvokeParams,
  signal?: AbortSignal,
) => Promise<EgressInvokeResult>;

/** Default declared sensitivity when a caller does not specify one (plan §2.5 default). */
const DEFAULT_SENSITIVITY: CapabilitySensitivity = "internal";

/** Per-call options that do not belong on the provider request itself. */
export interface CallOptions {
  readonly signal?: AbortSignal;
  /** The payload's declared sensitivity (Phase-2 effectiveSensitivity until 4.3). */
  readonly declaredSensitivity?: CapabilitySensitivity;
}

/**
 * The optional 3rd argument to every model method. The provider-interface signature
 * is `(req, cap, signal?: AbortSignal)`, so a bare {@link AbortSignal} MUST work and
 * be honored; {@link CallOptions} is the superset for the extra Phase-2
 * `declaredSensitivity`. Both are accepted and normalized by {@link toCallOptions}.
 */
export type SignalOrOptions = AbortSignal | CallOptions;

/** Normalize the accepted `signal?: AbortSignal | CallOptions` 3rd argument into {@link CallOptions}. */
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
  /** The shared-registry key sent over IPC (a Zod object cannot cross the seam). */
  readonly schemaId: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export class ModelsClient {
  /**
   * `receiptSink` is MANDATORY (D6/D18): a caller must not be able to invoke a model
   * without retaining its receipt. EVERY transmission — success, refusal, OR provider
   * error — hands its receipt to the sink BEFORE the call returns/throws, so the CLI
   * writes exactly one `model_calls` row per call. A pre-aborted call that never
   * reaches the broker produces no transmission and thus no receipt.
   */
  /**
   * The shared `generateObject` schema registry (the `@atlas/contracts` SSOT by
   * default). `generateObject` resolves `schemaId` against it and REJECTS a caller
   * whose supplied Zod `schema` is not the identically-registered one, so the client
   * and the broker can never validate against different schemas. A test may inject an
   * overlay registry.
   */
  private readonly schemaRegistry: SchemaRegistry;

  constructor(
    private readonly invoker: Invoker,
    private readonly receiptSink: ReceiptSink,
    opts: { schemaRegistry?: SchemaRegistry } = {},
  ) {
    this.schemaRegistry = opts.schemaRegistry ?? SCHEMA_REGISTRY;
  }

  /** Connect to the egress broker socket and build a client over it. */
  static async connect(
    socketPath: string,
    receiptSink: ReceiptSink,
    opts: { schemaRegistry?: SchemaRegistry } = {},
  ): Promise<ModelsClient> {
    const client = await EgressClient.connect(socketPath);
    return new ModelsClient((params, signal) => client.invoke(params, signal), receiptSink, opts);
  }

  /** Free-form generation (extraction/synthesis prompt). `signal` may be a bare
   * `AbortSignal` (provider-interface §1) or the {@link CallOptions} superset. */
  async generateText(
    req: GenerateTextRequest,
    cap: EgressCapability,
    signalOrOpts?: SignalOrOptions,
  ): Promise<GenerateTextResult> {
    const opts = toCallOptions(signalOrOpts);
    this.assertNotAborted(opts.signal);
    const outcome = await this.invoker(
      {
        capability: cap,
        body: { operation: "generateText", request: req },
        declaredSensitivity: opts.declaredSensitivity ?? DEFAULT_SENSITIVITY,
      },
      opts.signal,
    );
    const value = await this.settle(outcome);
    return GenerateTextResultSchema.parse(value);
  }

  /** Schema-constrained generation. Returns the caller's `z.infer<T>` after a local
   * re-validation of the broker-validated object. */
  async generateObject<T>(
    req: GenerateObjectClientRequest<T>,
    cap: EgressCapability,
    signalOrOpts?: SignalOrOptions,
  ): Promise<T> {
    const opts = toCallOptions(signalOrOpts);
    this.assertNotAborted(opts.signal);
    // The client and broker MUST resolve the SAME schema for `schemaId` (only the id
    // crosses IPC). Reject a caller whose supplied Zod schema is not the identically-
    // registered one — otherwise the two sides could validate against different
    // schemas. Reference identity is the guarantee: the caller passes the registry's
    // own schema object (`schema: SCHEMA_REGISTRY[schemaId]`).
    const registered = this.schemaRegistry[req.schemaId];
    if (registered === undefined) {
      throw new ProviderCallError({ kind: "validation", retryable: false, message: `unknown schemaId "${req.schemaId}" (not in the shared schema registry)` });
    }
    if ((registered as z.ZodTypeAny) !== (req.schema as z.ZodTypeAny)) {
      throw new ProviderCallError({ kind: "validation", retryable: false, message: `schema does not match the registered schema for schemaId "${req.schemaId}"` });
    }
    const outcome = await this.invoker(
      {
        capability: cap,
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
        declaredSensitivity: opts.declaredSensitivity ?? DEFAULT_SENSITIVITY,
      },
      opts.signal,
    );
    const value = await this.settle(outcome);
    return req.schema.parse(value);
  }

  /** Batch embeddings; N vectors in input order. A `partial_batch` provider error
   * names the succeeded indices — the caller re-drives only the missing ones. */
  async embed(req: EmbedRequest, cap: EgressCapability, signalOrOpts?: SignalOrOptions): Promise<EmbedResult> {
    const opts = toCallOptions(signalOrOpts);
    this.assertNotAborted(opts.signal);
    const outcome = await this.invoker(
      {
        capability: cap,
        body: { operation: "embed", request: req },
        declaredSensitivity: opts.declaredSensitivity ?? DEFAULT_SENSITIVITY,
      },
      opts.signal,
    );
    const value = await this.settle(outcome);
    return EmbedResultSchema.parse(value);
  }

  /**
   * Preflight cancellation: an already-aborted call must NOT transmit. It never
   * reaches the broker, so it produces no transmission and no receipt — the caller
   * simply gets a terminal `cancelled` {@link ProviderCallError}.
   */
  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ProviderCallError({ kind: "cancelled", retryable: false, message: "aborted before request" });
    }
  }

  /** Emit the receipt (mandatory, if the broker produced one) then resolve/throw. */
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
