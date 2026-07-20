/**
 * Authorization core (security/broker contract §7, §8, §9).
 *
 * Mints challenges (nonce + expiry + exact `signingPayload`) and verifies
 * authorization responses with the §7.3 stable drift codes. The verification
 * order is fixed and fail-closed: schema → canonicalization → payload recompute
 * → nonce → signer registry → D20 test-signer gate → signature → state drift.
 *
 * D20 lands HERE from Phase 1: an authorization signed by `atlas-test-approver`
 * is hard-rejected unless `ATLAS_TEST_MODE=1` is set in the broker env, so no
 * production-usable fixture signer can ship (`broker.rejects-test-signer-in-prod.test`).
 */
import {
  AuthorizationChallengeSchema,
  AuthorizationResponseSchema,
  CANONICALIZATION_ID,
  type AuthorizationChallenge,
  type AuthorizationResponse,
  type IntendedEffect,
  type SignerRegistryEntry,
} from "@atlas/contracts";
import { type KeyObject } from "node:crypto";
import { parsePublicKeyFlexible, parseP256PublicKeyFlexible, verifyBytes, verifyP256Bytes } from "./crypto.js";
import { BrokerRefusal, type AuthzCode } from "./errors.js";
import { NonceStore } from "./nonce.js";

/**
 * The shared fixture-signer descriptor (D20, SP-3). This is the SINGLE source of
 * truth for every fixture signer's id + algorithm + committed key material, so
 * `authorize.ts`'s D20 reject set, `keys.ts`'s fixture registration, and
 * `tools/test-signer.ts`'s signing key can NEVER drift apart (a rename in one
 * place that slipped the production reject in another is the exact hazard this
 * closes). Both fixture ids are hard-rejected unless `ATLAS_TEST_MODE=1`.
 *
 * - `ed25519` — the classic fixture; its key is DERIVED from the provisioned
 *   `atlas-test-approver.key` file (no committed key here — provisioning owns it).
 * - `p256` — the SP-3 software fixture; it has NO key file (SE keys have no
 *   broker-readable private key), so the descriptor carries a **committed fixed
 *   keypair**: `test-signer --alg p256` signs with `privateKeyPem`, the broker
 *   registers `publicKey` UNCONDITIONALLY (so D20 yields `d20`, not
 *   `signer_unknown`). Committing a fixture private key is safe precisely because
 *   D20 makes it un-authorizable outside test mode.
 */
export const TEST_SIGNER_DESCRIPTOR = {
  ed25519: { signerId: "atlas-test-approver", alg: "ed25519" as const },
  p256: {
    signerId: "atlas-test-approver-p256",
    alg: "p256" as const,
    /** `p256:<base64url(DER SPKI)>` — the broker registers + verifies against this. */
    publicKey:
      "p256:MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETLl9CKOG0i5lvX7wYZJhwFuYCQ0skIzj73x6lmIvX79VqhxIvPwyPckvRwTd-KYd0X-8rQPoxca1uTRys44VVg",
    /** PKCS#8 PEM — `tools/test-signer.ts --alg p256` signs with this. Fixture-only. */
    privateKeyPem:
      "-----BEGIN PRIVATE KEY-----\n" +
      "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQghPjIVg7zPK9FXX4t\n" +
      "YtQIjP3LcuV25ugmxKacEuyUtwWhRANCAARMuX0Io4bSLmW9fvBhkmHAW5gJDSyQ\n" +
      "jOPvfHqWYi9fv1WqHEi8/DI9yS9HBN34ph3Rf7ytA+jFxrW5NHKzjhVW\n" +
      "-----END PRIVATE KEY-----\n",
  },
} as const;

/** The classic ed25519 fixture signer id (keys.acl.json). Kept for back-compat. */
export const TEST_SIGNER_ID = TEST_SIGNER_DESCRIPTOR.ed25519.signerId;

/** The SP-3 software-P256 fixture signer id. */
export const TEST_P256_SIGNER_ID = TEST_SIGNER_DESCRIPTOR.p256.signerId;

/**
 * The full set of fixture signer ids the D20 gate hard-rejects outside test mode
 * (both algorithms). Derived from the descriptor — never a hand-kept second list.
 */
export const TEST_SIGNER_IDS: ReadonlySet<string> = new Set([
  TEST_SIGNER_DESCRIPTOR.ed25519.signerId,
  TEST_SIGNER_DESCRIPTOR.p256.signerId,
]);

