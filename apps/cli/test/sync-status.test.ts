/**
 * `sync status` — the read-only durable-state surface (60-B Task 4.9).
 * Drives `readSyncStatus` against the real sync harness: zero-state, caught-up,
 * mixed-cycle pending, divergence (behindBy: null), and the deterministic
 * exit-3 `blocked` diagnosis. Everything beyond the cursor row is derived at
 * read time — a status read mutates nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { runSyncCycle } from "../src/sync/cycle.js";
import { readSyncStatus } from "../src/commands/sync.js";
import {
  makeSyncHarness,
  noteText,
  PLANTED_SECRET,
  type SyncHarness,
} from "./e2e/sync-support.js";

describe("readSyncStatus", () => {
  let h: SyncHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("zero-state: null cursor, cycleSeq 0, empty pending, seed timestamp, full behindBy, divergence ok", async () => {
    h = await makeSyncHarness();
    const env = await readSyncStatus(h.store, h.repo, ["**/*.md"]);
    expect(env).toEqual({
      command: "sync status",
      sourceId: "main-vault",
      upstreamRef: h.upstreamRef,
      lastAbsorbedOid: null,
      upstreamHead: h.readRef(h.upstreamRef),
      behindBy: 1, // the seed commit, counted to the empty-tree base
      lastSyncedAt: expect.stringMatching(/^2026-/),
      cycleSeq: 0,
      pendingQuarantine: [],
      divergence: { state: "ok", cursorOid: null, upstreamHead: h.readRef(h.upstreamRef) },
      blocked: null,
    });
  }, 60_000);

  it("after a cycle: behindBy 0 caught up; a mixed cycle's pending carries {path, quarantineId, firstSeenOid}", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/dirty.md", noteText("concept-dirty", "Dirty", PLANTED_SECRET));
    const head = h.commitUpstream("dirty");
    await runSyncCycle(h.deps());

    const env = await readSyncStatus(h.store, h.repo, ["**/*.md"]);
    expect(env.lastAbsorbedOid).toBe(head);
    expect(env.behindBy).toBe(0);
    expect(env.cycleSeq).toBe(2);
    expect(env.pendingQuarantine).toEqual([
      { path: "notes/dirty.md", quarantineId: expect.stringMatching(/^q-/), firstSeenOid: head },
    ]);
    expect(env.divergence).toEqual({ state: "ok", cursorOid: head, upstreamHead: head });
    expect(env.blocked).toBeNull();
  }, 60_000);

  it("divergence surfaced: behindBy null, state non-ancestral, the stuck cursor OID reported", async () => {
    h = await makeSyncHarness();
    h.writeUpstream("notes/x.md", noteText("concept-x", "X"));
    h.commitUpstream("x");
    await runSyncCycle(h.deps());
    const cursor = h.cursorRow().last_absorbed_oid!;
    const root = h.git(["rev-list", "--max-parents=0", h.upstreamRef]);
    h.git(["reset", "--hard", root]);
    h.writeUpstream("notes/x.md", noteText("concept-x", "X", "rewritten"));
    h.commitUpstream("rewrite");

    const env = await readSyncStatus(h.store, h.repo, ["**/*.md"]);
    expect(env.behindBy).toBeNull();
    expect(env.divergence).toEqual({
      state: "non-ancestral",
      cursorOid: cursor,
      upstreamHead: h.readRef(h.upstreamRef),
    });
  }, 60_000);

  it("deterministic exit-3 block surfaced via blocked{commitOid, reason}; null when clean", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream(`notes/${PLANTED_SECRET}.md`, noteText("concept-leak", "Leak"));
    const bad = h.commitUpstream("leaky filename");

    const env = await readSyncStatus(h.store, h.repo, ["**/*.md"]);
    expect(env.blocked).toEqual({ commitOid: bad, reason: expect.stringContaining("aws-access-key-id") });
    expect(env.behindBy).toBe(1); // ancestry intact — a block is NOT a divergence
  }, 60_000);
});
