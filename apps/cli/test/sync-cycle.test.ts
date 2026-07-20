/**
 * `sync` cycle engine — 60-B Phase 4:
 *   - cursor read/finalize module (Task 4.2)
 *   - pending-quarantine reconcile policy (Task 4.6's pure half)
 *   - the cycle engine e2e via the in-process BrokerService on refs/atlas/main
 *     (Tasks 4.4–4.7 + the Task 4.10 refs/heads/main-untouched gate).
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, registerSyncCursorsMigration, type Store } from "@atlas/sqlite-store";
import { SecretDetectedError, scanBytes } from "@atlas/scan";
import { CliError } from "../src/errors/envelope.js";
import { seedSyncCursor } from "../src/sync/seed.js";
import {
  readCursor,
  finalizeCursor,
  serializePending,
  MalformedPendingError,
  type PendingEntry,
} from "../src/sync/cursor.js";
import { reconcilePending } from "../src/sync/pending.js";
import { runSyncCycle, computeBlocked, readSingleCursor } from "../src/sync/cycle.js";
import { dryScanners } from "../src/commands/sync.js";
import {
  makeSyncHarness,
  noteText,
  PLANTED_SECRET,
  SYNC_CANONICAL_REF,
  type SyncHarness,
} from "./e2e/sync-support.js";

function seededStore(sourceId = "main-vault"): Store {
  const store = openStore({ path: ":memory:" });
  registerSyncCursorsMigration(store);
  store.migrate();
  seedSyncCursor(store, { sourceId, upstreamRef: "refs/heads/main", now: () => "2026-07-20T00:00:00Z" });
  return store;
}

const entry = (path: string, q = "q1", oid = "b".repeat(40)): PendingEntry => ({
  path,
  quarantineId: q,
  firstSeenOid: oid,
});

describe("sync cursor module (Task 4.2)", () => {
  it("readCursor returns the seeded zero-state row", () => {
    const store = seededStore();
    try {
      const c = readCursor(store, "main-vault");
      expect(c).toEqual({
        sourceId: "main-vault",
        upstreamRef: "refs/heads/main",
        lastAbsorbedOid: null,
        lastSyncedAt: "2026-07-20T00:00:00Z",
        cycleSeq: 0,
        pendingQuarantine: [],
      });
    } finally {
      store.close();
    }
  });

  it("readCursor returns null for an un-adopted source (no row)", () => {
    const store = seededStore();
    try {
      expect(readCursor(store, "other-vault")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("finalizeCursor advances OID, bumps cycle_seq, persists the reconciled pending set, atomically", () => {
    const store = seededStore();
    try {
      const pending = [entry("s.md")];
      finalizeCursor(store.db, {
        sourceId: "main-vault",
        newOid: "a".repeat(40),
        now: "2026-07-20T01:00:00Z",
        pendingQuarantine: pending,
      });
      const c = readCursor(store, "main-vault")!;
      expect(c.lastAbsorbedOid).toBe("a".repeat(40));
      expect(c.cycleSeq).toBe(1);
      expect(c.lastSyncedAt).toBe("2026-07-20T01:00:00Z");
      expect(c.pendingQuarantine).toEqual(pending);
    } finally {
      store.close();
    }
  });

  it("finalizeCursor participates in the caller's transaction (rollback leaves the row untouched)", () => {
    const store = seededStore();
    try {
      const before = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id='main-vault'`).get();
      const tx = store.db.transaction(() => {
        finalizeCursor(store.db, {
          sourceId: "main-vault",
          newOid: "c".repeat(40),
          now: "t",
          pendingQuarantine: [],
        });
        throw new Error("boom"); // simulated late failure inside the finalize tx
      });
      expect(() => tx()).toThrow("boom");
      const after = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id='main-vault'`).get();
      expect(after).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("finalizeCursor throws for a missing row and a malformed OID", () => {
    const store = seededStore();
    try {
      expect(() =>
        finalizeCursor(store.db, { sourceId: "ghost", newOid: "a".repeat(40), now: "t", pendingQuarantine: [] }),
      ).toThrow(/no sync_cursors row/);
      expect(() =>
        finalizeCursor(store.db, { sourceId: "main-vault", newOid: "nope", now: "t", pendingQuarantine: [] }),
      ).toThrow(/not a 40-hex OID/);
    } finally {
      store.close();
    }
  });

  it("readCursor fails closed on malformed pending JSON (never silently tolerates)", () => {
    const store = seededStore();
    try {
      for (const bad of [
        `{"not":"array"}`,
        `[{"path":"x.md"}]`,
        `[{"path":"x.md","quarantineId":"q","firstSeenOid":"short"}]`,
        `[{"path":"x.md","quarantineId":"q","firstSeenOid":"${"b".repeat(40)}"},{"path":"x.md","quarantineId":"q2","firstSeenOid":"${"c".repeat(40)}"}]`,
        `not json`,
      ]) {
        store.db.prepare(`UPDATE sync_cursors SET pending_quarantine = ? WHERE source_id='main-vault'`).run(bad);
        expect(() => readCursor(store, "main-vault")).toThrow(MalformedPendingError);
      }
    } finally {
      store.close();
    }
  });

  it("serializePending is deterministic (sorted by path, byte-stable across replays)", () => {
    const a = serializePending([entry("z.md", "q2"), entry("a.md", "q1")]);
    const b = serializePending([entry("a.md", "q1"), entry("z.md", "q2")]);
    expect(a).toBe(b);
    expect(JSON.parse(a).map((e: PendingEntry) => e.path)).toEqual(["a.md", "z.md"]);
  });
});

describe("reconcilePending (sole pending-policy owner)", () => {
  it("clears corrected/archived/renamed-away paths and reports them", () => {
    const existing = [entry("a.md", "qa"), entry("b.md", "qb")];
    const r = reconcilePending(existing, { clearedPaths: ["a.md", "never-pending.md"], upsertedDirty: [] });
    expect(r.entries).toEqual([entry("b.md", "qb")]);
    expect(r.cleared).toEqual([entry("a.md", "qa")]);
  });

  it("upserts a still-dirty path preserving firstSeenOid (new quarantineId, old OID)", () => {
    const first = entry("a.md", "q-old", "1".repeat(40));
    const r = reconcilePending([first], {
      clearedPaths: [],
      upsertedDirty: [entry("a.md", "q-new", "2".repeat(40))],
    });
    expect(r.entries).toEqual([{ path: "a.md", quarantineId: "q-new", firstSeenOid: "1".repeat(40) }]);
    expect(r.cleared).toEqual([]);
  });

  it("a fresh dirty path records the sighting OID as firstSeenOid", () => {
    const r = reconcilePending([], { clearedPaths: [], upsertedDirty: [entry("new.md", "q", "3".repeat(40))] });
    expect(r.entries).toEqual([{ path: "new.md", quarantineId: "q", firstSeenOid: "3".repeat(40) }]);
  });

  it("clear-then-re-dirty in one range is a FRESH occurrence (new firstSeenOid)", () => {
    const r = reconcilePending([entry("a.md", "q-old", "1".repeat(40))], {
      clearedPaths: ["a.md"],
      upsertedDirty: [entry("a.md", "q-new", "9".repeat(40))],
    });
    expect(r.entries).toEqual([{ path: "a.md", quarantineId: "q-new", firstSeenOid: "9".repeat(40) }]);
    // The clear itself is still reported: the OLD entry did leave the set.
    expect(r.cleared).toEqual([entry("a.md", "q-old", "1".repeat(40))]);
  });

  it("untouched pending paths keep their entries; output is path-sorted; set stays keyed by path", () => {
    const existing = [entry("z.md", "qz"), entry("a.md", "qa")];
    const r = reconcilePending(existing, {
      clearedPaths: [],
      upsertedDirty: [entry("m.md", "qm", "4".repeat(40))],
    });
    expect(r.entries.map((e) => e.path)).toEqual(["a.md", "m.md", "z.md"]);
  });
});

// ── the cycle engine e2e (in-process broker, scope "sync") ───────────────────

async function expectCliError(p: Promise<unknown>, code: string): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    expect(e, `expected CliError ${code}, got ${String(e)}`).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe(code);
    return e as CliError;
  }
  throw new Error(`expected CliError ${code}, but the cycle resolved`);
}

describe("runSyncCycle — the absorb engine (Tasks 4.4–4.7, 4.10)", () => {
  let h: SyncHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("zero-state first absorb: one run, one integrate, one reconcile job, cursor→head; refs/heads/main untouched", async () => {
    h = await makeSyncHarness();
    const upstreamBefore = h.readRef(h.upstreamRef)!;
    const canonicalBefore = h.readRef(SYNC_CANONICAL_REF)!;

    const res = await runSyncCycle(h.deps());

    expect(res.exitCode).toBe(0);
    expect(res.envelope.cursorFrom).toBeNull();
    expect(res.envelope.cursorTo).toBe(upstreamBefore);
    expect(res.envelope.upstreamHead).toBe(upstreamBefore);
    expect(res.envelope.appliedOps).toBe(1); // seed.md created
    expect(res.envelope.absorbed).toEqual([
      { path: "seed.md", noteId: "concept-seed", contentId: expect.stringMatching(/^sha256:[0-9a-f]{64}:text\/markdown$/), action: "created" },
    ]);
    expect(res.envelope.truncated).toBe(false);
    expect(res.envelope.cycleSeq).toBe(1);

    // Single-run invariant: exactly one sync run, finalized.
    expect(h.runRows()).toEqual([{ run_id: expect.any(String), operation: "sync", status: "finalized" }]);
    // One integrate: canonical advanced exactly one commit past the baseline.
    const canonicalAfter = h.readRef(SYNC_CANONICAL_REF)!;
    expect(canonicalAfter).not.toBe(canonicalBefore);
    expect(h.git(["rev-list", "--count", `${canonicalBefore}..${canonicalAfter}`])).toBe("1");
    // The canonical tree mirrors upstream over the note globs.
    expect(h.git(["show", `${SYNC_CANONICAL_REF}:seed.md`])).toBe(h.git(["show", `${h.upstreamRef}:seed.md`]));
    // One reconcile job, payload = the changed note ids, key = the canonical sha.
    const jobs = h.jobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.workflow).toBe("index:reconcile");
    expect(jobs[0]!.idempotency_key).toBe(canonicalAfter);
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ noteIds: ["concept-seed"] });
    expect(res.envelope.reconcileJobId).toBe(jobs[0]!.job_id);
    // The notes projection folded.
    const note = h.store.db.prepare(`SELECT note_id, status, file_path FROM notes WHERE note_id='concept-seed'`).get() as { note_id: string; status: string; file_path: string };
    expect(note).toEqual({ note_id: "concept-seed", status: "active", file_path: "seed.md" });
    // The amended #60 gate: the upstream ref is byte-identical.
    expect(h.readRef(h.upstreamRef)).toBe(upstreamBefore);
    // Cursor row advanced in the finalize tx.
    expect(h.cursorRow()).toMatchObject({ last_absorbed_oid: upstreamBefore, cycle_seq: 1, pending_quarantine: "[]" });
  }, 60_000);

  it("behindBy==0 short-circuits: no run, no writes, exit 0", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps()); // catch up
    const runsBefore = h.runRows();
    const cursorBefore = h.cursorRow();

    const res = await runSyncCycle(h.deps());

    expect(res.exitCode).toBe(0);
    expect(res.envelope).toMatchObject({ appliedOps: 0, reconcileJobId: null, truncated: false });
    expect(res.envelope.cursorFrom).toBe(res.envelope.cursorTo);
    expect(res.envelope.cursorTo).toBe(res.envelope.upstreamHead);
    expect(res.envelope.cycleSeq).toBe(cursorBefore.cycle_seq); // unchanged
    expect(h.runRows()).toEqual(runsBefore); // no new run
    expect(h.cursorRow()).toEqual(cursorBefore); // row byte-identical
  }, 60_000);

  it("clean multi-commit cycle absorbs A/M across commits; modify-then-revert collapses to unchanged", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    // c1: new note; c2: modify seed; c3: revert seed; c4: modify the new note.
    h.writeUpstream("notes/alpha.md", noteText("concept-alpha", "Alpha", "v1"));
    h.commitUpstream("add alpha");
    h.writeUpstream("seed.md", noteText("concept-seed", "Seed", "tampered"));
    h.commitUpstream("modify seed");
    h.writeUpstream("seed.md", noteText("concept-seed", "Seed")); // byte-exact original
    h.commitUpstream("revert seed");
    h.writeUpstream("notes/alpha.md", noteText("concept-alpha", "Alpha", "v2"));
    const head = h.commitUpstream("modify alpha");

    const res = await runSyncCycle(h.deps());

    expect(res.exitCode).toBe(0);
    expect(res.envelope.cursorTo).toBe(head);
    // alpha collapses to ONE created op with the FINAL bytes; seed nets to unchanged.
    const byPath = Object.fromEntries(res.envelope.absorbed.map((a) => [a.path, a.action]));
    expect(byPath).toEqual({ "notes/alpha.md": "created", "seed.md": "unchanged" });
    expect(res.envelope.appliedOps).toBe(1);
    expect(h.git(["show", `${SYNC_CANONICAL_REF}:notes/alpha.md`])).toContain("v2");
    // O(delta): the reconcile payload names exactly the one changed note.
    const jobs = h.jobRows();
    expect(JSON.parse(jobs.at(-1)!.payload)).toEqual({ noteIds: ["concept-alpha"] });
  }, 60_000);

  it("delete → archive (never erase): row archived, file gone from canonical head, bytes recoverable from history", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/doomed.md", noteText("concept-doomed", "Doomed"));
    h.commitUpstream("add doomed");
    await runSyncCycle(h.deps());
    const canonicalWithNote = h.readRef(SYNC_CANONICAL_REF)!;

    h.rmUpstream("notes/doomed.md");
    h.commitUpstream("delete doomed");
    const res = await runSyncCycle(h.deps());

    expect(res.exitCode).toBe(0);
    expect(res.envelope.archived).toEqual([{ path: "notes/doomed.md", noteId: "concept-doomed" }]);
    expect(res.envelope.appliedOps).toBe(1);
    const row = h.store.db.prepare(`SELECT status FROM notes WHERE note_id='concept-doomed'`).get() as { status: string };
    expect(row.status).toBe("archived");
    // Gone from the canonical head tree…
    expect(() => h.git(["cat-file", "-e", `${SYNC_CANONICAL_REF}:notes/doomed.md`])).toThrow();
    // …but recoverable from canonical history (non-destructive).
    expect(h.git(["show", `${canonicalWithNote}:notes/doomed.md`])).toContain("Doomed");
    // The reconcile payload carries the archived note (chunks get dropped on drain).
    expect(JSON.parse(h.jobRows().at(-1)!.payload)).toEqual({ noteIds: ["concept-doomed"] });
  }, 60_000);

  it("pure rename: same content blob, renamed[] entry, no modified op, projection follows the path", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.mvUpstream("seed.md", "notes/seed-2026.md");
    h.commitUpstream("rename seed");

    const res = await runSyncCycle(h.deps());

    expect(res.exitCode).toBe(0);
    expect(res.envelope.renamed).toEqual([{ fromPath: "seed.md", toPath: "notes/seed-2026.md", noteId: "concept-seed" }]);
    expect(res.envelope.absorbed).toEqual([]); // pure rename: no created/modified/unchanged op
    expect(res.envelope.appliedOps).toBe(1);
    // Same blob (content-addressed reuse).
    expect(h.git(["rev-parse", `${SYNC_CANONICAL_REF}:notes/seed-2026.md`])).toBe(h.git(["rev-parse", `${h.upstreamRef}:notes/seed-2026.md`]));
    const row = h.store.db.prepare(`SELECT file_path, status FROM notes WHERE note_id='concept-seed'`).get() as { file_path: string; status: string };
    expect(row).toEqual({ file_path: "notes/seed-2026.md", status: "active" });
  }, 60_000);

  it("mixed cycle: the secret quarantines and does NOT wedge — clean absorbs, cursor→head, exit 6, firstSeenOid recorded", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/clean.md", noteText("concept-clean", "Clean"));
    h.writeUpstream("notes/dirty.md", noteText("concept-dirty", "Dirty", `token ${PLANTED_SECRET}`));
    const head = h.commitUpstream("mixed");

    const res = await runSyncCycle(h.deps());

    expect(res.exitCode).toBe(6);
    expect(res.envelope.absorbed.map((a) => a.path)).toEqual(["notes/clean.md"]);
    expect(res.envelope.quarantined).toEqual([{ path: "notes/dirty.md", quarantineId: expect.stringMatching(/^q-/) }]);
    expect(res.envelope.cursorTo).toBe(head); // cursor STILL advances (anti-wedge)
    const pending = JSON.parse(h.cursorRow().pending_quarantine) as { path: string; firstSeenOid: string }[];
    expect(pending).toEqual([{ path: "notes/dirty.md", quarantineId: expect.stringMatching(/^q-/), firstSeenOid: head }]);
    // The dirty bytes never reached canonical.
    expect(() => h.git(["cat-file", "-e", `${SYNC_CANONICAL_REF}:notes/dirty.md`])).toThrow();
    // Clean note is live.
    expect(h.git(["show", `${SYNC_CANONICAL_REF}:notes/clean.md`])).toContain("Clean");
    // Next cycle over unchanged upstream: behindBy==0 no-op (the dirty path is NOT re-attempted).
    const res2 = await runSyncCycle(h.deps());
    expect(res2.envelope.appliedOps).toBe(0);
    expect(res2.envelope.cursorFrom).toBe(res2.envelope.cursorTo);
  }, 60_000);

  it("all-quarantined cycle: one finalized empty-plan run, no integrate, cursor advanced, exit 6", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    const canonicalBefore = h.readRef(SYNC_CANONICAL_REF)!;
    h.writeUpstream("notes/bad1.md", noteText("concept-bad1", "Bad1", PLANTED_SECRET));
    h.writeUpstream("notes/bad2.md", noteText("concept-bad2", "Bad2", `x ${PLANTED_SECRET} y`));
    const head = h.commitUpstream("all dirty");

    const res = await runSyncCycle(h.deps());

    expect(res.exitCode).toBe(6);
    expect(res.envelope.appliedOps).toBe(0);
    expect(res.envelope.reconcileJobId).toBeNull();
    expect(res.envelope.quarantined).toHaveLength(2);
    expect(h.readRef(SYNC_CANONICAL_REF)).toBe(canonicalBefore); // NO ref move, no empty commit
    expect(h.cursorRow()).toMatchObject({ last_absorbed_oid: head });
    // The run is a successfully FINALIZED empty-plan run — not a failure…
    const syncRuns = h.runRows().filter((r) => r.operation === "sync");
    expect(syncRuns.at(-1)!.status).toBe("finalized");
    // …and it appended its run.planned audit event.
    const audit = h.store.db.prepare(`SELECT event_type FROM audit_events WHERE run_id = ?`).all(syncRuns.at(-1)!.run_id) as { event_type: string }[];
    expect(audit.map((a) => a.event_type)).toContain("run.planned");
    // Next cadence: no-op, no re-attempt of the same bytes.
    const res2 = await runSyncCycle(h.deps());
    expect(res2.envelope.cursorFrom).toBe(res2.envelope.cursorTo);
  }, 60_000);

  it("corrected path clears its pending entry (reported with the ORIGINAL quarantineId); still-dirty preserves firstSeenOid", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/s.md", noteText("concept-s", "S", PLANTED_SECRET));
    const firstDirty = h.commitUpstream("dirty v1");
    await runSyncCycle(h.deps());
    const entry1 = (JSON.parse(h.cursorRow().pending_quarantine) as { path: string; quarantineId: string; firstSeenOid: string }[])[0]!;
    expect(entry1.firstSeenOid).toBe(firstDirty);

    // Still-dirty re-quarantine: different dirty bytes, firstSeenOid preserved.
    h.writeUpstream("notes/s.md", noteText("concept-s", "S", `other ${PLANTED_SECRET}`));
    h.commitUpstream("dirty v2");
    const res2 = await runSyncCycle(h.deps());
    expect(res2.exitCode).toBe(6);
    const entry2 = (JSON.parse(h.cursorRow().pending_quarantine) as typeof entry1[])[0]!;
    expect(entry2.firstSeenOid).toBe(firstDirty); // preserved
    expect(entry2.quarantineId).not.toBe(entry1.quarantineId); // refreshed handle

    // Corrected: clean bytes absorb, entry removed in the SAME finalize tx.
    h.writeUpstream("notes/s.md", noteText("concept-s", "S", "clean now"));
    h.commitUpstream("corrected");
    const res3 = await runSyncCycle(h.deps());
    expect(res3.exitCode).toBe(0);
    expect(res3.envelope.absorbed.map((a) => a.path)).toEqual(["notes/s.md"]);
    expect(res3.envelope.clearedPending).toEqual([{ path: "notes/s.md", quarantineId: entry2.quarantineId }]);
    expect(JSON.parse(h.cursorRow().pending_quarantine)).toEqual([]);
  }, 60_000);

  it("halts diverged:non-ancestral on a force-push — cursor + canonical unmoved, no run, no audit append", async () => {
    h = await makeSyncHarness();
    // Absorb TWO commits so the cursor sits above the root and a reset-to-root
    // rewrite genuinely orphans it.
    h.writeUpstream("notes/extra.md", noteText("concept-extra", "Extra"));
    h.commitUpstream("extra");
    await runSyncCycle(h.deps());
    const cursorBefore = h.cursorRow();
    const canonicalBefore = h.readRef(SYNC_CANONICAL_REF);
    const runsBefore = h.runRows().length;
    const auditBefore = (h.store.db.prepare(`SELECT COUNT(*) c FROM audit_events`).get() as { c: number }).c;

    // Rewrite upstream history: reset to root and commit different content.
    const root = h.git(["rev-list", "--max-parents=0", h.upstreamRef]);
    h.git(["reset", "--hard", root]);
    h.writeUpstream("notes/extra.md", noteText("concept-extra", "Extra", "rewritten"));
    h.commitUpstream("rewritten history");

    const e = await expectCliError(runSyncCycle(h.deps()), "diverged:non-ancestral");
    expect(e.exitCode).toBe(2);
    expect(e.retryable).toBe(false);
    expect(h.cursorRow()).toEqual(cursorBefore);
    expect(h.readRef(SYNC_CANONICAL_REF)).toBe(canonicalBefore);
    expect(h.runRows().length).toBe(runsBefore);
    expect((h.store.db.prepare(`SELECT COUNT(*) c FROM audit_events`).get() as { c: number }).c).toBe(auditBefore);
  }, 60_000);

  it("halts diverged:cursor-unreachable after upstream gc prunes the cursor commit", async () => {
    h = await makeSyncHarness();
    h.writeUpstream("notes/extra.md", noteText("concept-extra", "Extra"));
    h.commitUpstream("extra");
    await runSyncCycle(h.deps());
    const root = h.git(["rev-list", "--max-parents=0", h.upstreamRef]);
    h.git(["reset", "--hard", root]);
    h.writeUpstream("notes/extra.md", noteText("concept-extra", "Extra", "post-gc"));
    h.commitUpstream("rewrite");
    // NOTE: refs/atlas/main + the audit chain keep most objects alive; prune the
    // cursor commit specifically by expiring reflogs — it is only reachable from
    // the rewritten-away upstream history.
    h.git(["reflog", "expire", "--expire=now", "--all"]);
    h.git(["gc", "--prune=now", "--quiet"]);

    const e = await expectCliError(runSyncCycle(h.deps()), "diverged:cursor-unreachable");
    expect(e.exitCode).toBe(2);
  }, 60_000);

  it("--dry-run mutates NOTHING and plans everything (incl. quarantineId:'' and planned clearedPending)", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    // A pending entry to be *planned* for clearing.
    h.writeUpstream("notes/p.md", noteText("concept-p", "P", PLANTED_SECRET));
    h.commitUpstream("dirty");
    await runSyncCycle(h.deps());
    const pendingEntry = (JSON.parse(h.cursorRow().pending_quarantine) as { quarantineId: string }[])[0]!;

    // Upstream: add + modify + delete + rename + a still-dirty path + the corrected pending path.
    h.writeUpstream("notes/new.md", noteText("concept-new", "New"));
    h.writeUpstream("notes/p.md", noteText("concept-p", "P", "clean"));
    h.rmUpstream("seed.md");
    h.writeUpstream("notes/dirty2.md", noteText("concept-dirty2", "D2", PLANTED_SECRET));
    h.commitUpstream("wave");

    const cursorBefore = h.cursorRow();
    const canonicalBefore = h.readRef(SYNC_CANONICAL_REF);
    const runsBefore = h.runRows().length;
    const jobsBefore = h.jobRows().length;
    const quarantinesBefore = h.quarantines.length;

    // Production dry-run wiring: the SAME scan engine, verdicts only — no
    // quarantine record persists (the command layer owns scanner selection).
    const res = await runSyncCycle(h.deps({ ...dryScanners() }), { dryRun: true });

    expect(res.exitCode).toBe(0);
    expect(res.envelope.appliedOps).toBe(0);
    expect(res.envelope.reconcileJobId).toBeNull();
    expect(res.envelope.cursorFrom).toBe(res.envelope.cursorTo);
    expect(res.envelope.cycleSeq).toBe(cursorBefore.cycle_seq);
    const classified = Object.fromEntries(res.envelope.absorbed.map((a) => [a.path, a.action]));
    expect(classified["notes/new.md"]).toBe("created");
    // p.md was quarantined when first seen — it never reached canonical, so its
    // corrected clean version is a CREATE, not a modify.
    expect(classified["notes/p.md"]).toBe("created");
    expect(res.envelope.archived).toEqual([{ path: "seed.md", noteId: "concept-seed" }]);
    expect(res.envelope.quarantined).toEqual([{ path: "notes/dirty2.md", quarantineId: "" }]); // sentinel: nothing persisted
    expect(res.envelope.clearedPending).toEqual([{ path: "notes/p.md", quarantineId: pendingEntry.quarantineId }]); // PLANNED only
    // NOTHING moved.
    expect(h.cursorRow()).toEqual(cursorBefore);
    expect(h.readRef(SYNC_CANONICAL_REF)).toBe(canonicalBefore);
    expect(h.runRows().length).toBe(runsBefore);
    expect(h.jobRows().length).toBe(jobsBefore);
    expect(h.quarantines.length).toBe(quarantinesBefore); // dry-run persisted no quarantine record
  }, 60_000);

  it("--max-paths stops at a commit boundary with a valid continuation; second cycle resumes to head exactly once", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    // 3 commits × 2 paths.
    const heads: string[] = [];
    for (let i = 0; i < 3; i++) {
      h.writeUpstream(`notes/a${i}.md`, noteText(`concept-a${i}`, `A${i}`));
      h.writeUpstream(`notes/b${i}.md`, noteText(`concept-b${i}`, `B${i}`));
      heads.push(h.commitUpstream(`wave ${i}`));
    }

    const res1 = await runSyncCycle(h.deps(), { maxPaths: 3 });
    // Commit 0 (2 paths) < 3 ⇒ continue; commit 1 reaches 4 ≥ 3 ⇒ stop AT commit 1 (atomic).
    expect(res1.envelope.truncated).toBe(true);
    expect(res1.envelope.cursorTo).toBe(heads[1]);
    expect(res1.envelope.absorbed).toHaveLength(4);
    expect(h.cursorRow().last_absorbed_oid).toBe(heads[1]);

    const res2 = await runSyncCycle(h.deps());
    expect(res2.envelope.truncated).toBe(false);
    expect(res2.envelope.cursorTo).toBe(heads[2]);
    expect(res2.envelope.absorbed.map((a) => a.path).sort()).toEqual(["notes/a2.md", "notes/b2.md"]);
    // Every path absorbed exactly once across the two cycles.
    for (let i = 0; i < 3; i++) {
      expect(h.git(["show", `${SYNC_CANONICAL_REF}:notes/a${i}.md`])).toContain(`A${i}`);
    }
  }, 60_000);

  it("oversize atomic commit: a single commit larger than n is processed in full", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    for (let i = 0; i < 5; i++) h.writeUpstream(`notes/big${i}.md`, noteText(`concept-big${i}`, `Big${i}`));
    const head = h.commitUpstream("one big commit");

    const res = await runSyncCycle(h.deps(), { maxPaths: 2 });
    expect(res.envelope.absorbed).toHaveLength(5); // whole commit, atomic
    expect(res.envelope.cursorTo).toBe(head);
    expect(res.envelope.truncated).toBe(false);
  }, 60_000);

  it("secret-bearing FILENAME: deterministic exit 3, cursor unadvanced, computeBlocked identifies the commit", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    const cursorBefore = h.cursorRow();
    h.writeUpstream(`notes/${PLANTED_SECRET}.md`, noteText("concept-leak", "Leak"));
    const badCommit = h.commitUpstream("leaky filename");
    h.writeUpstream("notes/after.md", noteText("concept-after", "After"));
    h.commitUpstream("clean after");

    // Deterministic: two runs, same non-attributable abort, cursor stuck.
    for (let i = 0; i < 2; i++) {
      try {
        await runSyncCycle(h.deps());
        throw new Error("expected SecretDetectedError");
      } catch (e) {
        expect(e).toBeInstanceOf(SecretDetectedError);
      }
      expect(h.cursorRow()).toEqual(cursorBefore);
    }
    // status-side diagnosis.
    const blocked = await computeBlocked(
      { repo: h.repo, noteGlobs: ["**/*.md"] },
      readSingleCursor(h.store),
      h.readRef(h.upstreamRef)!,
      (text) => {
        const v = scanBytes({ bytes: new TextEncoder().encode(text), context: { origin: "t", boundary: "generated-artifact", sink: "audit" } });
        return v.clean ? { clean: true, reason: "" } : { clean: false, reason: v.findings.map((f) => f.ruleId).join(",") };
      },
    );
    expect(blocked).toEqual({ commitOid: badCommit, reason: expect.stringContaining("aws-access-key-id") });
  }, 60_000);

  it("note-glob narrowing: an out-of-glob upstream change is excluded from absorb AND payload (rebuild parity)", async () => {
    h = await makeSyncHarness({ noteGlobs: ["notes/**/*.md"] });
    // seed.md (root) is OUTSIDE the globs — the first cycle absorbs nothing from it.
    h.writeUpstream("notes/in.md", noteText("concept-in", "In"));
    h.writeUpstream("docs/out.md", noteText("concept-out", "Out"));
    h.commitUpstream("in+out");

    const res = await runSyncCycle(h.deps());
    expect(res.envelope.absorbed.map((a) => a.path)).toEqual(["notes/in.md"]);
    expect(JSON.parse(h.jobRows().at(-1)!.payload)).toEqual({ noteIds: ["concept-in"] });
    expect(() => h.git(["cat-file", "-e", `${SYNC_CANONICAL_REF}:docs/out.md`])).toThrow();
    expect(() => h.git(["cat-file", "-e", `${SYNC_CANONICAL_REF}:seed.md`])).toThrow();
  }, 60_000);

  it("the untouched-upstream gate follows the row's upstream_ref (refs/heads/import fixture)", async () => {
    h = await makeSyncHarness({ upstreamRef: "refs/heads/import" });
    const before = h.readRef("refs/heads/import")!;
    const res = await runSyncCycle(h.deps());
    expect(res.exitCode).toBe(0);
    expect(h.readRef("refs/heads/import")).toBe(before);
    expect(h.readRef(SYNC_CANONICAL_REF)).not.toBe(before);
    expect(h.cursorRow().last_absorbed_oid).toBe(before);
  }, 60_000);

  it("unparseable in-glob upstream note fails closed (vault-error), cursor unadvanced, diagnosable", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    const cursorBefore = h.cursorRow();
    h.writeUpstream("notes/broken.md", "# no frontmatter at all\n");
    h.commitUpstream("broken note");

    const e = await expectCliError(runSyncCycle(h.deps()), "vault-error");
    expect(e.message).toContain("notes/broken.md");
    expect(h.cursorRow()).toEqual(cursorBefore);
  }, 60_000);

  it("config guard: canonical_ref == upstream_ref (or the un-adopted default) refuses config-invalid", async () => {
    h = await makeSyncHarness();
    await expectCliError(runSyncCycle(h.deps({ canonicalRef: h.upstreamRef })), "config-invalid");
    await expectCliError(runSyncCycle(h.deps({ canonicalRef: "refs/heads/main", defaultCanonicalRef: "refs/heads/main" })), "config-invalid");
  }, 60_000);
});