/** The signing-payload preamble tag (§8.2). */
const SIGNING_PREFIX = "atlas.authz.v1";

const encoder = new TextEncoder();

/** The op fields needed to mint a challenge (subset of `AuthorizationChallenge`). */
export interface PrivilegedOpDescriptor {
  readonly op: string;
  readonly runId?: string;
  readonly targetCommit?: string;
  readonly canonicalBaseCommit: string;
  readonly intendedEffect: IntendedEffect;
}

/**
 * The broker-re-derived expected authorization descriptor (§7.2: "the execute
 * step re-derives the challenge from current state and rejects any drift"). Every
 * field the caller supplies is COMPARED against the echoed challenge and a
 * mismatch is the contract-specific drift refusal — this is what binds an
 * authorization to the concrete operation + effect the broker is about to perform
 * (an authorization for operation A can never authorize operation B).
 */
export interface ExpectedAuthorization {
  /** The registry op the broker is actually performing. Mismatch ⇒ target_mismatch. */
  readonly op?: string;
  /** The run the broker is acting on (from the manifest). Mismatch ⇒ target_mismatch. */
  readonly runId?: string;
  /** The commit the broker is integrating. Mismatch ⇒ target_mismatch. */
  readonly targetCommit?: string;
  /** The canonical base the broker observed. Mismatch ⇒ canonical_moved. */
  readonly canonicalBaseCommit?: string;
  /** The broker-re-derived effect. Per-field mismatch ⇒ the effect's drift code. */
  readonly intendedEffect?: IntendedEffect;
}

/** State the broker re-derives to detect drift at verify time (§7.2). */
export interface VerifyContext {
  /** The current canonical tip — used for `authz.canonical_moved`. */
  readonly currentCanonicalTip?: string | null;
  /** The re-derived expected descriptor to bind the authorization to (§7.4). */
  readonly expected?: ExpectedAuthorization;
}

/**
 * Compare a broker-re-derived `expected` effect against the `actual` effect
 * echoed in the challenge, returning the §7.3 drift code for the first mismatched
 * field, or `null` if they agree. The code per field follows the §7.4 per-op
 * matrix exactly (e.g. rollback's `revertCommit` ⇒ `authz.revert_mismatch`).
 * A `kind` mismatch is a fundamental operation swap ⇒ `authz.target_mismatch`.
 */
function effectDrift(expected: IntendedEffect, actual: IntendedEffect): AuthzCode | null {
  if (expected.kind !== actual.kind) return "authz.target_mismatch";
  switch (expected.kind) {
    case "integrate": {
      const a = actual as typeof expected;
      if (expected.tier !== a.tier) return "authz.target_mismatch";
      if (expected.changePlanDigest !== a.changePlanDigest) return "authz.target_mismatch";
      return null;
    }
    case "revert": {
      const a = actual as typeof expected;
      return expected.revertCommit !== a.revertCommit ? "authz.revert_mismatch" : null;
    }
    case "erase": {
      const a = actual as typeof expected;
      if (expected.oldHead !== a.oldHead) return "authz.canonical_moved";
      if (expected.replacementHead !== a.replacementHead) return "authz.target_mismatch";
      if (expected.scope !== a.scope) return "authz.target_mismatch";
      return null;
    }
    case "restore": {
      const a = actual as typeof expected;
      if (expected.backupRef !== a.backupRef) return "authz.backup_hash_mismatch";
      if (expected.backupContentHash !== a.backupContentHash) return "authz.backup_hash_mismatch";
      return null;
    }
    case "graduate": {
      const a = actual as typeof expected;
      if (expected.fromGeneration !== a.fromGeneration) return "authz.generation_mismatch";
      if (expected.toGeneration !== a.toGeneration) return "authz.generation_mismatch";
      if (expected.migrationPlanDigest !== a.migrationPlanDigest) return "authz.migration_plan_mismatch";
      return null;
    }
    case "trust": {
      const a = actual as typeof expected;
      if (expected.sourceOpaqueId !== a.sourceOpaqueId) return "authz.target_mismatch";
      if (expected.fromLevel !== a.fromLevel) return "authz.trust_level_mismatch";
      if (expected.toLevel !== a.toLevel) return "authz.trust_level_mismatch";
      return null;
    }
    case "forceUnblock": {
      const a = actual as typeof expected;
      if (expected.latestLedgerSeq !== a.latestLedgerSeq) return "authz.rpo_gap_unaccepted";
      if (expected.acceptedRpoGap !== a.acceptedRpoGap) return "authz.rpo_gap_unaccepted";
      return null;
    }
    case "quarantineInspect": {
      const a = actual as typeof expected;
      return expected.quarantineItemOpaqueId !== a.quarantineItemOpaqueId
        ? "authz.quarantine_item_unknown"
        : null;
    }
    case "quarantineResolve": {
      const a = actual as typeof expected;
      if (expected.quarantineItemOpaqueId !== a.quarantineItemOpaqueId) return "authz.quarantine_item_unknown";
      if (expected.resolution !== a.resolution) return "authz.target_mismatch";
      return null;
    }
  }
}

