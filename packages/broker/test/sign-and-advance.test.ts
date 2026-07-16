/**
 * `sign-and-advance` — `BrokerService.signAndAdvanceProtectedRef`, the general-scope broker
 * sign-and-advance for synthesis/approve/rollback (the analogue of `signAndIntegrateSourceCapture`
 * for non-capture canonical installs). The CLI submits an UNSIGNED canonical-installing event; the
 * broker fills `prevAuditHead`, signs with the attestation key, verifies the audit-event binding,
 * and advances canonical under CAS — the CLI never holds the attestation key. A mismatched binding
 * or a stale base is refused before canonical moves.
 */
import { describe, it, expect } from "vitest";
import { newRunId, type AuditEvent, type RunManifest } from "@atlas/contracts";
import { BrokerRefusal } from "../src/index.js";
import { createHarness } from "./harness.ts";

const NOW = "2026-07-16T00:00:00.000Z";

function unsignedIntegrated(runId: string, canonicalCommit: string): Omit<AuditEvent, "prevAuditHead"> {
  return {
    schemaVersion: 1,
    eventId: newRunId(),
    kind: "run.integrated",
    seq: 0,
    occurredAt: NOW,
    runId,
    subjects: [],
    canonicalCommit,
    detail: {},
  };
}

function manifest(runId: string, base: string): RunManifest {
  return { schemaVersion: 1, runId, state: "integrated", createdAt: NOW, canonicalBaseCommit: base, targets: [] };
}

describe("BrokerService.signAndAdvanceProtectedRef", () => {
  it("signs the unsigned event internally + fast-forwards canonical to the installed commit", async () => {
    const h = createHarness({ testMode: true });
    try {
      const base = h.ref(h.canonicalRef);
      const newCommit = h.commitChild(base, { "notes/a.md": "enriched by synthesis\n" });
      const runId = newRunId();
      const res = await h.service.signAndAdvanceProtectedRef({
        ref: h.canonicalRef,
        expectedOld: base,
        newCommit,
        manifest: manifest(runId, base),
        event: unsignedIntegrated(runId, newCommit),
      });
      expect(res.newCommit).toBe(newCommit);
      // Canonical genuinely advanced to the reviewed commit — the CLI never signed anything.
      expect(h.ref(h.canonicalRef)).toBe(newCommit);
    } finally {
      h.cleanup();
    }
  });

  it("refuses when the event does not commit to the exact installed commit (binding mismatch)", async () => {
    const h = createHarness({ testMode: true });
    try {
      const base = h.ref(h.canonicalRef);
      const newCommit = h.commitChild(base, { "notes/a.md": "x\n" });
      const runId = newRunId();
      // The event claims canonicalCommit === base, not the commit being installed.
      await expect(
        h.service.signAndAdvanceProtectedRef({
          ref: h.canonicalRef,
          expectedOld: base,
          newCommit,
          manifest: manifest(runId, base),
          event: unsignedIntegrated(runId, base),
        }),
      ).rejects.toBeInstanceOf(BrokerRefusal);
      // Canonical untouched by the refused advance.
      expect(h.ref(h.canonicalRef)).toBe(base);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a stale base (CAS mismatch)", async () => {
    const h = createHarness({ testMode: true });
    try {
      const base = h.ref(h.canonicalRef);
      const newCommit = h.commitChild(base, { "notes/a.md": "y\n" });
      const runId = newRunId();
      await expect(
        h.service.signAndAdvanceProtectedRef({
          ref: h.canonicalRef,
          expectedOld: "f".repeat(40), // not the current canonical tip
          newCommit,
          manifest: manifest(runId, base),
          event: unsignedIntegrated(runId, newCommit),
        }),
      ).rejects.toBeInstanceOf(BrokerRefusal);
      expect(h.ref(h.canonicalRef)).toBe(base);
    } finally {
      h.cleanup();
    }
  });
});
