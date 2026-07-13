/**
 * Broker IPC wire protocol (D10): newline-delimited framed JSON over a Unix
 * domain socket. Each request/response is one JSON object per line (JSON never
 * contains a raw newline, so `\n` is an unambiguous frame delimiter). Both sides
 * validate against these shapes; the daemon additionally validates domain
 * payloads with the `@atlas/contracts` schemas.
 */
import { z } from "zod";
import {
  AuditEventSchema,
  AuthorizationChallengeSchema,
  AuthorizationResponseSchema,
  IntendedEffectSchema,
  RunManifestSchema,
} from "@atlas/contracts";

/** The methods the broker exposes over IPC. */
export type BrokerMethod =
  | "appendAuditEvent"
  | "signAndAppendAuditEvent"
  | "getAuditChainStatus"
  | "advanceProtectedRef"
  | "integrateSourceCapture"
  | "mintChallenge"
  | "execAuthorized";

/** The closed set of methods (runtime-checkable, matches {@link BrokerMethod}). */
export const BROKER_METHODS = [
  "appendAuditEvent",
  "signAndAppendAuditEvent",
  "getAuditChainStatus",
  "advanceProtectedRef",
  "integrateSourceCapture",
  "mintChallenge",
  "execAuthorized",
] as const;

/**
 * The wire form of an UNSIGNED audit event (F4): the caller submits everything a
 * signed event carries EXCEPT `prevAuditHead` (broker-filled) and the signature
 * (broker-owned attestation key). The broker deep-validates the completed event
 * again inside `signAndAppend`; this schema is the transit contract.
 */
export const UnsignedAuditEventSchema = AuditEventSchema.omit({ prevAuditHead: true });

/** A framed request. `id` correlates the response; `params` is method-specific. */
export interface BrokerRequest {
  readonly id: number;
  readonly method: BrokerMethod;
  readonly params: unknown;
}

/** A framed success response. */
export interface BrokerOkResponse {
  readonly id: number;
  readonly ok: true;
  readonly result: unknown;
}

/** A framed refusal response (mirrors {@link BrokerRefusal.toWire}). */
export interface BrokerErrResponse {
  readonly id: number;
  readonly ok: false;
  readonly code: string;
  readonly exitCode: number;
  readonly message: string;
  readonly detail: Record<string, unknown>;
}

export type BrokerResponse = BrokerOkResponse | BrokerErrResponse;

/**
 * The wire form of a `SignedAuditEvent`: its raw `Uint8Array` signature is
 * base64-encoded so it survives JSON (a bare `Uint8Array` would serialize to a
 * lossy `{0:..,1:..}` object). Client encodes before send; server decodes on
 * receipt so the broker verifies the exact raw signature bytes.
 */
export interface WireSignedAuditEvent {
  readonly event: unknown;
  readonly signatureB64: string;
  readonly signerId: string;
}

/** Encode a `{ event, signature: Uint8Array, signerId }` to its wire form. */
export function encodeAuditEvent(e: { event: unknown; signature: Uint8Array; signerId: string }): WireSignedAuditEvent {
  return { event: e.event, signatureB64: Buffer.from(e.signature).toString("base64"), signerId: e.signerId };
}

/** Decode a wire audit event back to `{ event, signature: Uint8Array, signerId }`. */
export function decodeAuditEvent(w: WireSignedAuditEvent): { event: unknown; signature: Uint8Array; signerId: string } {
  return { event: w.event, signature: new Uint8Array(Buffer.from(w.signatureB64, "base64")), signerId: w.signerId };
}

// ---------------------------------------------------------------------------
// Runtime contract validation (D10): every request/response is validated on
// BOTH sides against a discriminated schema. A malformed but correlatable
// request becomes `broker.bad_request`; a malformed response is rejected rather
// than resolving a typed client call with garbage.
// ---------------------------------------------------------------------------

/** Wire form of a signed audit event (raw signature base64 for JSON transit). */
const WireSignedAuditEventSchema = z.object({
  event: z.unknown(),
  signatureB64: z.string(),
  signerId: z.string().min(1),
});

/** A privileged-op descriptor (challenge inputs). */
const PrivilegedOpDescriptorSchema = z.object({
  op: z.string().min(1),
  runId: z.string().optional(),
  targetCommit: z.string().optional(),
  canonicalBaseCommit: z.string().min(1),
  intendedEffect: IntendedEffectSchema,
});

/** Per-method parameter schemas (the discriminated request contract). */
const METHOD_PARAM_SCHEMAS: Record<BrokerMethod, z.ZodTypeAny> = {
  appendAuditEvent: WireSignedAuditEventSchema,
  signAndAppendAuditEvent: UnsignedAuditEventSchema,
  // Read-only: no params (the broker reads its own ref + anchor). Accept an
  // absent or empty-object params bag.
  getAuditChainStatus: z.union([z.undefined(), z.object({}).passthrough()]),
  advanceProtectedRef: z.object({
    ref: z.string().min(1),
    expectedOld: z.string().min(1),
    newCommit: z.string().min(1),
    manifest: RunManifestSchema,
    authorization: AuthorizationResponseSchema.optional(),
    authorizedOp: z.object({ op: z.string().min(1), intendedEffect: IntendedEffectSchema }).optional(),
    auditEvent: WireSignedAuditEventSchema,
  }),
  integrateSourceCapture: z.object({
    captureCommit: z.string().min(1),
    expectedBase: z.string().min(1),
    manifest: RunManifestSchema,
    auditEvent: WireSignedAuditEventSchema,
  }),
  mintChallenge: PrivilegedOpDescriptorSchema,
  execAuthorized: z.object({
    op: PrivilegedOpDescriptorSchema,
    auth: AuthorizationResponseSchema,
  }),
};

