/**
 * `authorize-p256.test` (SP-3 / ADR-0002).
 *
 * The P-256 verify path, alg-dispatch, the §7.1 presence gate, and the widened
 * D20 reject — all exercised through the `Authorizer` directly (no git repo, so
 * no BrokerService/filesystem latency), with **software** P-256 keys. This is the
 * entire p256 authorization path CI-covered with zero Apple dependency.
 */
import { describe, it, expect } from "vitest";
import { createPrivateKey, generateKeyPairSync, sign as ecSign, type KeyObject } from "node:crypto";
import type { SignerRegistryEntry } from "@atlas/contracts";
import {
  Authorizer,
  BrokerRefusal,
  TEST_SIGNER_DESCRIPTOR,
  TEST_P256_SIGNER_ID,
  generateP256,
  signP256Bytes,
  signBytes,
  verifyP256Bytes,
  parseP256PublicKeyFlexible,
  serializeP256PublicKey,
  generateEd25519,
  type PrivilegedOpDescriptor,
} from "../src/index.js";

const ENC = new TextEncoder();
const ENROLLED = "2026-07-20T00:00:00.000Z";

const APPROVE_OP: PrivilegedOpDescriptor = {
  op: "git approve",
  runId: "01J9Z8Q0000000000000000000",
  targetCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:3f9ac012" },
};

const QUARANTINE_OP: PrivilegedOpDescriptor = {
  op: "quarantine resolve",
  canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  intendedEffect: { kind: "quarantineResolve", quarantineItemOpaqueId: "q_abc123", resolution: "release" },
};

const P256_OPS = ["git approve", "quarantine inspect", "quarantine resolve"];

function entry(over: Partial<SignerRegistryEntry> & Pick<SignerRegistryEntry, "signerId" | "publicKey">): SignerRegistryEntry {
  return { permittedOps: P256_OPS, status: "active", enrolledAt: ENROLLED, ...over };
}

describe("verifyP256Bytes — accept/reject matrix", () => {
  const kp = generateP256();
  const msg = ENC.encode("atlas.authz.v1\ngit approve\n-\n-\nbase\nnonce");

  it("accepts a valid DER p256 signature over the message", () => {
    expect(verifyP256Bytes(msg, signP256Bytes(msg, kp.privateKey), kp.publicKey)).toBe(true);
  });

  it("rejects a wrong-prefix (ed25519:) signature", () => {
    const ed = generateEd25519();
    expect(verifyP256Bytes(msg, signBytes(msg, ed.privateKey), kp.publicKey)).toBe(false);
  });

  it("rejects a signature over an altered message", () => {
    const sig = signP256Bytes(msg, kp.privateKey);
    expect(verifyP256Bytes(ENC.encode("tampered"), sig, kp.publicKey)).toBe(false);
  });

  it("rejects a signature from another key", () => {
    const other = generateP256();
    expect(verifyP256Bytes(msg, signP256Bytes(msg, other.privateKey), kp.publicKey)).toBe(false);
  });

  it("rejects an oversized-past-72-byte body", () => {
    const oversized = "p256:" + Buffer.alloc(73, 1).toString("base64url");
    expect(verifyP256Bytes(msg, oversized, kp.publicKey)).toBe(false);
  });

  it("rejects a corrupted / non-DER body (within the length bound)", () => {
    const junk = "p256:" + Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString("base64url");
    expect(verifyP256Bytes(msg, junk, kp.publicKey)).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(verifyP256Bytes(msg, "p256:", kp.publicKey)).toBe(false);
  });

  it("verifies a high-S (r, n−s) twin true — no low-S enforcement (ADR-0002)", () => {
    // Node has no ieee-p1363 access to r/s from the DER easily; instead sign many
    // times and assert every signature — some naturally high-S — verifies true,
    // proving the verifier never rejects on S range. (A deterministic malleated
    // twin is validated cross-impl in P4's Swift golden vectors.)
    for (let i = 0; i < 32; i++) {
      const sig = signP256Bytes(ENC.encode(`m${i}`), kp.privateKey);
      expect(verifyP256Bytes(ENC.encode(`m${i}`), sig, kp.publicKey)).toBe(true);
    }
    // Explicit malleated twin: decode DER (r,s), recompute s' = n - s, re-encode.
    const n = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
    const der = Buffer.from(ecSign("sha256", msg, kp.privateKey));
    const twin = highSTwin(der, n);
    if (twin) expect(verifyP256Bytes(msg, "p256:" + twin.toString("base64url"), kp.publicKey)).toBe(true);
  });
});

