/**
 * `contracts.signer-alg.test` (SP-3 / ADR-0002).
 *
 * The alg-agility widening of the authorization contract mirrors: `alg`/`presence`
 * on `SignerRegistryEntry`, the widened `publicKey`, and the prefix-discriminated
 * `ed25519 | p256` `AuthorizationResponse.signature` union. Every widening is
 * ADDITIVE — a pre-SP-3 entry (no `alg`, no `presence`, `ed25519:` key, `ed25519:`
 * signature) must parse byte-identically, so the whole existing corpus stays valid.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  SignerRegistryEntrySchema,
  AuthorizationResponseSchema,
  AuthorizationChallengeSchema,
  P256Sig,
  P256PubKey,
  AuthzSignature,
  PublicKeyString,
} from "../src/index.js";

/** A real P-256 SPKI PEM + its `p256:<base64url(DER SPKI)>` native form. */
function p256Keys(): { pem: string; native: string } {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const der = publicKey.export({ format: "der", type: "spki" });
  return { pem, native: "p256:" + Buffer.from(der).toString("base64url") };
}

const CHALLENGE = {
  schemaVersion: 1 as const,
  op: "git approve",
  runId: "01J9Z8Q0000000000000000000",
  targetCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  intendedEffect: { kind: "integrate" as const, tier: 3 as const, changePlanDigest: "sha256:3f9ac012" },
  nonce: "9c1f7b2e4d6a8c0e1f3b5d7a9c1e2f40",
  expiresAt: "2026-07-12T09:19:22.581Z",
  payloadCanonicalization: "atlas-jcs-v1",
  signingPayload: "atlas.authz.v1\ngit approve\n01J9Z8Q0000000000000000000",
};

describe("SP-3 alg-agility contract widening", () => {
  it("a pre-SP-3 ed25519 entry (no alg/presence) still parses byte-identically", () => {
    const entry = {
      signerId: "atlas-approver-hsm-01",
      publicKey: "ed25519:MCowBQYDK2VwAyEAabc",
      permittedOps: ["git approve"],
      status: "active" as const,
      enrolledAt: "2026-07-01T00:00:00.000Z",
    };
    const parsed = SignerRegistryEntrySchema.parse(entry);
    expect(parsed.alg).toBeUndefined();
    expect(parsed.presence).toBeUndefined();
    expect(parsed.publicKey).toBe(entry.publicKey);
  });

  it("accepts an alg:p256 + presence:true entry with an SPKI-PEM publicKey", () => {
    const { pem } = p256Keys();
    const parsed = SignerRegistryEntrySchema.parse({
      signerId: "approver-se-host-v1",
      alg: "p256",
      presence: true,
      publicKey: pem,
      permittedOps: ["git approve", "quarantine resolve"],
      status: "active",
      enrolledAt: "2026-07-20T00:00:00.000Z",
    });
    expect(parsed.alg).toBe("p256");
    expect(parsed.presence).toBe(true);
  });

  it("accepts a p256: native publicKey", () => {
    const { native } = p256Keys();
    const parsed = SignerRegistryEntrySchema.parse({
      signerId: "approver-se-host-v1",
      alg: "p256",
      publicKey: native,
      permittedOps: ["git approve"],
      status: "active",
      enrolledAt: "2026-07-20T00:00:00.000Z",
    });
    expect(parsed.publicKey).toBe(native);
  });

  it("rejects an out-of-set alg (p384)", () => {
    const r = SignerRegistryEntrySchema.safeParse({
      signerId: "x",
      alg: "p384",
      publicKey: "p256:abc",
      permittedOps: [],
      status: "active",
      enrolledAt: "2026-07-20T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a publicKey with no recognized prefix/PEM header", () => {
    expect(PublicKeyString.safeParse("rsa:whatever").success).toBe(false);
    expect(PublicKeyString.safeParse("-----BEGIN PUBLIC KEY-----\nMFk...\n-----END PUBLIC KEY-----\n").success).toBe(true);
    expect(PublicKeyString.safeParse("ed25519:abc").success).toBe(true);
    expect(PublicKeyString.safeParse("p256:abc").success).toBe(true);
  });

  it("the signature union accepts both prefixes and rejects others", () => {
    expect(AuthzSignature.safeParse("ed25519:1f8a").success).toBe(true);
    expect(AuthzSignature.safeParse("p256:MEUCIQ").success).toBe(true);
    expect(AuthzSignature.safeParse("rsa:dead").success).toBe(false);
    expect(P256Sig.safeParse("p256:x").success).toBe(true);
    expect(P256Sig.safeParse("ed25519:x").success).toBe(false);
    expect(P256PubKey.safeParse("p256:x").success).toBe(true);
  });

  it("an AuthorizationResponse carries a p256: signature", () => {
    const parsed = AuthorizationResponseSchema.parse({
      schemaVersion: 1,
      challenge: CHALLENGE,
      signature: "p256:MEUCIQDabc123",
      signerId: "approver-se-host-v1",
    });
    expect(parsed.signature.startsWith("p256:")).toBe(true);
    // the challenge shape is unchanged by SP-3
    expect(AuthorizationChallengeSchema.safeParse(CHALLENGE).success).toBe(true);
  });

  it("an AuthorizationResponse still carries an ed25519: signature (additive)", () => {
    const parsed = AuthorizationResponseSchema.parse({
      schemaVersion: 1,
      challenge: CHALLENGE,
      signature: "ed25519:1f8a3caa0",
      signerId: "atlas-approver-hsm-01",
    });
    expect(parsed.signature.startsWith("ed25519:")).toBe(true);
  });
});
