/**
 * `sync-scope.test` — the `"sync"` capture scope (#60/#266): the continuous-
 * vault-sync absorb commit, a broker-signed Tier-1 integrate mirroring upstream
 * vault edits onto canonical. Unlike `"note"` (additions-only) an absorb may
 * ADD, MODIFY, DELETE, or RENAME/COPY `*.md` files outside `sources/`, status-
 * checked over the WHOLE `base..capture` range (whole reachable history when
 * canonical is unborn). The gate is fail-closed:
 *   - any status outside {A,M,D,R,C} — e.g. `T`, a note replaced by a symlink —
 *     refuses (`broker.capture_scope_violation`);
 *   - BOTH paths of a rename/copy are validated, so a rename INTO or OUT OF
 *     `sources/` refuses on whichever side lands there (and stays refused even
 *     if rename detection is off and git reports the pair as A+D);
 *   - `isSyncAllowedPath` carries the same hardened path policy as
 *     `isNoteAddAllowedPath` (`*.md` only, no `sources/`, no `.git`, no
 *     traversal/absolute/empty segment — all case-insensitive);
 *   - an EMPTY change-set is refused;
 *   - a violation ANYWHERE in a multi-commit range refuses even when the tip's
 *     own diff is clean (whole-range property).
 */
import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSyncAllowedPath } from "../src/index.js";
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
 * Commit (child of `parentSha`) applying `removes` then `writes` to the
 * parent's tree — the absorb shape: one commit mixing add/modify/delete/rename
 * (a rename is a remove + a write of the same content elsewhere).
 */
function commitMutating(
  parentSha: string,
  opts: { writes?: Record<string, string>; removes?: readonly string[] },
  msg = "sync absorb",
): string {
  h.git(["read-tree", parentSha]);
  for (const path of opts.removes ?? []) h.git(["update-index", "--force-remove", path]);
  for (const [path, content] of Object.entries(opts.writes ?? {})) {
    const abs = join(h.repoDir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    h.git(["add", path]);
  }
  const tree = h.git(["write-tree"]);
  return h.git(["commit-tree", tree, "-p", parentSha, "-m", msg]);
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

/**
 * Commit (child of `parentSha`) that TYPECHANGES `path` from a regular file to
 * a symlink (index mode 120000) — git reports it as status `T`, which no sync
 * absorb may carry: a note swapped for a symlink is not a markdown edit.
 */
function commitTypechangeToSymlink(parentSha: string, path: string, target: string): string {
  h.git(["read-tree", parentSha]);
  const blob = gitIn(["hash-object", "-w", "--stdin"], target);
  h.git(["update-index", "--add", "--cacheinfo", `120000,${blob},${path}`]);
  const tree = h.git(["write-tree"]);
  return h.git(["commit-tree", tree, "-p", parentSha, "-m", "typechange"]);
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

describe('integrateSourceCapture scope "sync"', () => {
  it("accepts a range that ADDS, MODIFIES, and DELETES *.md outside sources/ (canonical advances)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const mid = h.commitChild(tip, { "notes/a.md": "# a\n", "notes/b.md": "# b\n" }); // A, A
    const capture = commitMutating(mid, {
      writes: { "notes/a.md": "# a — upstream edit\n", "notes/c.md": "# c\n" }, // M, A
      removes: ["notes/b.md"], // D
    });
    const res = await h.service.integrateSourceCapture({
      captureCommit: capture,
      expectedBase: tip,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
      scope: "sync",
    });
    expect(res.ok).toBe(true);
    expect(h.ref("refs/heads/main")).toBe(capture);
  });

  it("accepts a RENAME of a note (both sides *.md outside sources/)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const mid = h.commitChild(tip, { "notes/old-name.md": "# stable content\n" });
    // Identical blob at a new path: reported R100 (both paths under the letter)
    // when rename detection is on, A+D otherwise — allowed either way.
    const capture = commitMutating(mid, {
      writes: { "notes/new-name.md": "# stable content\n" },
      removes: ["notes/old-name.md"],
    });
    const res = await h.service.integrateSourceCapture({
      captureCommit: capture,
      expectedBase: tip,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
      scope: "sync",
    });
    expect(res.ok).toBe(true);
    expect(h.ref("refs/heads/main")).toBe(capture);
  });

  it("rejects a RENAME INTO sources/ (the destination side of the pair is validated)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const mid = h.commitChild(tip, { "notes/escapee.md": "# same bytes\n" });
    const capture = commitMutating(mid, {
      writes: { "sources/escapee.md": "# same bytes\n" },
      removes: ["notes/escapee.md"],
    });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "sync",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects a RENAME FROM sources/ (the source side of the pair is validated)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    // Seed canonical with a captured file BEFORE the sync range, then absorb a
    // commit that lifts it out of sources/ — refused on the sources/ side.
    const seeded = h.commitChild(tip, { "sources/cap.md": "captured\n" });
    h.git(["update-ref", "refs/heads/main", seeded]);
    const capture = commitMutating(seeded, {
      writes: { "notes/cap.md": "captured\n" },
      removes: ["sources/cap.md"],
    });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: seeded,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "sync",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(seeded);
  });

  it("rejects a commit that MODIFIES sources/x.md (nothing under sources/ may be touched)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const seeded = h.commitChild(tip, { "sources/x.md": "captured v1\n" });
    h.git(["update-ref", "refs/heads/main", seeded]);
    const capture = h.commitChild(seeded, { "sources/x.md": "tampered v2\n" }); // M sources/x.md
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: seeded,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "sync",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(seeded);
  });

  it("rejects a commit touching a non-.md path", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = h.commitChild(tip, { "notes/data.txt": "not markdown\n" });
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "sync",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects a crafted .git/x.md path (git-dir poisoning via a hostile mktree)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const capture = commitAddingCraftedDir(tip, ".git");
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
        scope: "sync",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("rejects a multi-commit range whose EARLIER commit violates while the tip's own diff is clean", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const mid = h.commitChild(tip, { "notes/evil.txt": "smuggled mid-range\n" }); // violation
    const capture = h.commitChild(mid, { "notes/clean.md": "# clean tip\n" }); // clean vs its parent
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: capture,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "sync",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });

  it("integrates FROM-ROOT onto an UNBORN canonical (expectedBase = ZERO_OID), adds + modifies checked", async () => {
    h = createHarness();
    h.git(["update-ref", "-d", "refs/heads/main"]); // canonical is UNBORN
    const root = commitWithTree({ "notes/a.md": "# a v1\n" }, []);
    const capture = h.commitChild(root, { "notes/a.md": "# a v2 — modified in-range\n" }); // M mid-history
    const res = await h.service.integrateSourceCapture({
      captureCommit: capture,
      expectedBase: ZERO_OID,
      manifest: manifest(),
      auditEvent: h.boundAuditEvent(0, manifest().runId, capture),
      scope: "sync",
    });
    expect(res.ok).toBe(true);
    expect(h.ref("refs/heads/main")).toBe(capture);
  });

  it("rejects a TYPECHANGE (T — a note replaced by a symlink) fail-closed", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const seeded = h.commitChild(tip, { "notes/link.md": "a regular note\n" });
    h.git(["update-ref", "refs/heads/main", seeded]);
    const capture = commitTypechangeToSymlink(seeded, "notes/link.md", "/etc/passwd");
    const err: unknown = await h.service
      .integrateSourceCapture({
        captureCommit: capture,
        expectedBase: seeded,
        manifest: manifest(),
        auditEvent: h.signedAuditEvent(0),
        scope: "sync",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toMatchObject({ code: "broker.capture_scope_violation" });
    // `parseNameStatusZ` reports the typechange as a single-path `T` entry — the
    // status allowlist (not the path policy: it IS a *.md outside sources/) is
    // what refuses it, so the offending listing must carry the `T`.
    expect(String((err as Error).message)).toContain("T notes/link.md");
    expect(h.ref("refs/heads/main")).toBe(seeded);
  });

  it("rejects an EMPTY change-set (a commit whose tree is identical to base)", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const noop = gitIn(["commit-tree", h.git(["rev-parse", `${tip}^{tree}`]), "-p", tip, "-m", "no-op"]);
    await expect(
      h.service.integrateSourceCapture({
        captureCommit: noop,
        expectedBase: tip,
        manifest: manifest(),
        auditEvent: h.boundAuditEvent(0, manifest().runId, noop),
        scope: "sync",
      }),
    ).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.ref("refs/heads/main")).toBe(tip);
  });
});

