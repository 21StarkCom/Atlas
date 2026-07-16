/**
 * `broker-authorization` (Task 4.9) — the CLI-constructed authorization round-trips through the
 * REAL broker Authorizer: an enrolled approver's response verifies + executes; a WRONG-key
 * (forged) signature is refused. Proves the CLI's `--export-challenge → sign → --authorization`
 * construction connects to the broker authority the privileged command seams rely on.
 */
import { describe, expect, it } from "vitest";
import { Authorizer, generateEd25519, TEST_SIGNER_ID, BrokerRefusal, type PrivilegedOpDescriptor } from "@atlas/broker";
import { buildAuthorization, keySigner } from "../src/broker/authorization.js";

const OP: PrivilegedOpDescriptor = {
  op: "git approve",
  runId: "01J9Z8Q0000000000000000000",
  targetCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:3f9ac012" },
};

function authorizer() {
  const approver = generateEd25519();
  const authz = new Authorizer(
    [{ signerId: TEST_SIGNER_ID, publicKey: approver.publicKeyString, permittedOps: ["git approve"], status: "active", enrolledAt: "2026-07-01T00:00:00.000Z" }],
    true, // test mode
    () => 1_000_000,
  );
  return { authz, approver };
}

describe("CLI broker authorization round-trip (Task 4.9)", () => {
  it("an enrolled approver's constructed authorization verifies", () => {
    const { authz, approver } = authorizer();
    const challenge = authz.mintChallenge(OP);
    const response = buildAuthorization(challenge, TEST_SIGNER_ID, keySigner(approver.privateKey));
    // The broker re-verifies + accepts.
    expect(() => authz.verify(response)).not.toThrow();
    expect(response.signerId).toBe(TEST_SIGNER_ID);
  });

  it("a forged (wrong-key) signature is refused by the broker", () => {
    const { authz } = authorizer();
    const challenge = authz.mintChallenge(OP);
    const wrongKey = generateEd25519().privateKey; // NOT the enrolled approver key
    const response = buildAuthorization(challenge, TEST_SIGNER_ID, keySigner(wrongKey));
    expect(() => authz.verify(response)).toThrow(BrokerRefusal);
  });
});