/**
 * The op-specific commitment lines appended after the six-line preamble (§8.2:
 * "followed by op-specific lines for `intendedEffect`-derived commitments"). EVERY
 * effect — `integrate` included — commits its drift-guarded fields into the signed
 * bytes so the signer authorizes a concrete effect, never an abstraction. Binding
 * `integrate.tier` + `integrate.changePlanDigest` here is load-bearing: without
 * it those fields sit outside the signature and could be swapped after signing.
 */
function effectCommitmentLines(effect: IntendedEffect): string[] {
  switch (effect.kind) {
    case "integrate":
      return [String(effect.tier), effect.changePlanDigest];
    case "revert":
      return [effect.revertCommit];
    case "erase":
      return [effect.oldHead, effect.replacementHead, effect.scope];
    case "restore":
      return [effect.backupRef, effect.backupContentHash];
    case "graduate":
      return [String(effect.fromGeneration), String(effect.toGeneration), effect.migrationPlanDigest];
    case "trust":
      return [effect.sourceOpaqueId, effect.fromLevel, effect.toLevel];
    case "forceUnblock":
      return [String(effect.latestLedgerSeq), String(effect.acceptedRpoGap)];
    case "quarantineInspect":
      return [effect.quarantineItemOpaqueId];
    case "quarantineResolve":
      return [effect.quarantineItemOpaqueId, effect.resolution];
  }
}

/**
 * Build the exact canonical byte string a signer must sign (§8.2): the
 * newline-joined `atlas.authz.v1`, op, runId|-, targetCommit|-,
 * canonicalBaseCommit, nonce, then op-specific commitment lines.
 */
export function buildSigningPayload(c: {
  op: string;
  runId?: string;
  targetCommit?: string;
  canonicalBaseCommit: string;
  nonce: string;
  intendedEffect: IntendedEffect;
}): string {
  const lines = [
    SIGNING_PREFIX,
    c.op,
    c.runId ?? "-",
    c.targetCommit ?? "-",
    c.canonicalBaseCommit,
    c.nonce,
    ...effectCommitmentLines(c.intendedEffect),
  ];
  // Newline-delimited framing is only unambiguous if NO field contains a line
  // separator: a `\n`/`\r` embedded in a free-string field (scope, backupRef,
  // sourceOpaqueId, trust levels, quarantine ids, resolution, …) would let two
  // DISTINCT effects serialize to identical signed bytes, permitting a
  // post-signature field substitution. Reject any embedded separator here so the
  // payload is an injective encoding of its fields (fail-closed at both mint and
  // verify — the verify path recomputes through this same function).
  for (const line of lines) {
    if (/[\r\n]/.test(line)) {
      throw new BrokerRefusal(
        "authz.payload_mismatch",
        "authorization field contains an embedded line separator — ambiguous signing payload refused",
      );
    }
  }
  return lines.join("\n");
}

/** A signer registry entry with its parsed public key. */
interface ResolvedSigner {
  readonly entry: SignerRegistryEntry;
  readonly publicKey: KeyObject;
}

/**
 * The authorization authority: nonce store + signer registry + the mint/verify
 * logic. Holds no git or ledger state (acyclic seam) — the caller supplies the
 * {@link VerifyContext} drawn from current protected-ref state.
 */
export class Authorizer {
  readonly nonces: NonceStore;
  private readonly signers = new Map<string, ResolvedSigner>();

