/**
 * The egress-broker service + Unix-domain-socket server (D10/D17/D18/D19).
 *
 * `EgressService` is the enforcement core: on EVERY `invoke` it
 *   1. verifies the run-bound capability (MAC + expiry, D19);
 *   2. asserts the request's operation/model match the capability's binding;
 *   3. SERIALIZES the exact HTTP request body (adapter, validates the model
 *      allowlist) and scans THOSE EXACT BYTES in-broker (INVARIANT 2);
 *   4. refuses a payload whose declared `effectiveSensitivity` exceeds
 *      `allowedSensitivity` (Phase-2 declared value until 4.3);
 *   5. atomically RESERVES the conservative projected byte/token/cost draw against
 *      the per-run budget (D19) — held across the round-trip so concurrent calls
 *      cannot race the ceiling;
 *   6. TRANSMITS via the in-broker adapter (the sole credential + network holder);
 *      error/intermediate-retry bodies are scanned RAW via the transmit hook;
 *   7. parses the final response, then scans the canonical serialization of the
 *      RELEASED result in-broker BEFORE releasing it (ADR-0001: discarded provider
 *      envelope fields — e.g. Gemini's high-entropy `thoughtSignature` — never
 *      re-enter the host and are not part of the scanned surface);
 *   8. RECONCILES the reservation to the actual usage (or charges the dispatched
 *      bytes on a provider error) and returns a RECEIPT carrying ONLY allowlisted
 *      audit fields (request/response hashes, destination, model, tokens, latency,
 *      cost, retries) — the CLI writes the `model_calls` row (egress has NO SQLite).
 *
 * A refusal (capability-mismatch, scan block, sensitivity over-export, budget) or a
 * provider error STILL yields a receipt for a run-attributable transmission, so the
 * CLI writes a `model_calls` row for the refused call too (D6). Only a structurally
 * invalid/expired capability (no trustworthy run binding) yields no receipt.
 */
import { createHash } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import type { z } from "zod";
import type { QuarantineSink } from "@atlas/scan";
import {
  verifyCapability,
  sensitivityRank,
  type CapabilitySensitivity,
  type EgressCapabilityClaims,
  type EgressOperation,
} from "./capability.js";
import { EgressRefusal } from "./errors.js";
import { RunBudget } from "./budget.js";
import type { BudgetStore } from "./budget-store.js";
import { scanEgressPayload } from "./scan.js";
import { ProviderCallError, providerError } from "./provider-error.js";
import type { ProviderAdapter, SerializedRequest } from "./gemini.js";
import { DEFAULT_SCHEMA_REGISTRY, resolveSchema } from "./schema-registry.js";
import type { EgressInvokeParams, EgressResponse } from "./protocol.js";
import {
  encodeFrame,
  FrameDecoder,
  validateEgressRequest,
} from "./protocol.js";
import type { ModelCallReceipt, Usage } from "./types.js";

/** The service's config: the credential-bound adapter, the scan sink, the mint key. */
export interface EgressServiceConfig {
  /** The provider adapter (holds the credential + network). */
  readonly adapter: ProviderAdapter;
  /** The CLI-side quarantine sink the in-broker scan captures offending bytes into. */
  readonly quarantine: QuarantineSink;
  /** The shared capability-MAC secret (verifies the CLI-minted capability). */
  readonly capabilitySecret: Buffer | string;
  /** The `generateObject` schema registry (defaults to {@link DEFAULT_SCHEMA_REGISTRY}). */
  readonly schemaRegistry?: Readonly<Record<string, z.ZodTypeAny>>;
  /**
   * Optional broker-owned PERSISTENT budget store (D19). When supplied, per-run
   * cost/byte/token tallies are durably persisted, so restarting or launching a
   * replacement daemon CANNOT reset a run's consumed allowance (the same capability
   * cannot regain its full ceilings by racing a restart). Absent ⇒ in-memory only.
   */
  readonly budgetStore?: BudgetStore;
  /** Injectable clock (ms) for latency + expiry (default real timer/date). */
  readonly now?: () => Date;
  readonly monotonicMs?: () => number;
}

/** The typed outcome of an `invoke` (before wire encoding). */
export type InvokeOutcome =
  | { readonly ok: true; readonly receipt: ModelCallReceipt; readonly result: unknown }
  | {
      readonly ok: false;
      readonly providerError: false;
      readonly refusal: EgressRefusal;
      readonly receipt?: ModelCallReceipt;
    }
  | {
      readonly ok: false;
      readonly providerError: true;
      readonly error: ProviderCallError;
      readonly receipt: ModelCallReceipt;
    };

