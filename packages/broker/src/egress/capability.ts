/**
 * Run-bound egress capability (D19).
 *
 * Every `@atlas/models` IPC request carries a short-lived capability minted
 * CLI-side per run, binding `{runId, operation, model, maxBytes, maxTokens,
 * costCeiling, allowedSensitivity}` plus an issue/expiry window and a nonce. The
 * egress broker enforces the capability + a per-run cost/byte/token budget in
 * addition to the payload scan, and refuses export of a payload whose
 * `effectiveSensitivity` exceeds the run's `allowedSensitivity`.
 *
 * THREAT MODEL (D13/D19, accepted local-first V1): the agent runs as the
 * unprivileged CLI, so a CLI-minted capability BOUNDS a compromised agent's
 * export/spend but is not unforgeable against a fully-compromised CLI (the CLI
 * holds the mint secret). The real boundary is the egress-side enforcement of the
 * capability + per-run budget + payload scan — a remote isolated issuer is V2. The
 * MAC here makes the fields tamper-evident IN TRANSIT and lets the broker reject a
 * capability whose bytes were mutated after mint; it is not a defence against a
 * CLI that can read the shared secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Ulid, Rfc3339Ms, Nonce } from "@atlas/contracts";

/** Sensitivity classes, most- to least-restrictive order fixed here (D2/§4.3 forward-ref). */
export const SENSITIVITY_ORDER = ["public", "internal", "confidential", "restricted"] as const;
export type CapabilitySensitivity = (typeof SENSITIVITY_ORDER)[number];

/** Rank a sensitivity class (higher = more restrictive). */
export function sensitivityRank(s: CapabilitySensitivity): number {
  return SENSITIVITY_ORDER.indexOf(s);
}

/** The provider operations a capability may authorize (the three non-mutating calls). */
export const EGRESS_OPERATIONS = ["generateText", "generateObject", "embed"] as const;
export type EgressOperation = (typeof EGRESS_OPERATIONS)[number];

/**
 * The signed capability fields (the MAC covers exactly these, in this shape). Kept
 * separate from the envelope so the canonical MAC input is unambiguous.
 */
export const EgressCapabilityClaimsSchema = z
  .object({
    runId: Ulid,
    operation: z.enum(EGRESS_OPERATIONS),
    model: z.string().min(1),
    /** Cumulative per-run outbound-byte ceiling (exact serialized request bytes). */
    maxBytes: z.number().int().positive(),
    /** Cumulative per-run token ceiling (input + output). */
    maxTokens: z.number().int().positive(),
    /** Cumulative per-run cost ceiling in integer micro-USD. */
    costCeiling: z.number().int().nonnegative(),
    /** The most-permissive sensitivity class this run may export. */
    allowedSensitivity: z.enum(SENSITIVITY_ORDER),
    issuedAt: Rfc3339Ms,
    expiresAt: Rfc3339Ms,
    nonce: Nonce,
  })
  .strict();

export type EgressCapabilityClaims = z.infer<typeof EgressCapabilityClaimsSchema>;

/** The capability as it crosses the IPC seam: the claims + a `keyId`-tagged MAC. */
export const EgressCapabilitySchema = z
  .object({
    claims: EgressCapabilityClaimsSchema,
    /** `hmac-sha256:<base64url>` over the canonical claims (see {@link macClaims}). */
    mac: z.string().min(1),
    /** Names which mint key produced the MAC (rotation-friendly). */
    keyId: z.string().min(1),
  })
  .strict();

export type EgressCapability = z.infer<typeof EgressCapabilitySchema>;

/** The default mint-key id (a single deployment key in V1). */
export const DEFAULT_CAPABILITY_KEY_ID = "atlas-egress-cap-v1";

/** RFC-8785-ish stable claim serialization: keys sorted, no whitespace, ms UTC times. */
function canonicalClaims(claims: EgressCapabilityClaims): string {
  // The claims are a flat object of primitives; JSON.stringify with a sorted key
  // list is byte-stable across processes (no nested objects, no floats — cost is
  // integer micros, times are RFC-3339 ms strings).
  const keys = Object.keys(claims).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = (claims as Record<string, unknown>)[k];
  return JSON.stringify(ordered);
}

