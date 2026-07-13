/**
 * `revision-binding.test` — round-2 wing findings on authorization binding.
 *
 *  - Finding 1/2: an authorization is bound to the concrete op + effect the broker
 *    re-derives; a swapped operation/target/effect is refused with the §7.4
 *    contract-specific drift code (the full verification matrix).
 *  - Finding 3: the nonce is validated (not consumed) before signer/signature, so
 *    an invalid request cannot burn a legitimate challenge; cross-operation reuse
 *    is refused; a genuine replay is refused.
 */
import { describe, it, expect } from "vitest";
import type { IntendedEffect, SignerRegistryEntry } from "@atlas/contracts";
import {
  Authorizer,
  buildSigningPayload,
  generateEd25519,
  signBytes,
  BrokerRefusal,
  type ExpectedAuthorization,
  type PrivilegedOpDescriptor,
} from "../src/index.js";

const APPROVER = "atlas-approver-hsm-01";
const ALL_OPS = [
  "git approve",
  "git refresh",
  "git rollback",
  "purge",
  "db restore",
  "graduation migrate",
  "source trust promote",
  "source trust revoke",
  "db backup --force-unblock",
];

function setup() {
  const kp = generateEd25519();
  const signers: SignerRegistryEntry[] = [
    {
      signerId: APPROVER,
      publicKey: kp.publicKeyString,
      permittedOps: ALL_OPS,
      status: "active",
      enrolledAt: "2026-07-01T00:00:00.000Z",
    },
  ];
  return { authz: new Authorizer(signers, false, () => 1_000_000), key: kp.privateKey };
}

function sign(payload: string, key: Parameters<typeof signBytes>[1]) {
  return signBytes(new TextEncoder().encode(payload), key);
}

/** Mint for `op`, sign with the approver, return the response object. */
function authorized(authz: Authorizer, key: Parameters<typeof signBytes>[1], op: PrivilegedOpDescriptor) {
  const ch = authz.mintChallenge(op);
  return { schemaVersion: 1 as const, challenge: ch, signature: sign(ch.signingPayload, key), signerId: APPROVER };
}