/** Decode an ECDSA DER (r,s), replace s with n−s, re-encode DER. Returns null if already reduced away. */
function highSTwin(der: Buffer, n: bigint): Buffer | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  i += 1; // sequence length byte (short form for a P-256 sig)
  if (der[i++] !== 0x02) return null;
  const rLen = der[i++]!;
  const r = der.subarray(i, i + rLen); i += rLen;
  if (der[i++] !== 0x02) return null;
  const sLen = der[i++]!;
  const s = der.subarray(i, i + sLen);
  const sVal = BigInt("0x" + s.toString("hex"));
  const sTwin = n - sVal;
  return encodeEcdsaDer(BigInt("0x" + r.toString("hex")), sTwin);
}
function encodeEcdsaDer(r: bigint, s: bigint): Buffer {
  const enc = (x: bigint) => {
    let h = x.toString(16);
    if (h.length % 2) h = "0" + h;
    let buf = Buffer.from(h, "hex");
    if (buf[0]! & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    return Buffer.concat([Buffer.from([0x02, buf.length]), buf]);
  };
  const body = Buffer.concat([enc(r), enc(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

describe("parseP256PublicKeyFlexible — fail-closed rejection", () => {
  it("accepts a valid P-256 SPKI PEM and its p256: native form", () => {
    const kp = generateP256();
    expect(parseP256PublicKeyFlexible(kp.publicKeyPem).asymmetricKeyType).toBe("ec");
    expect(parseP256PublicKeyFlexible(kp.publicKeyString).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    // round-trip: native → parse → serialize is stable
    expect(serializeP256PublicKey(parseP256PublicKeyFlexible(kp.publicKeyString))).toBe(kp.publicKeyString);
  });

  it("rejects an RSA key (PEM)", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => parseP256PublicKeyFlexible(publicKey.export({ format: "pem", type: "spki" }).toString())).toThrow();
  });

  it("rejects a P-384 (non-P-256 EC) key in both PEM and p256: forms", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const native = "p256:" + Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64url");
    expect(() => parseP256PublicKeyFlexible(pem)).toThrow();
    expect(() => parseP256PublicKeyFlexible(native)).toThrow();
  });

  it("rejects malformed / truncated SPKI and trailing-garbage base64url", () => {
    expect(() => parseP256PublicKeyFlexible("p256:not$$base64")).toThrow();
    expect(() => parseP256PublicKeyFlexible("-----BEGIN PUBLIC KEY-----\nMFkwEw\n-----END PUBLIC KEY-----\n")).toThrow();
    const kp = generateP256();
    expect(() => parseP256PublicKeyFlexible(kp.publicKeyString + "TRAILING")).toThrow();
  });
});

describe("Authorizer — alg-dispatch, presence gate, D20-p256", () => {
  const approver = generateP256();
  const nonPresence = generateP256();

  function authorizerWith(entries: SignerRegistryEntry[], testMode = false): Authorizer {
    return new Authorizer(entries, testMode);
  }

  function sign(authz: Authorizer, op: PrivilegedOpDescriptor, key: KeyObject, signerId: string): unknown {
    const ch = authz.mintChallenge(op);
    return { schemaVersion: 1, challenge: ch, signature: signP256Bytes(ENC.encode(ch.signingPayload), key), signerId };
  }

  it("verifies a p256 approver over git approve", () => {
    const authz = authorizerWith([
      entry({ signerId: "approver-se-v1", alg: "p256", publicKey: approver.publicKeyString, permittedOps: ["git approve"] }),
    ]);
    const res = authz.verify(sign(authz, APPROVE_OP, approver.privateKey, "approver-se-v1"));
    expect(res.signerId).toBe("approver-se-v1");
  });

  it("presence:true p256 signer authorizes quarantine resolve", () => {
    const authz = authorizerWith([
      entry({ signerId: "approver-se-v1", alg: "p256", presence: true, publicKey: approver.publicKeyString }),
    ]);
    const res = authz.verify(sign(authz, QUARANTINE_OP, approver.privateKey, "approver-se-v1"));
    expect(res.signerId).toBe("approver-se-v1");
  });

  it("presence:false signer is refused signer_not_permitted for quarantine resolve", () => {
    // A non-presence signer simply does not carry the quarantine ops in permittedOps.
    const authz = authorizerWith([
      entry({ signerId: "file-approver", alg: "p256", publicKey: nonPresence.publicKeyString, permittedOps: ["git approve"] }),
    ]);
    expect(() => authz.verify(sign(authz, QUARANTINE_OP, nonPresence.privateKey, "file-approver"))).toThrowError(
      /not permitted/,
    );
    try {
      authz.verify(sign(authz, QUARANTINE_OP, nonPresence.privateKey, "file-approver"));
    } catch (e) {
      expect((e as BrokerRefusal).code).toBe("authz.signer_not_permitted");
    }
  });

  it("a p256: signature against an ed25519-enrolled signer is signature_invalid (prefix/alg mismatch)", () => {
    const ed = generateEd25519();
    const authz = authorizerWith([
      entry({ signerId: "ed-approver", publicKey: ed.publicKeyString, permittedOps: ["git approve"] }),
    ]);
    // sign with p256 but claim the ed25519 signer id → alg-dispatch runs verifyBytes (ed), which rejects the p256 body
    const bad = sign(authz, APPROVE_OP, approver.privateKey, "ed-approver");
    try {
      authz.verify(bad);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as BrokerRefusal).code).toBe("authz.signature_invalid");
    }
  });

  it("D20-p256: the p256 fixture is REJECTED with the d20 detail when test mode is off", () => {
    const fixturePriv = createPrivateKey(TEST_SIGNER_DESCRIPTOR.p256.privateKeyPem);
    const authz = authorizerWith(
      [entry({ signerId: TEST_P256_SIGNER_ID, alg: "p256", publicKey: TEST_SIGNER_DESCRIPTOR.p256.publicKey, permittedOps: ["git approve"] })],
      false,
    );
    try {
      authz.verify(sign(authz, APPROVE_OP, fixturePriv, TEST_P256_SIGNER_ID));
      throw new Error("should have refused");
    } catch (e) {
      expect((e as BrokerRefusal).code).toBe("authz.signer_not_permitted");
      expect((e as BrokerRefusal).detail.d20).toBe(true);
    }
  });

  it("D20-p256: the p256 fixture is ACCEPTED under ATLAS_TEST_MODE=1", () => {
    const fixturePriv = createPrivateKey(TEST_SIGNER_DESCRIPTOR.p256.privateKeyPem);
    const authz = authorizerWith(
      [entry({ signerId: TEST_P256_SIGNER_ID, alg: "p256", publicKey: TEST_SIGNER_DESCRIPTOR.p256.publicKey, permittedOps: ["git approve"] })],
      true,
    );
    const res = authz.verify(sign(authz, APPROVE_OP, fixturePriv, TEST_P256_SIGNER_ID));
    expect(res.signerId).toBe(TEST_P256_SIGNER_ID);
  });

  it("the committed p256 fixture private key matches the descriptor's public key", () => {
    const priv = createPrivateKey(TEST_SIGNER_DESCRIPTOR.p256.privateKeyPem);
    const msg = ENC.encode("roundtrip");
    const sig = signP256Bytes(msg, priv);
    const pub = parseP256PublicKeyFlexible(TEST_SIGNER_DESCRIPTOR.p256.publicKey);
    expect(verifyP256Bytes(msg, sig, pub)).toBe(true);
  });
});
