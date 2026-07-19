/**
 * `note-add-scope.test` — the `"note"` capture scope (#262): an authored-note
 * integration may ONLY add `*.md` files outside `sources/`, status-checked over
 * the whole `base..capture` range; the default `"sources"` scope is unchanged.
 */
import { afterEach, describe, it, expect } from "vitest";
import { isNoteAddAllowedPath } from "../src/index.js";
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

/** Commit a child of `parentSha` that DELETES `path`; returns its SHA (no ref moves). */
function commitDeleting(parentSha: string, path: string): string {
  h.git(["read-tree", parentSha]);
  h.git(["update-index", "--force-remove", path]);
  const tree = h.git(["write-tree"]);
  return h.git(["commit-tree", tree, "-p", parentSha, "-m", "delete"]);
}

describe('integrateSourceCapture scope "note"', () => {
  it("accepts a commit that only ADDS a new .md outside sources/ (canonical advances)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, { "notes/fresh-note.md": "# fresh\n\nauthored\n" });
    const res = await h.service.integrateSourceCapture({
      captureCommit: capture,
      expectedBase: tip,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
      scope: "note",
    });
    expect(res.ok).toBe(true);
    expect(h.ref("refs/heads/main")).toBe(capture);
  });

  it("rejects a commit that MODIFIES an existing file", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    // README.md is a .md outside sources/ — the STATUS (M ≠ A) is what refuses it.
    const capture = h.commitChild(tip, { "README.md": "tampered\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects a commit that DELETES a file", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = commitDeleting(tip, "README.md");
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects adding a .md under sources/", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, { "sources/s1/note.md": "not a note-add\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects adding a non-.md file", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, { "notes/data.txt": "not markdown\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects a multi-commit range whose EARLIER commit modifies, even with an add-only tip", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const mid = h.commitChild(tip, { "README.md": "smuggled edit\n" }); // M, mid-range
    const capture = h.commitChild(mid, { "notes/fresh-note.md": "clean tip\n" }); // A only vs its parent
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });
});

describe('default scope "sources" is unchanged', () => {
  it("integrates a sources/** capture with no scope supplied", async () => {
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

  it("refuses a note-style add (.md outside sources/) with no scope supplied", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, { "notes/fresh-note.md": "authored\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });
});

describe("isNoteAddAllowedPath", () => {
  it("allows .md outside sources/; rejects sources/** and non-.md", () => {
    expect(isNoteAddAllowedPath("notes/a.md")).toBe(true);
    expect(isNoteAddAllowedPath("deep/nested/note.md")).toBe(true);
    expect(isNoteAddAllowedPath("sources/x/a.md")).toBe(false);
    expect(isNoteAddAllowedPath("notes/data.txt")).toBe(false);
    expect(isNoteAddAllowedPath("manifest.json")).toBe(false);
  });
});
