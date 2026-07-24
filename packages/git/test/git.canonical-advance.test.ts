/**
 * `git.canonical-advance.test` — the v2 in-process canonical-ref fast-forward
 * advance (ADR-0003, phase-2 in-process cutover). The retired broker no longer
 * owns the canonical ref; the agent process advances it under a FF-only CAS,
 * appending NO audit event / WORM anchor.
 *
 * Contract points locked here:
 *  - `assertCanonicalRef` accepts a fully-qualified refs/ ref outside the
 *    agent/audit/trust namespaces, rejects everything else fail-closed.
 *  - `advanceCanonicalRef` is a compare-and-swap: it moves the ref only when the
 *    current tip equals `expectedOld`, else a typed `broker.cas_failed`.
 *  - Fast-forward only: a non-ancestor `newCommit` is refused
 *    `broker.not_fast_forward`; canonical is never rewound or forked.
 *  - `expectedOld` = 40 zeros installs an unborn ref (must-not-exist).
 *  - The advance touches NO other ref — `refs/audit/*` / `refs/heads/*` are
 *    untouched (proven by the caller; here we prove the guard rejects them).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceCanonicalRef, assertCanonicalRef, CanonicalRefError, readRef } from "../src/index.js";

const ZERO = "0".repeat(40);
const CANONICAL = "refs/atlas/main";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atlas-git-canon-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Atlas Fixture"]);
  git(["config", "user.email", "fixtures@atlas.local"]);
  git(["config", "commit.gpgsign", "false"]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Write `rel`, stage-all, commit on the current branch; return the new HEAD oid. */
async function commit(rel: string, content: string, msg: string): Promise<string> {
  await writeFile(join(dir, rel), content);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}

describe("assertCanonicalRef — the guard", () => {
  const ACCEPTED = ["refs/atlas/main", "refs/heads/main", "refs/heads/canonical"];
  for (const ref of ACCEPTED) {
    it(`accepts "${ref}"`, () => {
      expect(() => assertCanonicalRef(ref)).not.toThrow();
    });
  }

  const REJECTED = [
    "refs/audit/runs",
    "refs/trust/ledger",
    "refs/agent/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    // The ENTIRE agent namespace is off-limits, not just well-formed
    // refs/agent/<ulid> — a malformed or nested agent ref must not slip past
    // the canonical guard into the reserved namespace (finding: agent-namespace
    // escape — isAgentRef accepted only the well-formed shape).
    "refs/agent/not-a-ulid",
    "refs/agent/foo/bar",
    "refs/agent/",
    "HEAD",
    "main",
    "",
    "refs/atlas/../audit/runs",
    "refs/atlas/ main",
  ];
  for (const ref of REJECTED) {
    it(`rejects "${ref}"`, () => {
      expect(() => assertCanonicalRef(ref)).toThrow(/non-canonical ref/);
    });
  }
});

describe("advanceCanonicalRef — in-process FF-advance", () => {
  it("installs an unborn canonical ref from the zero old-value", async () => {
    const c1 = await commit("a.md", "alpha\n", "seed");
    const installed = await advanceCanonicalRef(dir, CANONICAL, c1, ZERO);
    expect(installed).toBe(c1);
    expect(await readRef(dir, CANONICAL)).toBe(c1);
  });

  it("fast-forwards from the recorded old tip to a descendant", async () => {
    const c1 = await commit("a.md", "alpha\n", "seed");
    await advanceCanonicalRef(dir, CANONICAL, c1, ZERO);
    const c2 = await commit("a.md", "alpha edited\n", "edit");
    const installed = await advanceCanonicalRef(dir, CANONICAL, c2, c1);
    expect(installed).toBe(c2);
    expect(await readRef(dir, CANONICAL)).toBe(c2);
  });

  it("refuses a compare-and-swap miss (canonical moved) as broker.cas_failed", async () => {
    const c1 = await commit("a.md", "alpha\n", "seed");
    await advanceCanonicalRef(dir, CANONICAL, c1, ZERO);
    const c2 = await commit("a.md", "alpha edited\n", "edit");
    await advanceCanonicalRef(dir, CANONICAL, c2, c1);
    // A stale caller still believing canonical is at c1 must be refused.
    const c3 = await commit("a.md", "alpha again\n", "edit2");
    await expect(advanceCanonicalRef(dir, CANONICAL, c3, c1)).rejects.toMatchObject({
      code: "broker.cas_failed",
    });
    expect(await readRef(dir, CANONICAL)).toBe(c2);
  });

  it("refuses a non-fast-forward advance as broker.not_fast_forward", async () => {
    const base = await commit("a.md", "alpha\n", "seed");
    await advanceCanonicalRef(dir, CANONICAL, base, ZERO);
    // A sibling commit off the same base is not a descendant of the tip.
    git(["checkout", "-q", "-b", "side", base]);
    const sibling = await commit("b.md", "beta\n", "side commit");
    git(["checkout", "-q", "main"]);
    const forward = await commit("a.md", "alpha fwd\n", "forward");
    await advanceCanonicalRef(dir, CANONICAL, forward, base);
    await expect(advanceCanonicalRef(dir, CANONICAL, sibling, forward)).rejects.toBeInstanceOf(
      CanonicalRefError,
    );
    expect(await readRef(dir, CANONICAL)).toBe(forward);
  });

  it("translates a CAS race that lands on the atomic update-ref to broker.cas_failed (not a raw GitError)", async () => {
    // c1 → c2 → c3, all fast-forwards from c1. Two advances from the SAME recorded old
    // (c1) race concurrently: both pass the pre-read (both observe c1) and collide on
    // git's atomic old-value assertion. The loser must reject with the TYPED
    // `broker.cas_failed` — a raw GitError would abort the synthesis retry loop (which
    // rebases only on that code) instead of rebasing.
    const c1 = await commit("a.md", "one\n", "c1");
    await advanceCanonicalRef(dir, CANONICAL, c1, ZERO);
    const c2 = await commit("a.md", "two\n", "c2");
    const c3 = await commit("a.md", "three\n", "c3");

    const results = await Promise.allSettled([
      advanceCanonicalRef(dir, CANONICAL, c2, c1),
      advanceCanonicalRef(dir, CANONICAL, c3, c1),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    // Exactly one wins the CAS; the other loses.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser is the TYPED CAS refusal — never a raw GitError.
    expect(rejected[0]!.reason).toBeInstanceOf(CanonicalRefError);
    expect(rejected[0]!.reason).toMatchObject({ code: "broker.cas_failed" });
    // Canonical landed on exactly one of the two candidates (fast-forward preserved).
    expect([c2, c3]).toContain(await readRef(dir, CANONICAL));
  });

  it("rejects an unresolvable newCommit as broker.bad_commit", async () => {
    const c1 = await commit("a.md", "alpha\n", "seed");
    await advanceCanonicalRef(dir, CANONICAL, c1, ZERO);
    await expect(
      advanceCanonicalRef(dir, CANONICAL, "0".repeat(40).replace(/0$/, "1"), c1),
    ).rejects.toMatchObject({ code: "broker.bad_commit" });
  });

  it("refuses to advance an audit/trust anchor ref", async () => {
    const c1 = await commit("a.md", "alpha\n", "seed");
    await expect(advanceCanonicalRef(dir, "refs/audit/runs", c1, ZERO)).rejects.toThrow(
      /non-canonical ref/,
    );
    expect(await readRef(dir, "refs/audit/runs")).toBeNull();
  });
});
