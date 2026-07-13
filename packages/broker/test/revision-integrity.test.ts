/**
 * `revision-integrity.test` — round-2 wing findings on capture scope + audit
 * chain + WORM anchor integrity.
 *
 *  - Finding 4: a multi-commit capture cannot smuggle a forbidden path through an
 *    earlier commit while the tip stays clean (full-range scope check).
 *  - Finding 5: startup fully re-verifies the audit chain; append refuses seq
 *    gaps and idempotency-key collisions with different content.
 *  - Finding 6: a same-COUNT suffix rewrite of the audit ref is detected against
 *    the anchor head (not just count regression).
 */
import { afterEach, describe, it, expect } from "vitest";
import { BrokerRefusal } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
afterEach(() => h?.cleanup());

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // sha1 empty tree

function manifest(runId = "01J9Z8Q0000000000000000000") {
  return {
    schemaVersion: 1 as const,
    runId,
    state: "integrated" as const,
    createdAt: "2026-07-12T09:00:00.000Z",
    canonicalBaseCommit: "0".repeat(40),
    targets: ["sources/s1"],
  };
}

describe("multi-commit capture scope (finding 4)", () => {
  it("rejects a capture whose EARLIER commit introduces a forbidden path", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    // commit1 introduces a forbidden path; commit2 (the tip) touches only sources/**.
    const c1 = h.commitChild(tip, { "notes/evil.md": "smuggled\n" });
    const c2 = h.commitChild(c1, { "sources/s1/raw.txt": "clean\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: c2,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip); // canonical untouched
  });

  it("still integrates a multi-commit capture that stays within sources/**", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const c1 = h.commitChild(tip, { "sources/s1/a.txt": "1\n" });
    const c2 = h.commitChild(c1, { "sources/s1/b.txt": "2\n" });
    const res = await h.service.integrateSourceCapture({
      captureCommit: c2,
      expectedBase: tip,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, c2),
    });
    expect(res.ok).toBe(true);
    expect(h.ref("refs/heads/main")).toBe(c2);
  });
});

describe("audit append integrity (finding 5)", () => {
  it("refuses a sequence GAP (not just a regression)", async () => {
    h = createHarness();
    await h.service.appendAuditEvent(h.signedAuditEvent(0));
    await expect(h.service.appendAuditEvent(h.signedAuditEvent(2))).rejects.toMatchObject({
      code: "broker.audit_seq_nonmonotonic",
    });
  });

  it("refuses an idempotency-key collision with DIFFERENT content", async () => {
    h = createHarness();
    const runId = "01J9Z8Q0000000000000000000";
    await h.service.appendAuditEvent(h.signedAuditEvent(0, { runId }));
    // Same (runId, seq) but different content.
    await expect(
      h.service.appendAuditEvent(h.signedAuditEvent(0, { runId, kind: "run.failed" })),
    ).rejects.toMatchObject({ code: "broker.audit_idempotency_conflict" });
  });

  it("detects a corrupted historical audit commit on startup", async () => {
    h = createHarness();
    await h.service.appendAuditEvent(h.signedAuditEvent(0));
    await h.service.appendAuditEvent(h.signedAuditEvent(1));
    // Replace the audit tip with a commit whose message is not a valid envelope.
    const corrupt = h.git(["commit-tree", EMPTY_TREE, "-p", h.ref("refs/audit/runs"), "-m", "not-an-envelope"]);
    h.git(["update-ref", "refs/audit/runs", corrupt]);
    const err = await h.newService().start().catch((e) => e);
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("broker.audit_chain_invalid");
  });
});

describe("WORM anchor same-count rewrite (finding 6)", () => {
  it("detects a same-length suffix rewrite (head differs at equal count)", async () => {
    h = createHarness();
    const r0 = await h.service.appendAuditEvent(h.signedAuditEvent(0));
    await h.service.appendAuditEvent(h.signedAuditEvent(1)); // anchored: count 2, head = r1

    // Build a DIFFERENT but fully-valid second event chained onto r0, and force the
    // audit ref to it — same count (2) but a different head than the anchor records.
    const alt = h.signedAuditEvent(1, { prevAuditHead: r0.head });
    const env = {
      payload: alt.event,
      signature: "ed25519:" + Buffer.from(alt.signature).toString("base64url"),
      signerId: alt.signerId,
      canonicalization: "atlas-jcs-v1",
    };
    const altCommit = h.git(["commit-tree", EMPTY_TREE, "-p", r0.head, "-m", JSON.stringify(env)]);
    h.git(["update-ref", "refs/audit/runs", altCommit]);
    expect(h.git(["rev-list", "--count", "refs/audit/runs"])).toBe("2"); // same count

    const err = await h.newService().start().catch((e) => e);
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("broker.anchor_truncation");
  });
});
