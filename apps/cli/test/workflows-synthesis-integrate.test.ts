/**
 * `workflows-synthesis-integrate` — unit coverage for {@link makeSynthesisIntegrator}
 * (Task 4.5 slice B), the Tier-2 canonical-install seam. It asserts the wrapper signs
 * the engine-allocated `run.integrated` event, builds the correct `advanceProtectedRef`
 * request (ref/expectedOld/newCommit/manifest binding), maps the broker result to a
 * {@link BrokerIntegration}, and PROPAGATES a `broker.cas_failed` refusal unchanged so
 * the apply loop can rebase.
 */
import { describe, it, expect, vi } from "vitest";
import type { RefAdvanceRequest, RefAdvanceResult } from "@atlas/broker";
import type { SignedAuditEvent } from "@atlas/contracts";
import type { UnsignedAuditEvent } from "@atlas/sqlite-store";
import type { IntegrationContext } from "../src/workflows/index.js";
import { makeSynthesisIntegrator } from "../src/workflows/integrate.js";

function ctx(over: Partial<IntegrationContext> = {}): IntegrationContext {
  const event = {
    schemaVersion: 1,
    eventId: "01J000000000000000000EVENT",
    kind: "run.integrated",
    seq: 7,
    occurredAt: "2026-07-14T00:00:00.000Z",
    runId: "01J000000000000000000RUNID",
    subjects: [],
    canonicalCommit: "c".repeat(40),
    detail: { baseRef: "b".repeat(40) },
  } as unknown as UnsignedAuditEvent;
  return {
    runId: "01J000000000000000000RUNID",
    commitSha: "c".repeat(40),
    canonicalRef: "refs/heads/main",
    baseRef: "b".repeat(40),
    event,
    ...over,
  };
}

function signed(e: UnsignedAuditEvent): SignedAuditEvent {
  return { event: { ...e, prevAuditHead: "a".repeat(40) }, signature: "sig", signerId: "att-v1" } as unknown as SignedAuditEvent;
}

describe("makeSynthesisIntegrator", () => {
  it("signs the event, advances canonical under CAS, and maps the result", async () => {
    const advanceProtectedRef = vi.fn(
      async (_r: RefAdvanceRequest): Promise<RefAdvanceResult> => ({
        ok: true,
        ref: "refs/heads/main",
        newCommit: "c".repeat(40),
        seq: 7,
        auditHead: "h".repeat(40),
      }),
    );
    const sign = vi.fn((e: UnsignedAuditEvent) => signed(e));
    const integrator = makeSynthesisIntegrator({ advanceProtectedRef, sign, now: () => "2026-07-14T00:00:00.000Z" });

    const result = await integrator(ctx());

    expect(sign).toHaveBeenCalledOnce();
    expect(advanceProtectedRef).toHaveBeenCalledOnce();
    const req = advanceProtectedRef.mock.calls[0]![0];
    expect(req.ref).toBe("refs/heads/main");
    expect(req.expectedOld).toBe("b".repeat(40));
    expect(req.newCommit).toBe("c".repeat(40));
    expect(req.manifest.runId).toBe("01J000000000000000000RUNID");
    expect(req.manifest.canonicalBaseCommit).toBe("b".repeat(40));
    expect(req.auditEvent.signerId).toBe("att-v1");

    expect(result).toEqual({ canonicalRef: "refs/heads/main", canonicalSha: "c".repeat(40), seq: 7, auditHead: "h".repeat(40) });
  });

  it("propagates a broker.cas_failed refusal unchanged (the apply loop rebases)", async () => {
    const advanceProtectedRef = vi.fn(async (): Promise<RefAdvanceResult> => {
      throw Object.assign(new Error("CAS failed"), { code: "broker.cas_failed" });
    });
    const sign = vi.fn((e: UnsignedAuditEvent) => signed(e));
    const integrator = makeSynthesisIntegrator({ advanceProtectedRef, sign });

    await expect(integrator(ctx())).rejects.toMatchObject({ code: "broker.cas_failed" });
  });
});