  constructor(
    signerEntries: readonly SignerRegistryEntry[],
    private readonly testMode: boolean,
    now: () => number = () => Date.now(),
    private readonly ttlSecondsByOp: (op: string) => number | undefined = () => undefined,
  ) {
    this.nonces = new NonceStore(now);
    for (const entry of signerEntries) {
      // Parse the key per the entry's algorithm (absent ⇒ ed25519). ed25519 uses
      // the flexible parser (native `ed25519:` OR SPKI PEM); p256 uses the
      // curve-checked flexible parser (native `p256:` OR SPKI PEM). A malformed
      // or wrong-curve key throws HERE, at load — a signer that can't be parsed
      // never enters the registry (fail-closed).
      const alg = entry.alg ?? "ed25519";
      const publicKey =
        alg === "p256" ? parseP256PublicKeyFlexible(entry.publicKey) : parsePublicKeyFlexible(entry.publicKey);
      this.signers.set(entry.signerId, { entry, publicKey });
    }
  }

  /** Resolve a signerId to its registered public key (for audit re-verify), or `null`. */
  publicKeyFor(signerId: string): KeyObject | null {
    return this.signers.get(signerId)?.publicKey ?? null;
  }

  /** Mint an `AuthorizationChallenge` for `op` (records the nonce, §9.1). */
  mintChallenge(op: PrivilegedOpDescriptor): AuthorizationChallenge {
    const ttl = this.ttlSecondsByOp(op.op);
    const { nonce, expiresAt } = ttl === undefined ? this.nonces.issue(op.op) : this.nonces.issue(op.op, ttl);
    const signingPayload = buildSigningPayload({
      op: op.op,
      ...(op.runId !== undefined ? { runId: op.runId } : {}),
      ...(op.targetCommit !== undefined ? { targetCommit: op.targetCommit } : {}),
      canonicalBaseCommit: op.canonicalBaseCommit,
      nonce,
      intendedEffect: op.intendedEffect,
    });
    const challenge: AuthorizationChallenge = {
      schemaVersion: 1,
      op: op.op,
      ...(op.runId !== undefined ? { runId: op.runId } : {}),
      ...(op.targetCommit !== undefined ? { targetCommit: op.targetCommit } : {}),
      canonicalBaseCommit: op.canonicalBaseCommit,
      intendedEffect: op.intendedEffect,
      nonce,
      expiresAt: new Date(expiresAt).toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z"),
      payloadCanonicalization: CANONICALIZATION_ID,
      signingPayload,
    };
    // Round-trip through the schema so a mint can never emit an invalid challenge.
    return AuthorizationChallengeSchema.parse(challenge);
  }

  /**
   * Verify an `AuthorizationResponse`. Returns the parsed response on success;
   * throws a {@link BrokerRefusal} carrying the §7.3 stable code otherwise.
   */
  verify(response: unknown, ctx: VerifyContext = {}): AuthorizationResponse {
    const parsed = AuthorizationResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new BrokerRefusal("authz.schema_invalid", parsed.error.message);
    }
    const res = parsed.data;
    const ch = res.challenge;

    if (ch.payloadCanonicalization !== CANONICALIZATION_ID) {
      throw new BrokerRefusal(
        "authz.canonicalization_unsupported",
        `unsupported payloadCanonicalization "${ch.payloadCanonicalization}"`,
      );
    }

    // Recompute the signing payload from the echoed challenge fields; a mismatch
    // means the signer signed different bytes than the challenge claims.
    const recomputed = buildSigningPayload({
      op: ch.op,
      ...(ch.runId !== undefined ? { runId: ch.runId } : {}),
      ...(ch.targetCommit !== undefined ? { targetCommit: ch.targetCommit } : {}),
      canonicalBaseCommit: ch.canonicalBaseCommit,
      nonce: ch.nonce,
      intendedEffect: ch.intendedEffect,
    });
    if (recomputed !== ch.signingPayload) {
      throw new BrokerRefusal("authz.payload_mismatch", "signingPayload ≠ broker-recomputed canonical bytes");
    }

    // Nonce: VALIDATE (op binding + expiry + replay) WITHOUT consuming. An
    // invalid request (bad signer/signature) must never burn a legitimate
    // challenge, so the single-use consume happens LAST, only once every other
    // check has passed. A nonce presented for an op it was not issued for is
    // treated as unknown-for-this-op (cross-operation reuse is rejected).
    const nonceState = this.nonces.validate(ch.nonce, ch.op);
    if (!nonceState.ok) {
      const code: AuthzCode =
        nonceState.reason === "unknown" || nonceState.reason === "op_mismatch"
          ? "authz.nonce_unknown"
          : nonceState.reason === "expired"
            ? "authz.nonce_expired"
            : "authz.nonce_replayed";
      throw new BrokerRefusal(code, `nonce ${nonceState.reason}`);
    }

