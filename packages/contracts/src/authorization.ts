/**
 * Authorization challenge/response schemas mirroring the security/broker
 * contract §7 (Task 0.3). The drift-rejection error catalog and the machine-
 * readable §7.5 `authzContract` block remain the doc's SSOT (parsed by the
 * retained `contract-lint` gate) — this module mirrors the two message schemas
 * so both broker and CLI validate identical bytes across the IPC seam.
 */
import { z } from "zod";
import { Ulid, CommitHash, Rfc3339Ms, Nonce, Ed25519Sig, Sha256Digest, SchemaVersion1 } from "./primitives.js";

// ---------------------------------------------------------------------------
// §7.4 intendedEffect — op-specific, discriminated on `kind`
// ---------------------------------------------------------------------------

const RiskTier = z.union([z.literal(1), z.literal(2), z.literal(3)]);

// `git approve` (§7.1 example).
const IntegrateEffect = z.object({
  kind: z.literal("integrate"),
  tier: RiskTier,
  changePlanDigest: Sha256Digest,
});

// `git rollback` — carries the broker-derived revert commit (§7.4).
// NOTE: the contract fixes only `intendedEffect.revertCommit` for rollback and
// leaves the `kind` label unstated; we use "revert" as the reasonable name.
const RevertEffect = z.object({
  kind: z.literal("revert"),
  revertCommit: CommitHash,
});

// `purge` (§7.4).
const EraseEffect = z.object({
  kind: z.literal("erase"),
  oldHead: CommitHash,
  replacementHead: CommitHash,
  scope: z.string().min(1),
});

// `db restore` (§7.4).
const RestoreEffect = z.object({
  kind: z.literal("restore"),
  backupRef: z.string().min(1),
  backupContentHash: Sha256Digest,
});

// `graduation migrate` (§7.4).
const GraduateEffect = z.object({
  kind: z.literal("graduate"),
  fromGeneration: z.number().int().nonnegative(),
  toGeneration: z.number().int().nonnegative(),
  migrationPlanDigest: Sha256Digest,
});

// `source trust promote` / `revoke` (§7.4).
const TrustEffect = z.object({
  kind: z.literal("trust"),
  sourceOpaqueId: z.string().min(1),
  fromLevel: z.string().min(1),
  toLevel: z.string().min(1),
});

// `db backup --force-unblock` variant (§7.4).
const ForceUnblockEffect = z.object({
  kind: z.literal("forceUnblock"),
  latestLedgerSeq: z.number().int().nonnegative(),
  acceptedRpoGap: z.number().int().nonnegative(),
});

// `quarantine inspect` (os-presence, §7.4).
const QuarantineInspectEffect = z.object({
  kind: z.literal("quarantineInspect"),
  quarantineItemOpaqueId: z.string().min(1),
});

// `quarantine resolve` (os-presence, §7.4).
const QuarantineResolveEffect = z.object({
  kind: z.literal("quarantineResolve"),
  quarantineItemOpaqueId: z.string().min(1),
  resolution: z.enum(["release", "discard"]),
});

/** The op-specific intended effect carried by an authorization challenge (§7.4). */
export const IntendedEffectSchema = z.discriminatedUnion("kind", [
  IntegrateEffect,
  RevertEffect,
  EraseEffect,
  RestoreEffect,
  GraduateEffect,
  TrustEffect,
  ForceUnblockEffect,
  QuarantineInspectEffect,
  QuarantineResolveEffect,
]);

export type IntendedEffect = z.infer<typeof IntendedEffectSchema>;

// ---------------------------------------------------------------------------
// §7.1 AuthorizationChallenge
// ---------------------------------------------------------------------------

/**
 * `AuthorizationChallenge` (contract §7.1). `runId`/`targetCommit` are optional
 * per op (absent for ops with no run/commit target); the remaining fields are
 * required. `signingPayload` is the exact canonical byte string to sign (§8.2).
 */
export const AuthorizationChallengeSchema = z.object({
  schemaVersion: SchemaVersion1,
  op: z.string().min(1),
  runId: Ulid.optional(),
  targetCommit: CommitHash.optional(),
  canonicalBaseCommit: CommitHash,
  intendedEffect: IntendedEffectSchema,
  nonce: Nonce,
  expiresAt: Rfc3339Ms,
  payloadCanonicalization: z.string().min(1),
  signingPayload: z.string().min(1),
});

export type AuthorizationChallenge = z.infer<typeof AuthorizationChallengeSchema>;

// ---------------------------------------------------------------------------
// §7.2 AuthorizationResponse
// ---------------------------------------------------------------------------

/** `AuthorizationResponse` (contract §7.2): the echoed challenge + signature. */
export const AuthorizationResponseSchema = z.object({
  schemaVersion: SchemaVersion1,
  challenge: AuthorizationChallengeSchema,
  signature: Ed25519Sig,
  signerId: z.string().min(1),
});

export type AuthorizationResponse = z.infer<typeof AuthorizationResponseSchema>;
