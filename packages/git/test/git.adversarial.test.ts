/**
 * `git.adversarial.test` — error/attack-path coverage for the wing findings:
 *
 *  - readRef surfaces operational Git failures instead of masking them as an
 *    unknown ref (Finding: refs.ts readRef swallowed every error).
 *  - addWorktree rolls back the worktree when HEAD attachment fails, leaving no
 *    orphan behind (Finding: repo.ts partial-failure leak).
 *  - the manifest trailer codec cannot be subverted by an injected trailer in
 *    the caller message (Finding: commit.ts trailer injection).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newRunId, type RunManifest } from "@atlas/contracts";
import { GitError } from "../src/exec.js";
import {
  buildCommitMessage,
  encodeManifestTrailer,
  parseManifestTrailer,
  RUN_MANIFEST_TRAILER,
} from "../src/index.js";
import { readRef } from "../src/refs.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

function manifest(runId: string): RunManifest {
  return {
    schemaVersion: 1,
    runId,
    state: "planned",
    createdAt: "2026-07-13T00:00:00.000Z",
    canonicalBaseCommit: "0".repeat(40),
    targets: ["notes/x"],
  };
}

describe("readRef — operational failures propagate", () => {
  it("throws (does not return null) when the cwd is not a git repository", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "atlas-git-norepo-"));
    cleanups.push(notARepo);
    // A non-existent ref inside a real repo → null; but a broken repository is
    // an operational failure that must surface, not masquerade as unknown-ref.
    await expect(readRef(notARepo, "main")).rejects.toBeInstanceOf(GitError);
  });

  it("throws when the cwd does not exist at all", async () => {
    await expect(readRef(join(tmpdir(), "atlas-git-absent-xyz"), "main")).rejects.toBeTruthy();
  });
});

describe("addWorktree — rollback on attachment failure", () => {
  it("removes the registered worktree if attachHeadToAgentRef throws", async () => {
    // Mock only the attach step to fail; the real worktree add still runs, so
    // the rollback path must actually tear the worktree back down.
    vi.doMock("../src/refs.js", async () => {
      const actual = await vi.importActual<typeof import("../src/refs.js")>("../src/refs.js");
      return {
        ...actual,
        attachHeadToAgentRef: vi.fn(async () => {
          throw new Error("simulated symbolic-ref failure");
        }),
      };
    });
    const { openRepo } = await import("../src/repo.js");

    const dir = await mkdtemp(join(tmpdir(), "atlas-git-rollback-"));
    cleanups.push(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Atlas Fixture"]);
    git(["config", "user.email", "fixtures@atlas.local"]);
    git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(dir, "README.md"), "# fixture\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);

    const repo = openRepo(dir);
    const runId = newRunId();
    const ref = await repo.createAgentBranch(runId, "main");
    const wtDir = join(dir, "..", `wt-rollback-${runId}`);
    cleanups.push(wtDir);

    await expect(repo.addWorktree(ref, wtDir)).rejects.toThrow(/simulated symbolic-ref/);

    // No worktree left registered, and the directory was cleaned up.
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(list).not.toContain(`wt-rollback-${runId}`);
    expect(existsSync(wtDir)).toBe(false);
  });
});

describe("manifest trailer — injection resistance", () => {
  it("buildCommitMessage rejects a caller message carrying the reserved trailer key", () => {
    const forged = encodeManifestTrailer(manifest(newRunId())); // attacker's manifest
    const msg = `totally normal message\n\n${forged}`;
    expect(() => buildCommitMessage(msg, manifest(newRunId()))).toThrow(/reserved/);
  });

  it("rejects the key case-insensitively and mid-message", () => {
    const msg = `line one\n${RUN_MANIFEST_TRAILER.toLowerCase()}: abc\nline three`;
    expect(() => buildCommitMessage(msg, manifest(newRunId()))).toThrow();
  });

  it("parseManifestTrailer rejects a message with duplicate trailers", () => {
    const m = manifest(newRunId());
    const dup = `subject\n\n${encodeManifestTrailer(m)}\n${encodeManifestTrailer(m)}\n`;
    expect(() => parseManifestTrailer(dup)).toThrow(/expected exactly one/);
  });

  it("a legitimate build+parse still round-trips exactly one trailer", () => {
    const m = manifest(newRunId());
    const built = buildCommitMessage("agent: clean message", m);
    expect(parseManifestTrailer(built)).toEqual(m);
  });
});