    // Signer registry lookup (§9.2).
    const signer = this.signers.get(res.signerId);
    if (signer === undefined) {
      throw new BrokerRefusal("authz.signer_unknown", `unknown signer "${res.signerId}"`);
    }
    if (signer.entry.status === "revoked") {
      throw new BrokerRefusal("authz.signer_revoked", `signer "${res.signerId}" revoked`);
    }
    if (!signer.entry.permittedOps.includes(ch.op)) {
      throw new BrokerRefusal(
        "authz.signer_not_permitted",
        `signer "${res.signerId}" not permitted for op "${ch.op}"`,
      );
    }

    // D20: fixture signers (of EITHER algorithm) are fixture-only. Hard-reject
    // any member of the shared descriptor's id set outside test mode.
    if (TEST_SIGNER_IDS.has(res.signerId) && !this.testMode) {
      throw new BrokerRefusal(
        "authz.signer_not_permitted",
        `test signer "${res.signerId}" is rejected unless ATLAS_TEST_MODE=1 (D20)`,
        { d20: true },
      );
    }

    // Signature over the exact signing-payload bytes, dispatched on the enrolled
    // signer's algorithm (absent ⇒ ed25519). A signature whose prefix disagrees
    // with the enrolled alg fails the algorithm's own prefix check and so is
    // `authz.signature_invalid` — no new code, no negotiation (ADR-0002).
    const alg = signer.entry.alg ?? "ed25519";
    const payloadBytes = encoder.encode(ch.signingPayload);
    const ok =
      alg === "p256"
        ? verifyP256Bytes(payloadBytes, res.signature, signer.publicKey)
        : verifyBytes(payloadBytes, res.signature, signer.publicKey);
    if (!ok) {
      throw new BrokerRefusal("authz.signature_invalid", "signature verification failed");
    }

    // State drift (§7.4). Re-derive the expected descriptor from broker-observed
    // state and compare every bound field; a mismatch is the contract-specific
    // drift code. This is what binds the authorization to the concrete op/effect.
    if (ctx.currentCanonicalTip !== undefined && ctx.currentCanonicalTip !== null) {
      if (ch.canonicalBaseCommit !== ctx.currentCanonicalTip) {
        throw new BrokerRefusal("authz.canonical_moved", "canonicalBaseCommit is no longer the canonical tip");
      }
    }
    const exp = ctx.expected;
    if (exp !== undefined) {
      if (exp.op !== undefined && ch.op !== exp.op) {
        throw new BrokerRefusal(
          "authz.target_mismatch",
          `authorization is for op "${ch.op}" but the broker is performing "${exp.op}"`,
        );
      }
      if (exp.runId !== undefined && ch.runId !== exp.runId) {
        throw new BrokerRefusal("authz.target_mismatch", `runId ${ch.runId ?? "-"} ≠ re-derived ${exp.runId}`);
      }
      if (exp.targetCommit !== undefined && ch.targetCommit !== exp.targetCommit) {
        throw new BrokerRefusal(
          "authz.target_mismatch",
          `targetCommit ${ch.targetCommit ?? "-"} ≠ re-derived ${exp.targetCommit}`,
        );
      }
      if (exp.canonicalBaseCommit !== undefined && ch.canonicalBaseCommit !== exp.canonicalBaseCommit) {
        throw new BrokerRefusal("authz.canonical_moved", "canonicalBaseCommit ≠ re-derived canonical base");
      }
      if (exp.intendedEffect !== undefined) {
        const drift = effectDrift(exp.intendedEffect, ch.intendedEffect);
        if (drift !== null) {
          throw new BrokerRefusal(drift, `intendedEffect drift on op "${ch.op}"`);
        }
      }
    }

    // All checks passed — NOW atomically consume the single-use nonce (§9.1).
    const consumed = this.nonces.consume(ch.nonce);
    if (!consumed.ok) {
      const code: AuthzCode =
        consumed.reason === "expired" ? "authz.nonce_expired" : "authz.nonce_replayed";
      throw new BrokerRefusal(code, `nonce ${consumed.reason}`);
    }

    return res;
  }
}
