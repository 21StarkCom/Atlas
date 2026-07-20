/**
 * `sync reset` tree-diff reconcile (60-B Task 5.3) — the §0 re-converge tests,
 * driven against the in-process BrokerService with a real signed authorization.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { BrokerClient } from "@atlas/broker";
import type { AuthorizationResponse } from "@atlas/contracts";
import { scanBytes, SecretDetectedError } from "@atlas/scan";
import { runSyncCycle } from "../src/sync/cycle.js";
import { exportResetChallenge, applySyncReset, type SyncResetDeps } from "../src/sync/reset.js";
import { detectDivergence } from "../src/sync/diff.js";
import type { ScanOutcome } from "../src/sync/plan.js";
import { makeSyncHarness, noteText, PLANTED_SECRET, SYNC_CANONICAL_REF, type SyncHarness } from "./e2e/sync-support.js";

let quarantineSeq = 0;
function resetDeps(h: SyncHarness): SyncResetDeps {
  // The harness already bound an EnqueueContext; do NOT rebind (that would swap
  // the job-id scheme mid-test). The reset's enqueue rides the harness context.
  const scanNoteBytes = async (bytes: Buffer, origin: string): Promise<ScanOutcome> => {
    await Promise.resolve();
    const v = scanBytes({ bytes, context: { origin, boundary: "pre-persistence", kind: "raw" } });
    return v.clean ? { clean: true } : { clean: false, quarantineId: `q-reset-${quarantineSeq++}` };
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
    // REAL generated-artifact scan (#293 review): audit-ref-bound ids/paths are
    // scanned; a secret trips exit 3. Verdict-only, persists nothing.
    scanGeneratedArtifact: async (text: string, runId: string) => {
      await Promise.resolve();
      const origin = `run:${runId}→audit`;
      const v = scanBytes({ bytes: new TextEncoder().encode(text), context: { origin, boundary: "generated-artifact", sink: "audit" } });
      if (!v.clean) throw new SecretDetectedError(origin, v.findings, "generated-artifact");
    },
  };
}

async function authorizedReset(h: SyncHarness): Promise<Awaited<ReturnType<typeof applySyncReset>>> {
  const challenge = (await exportResetChallenge(resetDeps(h))).challenge as object;
  const auth = h.signReset(JSON.stringify(challenge)) as unknown as AuthorizationResponse;
  return applySyncReset(resetDeps(h), auth);
}

/** Absorb seed + noteA, then force-push upstream to a rewritten history (non-ancestral). */
async function divergeWithContent(h: SyncHarness): Promise<void> {
  await runSyncCycle(h.deps());
  h.writeUpstream("notes/keep.md", noteText("concept-keep", "Keep"));
  h.writeUpstream("notes/gone.md", noteText("concept-gone", "Gone"));
  h.commitUpstream("add keep+gone");
  await runSyncCycle(h.deps()); // canonical now has seed, keep, gone
  // Force-push: rewrite history so keep stays, gone is dropped, and a new note appears.
  const root = h.git(["rev-list", "--max-parents=0", h.upstreamRef]);
  h.git(["reset", "--hard", root]);
  h.writeUpstream("notes/keep.md", noteText("concept-keep", "Keep")); // unchanged content
  h.writeUpstream("notes/fresh.md", noteText("concept-fresh", "Fresh"));
  h.commitUpstream("rewritten: keep + fresh, gone dropped");
}

