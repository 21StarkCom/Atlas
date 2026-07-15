/**
 * `broker-signed-integrator` — regression for round-3 finding #6: the broker-signing
 * capture path carries the UNSIGNED `run.integrated` event (`Omit<AuditEvent,
 * "prevAuditHead">`) directly, with NO `SignedAuditEvent` masquerade around the RPC.
 *
 * The fixture is a GENUINELY TYPED {@link IntegrationContext} (round-3 wing finding) —
 * NOT `as unknown as IntegrationContext`, which would defeat the compile-time proof the
 * seam threads the UNSIGNED shape. A `@ts-expect-error` negative assertion pins that a
 * SIGNED/wrapped event is REJECTED by the context type, and a source-level check pins
 * that the production signing seam carries no `as unknown as` masquerade cast.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent, SignedAuditEvent } from "@atlas/contracts";
import { makeBrokerSignedCaptureIntegrator } from "../src/ingest/capture.js";
import type { IntegrationContext } from "../src/workflows/index.js";

/** The UNSIGNED integration event the seam threads: `Omit<AuditEvent, "prevAuditHead">`. */
type UnsignedIntegrationEvent = IntegrationContext["event"];

describe("broker-signed capture integrator: no SignedAuditEvent masquerade (finding #6)", () => {
  it("threads the UNSIGNED event through to the capture RPC unchanged", async () => {
    // A genuinely typed unsigned event (NO cast): if the shape drifted from
    // `Omit<AuditEvent, "prevAuditHead">` this would fail to compile.
    const event: UnsignedIntegrationEvent = {
      schemaVersion: 1,
      eventId: "e1",
      kind: "run.integrated",
      seq: 7,
      occurredAt: "2026-07-14T00:00:00.000Z",
      runId: "run-1",
      subjects: [],
      canonicalCommit: "c".repeat(40),
      detail: { baseRef: "b".repeat(40) },
    };
    let receivedEvent: unknown;
    let receivedShape: Record<string, unknown> | undefined;
    const integrate = makeBrokerSignedCaptureIntegrator({
      integrateSourceCapture: (r) => {
        receivedEvent = r.event;
        receivedShape = r as unknown as Record<string, unknown>;
        return Promise.resolve({ newCommit: "n".repeat(40), seq: 7, auditHead: "a".repeat(40), ref: "refs/heads/main" });
      },
    });
    // A genuinely typed IntegrationContext — no `as unknown as IntegrationContext`
    // double-cast (round-3 wing finding), so the compiler verifies the unsigned-event
    // contract end-to-end.
    const ctx: IntegrationContext = {
      runId: "run-1",
      commitSha: "d".repeat(40),
      canonicalRef: "refs/heads/main",
      baseRef: "b".repeat(40),
      event,
    };

    const res = await integrate(ctx);

    // The UNSIGNED event is forwarded BY REFERENCE — never re-wrapped as a
    // SignedAuditEvent and unwrapped again (the masquerade the finding removed).
    expect(receivedEvent).toBe(event);
    // The RPC carries `event` (the unsigned shape), not a signed `auditEvent`.
    expect(receivedShape).toHaveProperty("event");
    expect(receivedShape).not.toHaveProperty("auditEvent");
    expect(res).toEqual({ canonicalRef: "refs/heads/main", canonicalSha: "n".repeat(40), seq: 7, auditHead: "a".repeat(40) });
  });

  it("a SIGNED/wrapped event is REJECTED by the context type (negative compile-time proof)", () => {
    const base: Omit<AuditEvent, "prevAuditHead"> = {
      schemaVersion: 1,
      eventId: "e1",
      kind: "run.integrated",
      seq: 7,
      occurredAt: "2026-07-14T00:00:00.000Z",
      runId: "run-1",
      subjects: [],
      canonicalCommit: "c".repeat(40),
      detail: { baseRef: "b".repeat(40) },
    };
    // A signed event is `{ event, signature, signerId }` — structurally NOT an
    // unsigned `Omit<AuditEvent, "prevAuditHead">`, so the compiler must reject it as
    // the integration event. The `@ts-expect-error` FAILS the build if the type ever
    // widens to admit a signed/wrapped event (reintroducing the masquerade).
    const signed: SignedAuditEvent = { event: { ...base, prevAuditHead: "0".repeat(40) }, signature: new Uint8Array(64), signerId: "atlas-audit-attestation-v1" };
    // @ts-expect-error — a SignedAuditEvent (signed/wrapped) is NOT a valid unsigned integration event.
    const bad: UnsignedIntegrationEvent = signed;
    void bad;
    // A raw `{ auditEvent }` wrapper is likewise rejected (no such field on the unsigned shape).
    // @ts-expect-error — a `{ auditEvent }` wrapper is NOT a valid unsigned integration event.
    const wrapped: UnsignedIntegrationEvent = { auditEvent: base };
    void wrapped;
    expect(signed.signerId).toBe("atlas-audit-attestation-v1");
  });

  it("the production signing seam carries no `as unknown as` / SignedAuditEvent masquerade cast", () => {
    // The finding removed the `as unknown as SignedAuditEvent`/back cast around the RPC.
    // Pin it at the source level so a reintroduced masquerade fails HERE — a runtime
    // reference check cannot catch a type-only masquerade. Comments legitimately MENTION
    // the anti-pattern (they document its removal), so strip comments before matching and
    // assert no `SignedAuditEvent` reference or double-cast survives in the actual CODE.
    const src = join(import.meta.dirname, "..", "src", "ingest");
    for (const file of ["capture.ts", "wiring.ts"]) {
      const code = stripComments(readFileSync(join(src, file), "utf8"));
      expect(code, `${file} code must not reference SignedAuditEvent (the seam threads the UNSIGNED event)`).not.toMatch(/SignedAuditEvent/);
      expect(code, `${file} code must not carry an \`as unknown as\` masquerade cast`).not.toMatch(/as\s+unknown\s+as/);
    }
  });
});

/** Strip block + line comments so a source-level check inspects CODE, not documentation. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/([^:])\/\/.*$/gm, "$1");
}
