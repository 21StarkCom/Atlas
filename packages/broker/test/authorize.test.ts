/**
 * `authorize.test` — challenge mint + authorization verify with the §7.3 stable
 * drift codes. Drives the `Authorizer` directly with a controllable clock so the
 * expiry path is deterministic.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalSerialize,
  type SignerRegistryEntry,
} from "@atlas/contracts";
import {
  Authorizer,
  buildSigningPayload,
  generateEd25519,
  signBytes,
  BrokerRefusal,
  TEST_SIGNER_ID,
  type PrivilegedOpDescriptor,
} from "../src/index.js";

const APPROVER = "atlas-approver-hsm-01";

function setup(opts: { testMode?: boolean; clock?: () => number } = {}) {
  const kp = generateEd25519();
  const testKp = generateEd25519();
  const signers: SignerRegistryEntry[] = [
    {
      signerId: APPROVER,
      publicKey: kp.publicKeyString,
      permittedOps: ["git approve", "git rollback"],
      status: "active",
      enrolledAt: "2026-07-01T00:00:00.000Z",
    },
    {
      signerId: "revoked-one",
      publicKey: generateEd25519().publicKeyString,
      permittedOps: ["git approve"],
      status: "revoked",
      enrolledAt: "2026-07-01T00:00:00.000Z",
      revokedAt: "2026-07-02T00:00:00.000Z",
    },
    {
      signerId: TEST_SIGNER_ID,
      publicKey: testKp.publicKeyString,
      permittedOps: ["git approve"],
      status: "active",
      enrolledAt: "2026-07-01T00:00:00.000Z",
    },
  ];
  const clock = opts.clock ?? (() => 1_000_000);
  const authz = new Authorizer(signers, opts.testMode ?? false, clock);
  return { authz, approverKey: kp.privateKey, testKey: testKp.privateKey };
}

const OP: PrivilegedOpDescriptor = {
  op: "git approve",
  runId: "01J9Z8Q0000000000000000000",
  targetCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:3f9ac012" },
};

function sign(challenge: { signingPayload: string }, key: Parameters<typeof signBytes>[1]) {
  return signBytes(new TextEncoder().encode(challenge.signingPayload), key);
}

function expectRefusal(fn: () => void, code: string) {
  try {
    fn();
    throw new Error("expected a BrokerRefusal");
  } catch (err) {
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe(code);
  }
}

describe("mintChallenge", () => {
  it("emits a challenge whose signingPayload binds the integrate tier + changePlanDigest (§8.2)", () => {
    const { authz } = setup();
    const ch = authz.mintChallenge(OP);
    const eff = OP.intendedEffect as { kind: "integrate"; tier: number; changePlanDigest: string };
    const expected = [
      "atlas.authz.v1",
      "git approve",
      OP.runId,
      OP.targetCommit,
      OP.canonicalBaseCommit,
      ch.nonce,
      String(eff.tier),
      eff.changePlanDigest,
    ].join("\n");
    expect(ch.signingPayload).toBe(expected);
    expect(ch.payloadCanonicalization).toBe("atlas-jcs-v1");
  });

  it("appends the revertCommit commitment line for rollback", () => {
    const { authz } = setup();
    const ch = authz.mintChallenge({
      op: "git rollback",
      runId: OP.runId,
      targetCommit: OP.targetCommit,
      canonicalBaseCommit: OP.canonicalBaseCommit,
      intendedEffect: { kind: "revert", revertCommit: "c".repeat(40) },
    });
    expect(ch.signingPayload.endsWith("\n" + "c".repeat(40))).toBe(true);
  });
});

describe("verify — happy path + drift codes", () => {
  it("accepts a valid authorization (authz.ok)", () => {
    const { authz, approverKey } = setup();
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1, challenge: ch, signature: sign(ch, approverKey), signerId: APPROVER };
    expect(() => authz.verify(res)).not.toThrow();
  });

  it("rejects a schema-invalid response", () => {
    const { authz } = setup();
    expectRefusal(() => authz.verify({ nope: true }), "authz.schema_invalid");
  });

  it("rejects an unsupported canonicalization", () => {
    const { authz, approverKey } = setup();
    const ch = authz.mintChallenge(OP);
    const bad = { ...ch, payloadCanonicalization: "weird-v9" };
    const res = { schemaVersion: 1, challenge: bad, signature: sign(ch, approverKey), signerId: APPROVER };
    expectRefusal(() => authz.verify(res), "authz.canonicalization_unsupported");
  });

  it("rejects a tampered signingPayload (payload_mismatch)", () => {
    const { authz, approverKey } = setup();
    const ch = authz.mintChallenge(OP);
    const tampered = { ...ch, signingPayload: ch.signingPayload + "X" };
    const res = { schemaVersion: 1, challenge: tampered, signature: sign(tampered, approverKey), signerId: APPROVER };
    expectRefusal(() => authz.verify(res), "authz.payload_mismatch");
  });

  it("rejects an unknown nonce", () => {
    const { authz, approverKey } = setup();
    const ch = authz.mintChallenge(OP);
    const forged = { ...ch, nonce: "0".repeat(32) };
    // recompute payload for the forged nonce so it passes payload_mismatch first
    const forged2 = {
      ...forged,
      signingPayload: buildSigningPayload({
        op: forged.op,
        runId: forged.runId,
        targetCommit: forged.targetCommit,
        canonicalBaseCommit: forged.canonicalBaseCommit,
        nonce: forged.nonce,
        intendedEffect: forged.intendedEffect,
      }),
    };
    const res = { schemaVersion: 1, challenge: forged2, signature: sign(forged2, approverKey), signerId: APPROVER };
    expectRefusal(() => authz.verify(res), "authz.nonce_unknown");
  });

  it("rejects a replayed nonce", () => {
    const { authz, approverKey } = setup();
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1, challenge: ch, signature: sign(ch, approverKey), signerId: APPROVER };
    authz.verify(res);
    expectRefusal(() => authz.verify(res), "authz.nonce_replayed");
  });

  it("rejects an expired nonce", () => {
    let t = 1_000_000;
    const { authz, approverKey } = setup({ clock: () => t });
    const ch = authz.mintChallenge(OP);
    t += 301_000; // past the 300s TTL
    const res = { schemaVersion: 1, challenge: ch, signature: sign(ch, approverKey), signerId: APPROVER };
    expectRefusal(() => authz.verify(res), "authz.nonce_expired");
  });

  it("rejects an unknown signer", () => {
    const { authz, approverKey } = setup();
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1, challenge: ch, signature: sign(ch, approverKey), signerId: "nobody" };
    expectRefusal(() => authz.verify(res), "authz.signer_unknown");
  });

  it("rejects a revoked signer", () => {
    const { authz } = setup();
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1, challenge: ch, signature: "ed25519:" + "A".repeat(86), signerId: "revoked-one" };
    expectRefusal(() => authz.verify(res), "authz.signer_revoked");
  });

  it("rejects a signer not permitted for the op", () => {
    const { authz, approverKey } = setup();
    const ch = authz.mintChallenge({ ...OP, op: "git rollback", intendedEffect: { kind: "revert", revertCommit: "c".repeat(40) } });
    // approver IS permitted for rollback; use purge to trip not_permitted
    const ch2 = authz.mintChallenge({ ...OP, op: "purge", intendedEffect: { kind: "erase", oldHead: "a".repeat(40), replacementHead: "b".repeat(40), scope: "x" } });
    const res = { schemaVersion: 1, challenge: ch2, signature: sign(ch2, approverKey), signerId: APPROVER };
    expectRefusal(() => authz.verify(res), "authz.signer_not_permitted");
    void ch;
  });

  it("rejects an invalid signature", () => {
    const { authz } = setup();
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1, challenge: ch, signature: "ed25519:" + "A".repeat(86), signerId: APPROVER };
    expectRefusal(() => authz.verify(res), "authz.signature_invalid");
  });

  it("rejects canonical drift when the tip has moved", () => {
    const { authz, approverKey } = setup();
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1, challenge: ch, signature: sign(ch, approverKey), signerId: APPROVER };
    expectRefusal(() => authz.verify(res, { currentCanonicalTip: "f".repeat(40) }), "authz.canonical_moved");
  });
});

describe("D20 — test signer gate", () => {
  it("hard-rejects the test signer when test mode is off", () => {
    const { authz, testKey } = setup({ testMode: false });
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1, challenge: ch, signature: sign(ch, testKey), signerId: TEST_SIGNER_ID };
    expectRefusal(() => authz.verify(res), "authz.signer_not_permitted");
  });

  it("accepts the test signer when test mode is on", () => {
    const { authz, testKey } = setup({ testMode: true });
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1, challenge: ch, signature: sign(ch, testKey), signerId: TEST_SIGNER_ID };
    expect(() => authz.verify(res)).not.toThrow();
  });
});

// silence unused import in some type positions
void canonicalSerialize;