describe("sync reset — tree-diff re-converge (Task 5.3)", () => {
  let h: SyncHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("re-converges after a non-ancestral halt: canonical tree == upstream tree, gone archived, cursor re-baselined, divergence→ok", async () => {
    h = await makeSyncHarness();
    await divergeWithContent(h);
    // Precondition: a normal sync REJECT-halts on the divergence.
    const div = await detectDivergence(h.repo, h.cursorRow().last_absorbed_oid, h.readRef(h.upstreamRef)!);
    expect(div.state).toBe("non-ancestral");

    const res = await authorizedReset(h);

    expect(res.exitCode).toBe(0);
    expect(res.envelope.mode).toBe("applied");
    expect(res.envelope.historyGapAccepted).toBe(true);
    // Canonical tree now matches upstream over the note globs.
    expect(h.git(["show", `${SYNC_CANONICAL_REF}:notes/keep.md`])).toContain("Keep");
    expect(h.git(["show", `${SYNC_CANONICAL_REF}:notes/fresh.md`])).toContain("Fresh");
    // `gone` was archived (absent upstream): file gone from canonical head, row archived.
    expect(() => h.git(["cat-file", "-e", `${SYNC_CANONICAL_REF}:notes/gone.md`])).toThrow();
    expect(res.envelope.archived.map((a) => a.noteId)).toContain("concept-gone");
    expect((h.store.db.prepare(`SELECT status FROM notes WHERE note_id='concept-gone'`).get() as { status: string }).status).toBe("archived");
    // Cursor re-baselined to upstream head; divergence clears.
    const head = h.readRef(h.upstreamRef)!;
    expect(h.cursorRow().last_absorbed_oid).toBe(head);
    expect((await detectDivergence(h.repo, head, head)).state).toBe("ok");
    // A broker-signed run.integrated event recorded the reset.
    const events = h.store.db.prepare(`SELECT event_type FROM audit_events WHERE run_id IN (SELECT run_id FROM agent_runs WHERE operation='sync-reset')`).all() as { event_type: string }[];
    expect(events.map((e) => e.event_type)).toContain("run.integrated");
    // One index:reconcile job over the reconciled union (looked up by the returned id).
    expect(res.envelope.reconcileJobId).toBeTruthy();
    const job = h.jobRows().find((j) => j.job_id === res.envelope.reconcileJobId)!;
    expect(job.workflow).toBe("index:reconcile");
    // keep.md is byte-identical canonical↔upstream (tree-diff excludes it — O(delta));
    // only fresh (new) + gone (archived) are in the reconcile union.
    expect(JSON.parse(job.payload).noteIds.sort()).toEqual(["concept-fresh", "concept-gone"]);
    // The following sync is a behindBy==0 no-op.
    const after = await runSyncCycle(h.deps());
    expect(after.envelope.cursorFrom).toBe(after.envelope.cursorTo);
  }, 60_000);

  it("partial reconcile: a dirty upstream note is quarantined (exit 6), cursor still re-baselines, clean paths converge", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/a.md", noteText("concept-a", "A"));
    h.commitUpstream("a");
    await runSyncCycle(h.deps());
    // Force-push: a stays, plus a clean b and a DIRTY c.
    const root = h.git(["rev-list", "--max-parents=0", h.upstreamRef]);
    h.git(["reset", "--hard", root]);
    h.writeUpstream("notes/a.md", noteText("concept-a", "A"));
    h.writeUpstream("notes/b.md", noteText("concept-b", "B"));
    h.writeUpstream("notes/c.md", noteText("concept-c", "C", PLANTED_SECRET));
    h.commitUpstream("rewrite with a dirty note");

    const res = await authorizedReset(h);

    expect(res.exitCode).toBe(6);
    expect(res.envelope.quarantined.map((q) => q.path)).toEqual(["notes/c.md"]);
    // tree == upstream over NON-quarantined paths.
    expect(h.git(["show", `${SYNC_CANONICAL_REF}:notes/b.md`])).toContain("B");
    expect(() => h.git(["cat-file", "-e", `${SYNC_CANONICAL_REF}:notes/c.md`])).toThrow();
    // cursor still re-baselined; divergence clears; pending records the dirty path.
    const head = h.readRef(h.upstreamRef)!;
    expect(h.cursorRow().last_absorbed_oid).toBe(head);
    const pending = JSON.parse(h.cursorRow().pending_quarantine) as { path: string; firstSeenOid: string }[];
    expect(pending.map((p) => p.path)).toEqual(["notes/c.md"]);
    expect(pending[0]!.firstSeenOid).toBe(head);
  }, 60_000);

  it("history-only divergence (rewrite, identical final tree): re-baselines, no integrate, no reconcile job, no throw", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/h.md", noteText("concept-h", "H"));
    h.commitUpstream("h");
    await runSyncCycle(h.deps());
    const canonicalBefore = h.readRef(SYNC_CANONICAL_REF)!;
    // Force-push to a rewritten history whose FINAL TREE is identical (same files/bytes).
    const root = h.git(["rev-list", "--max-parents=0", h.upstreamRef]);
    h.git(["reset", "--hard", root]);
    h.writeUpstream("notes/h.md", noteText("concept-h", "H")); // identical bytes
    h.commitUpstream("rewritten but identical tree");
    // seed.md is also identical; the canonical vs upstream TREE diff over globs is empty.

    const res = await authorizedReset(h);

    expect(res.exitCode).toBe(0);
    expect(res.envelope.reconcileJobId).toBeNull(); // nothing to re-index
    expect(res.envelope.captured).toEqual([]);
    expect(res.envelope.archived).toEqual([]);
    // No canonical move (trees already matched); cursor re-baselined.
    expect(h.readRef(SYNC_CANONICAL_REF)).toBe(canonicalBefore);
    expect(h.cursorRow().last_absorbed_oid).toBe(h.readRef(h.upstreamRef));
    // The empty-plan reset finalized a run (run.planned) with no integrate.
    const rr = h.runRows().filter((r) => r.operation === "sync-reset");
    expect(rr.at(-1)!.status).toBe("finalized");
  }, 60_000);

  it("cursor CAS: a concurrent cursor advance between plan and finalize makes the reset fail-closed", async () => {
    h = await makeSyncHarness();
    await divergeWithContent(h);
    const challenge = (await exportResetChallenge(resetDeps(h))).challenge as object;
    const auth = h.signReset(JSON.stringify(challenge)) as unknown as AuthorizationResponse;

    // A concurrent sync advances cycle_seq AFTER the reset's plan read the row (the
    // scan callback fires post-row-read, pre-finalize) — the finalizeResetCursor CAS
    // must then mismatch and refuse, leaving the cursor un-re-baselined.
    const deps = resetDeps(h);
    let bumped = false;
    const inner = deps.scanNoteBytes;
    const cursorBefore = h.cursorRow();
    const racing: SyncResetDeps = {
      ...deps,
      scanNoteBytes: async (bytes, origin) => {
        if (!bumped) {
          bumped = true;
          h.store.db.prepare(`UPDATE sync_cursors SET cycle_seq = cycle_seq + 1`).run();
        }
        return inner(bytes, origin);
      },
    };
    let threw: unknown;
    try {
      await applySyncReset(racing, auth);
    } catch (e) {
      threw = e;
    }
    expect(bumped).toBe(true); // the race actually fired
    expect(threw).toBeTruthy();
    expect(String((threw as Error).message)).toMatch(/cursor CAS failed|cycle_seq/i);
    // The re-baseline did NOT happen (last_absorbed_oid unchanged from before the reset).
    expect(h.cursorRow().last_absorbed_oid).toBe(cursorBefore.last_absorbed_oid);
  }, 60_000);
});

