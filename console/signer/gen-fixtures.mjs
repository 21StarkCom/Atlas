// Generates the cross-implementation signing-payload golden vectors for the Swift
// atlas-signer tests: one full AuthorizationChallenge per intendedEffect kind,
// whose `signingPayload` is produced by @atlas/broker's OWN buildSigningPayload.
// The Swift `SigningPayload.rederive` must reproduce these exact bytes — drift in
// either implementation breaks the P4 test. Re-run after any buildSigningPayload
// change:  node console/signer/gen-fixtures.mjs
//
// NOT part of the build; the emitted JSON is committed under Tests/.../Fixtures.
import { writeFileSync } from "node:fs";
import { buildSigningPayload } from "../../packages/broker/dist/src/index.js";
import { AuthorizationChallengeSchema } from "../../packages/contracts/dist/index.js";

const BASE = "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182";
const TARGET = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const COMMIT2 = "0123456789abcdef0123456789abcdef01234567";
const RUN = "01J9Z8Q0000000000000000000";
const NONCE = "9c1f7b2e4d6a8c0e1f3b5d7a9c1e2f40";
const EXP = "2026-07-12T09:19:22.581Z";

const cases = [
  { op: "git approve", runId: RUN, targetCommit: TARGET, intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:3f9ac012" } },
  { op: "git rollback", runId: RUN, targetCommit: TARGET, intendedEffect: { kind: "revert", revertCommit: COMMIT2 } },
  { op: "purge", intendedEffect: { kind: "erase", oldHead: BASE, replacementHead: COMMIT2, scope: "note:n_9f2c1a8e0b3d4f56" } },
  { op: "db restore", intendedEffect: { kind: "restore", backupRef: "refs/atlas/backups/2026-07-20", backupContentHash: "sha256:deadbeef" } },
  { op: "graduation migrate", intendedEffect: { kind: "graduate", fromGeneration: 0, toGeneration: 1, migrationPlanDigest: "sha256:abc123" } },
  { op: "source trust promote", intendedEffect: { kind: "trust", sourceOpaqueId: "s_1234abcd5678ef90", fromLevel: "untrusted", toLevel: "tier1" } },
  { op: "db backup --force-unblock", intendedEffect: { kind: "forceUnblock", latestLedgerSeq: 42, acceptedRpoGap: 7 } },
  { op: "quarantine inspect", intendedEffect: { kind: "quarantineInspect", quarantineItemOpaqueId: "q_aabbccddeeff0011" } },
  { op: "quarantine resolve", intendedEffect: { kind: "quarantineResolve", quarantineItemOpaqueId: "q_aabbccddeeff0011", resolution: "release" } },
];

const vectors = cases.map((c) => {
  const signingPayload = buildSigningPayload({
    op: c.op,
    ...(c.runId !== undefined ? { runId: c.runId } : {}),
    ...(c.targetCommit !== undefined ? { targetCommit: c.targetCommit } : {}),
    canonicalBaseCommit: BASE,
    nonce: NONCE,
    intendedEffect: c.intendedEffect,
  });
  const challenge = {
    schemaVersion: 1,
    op: c.op,
    ...(c.runId !== undefined ? { runId: c.runId } : {}),
    ...(c.targetCommit !== undefined ? { targetCommit: c.targetCommit } : {}),
    canonicalBaseCommit: BASE,
    intendedEffect: c.intendedEffect,
    nonce: NONCE,
    expiresAt: EXP,
    payloadCanonicalization: "atlas-jcs-v1",
    signingPayload,
  };
  // Prove it's a valid challenge the Swift decoder will accept.
  AuthorizationChallengeSchema.parse(challenge);
  return { kind: c.intendedEffect.kind, challenge };
});

const out = new URL("./Tests/SignerCoreTests/Fixtures/signing-payload-vectors.json", import.meta.url);
writeFileSync(out, JSON.stringify({ generatedBy: "console/signer/gen-fixtures.mjs", vectors }, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors to ${out.pathname}`);
