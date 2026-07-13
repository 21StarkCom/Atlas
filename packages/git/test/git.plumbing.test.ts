/**
 * `git.plumbing.test` — agent branch + worktree + commit round-trip on a fresh
 * temp fixture repo, asserting the manifest trailer parses back to an equal
 * `RunManifest` (Task 1.5 acceptance).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStringify, newRunId, type RunManifest } from "@atlas/contracts";
import { openRepo, parseManifestTrailer } from "../src/index.js";

/** Stand up a minimal one-commit git repo in a temp dir; return its path. */
async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atlas-git-plumbing-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Atlas Fixture"]);
  git(["config", "user.email", "fixtures@atlas.local"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "# fixture\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture: initial"]);
  return dir;
}

let repoDir: string;
const worktreeDirs: string[] = [];

beforeEach(async () => {
  repoDir = await makeFixtureRepo();
});

afterEach(async () => {
  for (const d of worktreeDirs.splice(0)) await rm(d, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

function sampleManifest(runId: string, base: string): RunManifest {
  return {
    schemaVersion: 1,
    runId,
    state: "agent-committed",
    createdAt: "2026-07-13T12:34:56.789Z",
    canonicalBaseCommit: base,
    targets: ["notes/alpha", "notes/beta"],
    changePlanDigest: "sha256:deadbeef",
    proposedRisk: "tier-1",
  };
}

describe("git plumbing round-trip", () => {
  it("creates an agent branch, adds a worktree, and commits with a manifest trailer", async () => {
    const repo = openRepo(repoDir);

    const base = await repo.readRef("main");
    expect(base).toMatch(/^[0-9a-f]{40}$/);

    const runId = newRunId();
    const ref = await repo.createAgentBranch(runId, "main");
    expect(ref).toBe(`refs/agent/${runId}`);
    // The new agent ref points at the same commit as the base.
    expect(await repo.readRef(ref)).toBe(base);

    const wtDir = join(repoDir, "..", `wt-${runId}`);
    worktreeDirs.push(wtDir);
    const wt = await repo.addWorktree(ref, wtDir);
    expect(wt.ref).toBe(ref);

    // Mutate the worktree, then commit with the manifest trailer.
    await writeFile(join(wt.dir, "notes.md"), "hello from the agent\n");
    const manifest = sampleManifest(runId, base!);
    const sha = await wt.commit("agent: add notes", manifest);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // The commit advanced the agent ref (not any protected branch).
    expect(await repo.readRef(ref)).toBe(sha);
    expect(await repo.readRef("main")).toBe(base); // main untouched

    // Manifest trailer parses back to an equal RunManifest.
    const parsed = await wt.readManifest();
    expect(parsed).toEqual(manifest);
    expect(canonicalStringify(parsed)).toBe(canonicalStringify(manifest));

    // And parsing the raw commit message directly agrees.
    const msg = execFileSync("git", ["show", "-s", "--format=%B", sha], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(parseManifestTrailer(msg)).toEqual(manifest);
  });

  it("round-trips a minimal manifest that omits optional fields", async () => {
    const repo = openRepo(repoDir);
    const base = await repo.readRef("main");
    const runId = newRunId();
    const ref = await repo.createAgentBranch(runId, "main");
    const wtDir = join(repoDir, "..", `wt-min-${runId}`);
    worktreeDirs.push(wtDir);
    const wt = await repo.addWorktree(ref, wtDir);

    await writeFile(join(wt.dir, "x.md"), "x\n");
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId,
      state: "planned",
      createdAt: "2026-07-13T00:00:00.000Z",
      canonicalBaseCommit: base!,
      targets: ["notes/x"],
    };
    await wt.commit("agent: minimal", manifest);
    expect(await wt.readManifest()).toEqual(manifest);
  });

  it("removeWorktree tears down the worktree", async () => {
    const repo = openRepo(repoDir);
    const runId = newRunId();
    const ref = await repo.createAgentBranch(runId, "main");
    const wtDir = join(repoDir, "..", `wt-rm-${runId}`);
    const wt = await repo.addWorktree(ref, wtDir);
    await repo.removeWorktree(wt.dir);
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(list).not.toContain(`wt-rm-${runId}`);
  });

  it("addWorktree rejects a protected ref and leaves no worktree behind", async () => {
    const repo = openRepo(repoDir);
    const wtDir = join(repoDir, "..", "wt-protected");
    worktreeDirs.push(wtDir);
    await expect(repo.addWorktree("refs/heads/main", wtDir)).rejects.toThrow(/non-agent ref/);
    // The guard fires before `git worktree add`, so nothing was registered.
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(list).not.toContain("wt-protected");
  });

  it("readRef returns null for an unknown ref", async () => {
    const repo = openRepo(repoDir);
    expect(await repo.readRef("refs/heads/does-not-exist")).toBeNull();
  });

  it("createAgentBranch rejects a non-ULID runId", async () => {
    const repo = openRepo(repoDir);
    await expect(repo.createAgentBranch("not-a-ulid", "main")).rejects.toThrow(/ULID/);
  });

  it("createAgentBranch throws when the base does not resolve", async () => {
    const repo = openRepo(repoDir);
    await expect(repo.createAgentBranch(newRunId(), "refs/heads/nope")).rejects.toThrow(/resolve/);
  });
});