// ── #293 review fixes: audit-ref scan + crash recovery ──

describe("sync reset — generated-artifact scan + crash recovery (#293 review)", () => {
  let h: SyncHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("a secret-bearing ARCHIVED note id (in canonical, gone upstream) makes reset refuse exit 3 — the audit-ref scan is not bypassed", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps()); // absorb seed onto refs/atlas/main; cursor caught up
    // Seed a note whose ID carries a secret DIRECTLY onto canonical (it could never
    // be absorbed normally — the cycle's id scan would block it). Upstream does NOT
    // have it, so reset's tree-diff sees it as an archive candidate; its id flows
    // into changedNoteIds → the finalization intent + manifest.targets (the signed
    // audit ref). reset MUST scan it and refuse.
    const canonical = h.readRef(SYNC_CANONICAL_REF)!;
    const leak = `---\nid: concept-${PLANTED_SECRET}\ntype: concept\nschema_version: 1\ntitle: Leak\nstatus: active\ncreated: 2026-07-20\nupdated: 2026-07-20\n---\n# Leak\n`;
    // Plumbing-only seed of a secret-id note onto canonical (off a fresh index).
    const b = execFileSync("git", ["-C", h.vaultDir, "hash-object", "-w", "--stdin"], { input: leak, encoding: "utf8" }).trim();
    h.git(["read-tree", canonical]);
    h.git(["update-index", "--add", "--cacheinfo", `100644,${b},notes/leak.md`]);
    const treeWithLeak = h.git(["write-tree"]);
    const commitWithLeak = h.git(["commit-tree", treeWithLeak, "-p", canonical, "-m", "seed secret-id note on canonical"]);
    h.git(["update-ref", SYNC_CANONICAL_REF, commitWithLeak]);

    // export (read-only) must already refuse — it runs the same plan + scan.
    let threw: unknown;
    try {
      await exportResetChallenge(resetDeps(h));
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(SecretDetectedError);
    // canonical unchanged (export mutates nothing), cursor unchanged.
    expect(h.readRef(SYNC_CANONICAL_REF)).toBe(commitWithLeak);
  }, 60_000);

  it("crash after reset integrate → recoverSyncRuns replays the sync-reset intent (cursor re-baselined, one reconcile job)", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/r.md", noteText("concept-r", "R"));
    h.commitUpstream("r");
    await runSyncCycle(h.deps());
    // Force-push divergence so reset has real work.
    const root = h.git(["rev-list", "--max-parents=0", h.upstreamRef]);
    h.git(["reset", "--hard", root]);
    h.writeUpstream("notes/r.md", noteText("concept-r", "R", "rewritten"));
    const head = h.commitUpstream("rewrite");

    const challenge = (await exportResetChallenge(resetDeps(h))).challenge as object;
    const auth = h.signReset(JSON.stringify(challenge)) as unknown as AuthorizationResponse;
    // Crash the reset right after its canonical integrate, before finalize.
    const deps = resetDeps(h);
    const crashing: SyncResetDeps = { ...deps, failpoints: { afterIntegrate: () => { throw new Error("crash post reset-integrate"); } } };
    await expect(applySyncReset(crashing, auth)).rejects.toThrow("crash post reset-integrate");
    // Canonical moved (reconciled commit installed); cursor NOT yet re-baselined.
    expect(h.cursorRow().last_absorbed_oid).not.toBe(head);
    const stuck = h.runRows().filter((r) => r.operation === "sync-reset" && (r.status === "integrated" || r.status === "reindexed"));
    expect(stuck.length).toBe(1);

    // The next cycle runs recoverSyncRuns, which replays the sync-reset intent.
    await runSyncCycle(h.deps());
    expect(h.runRows().find((r) => r.run_id === stuck[0]!.run_id)!.status).toBe("finalized");
    expect(h.cursorRow().last_absorbed_oid).toBe(head);
    expect((h.store.db.prepare(`SELECT status FROM notes WHERE note_id='concept-r'`).get() as { status: string }).status).toBe("active");
    const jobs = h.jobRows().filter((j) => j.workflow === "index:reconcile" && JSON.parse(j.payload).noteIds.includes("concept-r"));
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
