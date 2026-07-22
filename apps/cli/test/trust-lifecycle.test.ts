/**
 * `trust-lifecycle` (Task 4.8) — the trust decision core: fail-closed trust resolution,
 * transitive taint (floors, never averages, no laundering), and revocation semantics
 * (fail pre-integration / remediate post-integration). The broker-authorized promote/revoke
 * ledger advance (challenge/authorization, forged/replay refusal) is the git-surface
 * authorization surface (Task 4.9) and is not exercised here.
 */
import { describe, expect, it } from "vitest";
import { openStore } from "@atlas/sqlite-store";
import { bindEnqueueContext, productionEnqueueContext, registerJobsMigration, jobIdsInStates, readSnapshot } from "@atlas/jobs";
import { trustStateFor, isTrusted, DEFAULT_TRUST, revocationEffect, spawnRemediationRun, type TrustState } from "../src/trust/index.js";

const trusted: TrustState = { level: "trusted", suspended: false };
const authoritative: TrustState = { level: "authoritative", suspended: false };
const provisional: TrustState = { level: "provisional", suspended: false };
const untrusted: TrustState = { level: "untrusted", suspended: false };

describe("trust state (fail-closed)", () => {
  it("an unknown/unprojected source is untrusted (never throws)", () => {
    expect(trustStateFor("sha256:x", () => null)).toEqual(DEFAULT_TRUST);
    expect(isTrusted(DEFAULT_TRUST)).toBe(false);
  });
  it("only non-suspended trusted/authoritative levels are trusted for grounding", () => {
    expect(isTrusted(trusted)).toBe(true);
    expect(isTrusted(authoritative)).toBe(true);
    expect(isTrusted(provisional)).toBe(false);
    expect(isTrusted(untrusted)).toBe(false);
    expect(isTrusted({ level: "trusted", suspended: true })).toBe(false); // a suspension drops trust
  });
});

describe("revocation semantics", () => {
  it("a pre-integration run is failed at its checkpoint with reason trust-revoked", () => {
    expect(revocationEffect("planned")).toEqual({ kind: "fail", checkpoint: "planned", reason: "trust-revoked" });
    expect(revocationEffect("agent-committed")).toEqual({ kind: "fail", checkpoint: "agent-committed", reason: "trust-revoked" });
    expect(revocationEffect("review-pending")).toEqual({ kind: "fail", checkpoint: "review-pending", reason: "trust-revoked" });
  });
  it("an integrated run must be remediated (spawn a Tier-3 remediation run)", () => {
    expect(revocationEffect("integrated")).toEqual({ kind: "remediate" });
    expect(revocationEffect("reindexed")).toEqual({ kind: "remediate" });
    expect(revocationEffect("finalized")).toEqual({ kind: "remediate" });
  });

  it("spawnRemediationRun enqueues an idempotent remediation job referencing source + affected run", () => {
    const s = openStore({ path: ":memory:" });
    registerJobsMigration(s);
    s.migrate();
    let n = 0;
    bindEnqueueContext(s.db, productionEnqueueContext({ nextJobId: () => `rem-${n++}`, now: () => "2026-07-16T00:00:00.000Z" }));
    try {
      const id1 = spawnRemediationRun(s.db, "sha256:src", "run-1");
      const id2 = spawnRemediationRun(s.db, "sha256:src", "run-1"); // idempotent
      expect(id2).toBe(id1);
      expect(jobIdsInStates(s.db, ["pending"])).toHaveLength(1);
      const snap = readSnapshot(s, id1)!;
      expect(snap.workflow).toBe("trust-remediation");
      expect(snap.payload).toMatchObject({ revokedSourceHandle: "sha256:src", affectedRunId: "run-1" });
    } finally {
      s.close();
    }
  });
});
