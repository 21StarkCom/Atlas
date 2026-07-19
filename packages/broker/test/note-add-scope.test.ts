/**
 * `note-add-scope.test` — the `"note"` capture scope (#262): an authored-note
 * integration may ONLY add `*.md` files outside `sources/`, status-checked over
 * the whole `base..capture` range; the default `"sources"` scope is unchanged.
 *
 * Also the REGRESSION suite for the hardened scope (the security fixes):
 *   - `isNoteAddAllowedPath` rejects `.git`/`.GIT` components, case-insensitive
 *     `sources/`, `..`/`.`/empty segments, absolute + backslash paths — crafted
 *     trees carrying them (which `git add` would refuse but `mktree` builds) are
 *     refused broker-side;
 *   - the `-z` name-status parse accepts non-ASCII (Hebrew) filenames that the
 *     old newline parse saw C-quoted (and therefore wrongly refused);
 *   - an UNBORN canonical is checked over the WHOLE reachable history with `-m`
 *     (a merge tip that plain `diff-tree` printed as empty, or a chain whose
 *     earlier commit smuggles a non-.md, can no longer install unchecked trees);
 *   - an EMPTY change-set is refused fail-closed.
 */
import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isNoteAddAllowedPath } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
afterEach(() => h?.cleanup());

const ZERO_OID = "0".repeat(40);

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

/** Run git in the harness repo WITH stdin (the harness `git()` has no input seam). */
function gitIn(args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: h.repoDir,
    ...(input !== undefined ? { input } : {}),
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Aryeh Stark",
      GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
      GIT_COMMITTER_NAME: "Aryeh Stark",
      GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
    },
  }).trim();
}

/**
 * Commit (child of `parentSha`) whose tree is the parent's tree PLUS a crafted
 * subtree `<dirName>/x.md` — built with `mktree`, the way a hostile direct
 * object-store writer would, because `git add` refuses `.git`/`..` path
 * components. The broker's committed-path policy is the ONLY thing standing
 * between such a tree and canonical.
 */
function commitAddingCraftedDir(parentSha: string, dirName: string): string {
  const blob = gitIn(["hash-object", "-w", "--stdin"], "poison\n");
  const inner = gitIn(["mktree"], `100644 blob ${blob}\tx.md\n`);
  const outer = gitIn(["mktree"], `${gitIn(["ls-tree", parentSha])}\n040000 tree ${inner}\t${dirName}\n`);
  return gitIn(["commit-tree", outer, "-p", parentSha, "-m", `crafted ${dirName}`]);
}

/** Commit adding the traversal path `notes/../evil.md` (a `..`-named subtree). */
function commitAddingDotDotPath(parentSha: string): string {
  const blob = gitIn(["hash-object", "-w", "--stdin"], "poison\n");
  const inner = gitIn(["mktree"], `100644 blob ${blob}\tevil.md\n`);
  const dotdot = gitIn(["mktree"], `040000 tree ${inner}\t..\n`);
  const outer = gitIn(["mktree"], `${gitIn(["ls-tree", parentSha])}\n040000 tree ${dotdot}\tnotes\n`);
  return gitIn(["commit-tree", outer, "-p", parentSha, "-m", "traversal"]);
}

/** Build a commit whose tree is EXACTLY `files` (fresh empty index), with `parents`. */
function commitWithTree(files: Record<string, string>, parents: readonly string[]): string {
  gitIn(["read-tree", "--empty"]);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(h.repoDir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    gitIn(["add", path]);
  }
  const tree = gitIn(["write-tree"]);
  return gitIn(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "built"]);
}