/** Compute the MAC over the canonical claims. */
function macClaims(claims: EgressCapabilityClaims, secret: Buffer | string): string {
  const h = createHmac("sha256", secret);
  h.update(canonicalClaims(claims), "utf8");
  return `hmac-sha256:${h.digest("base64url")}`;
}

/** Everything `mintEgressCapability` needs beyond the run: the per-run limits. */
export interface EgressLimits {
  readonly operation: EgressOperation;
  readonly model: string;
  readonly maxBytes: number;
  readonly maxTokens: number;
  readonly costCeiling: number;
  readonly allowedSensitivity: CapabilitySensitivity;
  /** Capability TTL in seconds (default 300 — matches the broker nonce TTL). */
  readonly ttlSeconds?: number;
}

/** The minimal run context `mintEgressCapability` binds a capability to. */
export interface RunBinding {
  readonly runId: string;
}

/** Default capability TTL (seconds) — 5 minutes, matching the broker nonce store. */
export const DEFAULT_CAPABILITY_TTL_SECONDS = 300;

/**
 * Mint a run-bound egress capability (CLI-side, D19). `now`/`nonce` are injectable
 * for deterministic tests. The `secret` is the shared mint key (Keychain/keys-dir
 * custody in production); the same key verifies broker-side.
 */
export function mintEgressCapability(
  run: RunBinding,
  limits: EgressLimits,
  opts: { secret: Buffer | string; keyId?: string; now?: () => Date; nonce?: string },
): EgressCapability {
  const now = opts.now?.() ?? new Date();
  const ttl = limits.ttlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS;
  const nonce = opts.nonce ?? randomNonceHex();
  const claims: EgressCapabilityClaims = {
    runId: run.runId,
    operation: limits.operation,
    model: limits.model,
    maxBytes: limits.maxBytes,
    maxTokens: limits.maxTokens,
    costCeiling: limits.costCeiling,
    allowedSensitivity: limits.allowedSensitivity,
    issuedAt: toRfc3339Ms(now),
    expiresAt: toRfc3339Ms(new Date(now.getTime() + ttl * 1000)),
    nonce,
  };
  const keyId = opts.keyId ?? DEFAULT_CAPABILITY_KEY_ID;
  return { claims, mac: macClaims(claims, opts.secret), keyId };
}

/** The outcome of a broker-side capability verification. */
export type CapabilityVerdict =
  | { readonly ok: true; readonly claims: EgressCapabilityClaims }
  | { readonly ok: false; readonly code: "egress.capability_invalid" | "egress.capability_expired"; readonly reason: string };

/**
 * Verify a capability broker-side: structural validation, MAC over the canonical
 * claims (constant-time compare), and expiry. Operation/model/sensitivity/budget
 * enforcement is the server's job (it needs the request + the per-run tally); this
 * only proves the capability is well-formed, authentic, and unexpired.
 */
export function verifyCapability(
  cap: unknown,
  opts: { secret: Buffer | string; now?: () => Date },
): CapabilityVerdict {
  const parsed = EgressCapabilitySchema.safeParse(cap);
  if (!parsed.success) {
    return { ok: false, code: "egress.capability_invalid", reason: parsed.error.message };
  }
  const expected = macClaims(parsed.data.claims, opts.secret);
  const a = Buffer.from(parsed.data.mac, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "egress.capability_invalid", reason: "capability MAC did not verify" };
  }
  const now = opts.now?.() ?? new Date();
  if (Date.parse(parsed.data.claims.expiresAt) <= now.getTime()) {
    return { ok: false, code: "egress.capability_expired", reason: "capability expired" };
  }
  return { ok: true, claims: parsed.data.claims };
}

/** RFC-3339 UTC millisecond timestamp (matches `@atlas/contracts` `Rfc3339Ms`). */
function toRfc3339Ms(d: Date): string {
  return d.toISOString();
}

/** A 128-bit random nonce as 32 lowercase hex chars (matches the `Nonce` primitive). */
function randomNonceHex(): string {
  return randomBytes(16).toString("hex");
}
