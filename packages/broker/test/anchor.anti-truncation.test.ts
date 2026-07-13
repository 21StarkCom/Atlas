/**
 * `anchor.anti-truncation.test` (§6, D8).
 *
 * Append audit events (each anchors head + a monotonic eventCount into the WORM
 * file), then TRUNCATE the audit ref back to an earlier commit. A restarted
 * broker's startup verify must detect the live count regression against the
 * anchored count and fail closed (`broker.anchor_truncation`).
 */
import { afterEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BrokerRefusal } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
afterEach(() => h?.cleanup());

describe("WORM anchor truncation detection", () => {
  it("anchors an increasing eventCount on every append", async () => {
    h = createHarness();
    await h.service.appendAuditEvent(h.signedAuditEvent(0));
    await h.service.appendAuditEvent(h.signedAuditEvent(1));
    await h.service.appendAuditEvent(h.signedAuditEvent(2));
    const lines = readFileSync(h.anchorPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.payload.eventCount).toBe(3);
  });

  it("detects a truncated audit ref on restart (fail-closed)", async () => {
    h = createHarness();
    const r0 = await h.service.appendAuditEvent(h.signedAuditEvent(0));
    await h.service.appendAuditEvent(h.signedAuditEvent(1));
    await h.service.appendAuditEvent(h.signedAuditEvent(2));
    expect(h.git(["rev-list", "--count", "refs/audit/runs"])).toBe("3");

    // Truncate: force the audit ref back to the first event (drops 2 events).
    h.git(["update-ref", "refs/audit/runs", r0.head]);
    expect(h.git(["rev-list", "--count", "refs/audit/runs"])).toBe("1");

    // A fresh broker over the same repo + anchor must refuse to start.
    const restarted = h.newService();
    const err = await restarted.start().catch((e) => e);
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("broker.anchor_truncation");
    expect((err as BrokerRefusal).exitCode).toBe(4);
  });

  it("starts cleanly when the audit ref matches the anchor", async () => {
    h = createHarness();
    await h.service.appendAuditEvent(h.signedAuditEvent(0));
    await h.service.appendAuditEvent(h.signedAuditEvent(1));
    const restarted = h.newService();
    await expect(restarted.start()).resolves.toBeUndefined();
  });
});
