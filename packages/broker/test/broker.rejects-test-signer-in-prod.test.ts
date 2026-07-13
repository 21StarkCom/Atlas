/**
 * `broker.rejects-test-signer-in-prod.test` (D20).
 *
 * An authorization signed by `atlas-test-approver` is HARD-REJECTED when
 * `ATLAS_TEST_MODE` is unset — so Phases 1-4 cannot ship a production-usable
 * fixture signer. Under test mode the same authorization is accepted, proving
 * the gate is exactly the env flag and nothing else.
 */
import { afterEach, describe, it, expect } from "vitest";
import { BrokerRefusal, type PrivilegedOpDescriptor } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
afterEach(() => h?.cleanup());

const OP: PrivilegedOpDescriptor = {
  op: "git approve",
  runId: "01J9Z8Q0000000000000000000",
  targetCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:3f9ac012" },
};

describe("D20 test-signer rejection", () => {
  it("rejects an atlas-test-approver authorization when ATLAS_TEST_MODE is unset", () => {
    h = createHarness({ testMode: false });
    const { response } = h.authorize(OP, "test");
    let err: unknown;
    try {
      h.service.execAuthorized(OP, response as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("authz.signer_not_permitted");
    expect((err as BrokerRefusal).detail.d20).toBe(true);
  });

  it("accepts a production approver authorization even when test mode is off", () => {
    h = createHarness({ testMode: false });
    const { response } = h.authorize(OP, "approver");
    expect(() => h.service.execAuthorized(OP, response as never)).not.toThrow();
  });

  it("accepts the test signer when ATLAS_TEST_MODE=1", () => {
    h = createHarness({ testMode: true });
    const { response } = h.authorize(OP, "test");
    const res = h.service.execAuthorized(OP, response as never);
    expect(res.code).toBe("authz.ok");
  });
});
