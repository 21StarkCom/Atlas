/**
 * Egress-broker IPC wire protocol (D10): newline-delimited framed JSON over the
 * `atlas-egress` Unix domain socket. One JSON object per line; both sides validate
 * against these shapes. Distinct from the integration-broker protocol — the egress
 * broker exposes exactly one method (`invoke`) carrying a capability + a typed
 * provider request, and always replies with a RECEIPT (D18) alongside the result
 * or refusal so the CLI can write the `model_calls` row for every transmission.
 *
 * The frame codec (`encodeFrame`/`FrameDecoder`) is shared with the integration
 * broker (`../protocol.js`) — the framing is identical; only the payload contract
 * differs.
 */
import { z } from "zod";
import { EgressCapabilitySchema, SENSITIVITY_ORDER } from "./capability.js";
import {
  EmbedRequestSchema,
  GenerateObjectRequestSchema,
  GenerateTextRequestSchema,
  ModelCallReceiptSchema,
} from "./types.js";

export { encodeFrame, FrameDecoder } from "../protocol.js";

/** The typed provider request carried in an `invoke` — discriminated by `operation`. */
export const EgressRequestBodySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("generateText"), request: GenerateTextRequestSchema }).strict(),
  z.object({ operation: z.literal("generateObject"), request: GenerateObjectRequestSchema }).strict(),
  z.object({ operation: z.literal("embed"), request: EmbedRequestSchema }).strict(),
]);
export type EgressRequestBody = z.infer<typeof EgressRequestBodySchema>;

/** The `invoke` params: a run-bound capability + the typed provider request + the
 * payload's declared sensitivity (Phase-2 uses the declared value as
 * `effectiveSensitivity` until 4.3). */
export const EgressInvokeParamsSchema = z
  .object({
    capability: EgressCapabilitySchema,
    body: EgressRequestBodySchema,
    declaredSensitivity: z.enum(SENSITIVITY_ORDER),
  })
  .strict();
export type EgressInvokeParams = z.infer<typeof EgressInvokeParamsSchema>;

/** A framed request. Only `invoke` exists; `id` correlates the response. */
export interface EgressRequest {
  readonly id: number;
  readonly method: "invoke";
  readonly params: unknown;
}

const OuterRequestSchema = z.object({ id: z.number().int(), method: z.string(), params: z.unknown() });

/** The outcome of validating an inbound request frame. */
export type EgressRequestParse =
  | { readonly kind: "ok"; readonly id: number; readonly params: EgressInvokeParams }
  | { readonly kind: "bad"; readonly id: number; readonly message: string }
  | { readonly kind: "fatal"; readonly message: string };

/** Validate an inbound request frame against the egress contract. */
export function validateEgressRequest(raw: unknown): EgressRequestParse {
  const outer = OuterRequestSchema.safeParse(raw);
  if (!outer.success) return { kind: "fatal", message: "request frame missing a numeric id" };
  const { id, method, params } = outer.data;
  if (method !== "invoke") return { kind: "bad", id, message: `unknown method "${method}"` };
  const parsed = EgressInvokeParamsSchema.safeParse(params);
  if (!parsed.success) return { kind: "bad", id, message: `invalid invoke params: ${parsed.error.message}` };
  return { kind: "ok", id, params: parsed.data };
}

// ---------------------------------------------------------------------------
// Responses. Every response carries a RECEIPT (D18). A success additionally
// carries the typed provider `result`; a failure carries a typed `error` that is
// EITHER an egress refusal (`egress.*`) OR a mapped provider error (its `kind`).
// ---------------------------------------------------------------------------

export interface EgressOkResponse {
  readonly id: number;
  readonly ok: true;
  readonly receipt: unknown;
  readonly result: unknown;
}

export interface EgressErrResponse {
  readonly id: number;
  readonly ok: false;
  /** `true` when `error` is a `@atlas/contracts` ProviderError; `false` for an egress refusal. */
  readonly providerError: boolean;
  readonly code: string;
  readonly exitCode: number;
  readonly message: string;
  readonly detail: Record<string, unknown>;
  /** Present for a provider-error failure — the exact ProviderError to re-throw client-side. */
  readonly providerErrorBody?: Record<string, unknown>;
  /** Present when the broker produced a receipt for the failed transmission (D18). */
  readonly receipt?: unknown;
}

export type EgressResponse = EgressOkResponse | EgressErrResponse;

const ResponseSchema = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), receipt: ModelCallReceiptSchema, result: z.unknown() }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    providerError: z.boolean(),
    code: z.string().min(1),
    exitCode: z.number().int(),
    message: z.string(),
    detail: z.record(z.string(), z.unknown()),
    providerErrorBody: z.record(z.string(), z.unknown()).optional(),
    receipt: ModelCallReceiptSchema.optional(),
  }),
]);

/** Validate an inbound response frame; returns `null` if malformed. */
export function validateEgressResponse(raw: unknown): EgressResponse | null {
  const parsed = ResponseSchema.safeParse(raw);
  return parsed.success ? (parsed.data as EgressResponse) : null;
}
