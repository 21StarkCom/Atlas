/**
 * `broker.audit-append.test` — signed-only + monotonic-seq + idempotent append,
 * with a WORM anchor written on every append (§5, §6).
 */
import { afterEach, describe, it, expect } from "vitest";
import { canonicalSerialize, type SignedAuditEvent } from "@atlas/contracts";
import { BrokerRefusal, signRaw } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
afterEach(() => h?.cleanup());

describe("appendAuditEvent", () => {
  it("appends events, advancing refs/audit/runs and the WORM anchor", async () => {
    h = createHarness();
    const r0 = await h.service.appendAuditEvent(h.signedAuditEvent(0));
    expect(r0.seq).toBe(0);
    expect(h.ref("refs/audit/runs")).toBe(r0.head);

    const r1 = await h.service.appendAuditEvent(h.signedAuditEvent(1));
    expect(r1.seq).toBe(1);
    expect(h.ref("refs/audit/runs")).toBe(r1.head);
    // Two commits chained on the audit ref.
    expect(h.git(["rev-list", "--count", "refs/audit/runs"])).toBe("2");
  });

  it("is idempotent on (runId, seq)", async () => {
    h = createHarness();
    const ev = h.signedAuditEvent(0, { runId: "01J9Z8Q0000000000000000000" });
    const first = await h.service.appendAuditEvent(ev);
    const again = await h.service.appendAuditEvent(ev);
    expect(again).toEqual(first);
    expect(h.git(["rev-list", "--count", "refs/audit/runs"])).toBe("1");
  });

  it("refuses a non-monotonic seq", async () => {
    h = createHarness();
    await h.service.appendAuditEvent(h.signedAuditEvent(5));
    await expect(h.service.appendAuditEvent(h.signedAuditEvent(3))).rejects.toMatchObject({
      code: "broker.audit_seq_nonmonotonic",
    });
  });

  it("refuses an event with a forged (bad) signature", async () => {
    h = createHarness();
    const good = h.signedAuditEvent(0);
    const forged: SignedAuditEvent = { ...good, signature: new Uint8Array(64) };
    await expect(h.service.appendAuditEvent(forged)).rejects.toMatchObject({
      code: "broker.audit_signature_invalid",
    });
  });

  it("refuses an event signed by a non-attestation identity (finding 2)", async () => {
    h = createHarness();
    const ev = h.signedAuditEvent(0);
    // Re-sign with the RIGHT bytes but claim a signerId other than the dedicated
    // attestation identity — the audit log trusts ONLY the attestation identity,
    // so any other signer (approval signer or unknown) is refused as untrusted.
    const resigned: SignedAuditEvent = {
      ...ev,
      signature: signRaw(canonicalSerialize(ev.event), h.attestation.privateKey),
      signerId: "ghost-signer",
    };
    await expect(h.service.appendAuditEvent(resigned)).rejects.toMatchObject({
      code: "broker.audit_signer_untrusted",
    });
  });

  it("refuses an audit event signed by a valid APPROVAL signer, not the attestation identity (finding 2)", async () => {
    h = createHarness();
    const ev = h.signedAuditEvent(0);
    // A legitimate registry signer (the enrolled approver) signs a well-formed
    // audit event. It must STILL be refused: only the dedicated audit-attestation
    // identity may sign the audit stream — an approval key cannot forge history.
    const approverSigned: SignedAuditEvent = {
      ...ev,
      signature: signRaw(canonicalSerialize(ev.event), h.approverPrivateKey),
      signerId: h.approverSignerId,
    };
    await expect(h.service.appendAuditEvent(approverSigned)).rejects.toMatchObject({
      code: "broker.audit_signer_untrusted",
    });
    // No side effect: the audit ref never came into existence.
    await expect(h.service.appendAuditEvent(h.signedAuditEvent(0))).resolves.toMatchObject({ seq: 0 });
  });

  it("surfaces refusals as BrokerRefusal instances", async () => {
    h = createHarness();
    await h.service.appendAuditEvent(h.signedAuditEvent(1));
    const err = await h.service.appendAuditEvent(h.signedAuditEvent(0)).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).exitCode).toBe(1);
  });
});