const OuterRequestSchema = z.object({
  id: z.number().int(),
  method: z.string(),
  params: z.unknown(),
});

/** The outcome of validating an inbound request frame. */
export type RequestParse =
  | { readonly kind: "ok"; readonly id: number; readonly method: BrokerMethod; readonly params: unknown }
  /** Correlatable (has a valid id): reply `broker.bad_request` for this id. */
  | { readonly kind: "bad"; readonly id: number; readonly message: string }
  /** Uncorrelatable (no usable id): the caller drops the connection. */
  | { readonly kind: "fatal"; readonly message: string };

/** Validate an inbound request frame against the discriminated request contract. */
export function validateRequest(raw: unknown): RequestParse {
  const outer = OuterRequestSchema.safeParse(raw);
  if (!outer.success) return { kind: "fatal", message: "request frame missing a numeric id" };
  const { id, method, params } = outer.data;
  if (!(BROKER_METHODS as readonly string[]).includes(method)) {
    return { kind: "bad", id, message: `unknown method "${method}"` };
  }
  const schema = METHOD_PARAM_SCHEMAS[method as BrokerMethod];
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { kind: "bad", id, message: `invalid params for "${method}": ${parsed.error.message}` };
  }
  return { kind: "ok", id, method: method as BrokerMethod, params: parsed.data };
}

const ResponseSchema = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    code: z.string().min(1),
    exitCode: z.number().int(),
    message: z.string(),
    detail: z.record(z.string(), z.unknown()),
  }),
]);

/** Validate an inbound response frame; returns `null` if it is malformed. */
export function validateResponse(raw: unknown): BrokerResponse | null {
  const parsed = ResponseSchema.safeParse(raw);
  return parsed.success ? (parsed.data as BrokerResponse) : null;
}

// ---------------------------------------------------------------------------
// Method-discriminated SUCCESS-result contract (round-3 finding 5). A
// correlatable `ok:true` frame must ALSO carry a `result` that conforms to the
// pending request's method — otherwise a malformed-but-correlatable success
// response would resolve a typed client call with arbitrary data. The client
// validates every success `result` against the schema for the method it sent.
// ---------------------------------------------------------------------------

/** `{ seq, head }` — the audit append result. */
const AppendResultSchema = z.object({ seq: z.number().int().nonnegative(), head: z.string().min(1) });

/** `{ ok, ref, newCommit, seq, auditHead }` — a protected-ref advance/capture result. */
const RefAdvanceResultSchema = z.object({
  ok: z.literal(true),
  ref: z.string().min(1),
  newCommit: z.string().min(1),
  seq: z.number().int().nonnegative(),
  auditHead: z.string().min(1),
});

/** `{ code:"authz.ok", authorized:true, op }` — the exec-authorized verdict. */
const PrivilegedOpResultSchema = z.object({
  code: z.literal("authz.ok"),
  authorized: z.literal(true),
  op: z.string().min(1),
});

/** `{ ok, head, count, detail? }` — the read-only audit-chain health verdict. */
const AuditChainStatusSchema = z.object({
  ok: z.boolean(),
  head: z.string(),
  count: z.number().int().nonnegative(),
  detail: z.string().optional(),
});

/** Per-method success-result schemas (mirrors the client's typed return shapes). */
const METHOD_RESULT_SCHEMAS: Record<BrokerMethod, z.ZodTypeAny> = {
  appendAuditEvent: AppendResultSchema,
  signAndAppendAuditEvent: AppendResultSchema,
  getAuditChainStatus: AuditChainStatusSchema,
  advanceProtectedRef: RefAdvanceResultSchema,
  integrateSourceCapture: RefAdvanceResultSchema,
  mintChallenge: AuthorizationChallengeSchema,
  execAuthorized: PrivilegedOpResultSchema,
};

/**
 * Validate a success `result` against the schema for `method`. Returns the
 * validated value on success or `null` when the result is malformed for that
 * method — the client rejects a `null` rather than resolving with garbage.
 */
export function validateResult(method: BrokerMethod, result: unknown): unknown | null {
  const schema = METHOD_RESULT_SCHEMAS[method];
  const parsed = schema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

/** Encode one frame (object → single line terminated by `\n`). */
export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * A minimal newline-delimited-JSON decoder. Feed it socket chunks; it yields
 * complete parsed frames and buffers any partial trailing line.
 */
export class FrameDecoder {
  private buf = "";

  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      out.push(JSON.parse(line));
    }
    return out;
  }
}
