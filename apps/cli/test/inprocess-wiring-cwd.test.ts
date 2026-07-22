/**
 * `inprocess-wiring-cwd` (phase-2 in-process cutover, task 2.2, ADR-0003, finding #6) —
 * `buildCaptureDeps` must resolve the vault {@link Repo} ONCE (against `ctx.cwd`, never
 * `process.cwd`) and reuse the SAME instance for both the run's git ops
 * (`CaptureDeps.repo`) and the integration seam (`connectIntegration`). A prior defect
 * had `connectBrokerIntegration` use a ctx-resolved path while `CaptureDeps.repo` used a
 * raw RELATIVE path, so with `ctx.cwd` ≠ `process.cwd` commit creation and integration
 * targeted DIFFERENT repositories. This drives exactly that skew:
 *   - `vault.path` is RELATIVE;
 *   - `ctx.cwd` is the vault's parent;
 *   - `process.cwd()` is chdir'd somewhere ELSE for the whole test.
 * and proves (a) `CaptureDeps.repo.dir` is the ctx-resolved absolute path, and (b) the
 * integration seam advances canonical in that SAME repo.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRunId, type AuditEvent } from "@atlas/contracts";
import { buildCaptureDeps } from "../src/ingest/wiring.js";
import type { RunContext } from "../src/handlers.js";

const CANONICAL_REF = "refs/heads/main";
const FIXED_NOW = "2026-07-14T00:00:00.000Z";
const KEY_ID = "test-key-v1";

let root: string;
let originalCwd: string;
let vaultRel: string;
let vaultAbs: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
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

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "atlas-wiring-cwd-"));
  // The vault lives at a RELATIVE path under `ctx.cwd` (root).
  vaultRel = join("sub", "vault");
  vaultAbs = join(root, vaultRel);
  mkdirSync(vaultAbs, { recursive: true });
  git(vaultAbs, ["init", "-q", "-b", "main"]);
  git(vaultAbs, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(vaultAbs, "sources"), { recursive: true });
  writeFileSync(join(vaultAbs, "sources", "seed.txt"), "seed\n", "utf8");
  git(vaultAbs, ["add", "-A"]);
  git(vaultAbs, ["commit", "-q", "-m", "seed"]);

  // The external `.atlas` sink tree + a provisioned test-custody backup key.
  mkdirSync(join(root, ".atlas", "worktrees"), { recursive: true });
  mkdirSync(join(root, ".atlas", "backups"), { recursive: true });
  const custody = join(root, ".atlas", "custody");
  mkdirSync(custody, { recursive: true });
  writeFileSync(join(custody, `${KEY_ID}.key`), Buffer.from(randomBytes(32)).toString("base64"), "utf8");

  // Drive `process.cwd()` AWAY from `ctx.cwd` for the whole test — resolution must
  // depend on `ctx.cwd`, never the ambient process cwd.
  process.chdir(tmpdir());
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

/** A partial RunContext the production wiring reads, with a RELATIVE vault path. */
function runContext(): RunContext {
  const custody = join(root, ".atlas", "custody");
  return {
    cwd: root,
    env: { ...process.env, ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: custody } as NodeJS.ProcessEnv,
    config: {
      config: {
        sqlite: { path: join(".atlas", "atlas.db"), ledger_backup: { dir: join(".atlas", "backups"), key_id: KEY_ID, keep: 10 } },
        vault: { path: vaultRel },
        git: { worktrees_path: join(".atlas", "worktrees"), canonical_ref: CANONICAL_REF },
      },
    },
  } as unknown as RunContext;
}

/** Build a candidate FF child of canonical touching `sources/`, in a throwaway worktree. */
function buildCandidate(): string {
  const branch = `cand-${newRunId()}`;
  const wt = join(root, ".atlas", "worktrees", branch);
  git(vaultAbs, ["worktree", "add", "-q", "-b", branch, wt, CANONICAL_REF]);
  try {
    writeFileSync(join(wt, "sources", "captured.txt"), "captured bytes\n", "utf8");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-q", "-m", "candidate"]);
    return git(wt, ["rev-parse", "HEAD"]);
  } finally {
    git(vaultAbs, ["worktree", "remove", "--force", wt]);
    try {
      git(vaultAbs, ["branch", "-D", branch]);
    } catch {
      /* best-effort */
    }
  }
}

function unsignedEvent(runId: string, canonicalCommit: string, base: string): Omit<AuditEvent, "prevAuditHead"> {
  return { schemaVersion: 1, eventId: newRunId(), kind: "run.integrated", seq: 0, occurredAt: FIXED_NOW, runId, subjects: [], canonicalCommit, detail: { baseRef: base } };
}

describe("in-process capture wiring — relative vault path, differing process.cwd (finding #6)", () => {
  it("resolves CaptureDeps.repo against ctx.cwd (absolute), not the raw relative path or process.cwd", () => {
    const deps = buildCaptureDeps(runContext(), "ingest");
    // The Repo was opened at the CTX-resolved absolute path — never the raw "sub/vault"
    // (which would resolve against the differing process.cwd and miss the repo).
    expect(deps.repo.dir).toBe(resolve(root, vaultRel));
    expect(deps.repo.dir).not.toBe(vaultRel);
    expect(deps.canonicalRef).toBe(CANONICAL_REF);
  });

  it("the integration seam advances canonical in the SAME repo commit creation targets", async () => {
    const deps = buildCaptureDeps(runContext(), "ingest");
    const before = git(vaultAbs, ["rev-parse", CANONICAL_REF]);
    const candidate = buildCandidate();
    const integration = await deps.connectIntegration();
    try {
      const runId = newRunId();
      await integration.integrate({ runId, commitSha: candidate, canonicalRef: CANONICAL_REF, baseRef: before, event: unsignedEvent(runId, candidate, before) });
    } finally {
      integration.close();
    }
    // Canonical advanced in the ctx-resolved vault (not a phantom repo under process.cwd).
    const after = git(vaultAbs, ["rev-parse", CANONICAL_REF]);
    expect(after).toBe(candidate);
    expect(after).not.toBe(before);
    // And it is the exact repo CaptureDeps.repo points at.
    expect(deps.repo.dir).toBe(vaultAbs);
  });
});
