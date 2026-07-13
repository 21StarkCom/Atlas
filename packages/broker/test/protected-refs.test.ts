/**
 * `protected-refs.test` — CAS advance (ancestry + audit re-verify) and the
 * narrowly scoped `integrateSourceCapture` (sources/** + manifest only).
 */
import { afterEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isCaptureAllowedPath } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
afterEach(() => h?.cleanup());

function manifest(runId = "01J9Z8Q0000000000000000000") {
  return {
    schemaVersion: 1 as const,
    runId,
    state: "integrated" as const,
    createdAt: "2026-07-12T09:00:00.000Z",
    canonicalBaseCommit: "0".repeat(40),
    targets: ["notes/x"],
  };
}

describe("advanceProtectedRef", () => {
  it("fast-forwards canonical under CAS and appends the audit event", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const child = h.commitChild(tip, { "notes/a.md": "hello\n" });
    const res = await h.service.advanceProtectedRef({
      ref: "refs/heads/main",
      expectedOld: tip,
      newCommit: child,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, child),
    });
    expect(res.ok).toBe(true);
    expect(h.ref("refs/heads/main")).toBe(child);
    expect(h.ref("refs/audit/runs")).toBe(res.auditHead);
  });

  it("refuses a stale CAS old-value", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const child = h.commitChild(tip, { "notes/a.md": "hi\n" });
    await expect(
      h.service.advanceProtectedRef({
        ref: "refs/heads/main",
        expectedOld: "f".repeat(40),
        newCommit: child,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
      }),
    ).rejects.toMatchObject({ code: "broker.cas_failed" });
  });

  it("refuses a non-fast-forward advance", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    // Sibling commit off the SAME parent's parent (not descending from tip):
    // build a child of the seed's tree that is unrelated to tip's history.
    const sibling = h.commitChild(tip, { "notes/a.md": "x\n" });
    // advance to sibling first (ff), then try to advance to a commit not descending.
    await h.service.advanceProtectedRef({
      ref: "refs/heads/main",
      expectedOld: tip,
      newCommit: sibling,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, sibling),
    });
    const orphan = h.commitChild(tip, { "notes/b.md": "y\n" }); // child of old tip, not of sibling
    await expect(
      h.service.advanceProtectedRef({
        ref: "refs/heads/main",
        expectedOld: sibling,
        newCommit: orphan,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(1),
      }),
    ).rejects.toMatchObject({ code: "broker.not_fast_forward" });
  });

  it("refuses to advance the audit ref via this primitive, with NO side effect (finding 6)", async () => {
    h = createHarness();
    // Seed one real audit event so there is an audit ref + anchor to observe.
    const seeded = await h.service.appendAuditEvent(h.signedAuditEvent(0));
    const auditHeadBefore = h.ref("refs/audit/runs");
    const anchorBefore = readFileSync(h.anchorPath, "utf8");
    expect(auditHeadBefore).toBe(seeded.head);

    await expect(
      h.service.advanceProtectedRef({
        ref: "refs/audit/runs",
        expectedOld: "f".repeat(40), // deliberately stale so the CAS would fail
        newCommit: auditHeadBefore,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(1, manifest().runId, auditHeadBefore),
      }),
    ).rejects.toMatchObject({ code: "broker.ref_not_protected" });

    // Neither the audit ref nor the WORM anchor moved — no durable side effect.
    expect(h.ref("refs/audit/runs")).toBe(auditHeadBefore);
    expect(readFileSync(h.anchorPath, "utf8")).toBe(anchorBefore);
    expect(h.git(["rev-list", "--count", "refs/audit/runs"])).toBe("1");
  });

  it("refuses a write to a non-protected ref", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    await expect(
      h.service.advanceProtectedRef({
        ref: "refs/agent/01J9Z8Q0000000000000000000",
        expectedOld: tip,
        newCommit: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
      }),
    ).rejects.toMatchObject({ code: "broker.ref_not_protected" });
  });
});

describe("integrateSourceCapture", () => {
  it("integrates a capture touching only sources/**", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, {
      "sources/s1/raw.txt": "captured\n",
      "sources/s1/manifest.json": "{}\n",
    });
    const res = await h.service.integrateSourceCapture({
      captureCommit: capture,
      expectedBase: tip,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
    });
    expect(res.ok).toBe(true);
    expect(h.ref("refs/heads/main")).toBe(capture);
  });

  it("rejects a capture touching a path outside sources/** + manifest", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, {
      "sources/s1/raw.txt": "captured\n",
      "notes/evil.md": "not allowed\n",
    });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    // Canonical must be untouched after a rejected capture.
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects a capture whose base moved (CAS)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, { "sources/s1/raw.txt": "x\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: "f".repeat(40),
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
      }),
    ).rejects.toMatchObject({ code: "broker.cas_failed" });
  });
});

describe("isCaptureAllowedPath", () => {
  it("allows sources/** and manifest files; rejects everything else", () => {
    expect(isCaptureAllowedPath("sources/x/raw.txt")).toBe(true);
    expect(isCaptureAllowedPath("sources/x/manifest.json")).toBe(true);
    expect(isCaptureAllowedPath("manifest.json")).toBe(true);
    expect(isCaptureAllowedPath("manifest.yaml")).toBe(true);
    expect(isCaptureAllowedPath("notes/a.md")).toBe(false);
    expect(isCaptureAllowedPath("refs/heads/main")).toBe(false);
  });
});
