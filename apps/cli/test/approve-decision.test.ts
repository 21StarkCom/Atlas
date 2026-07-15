/**
 * `approve-decision` (Task 4.9) — the Tier-3 approve precondition core: idempotent
 * re-approve, stale-base ⇒ refresh-required (never rebases), review-gate check, and the
 * FF-CAS approve of the exact signed commit at an unmoved base.
 */
import { describe, expect, it } from "vitest";
import { decideApprove, canReject, type ApproveInput } from "../src/workflows/approve.js";

const BASE = "b".repeat(40);
const COMMIT = "c".repeat(40);
const MOVED = "d".repeat(40);

function input(over: Partial<ApproveInput> = {}): ApproveInput {
  return { state: "review-pending", reviewPendingCommit: COMMIT, recordedBase: BASE, currentCanonical: BASE, ...over };
}

describe("approve decision (Task 4.9)", () => {
  it("approves the EXACT signed commit under FF-CAS when the base is unmoved", () => {
    expect(decideApprove(input())).toEqual({ kind: "approve", commitSha: COMMIT, expectedBase: BASE });
  });

  it("a moved base is refresh-required — approve NEVER rebases", () => {
    expect(decideApprove(input({ currentCanonical: MOVED }))).toEqual({
      kind: "refresh-required",
      recordedBase: BASE,
      currentCanonical: MOVED,
    });
  });

  it("re-approve is idempotent — an already-integrated run returns its installed sha", () => {
    // Idempotency wins even if the base has since moved (the commit is already canonical).
    expect(decideApprove(input({ integratedSha: COMMIT, currentCanonical: MOVED }))).toEqual({
      kind: "already-approved",
      canonicalSha: COMMIT,
    });
  });

  it("a run not at the review gate is not approvable", () => {
    expect(decideApprove(input({ state: "agent-committed" }))).toEqual({ kind: "not-review-pending", state: "agent-committed" });
    expect(decideApprove(input({ state: null }))).toEqual({ kind: "not-review-pending", state: null });
  });

  it("only a review-pending run may be rejected", () => {
    expect(canReject("review-pending")).toBe(true);
    expect(canReject("agent-committed")).toBe(false);
    expect(canReject("integrated")).toBe(false);
    expect(canReject(null)).toBe(false);
  });
});