describe("isSyncAllowedPath", () => {
  it("allows .md outside sources/ (including non-ASCII); rejects sources/** and non-.md", () => {
    expect(isSyncAllowedPath("notes/a.md")).toBe(true);
    expect(isSyncAllowedPath("deep/nested/note.md")).toBe(true);
    expect(isSyncAllowedPath("notes/פגישה.md")).toBe(true);
    expect(isSyncAllowedPath("sources/x/a.md")).toBe(false);
    expect(isSyncAllowedPath("Sources/x.md")).toBe(false);
    expect(isSyncAllowedPath("SOURCES/x.md")).toBe(false);
    expect(isSyncAllowedPath("notes/data.txt")).toBe(false);
    expect(isSyncAllowedPath("manifest.json")).toBe(false);
  });

  it("carries the hardened note-add path policy (no .git, no traversal/absolute/backslash/empty)", () => {
    expect(isSyncAllowedPath(".git/x.md")).toBe(false);
    expect(isSyncAllowedPath(".GIT/x.md")).toBe(false);
    expect(isSyncAllowedPath("notes/.git/hooks.md")).toBe(false);
    expect(isSyncAllowedPath("notes/../x.md")).toBe(false);
    expect(isSyncAllowedPath("../x.md")).toBe(false);
    expect(isSyncAllowedPath("notes/./x.md")).toBe(false);
    expect(isSyncAllowedPath("/abs/x.md")).toBe(false);
    expect(isSyncAllowedPath("notes\\..\\x.md")).toBe(false);
    expect(isSyncAllowedPath("notes//x.md")).toBe(false);
  });
});