function expectRefusal(fn: () => void, code: string) {
  try {
    fn();
    throw new Error(`expected BrokerRefusal ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe(code);
  }
}

const BASE = "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182";
const RUN = "01J9Z8Q0000000000000000000";
const TARGET = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("operation + target binding (finding 1)", () => {
  it("refuses an authorization for op A used to authorize op B (swapped op)", () => {
    const { authz, key } = setup();
    const res = authorized(authz, key, {
      op: "git approve",
      runId: RUN,
      targetCommit: TARGET,
      canonicalBaseCommit: BASE,
      intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:aa" },
    });
    const expected: ExpectedAuthorization = { op: "git refresh" };
    expectRefusal(() => authz.verify(res, { expected }), "authz.target_mismatch");
  });

  it("refuses a swapped targetCommit", () => {
    const { authz, key } = setup();
    const res = authorized(authz, key, {
      op: "git approve",
      runId: RUN,
      targetCommit: TARGET,
      canonicalBaseCommit: BASE,
      intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:aa" },
    });
    expectRefusal(() => authz.verify(res, { expected: { targetCommit: "f".repeat(40) } }), "authz.target_mismatch");
  });

  it("refuses a swapped runId", () => {
    const { authz, key } = setup();
    const res = authorized(authz, key, {
      op: "git approve",
      runId: RUN,
      targetCommit: TARGET,
      canonicalBaseCommit: BASE,
      intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:aa" },
    });
    expectRefusal(
      () => authz.verify(res, { expected: { runId: "01J9Z8Q0000000000000000009" } }),
      "authz.target_mismatch",
    );
  });
});

describe("full §7.4 effect drift matrix (finding 2)", () => {
  // Each row: mint with `minted`, verify with an `expected` effect that differs
  // in exactly one field, asserting the stable drift code.
  interface Row {
    op: string;
    minted: IntendedEffect;
    expected: IntendedEffect;
    code: string;
  }
  const rows: Row[] = [
    {
      op: "git approve",
      minted: { kind: "integrate", tier: 3, changePlanDigest: "sha256:aa" },
      expected: { kind: "integrate", tier: 1, changePlanDigest: "sha256:aa" },
      code: "authz.target_mismatch",
    },
    {
      op: "git rollback",
      minted: { kind: "revert", revertCommit: "a".repeat(40) },
      expected: { kind: "revert", revertCommit: "b".repeat(40) },
      code: "authz.revert_mismatch",
    },
    {
      op: "purge",
      minted: { kind: "erase", oldHead: "a".repeat(40), replacementHead: "b".repeat(40), scope: "s" },
      expected: { kind: "erase", oldHead: "a".repeat(40), replacementHead: "c".repeat(40), scope: "s" },
      code: "authz.target_mismatch",
    },
    {
      op: "purge",
      minted: { kind: "erase", oldHead: "a".repeat(40), replacementHead: "b".repeat(40), scope: "s" },
      expected: { kind: "erase", oldHead: "d".repeat(40), replacementHead: "b".repeat(40), scope: "s" },
      code: "authz.canonical_moved",
    },
    {
      op: "db restore",
      minted: { kind: "restore", backupRef: "r", backupContentHash: "sha256:aa" },
      expected: { kind: "restore", backupRef: "r", backupContentHash: "sha256:bb" },
      code: "authz.backup_hash_mismatch",
    },
    {
      op: "graduation migrate",
      minted: { kind: "graduate", fromGeneration: 1, toGeneration: 2, migrationPlanDigest: "sha256:aa" },
      expected: { kind: "graduate", fromGeneration: 9, toGeneration: 2, migrationPlanDigest: "sha256:aa" },
      code: "authz.generation_mismatch",
    },
    {
      op: "graduation migrate",
      minted: { kind: "graduate", fromGeneration: 1, toGeneration: 2, migrationPlanDigest: "sha256:aa" },
      expected: { kind: "graduate", fromGeneration: 1, toGeneration: 2, migrationPlanDigest: "sha256:bb" },
      code: "authz.migration_plan_mismatch",
    },
    {
      op: "source trust promote",
      minted: { kind: "trust", sourceOpaqueId: "s_1", fromLevel: "unverified", toLevel: "trusted" },
      expected: { kind: "trust", sourceOpaqueId: "s_1", fromLevel: "quarantined", toLevel: "trusted" },
      code: "authz.trust_level_mismatch",
    },
    {
      op: "db backup --force-unblock",
      minted: { kind: "forceUnblock", latestLedgerSeq: 10, acceptedRpoGap: 2 },
      expected: { kind: "forceUnblock", latestLedgerSeq: 99, acceptedRpoGap: 2 },
      code: "authz.rpo_gap_unaccepted",
    },
  ];

  for (const row of rows) {
    it(`${row.op}: ${row.minted.kind} drift → ${row.code}`, () => {
      const { authz, key } = setup();
      const res = authorized(authz, key, {
        op: row.op,
        canonicalBaseCommit: BASE,
        intendedEffect: row.minted,
      });
      expectRefusal(() => authz.verify(res, { expected: { intendedEffect: row.expected } }), row.code);
    });
  }

  it("accepts when the re-derived effect matches exactly", () => {
    const { authz, key } = setup();
    const eff: IntendedEffect = { kind: "integrate", tier: 3, changePlanDigest: "sha256:aa" };
    const res = authorized(authz, key, { op: "git approve", canonicalBaseCommit: BASE, intendedEffect: eff });
    expect(() => authz.verify(res, { expected: { op: "git approve", canonicalBaseCommit: BASE, intendedEffect: eff } })).not.toThrow();
  });
});

describe("nonce validate-before-consume ordering (finding 3)", () => {
  const OP: PrivilegedOpDescriptor = {
    op: "git approve",
    canonicalBaseCommit: BASE,
    intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:aa" },
  };

  it("an invalid signature does NOT burn the nonce; a subsequent valid use succeeds", () => {
    const { authz, key } = setup();
    const ch = authz.mintChallenge(OP);
    const bad = { schemaVersion: 1 as const, challenge: ch, signature: "ed25519:" + "A".repeat(86), signerId: APPROVER };
    expectRefusal(() => authz.verify(bad), "authz.signature_invalid");
    // The nonce survived — a valid response over the SAME challenge now verifies.
    const good = { schemaVersion: 1 as const, challenge: ch, signature: sign(ch.signingPayload, key), signerId: APPROVER };
    expect(() => authz.verify(good)).not.toThrow();
  });

  it("refuses cross-operation nonce reuse", () => {
    const { authz, key } = setup();
    const ch = authz.mintChallenge(OP); // nonce bound to "git approve"
    // Reuse the nonce inside a challenge that claims a different op.
    const crossEffect: IntendedEffect = { kind: "revert", revertCommit: "a".repeat(40) };
    const forged = {
      ...ch,
      op: "git rollback",
      intendedEffect: crossEffect,
      signingPayload: buildSigningPayload({
        op: "git rollback",
        canonicalBaseCommit: ch.canonicalBaseCommit,
        nonce: ch.nonce,
        intendedEffect: crossEffect,
      }),
    };
    const res = { schemaVersion: 1 as const, challenge: forged, signature: sign(forged.signingPayload, key), signerId: APPROVER };
    expectRefusal(() => authz.verify(res), "authz.nonce_unknown");
  });

  it("refuses a genuine replay after a successful verify", () => {
    const { authz, key } = setup();
    const ch = authz.mintChallenge(OP);
    const res = { schemaVersion: 1 as const, challenge: ch, signature: sign(ch.signingPayload, key), signerId: APPROVER };
    expect(() => authz.verify(res)).not.toThrow();
    expectRefusal(() => authz.verify(res), "authz.nonce_replayed");
  });
});
