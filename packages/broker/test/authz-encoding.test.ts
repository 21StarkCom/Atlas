/**
 * Regression tests for two review findings on the signing/authorization surface:
 *
 *  - **F2 (signing-payload injectivity).** The newline-delimited signing payload
 *    must reject any field carrying an embedded `\n`/`\r`, so two distinct
 *    effects can never serialize to identical signed bytes (no post-signature
 *    field substitution).
 *  - **F3 (op mechanism boundary).** The `os-presence`-authorized quarantine ops
 *    (`quarantine inspect` / `quarantine resolve`) must NOT appear in any
 *    signature signer's `permittedOps` — an Ed25519 approval key must never be
 *    able to authorize an operation the contract reserves for os-presence.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSigningPayload,
  deriveSignerRegistryFromKeyFiles,
  SIGNATURE_AUTHORIZABLE_OPS,
  generateEd25519,
  serializePublicKey,
  BrokerRefusal,
} from "../src/index.js";

const QUARANTINE_OPS = ["quarantine inspect", "quarantine resolve"];

describe("F2 — signing payload is an injective field encoding", () => {
  const base = {
    op: "source trust promote",
    canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
    nonce: "n0",
    intendedEffect: {
      kind: "trust" as const,
      sourceOpaqueId: "src-1",
      fromLevel: "candidate",
      toLevel: "trusted",
    },
  };

  it("accepts single-line fields", () => {
    expect(() => buildSigningPayload(base)).not.toThrow();
  });

  it("refuses a newline embedded in a free-string effect field (\\n)", () => {
    const err = (() => {
      try {
        buildSigningPayload({
          ...base,
          intendedEffect: { ...base.intendedEffect, sourceOpaqueId: "src-1\nsource trust revoke" },
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("authz.payload_mismatch");
  });

  it("refuses a carriage-return embedded in a field (\\r)", () => {
    expect(() =>
      buildSigningPayload({ ...base, op: "source trust promote\rpurge" }),
    ).toThrowError(BrokerRefusal);
  });
});

describe("F3 — quarantine (os-presence) ops are not signature-authorizable", () => {
  it("SIGNATURE_AUTHORIZABLE_OPS excludes both quarantine ops", () => {
    for (const q of QUARANTINE_OPS) {
      expect(SIGNATURE_AUTHORIZABLE_OPS as readonly string[]).not.toContain(q);
    }
  });

  it("a derived approval signer is not permitted any quarantine op", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-keys-"));
    try {
      const kp = generateEd25519();
      writeFileSync(join(dir, "approval-verify.pub"), serializePublicKey(kp.publicKey));
      const reg = deriveSignerRegistryFromKeyFiles(dir);
      const approver = reg.find((e) => e.signerId === "approval-verify");
      expect(approver).toBeDefined();
      for (const q of QUARANTINE_OPS) {
        expect(approver!.permittedOps).not.toContain(q);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