function sha256Hex(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * A DEMONSTRABLY-SAFE token upper bound for a text: its UTF-8 BYTE length (≥1).
 * Every subword/BPE token a provider tokenizer emits merges AT LEAST one input byte,
 * so the token count can never exceed the byte count — byte length is a conservative
 * over-estimate, whereas `chars/4` UNDER-estimates and lets actual usage overrun the
 * ceiling (the finding). Over-charging only refuses sooner, never lets a run exceed
 * its bound; the reservation is reconciled down to the provider-reported usage on
 * success.
 */
function estimateTextTokens(text: string): number {
  return Math.max(1, Buffer.byteLength(text, "utf8"));
}

/** A pre-flight token upper bound for an embed batch: the summed UTF-8 byte length (≥1 per text). */
function estimateEmbedTokens(texts: readonly string[]): number {
  return texts.reduce((n, t) => n + Math.max(1, Buffer.byteLength(t, "utf8")), 0);
}

export class EgressService {
  private readonly budget: RunBudget;
  private readonly schemaRegistry: Readonly<Record<string, z.ZodTypeAny>>;
  private readonly now: () => Date;
  private readonly monotonicMs: () => number;

  constructor(private readonly cfg: EgressServiceConfig) {
    // The per-run budget is the actual export/spend boundary (D19). When a
    // persistent `budgetStore` is supplied, tallies survive a daemon restart /
    // replacement (a restart MUST NOT reset a run's consumed allowance); otherwise
    // it is daemon-lifetime in-memory state (unit tests / single-process use).
    this.budget = new RunBudget(cfg.budgetStore !== undefined ? { store: cfg.budgetStore } : {});
    this.schemaRegistry = cfg.schemaRegistry ?? DEFAULT_SCHEMA_REGISTRY;
    this.now = cfg.now ?? (() => new Date());
    this.monotonicMs = cfg.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  }

  /**
   * Reconcile a DISPATCHED call whose provider-reported usage is unavailable (a
   * provider error, a response-scan block, or a malformed/schema-invalid body):
   * reconcile the byte draw to what was actually retransmitted, but RETAIN the
   * conservative projected tokens/cost (never reduced to zero) so repeated invalid
   * outputs cannot consume provider spend without drawing down the run budget.
   */
  private chargeConservative(reservation: import("./budget.js").BudgetReservation, actualBytes: number): void {
    this.budget.reconcile(reservation, { bytes: actualBytes, tokens: reservation.tokens, costMicros: reservation.costMicros });
  }

  /** Enforce + transmit a single provider call. Never throws for a run-attributable
   * refusal/provider-error — it returns a typed outcome carrying the receipt. */
  async invoke(params: EgressInvokeParams, signal?: AbortSignal): Promise<InvokeOutcome> {
    // (1) Capability verification (MAC + expiry). No trustworthy run binding ⇒ no receipt.
    const verdict = verifyCapability(params.capability, { secret: this.cfg.capabilitySecret, now: this.now });
    if (!verdict.ok) {
      return { ok: false, providerError: false, refusal: new EgressRefusal(verdict.code, verdict.reason) };
    }
    const claims = verdict.claims;
    const adapter = this.cfg.adapter;
    const body = params.body;
    const operation = body.operation as EgressOperation;

    // (2) Operation/model binding — refuse BEFORE serializing anything.
    if (body.operation !== claims.operation) {
      return this.refuseNoReserve(claims, operation, "unbound", params.declaredSensitivity, "egress.capability_mismatch", `operation ${body.operation} != capability ${claims.operation}`);
    }
    if (body.request.model !== claims.model) {
      return this.refuseNoReserve(claims, operation, "unbound", params.declaredSensitivity, "egress.capability_mismatch", `model ${body.request.model} != capability ${claims.model}`);
    }

    // (3a) Serialize the EXACT HTTP request body (validates the model allowlist). A
    // disallowed/unpriced/cross-operation model is a terminal provider error emitted
    // BEFORE any transport, dispatch, or budget reservation.
    let serialized: SerializedRequest;
    try {
      serialized = adapter.serialize(operation, body.request);
    } catch (err) {
      if (err instanceof ProviderCallError) {
        return { ok: false, providerError: true, error: err, receipt: this.receipt(claims, operation, "unbound", params.declaredSensitivity, { outcome: "error", reasonCode: err.kind }) };
      }
      throw err;
    }
    const requestBytes = serialized.bytes;
    const requestHash = sha256Hex(requestBytes);
    const origin = `egress:${claims.runId}:${requestHash}`;

    // (3b) In-broker request scan — on the EXACT SERIALIZED HTTP bytes.
    try {
      await scanEgressPayload(requestBytes, "request", origin, this.cfg.quarantine);
    } catch (err) {
      if (err instanceof EgressRefusal) {
        return this.refuseNoReserve(claims, operation, requestHash, params.declaredSensitivity, err.code, err.message, err.detail as Record<string, unknown>);
      }
      throw err;
    }

    // (4) Sensitivity ceiling (Phase-2 declared value).
    if (sensitivityRank(params.declaredSensitivity) > sensitivityRank(claims.allowedSensitivity as CapabilitySensitivity)) {
      return this.refuseNoReserve(claims, operation, requestHash, params.declaredSensitivity, "egress.sensitivity_exceeded", `declared ${params.declaredSensitivity} exceeds allowed ${claims.allowedSensitivity}`, { declaredSensitivity: params.declaredSensitivity, allowedSensitivity: claims.allowedSensitivity });
    }

    // (5a) generateObject schema resolution — BEFORE dispatch (a pointless dispatch
    // for an unresolvable schema is a terminal validation error, no reservation).
    let schema: z.ZodTypeAny | undefined;
    if (body.operation === "generateObject") {
      schema = resolveSchema(this.schemaRegistry, body.request.schemaId);
      if (schema === undefined) {
        const e = new ProviderCallError({ kind: "validation", retryable: false, message: `unknown schemaId "${body.request.schemaId}"` });
        return { ok: false, providerError: true, error: e, receipt: this.receipt(claims, operation, requestHash, params.declaredSensitivity, { outcome: "error", reasonCode: e.kind }) };
      }
    }

    // (5b) Conservative projection: input + output tokens, retry-bounded cost. An
    // UNPRICED model cannot be cost-bounded and is refused (never charged at zero).
    let projInputTokens: number;
    let projOutputTokens: number;
    if (body.operation === "embed") {
      projInputTokens = estimateEmbedTokens(body.request.texts);
      projOutputTokens = 0;
    } else {
      projInputTokens = estimateTextTokens(body.request.input);
      projOutputTokens = body.request.maxTokens ?? projInputTokens;
    }
    const projTokens = projInputTokens + projOutputTokens;
    const projCost = adapter.costMicros(body.request.model, { inputTokens: projInputTokens, outputTokens: projOutputTokens });
    if (projCost === null) {
      return this.refuseNoReserve(claims, operation, requestHash, params.declaredSensitivity, "egress.cost_budget_exceeded", `model ${body.request.model} is unpriced — the dispatch cannot be cost-bounded`);
    }

    // (5c) Atomic reservation (synchronous — no await between check and commit).
    // Reserve the RETRY-BOUNDED worst case for bytes: a single call may retransmit
    // its request body up to `maxAttempts` times, so a retry storm cannot slip past
    // the run's byte ceiling. Tokens/cost are charged once (failed attempts return no
    // provider usage). Bytes are reconciled below to what was actually retransmitted.
    const maxAttempts = adapter.maxAttempts ?? 1;
    const reserved = this.budget.reserve(claims, { bytes: requestBytes.byteLength * maxAttempts, tokens: projTokens, costMicros: projCost });
    if (!reserved.ok) {
      return this.refuseNoReserve(claims, operation, requestHash, params.declaredSensitivity, reserved.code, reserved.reason);
    }
    const reservation = reserved.reservation;

    // (6) The provider round-trip (the sole credential + network holder). The
    // `onResponse` hook scans the EXACT RAW BYTES of every ERROR / intermediate-retry
    // response in-broker BEFORE the adapter maps its status — so a secret in a 401 /
    // 429 / 5xx body (or an echo in a retried body) is caught, quarantined, and
    // refused just like a 2xx echo (INVARIANT 2). A scan block throws EgressRefusal
    // out of `transmit`; a provider fault throws ProviderCallError.
    const started = this.monotonicMs();
    let transmitted: { rawResponse: Uint8Array; retries: number };
    try {
      transmitted = await adapter.transmit(serialized, signal, (bytes) =>
        scanEgressPayload(bytes, "response", origin, this.cfg.quarantine),
      );
    } catch (err) {
      if (err instanceof EgressRefusal) {
        // An error/retry response body was scan-blocked in-broker. The call WAS
        // dispatched, so retain the CONSERVATIVE projected charge (bytes reconciled
        // to what was retransmitted; tokens/cost held at the projection because no
        // trustworthy provider usage is available).
        const latencyMs = this.monotonicMs() - started;
        this.chargeConservative(reservation, requestBytes.byteLength);
        return {
          ok: false,
          providerError: false,
          refusal: err,
          receipt: this.receipt(claims, operation, requestHash, params.declaredSensitivity, { outcome: "refused", reasonCode: err.code, latencyMs }),
        };
      }
      if (err instanceof ProviderCallError) {
        const latencyMs = this.monotonicMs() - started;
        const retries = err.attempt?.retries ?? 0;
        // Dispatched-but-no-usage: charge the retransmitted bytes AND retain the
        // conservative projected tokens/cost (never reconciled to zero — else a
        // repeated provider fault would consume spend without drawing down budget).
        this.chargeConservative(reservation, requestBytes.byteLength * (retries + 1));
        return { ok: false, providerError: true, error: err, receipt: this.receipt(claims, operation, requestHash, params.declaredSensitivity, { outcome: "error", reasonCode: err.kind, latencyMs, retries }) };
      }
      this.budget.release(reservation);
      throw err;
    }
    const latencyMs = this.monotonicMs() - started;
    const retries = transmitted.retries;
    const responseBytes = transmitted.rawResponse;
    const responseHash = sha256Hex(responseBytes);

    // (7a) Parse the raw (final, 2xx) response bytes into the typed result FIRST
    // (ADR-0001). Envelope fields the adapter discards (e.g. Gemini's per-response
    // `thoughtSignature` — an opaque high-entropy blob scan-indistinguishable from
    // a secret) never leave the broker, so they are not part of the scanned
    // surface. (Error/intermediate bodies were already scanned RAW by the hook.)
    let usage: Usage;
    let result: unknown;
    try {
      const parsed = adapter.parse(operation, body.request, responseBytes, schema);
      usage = parsed.usage;
      result = parsed.result;
    } catch (err) {
      if (err instanceof ProviderCallError) {
        // Malformed / schema-invalid output: dispatched-but-no-trustworthy-usage —
        // retain the conservative projected tokens/cost (never reconciled to zero).
        this.chargeConservative(reservation, requestBytes.byteLength * (retries + 1));
        return { ok: false, providerError: true, error: err, receipt: this.receipt(claims, operation, requestHash, params.declaredSensitivity, { outcome: "error", reasonCode: err.kind, responseHash, latencyMs, retries }) };
      }
      this.chargeConservative(reservation, requestBytes.byteLength * (retries + 1));
      throw err;
    }

    // (7b) In-broker response scan — on the canonical serialization of the RELEASED
    // result: exactly the bytes that re-enter the host (ADR-0001). A provider echo
    // of a secret in the generated text/object is in these bytes by definition and
    // blocks + quarantines just as before.
    const releasedBytes = Buffer.from(JSON.stringify(result ?? null), "utf8");
    try {
      await scanEgressPayload(releasedBytes, "response", origin, this.cfg.quarantine);
    } catch (err) {
      if (err instanceof EgressRefusal) {
        // Dispatched but the released response is blocked: retain the conservative charge.
        this.chargeConservative(reservation, requestBytes.byteLength * (retries + 1));
        return {
          ok: false,
          providerError: false,
          refusal: err,
          receipt: this.receipt(claims, operation, requestHash, params.declaredSensitivity, { outcome: "refused", reasonCode: err.code, responseHash, latencyMs, retries }),
        };
      }
      this.chargeConservative(reservation, requestBytes.byteLength * (retries + 1));
      throw err;
    }

    // (8) Success — reconcile to ACTUAL usage + emit the success receipt.
    const actualCost = adapter.costMicros(body.request.model, usage) ?? 0;
    const usedTokens = usage.inputTokens + (usage.outputTokens ?? 0);
    this.budget.reconcile(reservation, { bytes: requestBytes.byteLength * (retries + 1), tokens: usedTokens, costMicros: actualCost });
    return {
      ok: true,
      result,
      receipt: this.receipt(claims, operation, requestHash, params.declaredSensitivity, {
        outcome: "success",
        responseHash,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens ?? 0,
        costMicros: actualCost,
        latencyMs,
        retries,
      }),
    };
  }

  /** Build a refusal outcome for a case that never held a budget reservation. */
  private refuseNoReserve(
    claims: EgressCapabilityClaims,
    operation: EgressOperation,
    requestHash: string,
    declaredSensitivity: CapabilitySensitivity,
    code: EgressRefusal["code"],
    reason: string,
    detail?: Record<string, unknown>,
  ): InvokeOutcome {
    return {
      ok: false,
      providerError: false,
      refusal: new EgressRefusal(code, reason, detail),
      receipt: this.receipt(claims, operation, requestHash, declaredSensitivity, { outcome: "refused", reasonCode: code }),
    };
  }

  /** Read-only per-run budget view (tests/diagnostics). */
  budgetSnapshot(runId: string): { bytes: number; tokens: number; costMicros: number } {
    return this.budget.snapshot(runId);
  }

  /** Assemble a receipt (allowlisted audit fields only). */
  private receipt(
    claims: EgressCapabilityClaims,
    operation: ModelCallReceipt["operation"],
    requestHash: string,
    declaredSensitivity: CapabilitySensitivity,
    over: Partial<ModelCallReceipt> & { outcome: ModelCallReceipt["outcome"] },
  ): ModelCallReceipt {
    return {
      runId: claims.runId,
      provider: this.cfg.adapter.provider,
      model: claims.model,
      operation,
      requestHash: requestHash === "unbound" ? sha256Hex(Buffer.from(`unbound:${claims.runId}:${claims.nonce}`, "utf8")) : requestHash,
      destination: this.cfg.adapter.host,
      inputTokens: over.inputTokens ?? 0,
      outputTokens: over.outputTokens ?? 0,
      costMicros: over.costMicros ?? 0,
      latencyMs: over.latencyMs ?? 0,
      retries: over.retries ?? 0,
      outcome: over.outcome,
      effectiveSensitivity: declaredSensitivity,
      ...(over.responseHash !== undefined ? { responseHash: over.responseHash } : {}),
      ...(over.reasonCode !== undefined ? { reasonCode: over.reasonCode } : {}),
    };
  }
}

/** A running egress socket server. */
export interface EgressServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

function encodeOutcome(id: number, outcome: InvokeOutcome): EgressResponse {
  if (outcome.ok) return { id, ok: true, receipt: outcome.receipt, result: outcome.result };
  if (outcome.providerError) {
    const wire = outcome.error.toBody();
    return {
      id,
      ok: false,
      providerError: true,
      code: `provider.${outcome.error.kind}`,
      exitCode: 1,
      message: outcome.error.message,
      detail: {},
      providerErrorBody: wire as unknown as Record<string, unknown>,
      receipt: outcome.receipt,
    };
  }
  const w = outcome.refusal.toWire();
  return {
    id,
    ok: false,
    providerError: false,
    code: w.code,
    exitCode: w.exitCode,
    message: w.message,
    detail: w.detail,
    ...(outcome.receipt !== undefined ? { receipt: outcome.receipt } : {}),
  };
}

/**
 * Start the egress server bound to `socketPath` (created `0660`; the
 * `atlas-egress:atlas-git` ownership is provisioning's job, D10). A stale socket
 * file is removed first. Each in-flight `invoke` is backed by a server-side
 * `AbortController`: a `cancel` frame for its id aborts it, and a socket
 * disconnect aborts every in-flight request on that connection (D19 cancellation).
 */
export async function startEgressServer(service: EgressService, socketPath: string): Promise<EgressServer> {
  // A stale socket file is safe to remove; a LIVE one means another egress daemon is
  // already bound. Unconditionally unlinking it (the finding, D19) would let a SECOND
  // daemon run with an INDEPENDENT in-memory tally — the two would reserve from stale
  // totals and jointly overrun the ceiling. So probe first and REFUSE a live socket;
  // only a stale (no-listener) socket is reclaimed. This is the singleton guard that
  // pairs with the cross-process budget CAS (a persistent store guards the residual
  // race where two daemons bind DIFFERENT socket paths for the same run).
  if (existsSync(socketPath)) {
    if (await isSocketLive(socketPath)) {
      throw new Error(`refusing to start: a live egress daemon is already listening on ${socketPath}`);
    }
    rmSync(socketPath, { force: true });
  }

  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder();
    let queue: Promise<void> = Promise.resolve();
    // Per-connection invoke registry. `started` flips synchronously at the top of the
    // queued task (before any await); `settled` guards against a double response when
    // a queued call is cancelled OUT OF BAND (finding #9).
    interface PendingInvoke { readonly controller: AbortController; started: boolean; settled: boolean }
    const inflight = new Map<number, PendingInvoke>();

    /**
     * Respond to a cancel for an invoke still QUEUED behind another call (finding #9).
     * The invoke serialization queue means a queued task's body does NOT run until the
     * call ahead of it finishes — so merely aborting its controller (which it can only
     * observe once its body runs) would leave the caller hanging behind a long/blocked
     * predecessor. We therefore emit the `cancelled` provider-error receipt OUT OF
     * BAND, in frame order, and mark the entry `settled` so the queued task becomes a
     * no-op when it eventually reaches the front. A queued-never-dispatched call had no
     * transmission, so it carries no `model_calls` receipt (D6 covers dispatched calls).
     */
    const cancelQueued = (id: number): void => {
      const err = new ProviderCallError(providerError("cancelled", { message: "cancelled before dispatch" }));
      socket.write(encodeFrame({
        id,
        ok: false,
        providerError: true,
        code: `provider.${err.kind}`,
        exitCode: 1,
        message: err.message,
        detail: {},
        providerErrorBody: err.toBody() as unknown as Record<string, unknown>,
      }));
    };

    socket.on("data", (chunk: string) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        // A `cancel` frame is handled synchronously, out of band (never queued behind
        // the invoke it is cancelling). If the target invoke has already STARTED, we
        // abort its controller and let the running call return `cancelled` through the
        // normal path. If it is still QUEUED (its body has not run), we cannot rely on
        // it observing the abort — the queue is blocked behind the predecessor — so we
        // respond immediately and mark it settled so the queued task skips (finding #9).
        if (isCancelFrame(frame)) {
          const entry = inflight.get(frame.params.id);
          if (entry === undefined) continue;
          entry.controller.abort();
          if (!entry.started && !entry.settled) {
            entry.settled = true;
            inflight.delete(frame.params.id);
            cancelQueued(frame.params.id);
          }
          continue;
        }
        const parse = validateEgressRequest(frame);
        if (parse.kind === "fatal") {
          socket.destroy();
          return;
        }
        // Register the AbortController BEFORE queueing (finding #9): a `cancel` frame
        // for an invoke still QUEUED behind another call must find its controller.
        const entry: PendingInvoke | undefined = parse.kind === "ok" ? { controller: new AbortController(), started: false, settled: false } : undefined;
        if (parse.kind === "ok" && entry !== undefined) inflight.set(parse.id, entry);
        queue = queue.then(async () => {
          if (parse.kind === "bad") {
            const refusal = new EgressRefusal("egress.bad_request", parse.message);
            const w = refusal.toWire();
            socket.write(encodeFrame({ id: parse.id, ok: false, providerError: false, code: w.code, exitCode: w.exitCode, message: w.message, detail: w.detail }));
            return;
          }
          // The call may have been cancelled while queued (settled out of band above);
          // if so this task is a no-op — the caller already received `cancelled`.
          if (entry!.settled) return;
          entry!.started = true;
          try {
            const outcome = await service.invoke(parse.params, entry!.controller.signal);
            socket.write(encodeFrame(encodeOutcome(parse.id, outcome)));
          } catch (err) {
            const refusal = new EgressRefusal("egress.internal", err instanceof Error ? err.message : String(err));
            const w = refusal.toWire();
            socket.write(encodeFrame({ id: parse.id, ok: false, providerError: false, code: w.code, exitCode: w.exitCode, message: w.message, detail: w.detail }));
          } finally {
            inflight.delete(parse.id);
          }
        });
      }
    });
    const abortAll = (): void => {
      for (const [, e] of inflight) e.controller.abort();
      inflight.clear();
    };
    socket.on("close", abortAll);
    socket.on("error", () => {
      abortAll();
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  try {
    chmodSync(socketPath, 0o660);
  } catch {
    // Provisioning owns the final mode; do not fail startup on chmod.
  }

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (existsSync(socketPath)) rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}

/**
 * Probe whether a Unix socket file has a LIVE listener. A successful connect ⇒ live
 * (a daemon is bound); `ECONNREFUSED`/`ENOENT` ⇒ stale (the file outlived its
 * daemon). Any connection opened is immediately destroyed. Used to refuse starting a
 * second daemon over a live socket (finding #3).
 */
function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    const done = (live: boolean): void => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/** A well-formed cancellation frame: `{ method: "cancel", params: { id } }`. */
function isCancelFrame(frame: unknown): frame is { method: "cancel"; params: { id: number } } {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as { method?: unknown; params?: unknown };
  if (f.method !== "cancel") return false;
  const p = f.params as { id?: unknown } | undefined;
  return typeof p === "object" && p !== null && typeof p.id === "number";
}