describe("sync crash semantics (Task 4.8 — replay from the durable intent)", () => {
  let h: SyncHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("crash between integrate and finalize: recovery replays fold + cursor + ONE enqueue from the intent — never from the (now-unchanged) diff", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/crashy.md", noteText("concept-crashy", "Crashy"));
    const head = h.commitUpstream("crashy");

    // Crash right after the broker CAS moved refs/atlas/main.
    h.failpoints = {
      afterIntegrate: () => {
        throw new Error("simulated crash after integrate");
      },
    };
    await expect(runSyncCycle(h.deps())).rejects.toThrow("simulated crash after integrate");
    h.failpoints = undefined;

    // Canonical moved but the cursor did NOT advance — the crash window.
    expect(h.git(["show", `${SYNC_CANONICAL_REF}:notes/crashy.md`])).toContain("Crashy");
    expect(h.cursorRow().last_absorbed_oid).not.toBe(head);
    const stuck = h.runRows().filter((r) => r.operation === "sync" && r.status === "integrated");
    expect(stuck).toHaveLength(1);

    // The next cycle replays the finalization intent, then short-circuits (behindBy==0).
    const res = await runSyncCycle(h.deps());
    expect(res.envelope.cursorFrom).toBe(head); // replay advanced the cursor BEFORE the new cycle
    expect(res.envelope.cursorTo).toBe(head);
    // The stuck run reached finalized; the projection folded; EXACTLY ONE reconcile job exists.
    expect(h.runRows().filter((r) => r.operation === "sync" && r.status === "finalized").length).toBeGreaterThanOrEqual(2);
    const note = h.store.db.prepare(`SELECT status FROM notes WHERE note_id='concept-crashy'`).get() as { status: string };
    expect(note.status).toBe("active");
    const reconcileJobs = h.jobRows().filter((j) => j.workflow === "index:reconcile" && JSON.parse(j.payload).noteIds.includes("concept-crashy"));
    expect(reconcileJobs).toHaveLength(1);
  }, 60_000);

  it("crash after reindexed but before finalize: same replay, no duplicate fold effects", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    h.writeUpstream("notes/late.md", noteText("concept-late", "Late"));
    const head = h.commitUpstream("late");

    h.failpoints = {
      afterReindexed: () => {
        throw new Error("simulated crash after reindexed");
      },
    };
    await expect(runSyncCycle(h.deps())).rejects.toThrow("simulated crash after reindexed");
    h.failpoints = undefined;

    const res = await runSyncCycle(h.deps());
    expect(res.envelope.cursorTo).toBe(head);
    expect(h.cursorRow().last_absorbed_oid).toBe(head);
    const jobs = h.jobRows().filter((j) => j.workflow === "index:reconcile" && JSON.parse(j.payload).noteIds.includes("concept-late"));
    expect(jobs).toHaveLength(1); // idempotent enqueue (key = canonical sha)
  }, 60_000);

  it("crash BEFORE the empty-plan finalize (all-quarantined): cursor + pending unchanged; re-run converges with no duplicate pending rows", async () => {
    h = await makeSyncHarness();
    await runSyncCycle(h.deps());
    const cursorBefore = h.cursorRow();
    h.writeUpstream("notes/dq.md", noteText("concept-dq", "DQ", PLANTED_SECRET));
    const head = h.commitUpstream("dirty quarantine");

    h.failpoints = {
      beforeFinalize: () => {
        throw new Error("simulated crash before finalize");
      },
    };
    await expect(runSyncCycle(h.deps())).rejects.toThrow("simulated crash before finalize");
    h.failpoints = undefined;

    // Nothing finalized: cursor and pending byte-identical.
    expect(h.cursorRow()).toEqual(cursorBefore);

    // Re-run: identical delta re-derived, ONE pending entry, content-addressed handle.
    const res = await runSyncCycle(h.deps());
    expect(res.exitCode).toBe(6);
    expect(h.cursorRow().last_absorbed_oid).toBe(head);
    const pending = JSON.parse(h.cursorRow().pending_quarantine) as { path: string }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.path).toBe("notes/dq.md");
  }, 60_000);
});