/** Whether `name` resolves (the canonical ref stays UNBORN after a refused install). */
function refExists(name: string): boolean {
  try {
    return h.git(["rev-parse", "--verify", "--quiet", name]).length > 0;
  } catch {
    return false;
  }
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

describe('scope "note" — hardened path policy (regression: crafted trees beat the old string checks)', () => {
  // Every rejection below carries a FULLY-BOUND audit event (runId + the capture
  // sha + a canonical-installing kind): on the pre-fix code the install would
  // have gone all the way through, so `.rejects` + an unmoved canonical is the
  // regression proof — not an incidental binding refusal.
  it("rejects adding .git/x.md (was accepted — .md outside sources/)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = commitAddingCraftedDir(tip, ".git");
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects .GIT/x.md (case-insensitive .git guard)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = commitAddingCraftedDir(tip, ".GIT");
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects Sources/x.md (case-insensitive sources/ guard — the vault may sit on a case-insensitive FS)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, { "Sources/x.md": "masquerading capture\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it('rejects a path with a ".." segment (notes/../evil.md)', async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = commitAddingDotDotPath(tip);
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("accepts a non-ASCII (Hebrew) filename — the -z status stream never C-quotes it (was refused)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, { "notes/פגישה.md": "# פגישה\n\nauthored in Hebrew\n" });
    const res = await h.service.integrateSourceCapture({
      captureCommit: capture,
      expectedBase: tip,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
      scope: "note",
    });
    expect(res.ok).toBe(true);
    // Canonical ADVANCED to the capture — the fix's positive half.
    expect(h.ref("refs/heads/main")).toBe(capture);
  });

  it("rejects an EMPTY change-set (a commit whose tree is identical to base — was accepted)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const noop = gitIn(["commit-tree", h.git(["rev-parse", `${tip}^{tree}`]), "-p", tip, "-m", "no-op"]);
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: noop,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, noop),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });
});

describe('scope "note" onto an UNBORN canonical (expectedBase = ZERO_OID) — whole-history checks', () => {
  it("rejects a MERGE tip whose merge smuggles a non-.md (diff-tree without -m printed nothing — was accepted)", async () => {
    h = createHarness();
    h.git(["update-ref", "-d", "refs/heads/main"]); // canonical is UNBORN
    const r1 = commitWithTree({ "notes/a.md": "# a\n" }, []);
    const r2 = commitWithTree({ "notes/b.txt": "not markdown\n" }, []);
    const mergeTip = commitWithTree({ "notes/a.md": "# a\n", "notes/b.txt": "not markdown\n" }, [r1, r2]);
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: mergeTip,
        expectedBase: ZERO_OID,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, mergeTip),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(refExists("refs/heads/main")).toBe(false);
  });

  it("rejects a multi-commit chain whose EARLIER commit adds a non-.md while the tip adds a clean .md", async () => {
    h = createHarness();
    h.git(["update-ref", "-d", "refs/heads/main"]); // canonical is UNBORN
    const root = commitWithTree({ "notes/evil.txt": "smuggled through the root commit\n" }, []);
    const tip = h.commitChild(root, { "notes/clean.md": "# clean tip\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: tip,
        expectedBase: ZERO_OID,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, tip),
        scope: "note",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(refExists("refs/heads/main")).toBe(false);
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

  it("rejects .git components (any case, any depth) — regression for the accepted `.git/x.md`", () => {
    expect(isNoteAddAllowedPath(".git/x.md")).toBe(false);
    expect(isNoteAddAllowedPath(".GIT/x.md")).toBe(false);
    expect(isNoteAddAllowedPath("notes/.git/hooks.md")).toBe(false);
  });

  it("rejects sources/ case-insensitively — regression for the accepted `Sources/x.md`", () => {
    expect(isNoteAddAllowedPath("Sources/x.md")).toBe(false);
    expect(isNoteAddAllowedPath("SOURCES/x.md")).toBe(false);
    expect(isNoteAddAllowedPath("sOuRcEs/deep/x.md")).toBe(false);
  });

  it("rejects traversal/absolute/backslash/empty segments — regression for the accepted `..` paths", () => {
    expect(isNoteAddAllowedPath("notes/../x.md")).toBe(false);
    expect(isNoteAddAllowedPath("../x.md")).toBe(false);
    expect(isNoteAddAllowedPath("notes/./x.md")).toBe(false);
    expect(isNoteAddAllowedPath("/abs/x.md")).toBe(false);
    expect(isNoteAddAllowedPath("notes\\..\\x.md")).toBe(false);
    expect(isNoteAddAllowedPath("notes//x.md")).toBe(false);
  });

  it("accepts a non-ASCII (Hebrew) filename — regression for the C-quoted refusal", () => {
    expect(isNoteAddAllowedPath("notes/פגישה.md")).toBe(true);
  });
});
