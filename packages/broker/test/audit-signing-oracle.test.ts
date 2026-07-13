/**
 * Regression test for the **audit signing-oracle** finding on the F4
 * broker-internal signing entry point (`signAndAppendAuditEvent`).
 *
 * The broker socket is reachable by the agent identity (the run dir is `2770`
 * setgid `atlas-git`), and `signAndAppend` signs an event whose CONTENT is
 * supplied by the caller. A canonical-installing event (`run.integrated` /
 * `run.rolled_back`) asserts "the canonical ref now points at this commit" — an
 * assertion that is only truthful when the broker itself performed the move.
 *
 * So the signing entry point MUST refuse to attest those kinds: an untrusted peer
 * must not be able to obtain a broker attestation for a fabricated canonical
 * install naming a commit that was never installed. Those events may only be
 * produced by the protected-ref path, which binds the event to the observed move.
 */
import { afterEach, describe, it, expect } from "vitest";
import { BrokerRefusal } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
afterEach(() => h?.cleanup());

/** An unsigned event as an untrusted socket peer would submit it. */
function unsigned(kind: string, seq: number, canonicalCommit: string) {
  return {
    schemaVersion: 1 as const,
    eventId: "01J9Z8Q000000000000000ZZZZ",
    kind,
    seq,
    occurredAt: "2026-07-13T09:14:22.581Z",
    runId: "01J9Z8Q0000000000000000000",
    subjects: [],
    canonicalCommit,
    detail: {},
  };
}

describe("signAndAppendAuditEvent is not a canonical-install signing oracle", () => {
  const FABRICATED = "dead".repeat(10); // a commit the broker never installed

  for (const kind of ["run.integrated", "run.rolled_back"]) {
    it(`refuses to sign a fabricated "${kind}" (asserts an unobserved canonical move)`, async () => {
      h = createHarness();
      await h.service.start();
      const err = await h.service
        .signAndAppendAuditEvent(unsigned(kind, 0, FABRICATED) as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BrokerRefusal);
      expect((err as BrokerRefusal).code).toBe("broker.audit_kind_not_signable");
    });
  }

  it("still signs a non-installing ledger event (the orchestrator's legitimate use)", async () => {
    h = createHarness();
    await h.service.start();
    const res = await h.service.signAndAppendAuditEvent(
      unsigned("run.readonly", 0, "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182") as never,
    );
    expect(res.seq).toBe(0);
    expect(res.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses a fabricated canonical install even at the exact next seq", async () => {
    h = createHarness();
    await h.service.start();
    // Burn seq 0 with a legitimate non-installing event, so seq 1 is "exact next"
    // — proving the kind gate is independent of the seq gate.
    await h.service.signAndAppendAuditEvent(
      unsigned("run.readonly", 0, "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182") as never,
    );
    const err = await h.service
      .signAndAppendAuditEvent(unsigned("run.integrated", 1, FABRICATED) as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("broker.audit_kind_not_signable");
  });
});
