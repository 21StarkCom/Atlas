/**
 * `sync reset` authorization gate (60-B Task 5.2) — the two exclusive modes and
 * the fail-closed drift rejection, driven against the in-process BrokerService.
 */
import { describe, it, expect, afterEach } from "vitest";
import { BrokerClient } from "@atlas/broker";
import type { AuthorizationResponse } from "@atlas/contracts";
import { CliError } from "../src/errors/envelope.js";
import { exportResetChallenge, applySyncReset, type SyncResetDeps } from "../src/sync/reset.js";
import { parseResetArgs } from "../src/commands/sync-reset.js";
import { scanBytes } from "@atlas/scan";
import { runSyncCycle } from "../src/sync/cycle.js";
import type { ScanOutcome } from "../src/sync/plan.js";
import { makeSyncHarness, noteText, SYNC_CANONICAL_REF, type SyncHarness } from "./e2e/sync-support.js";

function resetDeps(h: SyncHarness): SyncResetDeps {

  const scanNoteBytes = async (bytes: Buffer, origin: string): Promise<ScanOutcome> => {
    await Promise.resolve();
    const v = scanBytes({ bytes, context: { origin, boundary: "pre-persistence", kind: "raw" } });
    return v.clean ? { clean: true } : { clean: false, quarantineId: `q-${origin.slice(0, 12)}` };
  };
  const base = h.deps();
  return {
    store: h.store,
    repo: h.repo,
    connectIntegration: base.connectIntegration,
    connectBroker: () => BrokerClient.connect(h.socketPath),
    backup: base.backup,
    worktreesPath: base.worktreesPath,
    canonicalRef: SYNC_CANONICAL_REF,
    defaultCanonicalRef: "refs/heads/main",
    noteGlobs: ["**/*.md"],
    now: base.now,
    scanNoteBytes,
    scanGeneratedArtifact: async () => Promise.resolve(),
  };
}

/** Drive a divergence so reset has something to re-converge. */
async function diverge(h: SyncHarness): Promise<void> {
  await runSyncCycle(h.deps());
  h.writeUpstream("notes/x.md", noteText("concept-x", "X"));
  h.commitUpstream("x");
  await runSyncCycle(h.deps());
  const root = h.git(["rev-list", "--max-parents=0", h.upstreamRef]);
  h.git(["reset", "--hard", root]);
  h.writeUpstream("notes/x.md", noteText("concept-x", "X", "rewritten history"));
  h.commitUpstream("force-push rewrite");
}

describe("sync reset authorization gate (Task 5.2)", () => {
  let h: SyncHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("--export-challenge alone: exit 0, emits a challenge, mutates NOTHING", async () => {
    h = await makeSyncHarness();
    await diverge(h);
    const cursorBefore = h.cursorRow();
    const canonicalBefore = h.readRef(SYNC_CANONICAL_REF);
    const runsBefore = h.runRows().length;

    const res = await exportResetChallenge(resetDeps(h));

    expect(res.exitCode).toBe(0);
    expect(res.challenge).toBeTruthy();
    expect((res.challenge as { op: string }).op).toBe("sync reset");
    expect((res.challenge as { signingPayload?: string }).signingPayload).toBeTruthy();
    // Zero mutation.
    expect(h.cursorRow()).toEqual(cursorBefore);
    expect(h.readRef(SYNC_CANONICAL_REF)).toBe(canonicalBefore);
    expect(h.runRows().length).toBe(runsBefore);
    expect(h.quarantines.length).toBe(0);
  }, 60_000);

  it("a valid signed authorization proceeds (applied), re-baselining the cursor", async () => {
    h = await makeSyncHarness();
    await diverge(h);
    const challenge = (await exportResetChallenge(resetDeps(h))).challenge as object;
    const auth = h.signReset(JSON.stringify(challenge)) as unknown as AuthorizationResponse;

    const res = await applySyncReset(resetDeps(h), auth);

    expect(res.exitCode).toBe(0);
    expect(res.envelope.mode).toBe("applied");
    expect(res.envelope.reBaselinedTo).toBe(h.readRef(h.upstreamRef));
    expect(h.cursorRow().last_absorbed_oid).toBe(h.readRef(h.upstreamRef));
  }, 60_000);

  it("canonical-state drift is rejected before any mutation (a concurrent capture moved refs/atlas/main)", async () => {
    h = await makeSyncHarness();
    await diverge(h);
    const challenge = (await exportResetChallenge(resetDeps(h))).challenge as object;
    const auth = h.signReset(JSON.stringify(challenge)) as unknown as AuthorizationResponse;

    // A concurrent capture advances refs/atlas/main AFTER the challenge was signed:
    // absorb a fresh upstream commit via a normal cycle (moves canonical) — but the
    // divergence blocks a normal cycle, so instead simulate the move directly by
    // pointing canonical at a new child commit.
    const canonicalBefore = h.readRef(SYNC_CANONICAL_REF)!;
    const moved = h.git(["commit-tree", `${canonicalBefore}^{tree}`, "-p", canonicalBefore, "-m", "concurrent capture"]);
    h.git(["update-ref", SYNC_CANONICAL_REF, moved]);
    const cursorBefore = h.cursorRow();

    // The broker's canonical-tip check refuses the stale authorization (canonical_moved).
    let threw: unknown;
    try {
      await applySyncReset(resetDeps(h), auth);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeTruthy();
    // No cursor mutation; canonical stayed at the concurrently-moved commit (reset never ran).
    expect(h.cursorRow()).toEqual(cursorBefore);
    expect(h.readRef(SYNC_CANONICAL_REF)).toBe(moved);
  }, 60_000);
});

describe("parseResetArgs gate (Task 5.2 — two exclusive modes, --yes inert)", () => {
  it("both flags together ⇒ usage (exit 5)", () => {
    let e: unknown;
    try {
      parseResetArgs(["--export-challenge", "--authorization", "/tmp/a.json"]);
    } catch (err) {
      e = err;
    }
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(5);
  });

  it("--export-challenge alone parses to the export mode", () => {
    expect(parseResetArgs(["--export-challenge"])).toEqual({ exportChallenge: true, authorization: undefined });
  });

  it("--authorization <path> parses to the apply mode; = form too", () => {
    expect(parseResetArgs(["--authorization", "/tmp/a.json"])).toEqual({ exportChallenge: false, authorization: "/tmp/a.json" });
    expect(parseResetArgs(["--authorization=/tmp/b.json"])).toEqual({ exportChallenge: false, authorization: "/tmp/b.json" });
  });

  it("--yes is inert (never turns a no-mode invocation into an authorized one)", () => {
    // Neither flag (even with --yes) ⇒ no export, no authorization ⇒ the handler
    // maps that to action-required (exit 6). parseResetArgs just proves --yes adds nothing.
    expect(parseResetArgs(["--yes"])).toEqual({ exportChallenge: false, authorization: undefined });
  });

  it("an unknown flag ⇒ usage (exit 5)", () => {
    expect(() => parseResetArgs(["--force"])).toThrow(CliError);
  });
});
