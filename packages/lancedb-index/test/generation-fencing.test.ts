/**
 * `index.generation-fencing.test` (Task 3.2 — the acceptance suite).
 *
 * Exercises the fenced, crash-safe index write path end-to-end against a REAL
 * SQLite store (`@atlas/sqlite-store`, the sole activation authority) and a REAL
 * LanceDB table. Asserts:
 *
 *   1. the generation/config fence (Task issue #39, carry-forward #1): a
 *      stale-config worker's CAS FAILS after a newer activation — in BOTH
 *      completion orders (old-then-new and new-then-old);
 *   2. the config epoch is a DURABLE, server-OWNED value consumed by CONFIG
 *      IDENTITY, not a caller-supplied integer (round-3 finding 3): activation takes
 *      a `configKey`, the store resolves + issues the epoch, an un-adopted config is
 *      rejected;
 *   3. the epoch is a durable ADOPTION LOG, not a permanent first-seen mapping
 *      (round-3 finding 4): rollback / re-adoption mints a fresh, higher epoch so an
 *      earlier config can supersede a newer one; recency (adoption order) drives the
 *      fence;
 *   4. the content-hash fence (a mid-flight content change loses);
 *   5. orphaned/mixed generations are FILTERED FROM RETRIEVAL through the real
 *      active-generation filter and later compacted by `reconcileIndex`;
 *   6. retirement + compaction cannot race activation (round-2 findings 2 & 3) AND
 *      callers that do NOT manually coordinate a mutex still serialize through the
 *      REQUIRED table-scoped lock, including a foreign (cross-process) lockfile
 *      blocking activation (round-3 finding 1);
 *   7. a crash between EVERY pipeline step converges on rerun with no duplicate
 *      chunks and no orphaned active generation — including failpoint-driven
 *      partial multi-chunk write recovery;
 *   8. a permanent embedding failure surfaces as a TYPED outcome (repairable),
 *      distinct from a retryable one — through the REAL `@atlas/models` `ModelsClient`
 *      + a minted capability (the capability-closing adapter, round-3 finding 6);
 *   9. an empty note is never activated into the §4 "zero live chunks" divergence:
 *      a never-indexed empty note is a benign `empty`, and a formerly-indexed note
 *      that loses all prose is TOMBSTONED — its fence cleared + chunks retired
 *      (round-2 finding 6 + round-3 finding 2).
 */
import { closeSync, openSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { ParsedNote, SectionTree } from "@atlas/contracts";
import { openStore, registerGenerationMigration, type Store } from "@atlas/sqlite-store";
import {
  ModelsClient,
  ProviderCallError,
  mintEgressCapability,
  type EgressCapability,
  type EmbedResult,
  type Invoker,
  type ModelCallReceipt,
} from "@atlas/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleRows,
  chunkId,
  chunkNote,
  countGenerationChunks,
  createIndexMaintenanceLock,
  embedderFromClient,
  generationId,
  indexingConfigKey,
  indexMaintenanceLockPath,
  indexNote,
  openSearchTable,
  readGenerationChunkIds,
  reconcileIndex,
  retrieveActiveChunks,
  verifyComplete,
  writeGeneration,
  type EmbedClient,
  type Embedder,
  type IndexDeps,
  type IndexHooks,
  type IndexingConfig,
  type IndexMaintenanceLock,
  type SearchTable,
} from "../src/index.js";

const DIMS = 4;
/** Old vs new indexing config: same content ⇒ DIFFERENT generationId (model differs). */
const OLD_CFG: IndexingConfig = { chunker_version: 1, embedding_model: "gemini-embedding-001", dimensions: DIMS };
const NEW_CFG: IndexingConfig = { chunker_version: 1, embedding_model: "gemini-embedding-002", dimensions: DIMS };
/** A third config used only to prove an un-adopted config is rejected by the CAS. */
const THIRD_CFG: IndexingConfig = { chunker_version: 2, embedding_model: "gemini-embedding-001", dimensions: DIMS };
/** The epochs the canonical adoption order (OLD then NEW) yields (OLD < NEW). */
const OLD_REV = 1;
const NEW_REV = 2;

/** A minimal single-preamble-chunk note (no headings ⇒ one `""`-path chunk). */
function makeNote(id: string, body: string, contentHash: string): ParsedNote {
  return {
    id,
    path: `${id}.md`,
    type: "concept",
    schemaVersion: 1,
    title: id,
    status: "active",
    created: "2026-07-12T00:00:00.000Z",
    updated: "2026-07-12T00:00:00.000Z",
    aliases: [],
    sources: [],
    declaredSensitivity: "internal",
    links: [],
    sections: { heading: "", level: 0, path: "", children: [] },
    contentHash,
    raw: body,
  };
}

/** A two-section note ⇒ TWO chunks (one per heading body), for partial-write tests. */
function makeMultiNote(id: string, contentHash: string): ParsedNote {
  const sections: SectionTree = {
    heading: "",
    level: 0,
    path: "",
    children: [
      { heading: "A", level: 1, path: "A", children: [] },
      { heading: "B", level: 1, path: "B", children: [] },
    ],
  };
  return {
    ...makeNote(id, "# A\n\nAlpha body.\n\n# B\n\nBeta body.\n", contentHash),
    sections,
  };
}

/** A title-only stub with no prose in any section ⇒ ZERO chunks. */
function makeEmptyNote(id: string, contentHash: string): ParsedNote {
  // Front matter only, no body prose, no headings → preamble empty, no sections.
  return makeNote(id, "---\ntitle: x\n---\n", contentHash);
}

/** Insert a note projection row so the CAS has a row to fence (active_generation defaults 0). */
function insertNoteRow(store: Store, note: ParsedNote): void {
  store.db
    .prepare(
      `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
       VALUES (@id, @slug, @title, @type, 1, @status, @path, @contentHash, @created, @updated)`,
    )
    .run({
      id: note.id,
      slug: note.id,
      title: note.title,
      type: note.type,
      status: note.status,
      path: note.path,
      contentHash: note.contentHash,
      created: note.created,
      updated: note.updated,
    });
}

/** A deterministic, always-succeeding embedder (N vectors of length DIMS). */
const okEmbed: Embedder = async (texts) => ({ ok: true, vectors: texts.map(() => Array(DIMS).fill(0.1)) });

/** A retryable-failure embedder (provider rate-limit). */
const retryableEmbed: Embedder = async () => ({
  ok: false,
  retryable: true,
  kind: "rate_limit",
  message: "provider rate limited the embed batch",
  retryAfterMs: 2000,
});

/** A permanent-failure embedder (provider auth — non-retryable). */
const permanentEmbed: Embedder = async () => ({
  ok: false,
  retryable: false,
  kind: "authentication",
  message: "provider rejected the credential",
});

let store: Store;
let db: lancedb.Connection;
let table: SearchTable;
let dir: string;

interface DepOpts {
  readonly embed?: Embedder;
  readonly lock?: IndexMaintenanceLock;
  readonly hooks?: IndexHooks;
}

function deps(config: IndexingConfig, opts: DepOpts = {}): IndexDeps {
  // `GenerationRepo` (store.generation) is the ActivationStore — SQLite is the sole
  // activation authority; the write path only ever calls it, never LanceDB, to fence.
  // `lockLocation` is ALWAYS supplied (never a NOOP): without an injected shared
  // lock, the write path derives the REQUIRED table-scoped cross-process lock from it
  // (round-3 finding 1).
  return {
    config,
    table,
    store: store.generation,
    embed: opts.embed ?? okEmbed,
    lockLocation: dir,
    ...(opts.lock !== undefined ? { lock: opts.lock } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
  };
}

/** Record an adoption event for `cfg` (the operator declaring the current config). */
function adopt(cfg: IndexingConfig): number {
  return store.generation.adoptConfig(indexingConfigKey(cfg));
}

/** The config identity string the CAS consumes. */
function key(cfg: IndexingConfig): string {
  return indexingConfigKey(cfg);
}

/** Flush all pending microtasks + timers so a blocked worker provably makes no progress. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  // The durable config-adoption-log migration (0008) is a feature migration —
  // register it before migrate (the generation layer's store-open step).
  registerGenerationMigration(store);
  store.migrate();
  dir = await mkdtemp(join(tmpdir(), "atlas-fence-"));
  db = await lancedb.connect(dir);
  table = await openSearchTable(db, OLD_CFG);
});

afterEach(async () => {
  store.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("durable config adoption log — SQLite owns the epoch by identity (round-3 findings 3 & 4)", () => {
  it("adoption is idempotent for the current config but mints a fresh epoch on switch/rollback", () => {
    expect(adopt(OLD_CFG)).toBe(1); // first adoption
    expect(adopt(OLD_CFG)).toBe(1); // re-adopt the CURRENT config → idempotent, no new event
    expect(adopt(NEW_CFG)).toBe(2); // switch to a newer config → new epoch
    expect(adopt(NEW_CFG)).toBe(2); // re-adopt the current → idempotent
    // ROLLBACK to OLD is a NEW adoption event with a strictly-higher epoch (recency,
    // NOT the permanent first-seen value 1) — this is what lets a rollback supersede.
    expect(adopt(OLD_CFG)).toBe(3);
    expect(adopt(NEW_CFG)).toBe(4); // re-adopting NEW again also mints a fresh epoch
    // The identity is config-derived and note-independent.
    expect(key(OLD_CFG)).not.toEqual(key(NEW_CFG));
    expect(key(OLD_CFG)).toEqual(key({ ...OLD_CFG }));
  });

  it("configRevisionFor reads the live (most-recent-adoption) epoch, 0 when never adopted", () => {
    expect(store.generation.configRevisionFor(key(OLD_CFG))).toBe(0); // never adopted
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    expect(store.generation.configRevisionFor(key(OLD_CFG))).toBe(1);
    expect(store.generation.configRevisionFor(key(NEW_CFG))).toBe(2);
    adopt(OLD_CFG); // rollback → OLD's live epoch becomes 3
    expect(store.generation.configRevisionFor(key(OLD_CFG))).toBe(3);
  });

  it("rollback: re-adopting an earlier config supersedes a newer live generation (finding 4)", () => {
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genOld = generationId(note, OLD_CFG);
    const genNew = generationId(note, NEW_CFG);
    adopt(OLD_CFG); // 1
    adopt(NEW_CFG); // 2 (current)

    // Index under NEW → live at epoch 2.
    expect(store.activateGeneration(note.id, genNew, note.contentHash, key(NEW_CFG))).toBe(true);
    expect(store.generation.fence(note.id)!.active_generation).toBe(2);
    // An OLD worker at epoch 1 cannot supersede NEW (a permanent map would leave it
    // stuck here forever).
    expect(store.activateGeneration(note.id, genOld, note.contentHash, key(OLD_CFG))).toBe(false);

    // Operator ROLLS BACK to OLD — a fresh adoption event mints epoch 3.
    expect(adopt(OLD_CFG)).toBe(3);
    // Now an OLD worker CAN supersede NEW (its live epoch 3 >= stored 2).
    expect(store.activateGeneration(note.id, genOld, note.contentHash, key(OLD_CFG))).toBe(true);
    expect(store.generation.activeGenerationId(note.id)).toBe(genOld);
    expect(store.generation.fence(note.id)!.active_generation).toBe(3);
  });

  it("indexNote resolves the fence epoch server-side by config identity (new-then-old fences correctly)", async () => {
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genNew = generationId(note, NEW_CFG);
    // Establish adoption order BEFORE any worker runs: OLD adopted first, NEW second.
    adopt(OLD_CFG);
    adopt(NEW_CFG);

    // new-then-old completion; NEITHER dep supplies a revision — the store resolves it.
    expect((await indexNote(note, deps(NEW_CFG))).kind).toBe("indexed");
    expect((await indexNote(note, deps(OLD_CFG))).kind).toBe("superseded");
    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
    expect(store.generation.fence(note.id)!.active_generation).toBe(NEW_REV);
  });
});

describe("generation/config fence — the SQLite CAS (Task issue #39, carry-forward #1)", () => {
  it("a stale-config worker's CAS FAILS after a newer activation (direct CAS, new-then-old)", () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genOld = generationId(note, OLD_CFG);
    const genNew = generationId(note, NEW_CFG);
    expect(genOld).not.toEqual(genNew); // same content, different config ⇒ different id

    // Newer config activates first.
    expect(store.activateGeneration(note.id, genNew, note.contentHash, key(NEW_CFG))).toBe(true);
    // The stale OLD-config worker, though its content_hash matches, is fenced out.
    expect(store.activateGeneration(note.id, genOld, note.contentHash, key(OLD_CFG))).toBe(false);
    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
    expect(store.generation.fence(note.id)!.active_generation).toBe(NEW_REV);
  });

  it("a newer-config worker SUPERSEDES an older activation (direct CAS, old-then-new)", () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genOld = generationId(note, OLD_CFG);
    const genNew = generationId(note, NEW_CFG);

    expect(store.activateGeneration(note.id, genOld, note.contentHash, key(OLD_CFG))).toBe(true);
    expect(store.generation.fence(note.id)!.active_generation).toBe(OLD_REV);
    expect(store.activateGeneration(note.id, genNew, note.contentHash, key(NEW_CFG))).toBe(true);
    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
    expect(store.generation.fence(note.id)!.active_generation).toBe(NEW_REV);
    // And a stale old worker arriving AFTER the supersede still fails.
    expect(store.activateGeneration(note.id, genOld, note.contentHash, key(OLD_CFG))).toBe(false);
  });

  it("content-hash fence: a mid-flight content change loses the CAS", () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const gen = generationId(note, OLD_CFG);
    // The note's live content is hash-1; a worker that embedded against a stale hash fails.
    expect(store.activateGeneration(note.id, gen, "stale-hash", key(OLD_CFG))).toBe(false);
    expect(store.generation.activeGenerationId(note.id)).toBeNull();
  });

  it("activation under an UN-ADOPTED config is rejected (the store owns the epoch, round-3 finding 3)", () => {
    adopt(OLD_CFG); // only OLD is adopted
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genThird = generationId(note, THIRD_CFG);
    // A caller cannot activate under a config with no adopted epoch (nor invent a number).
    expect(() => store.activateGeneration(note.id, genThird, note.contentHash, key(THIRD_CFG))).toThrow(
      /no adopted epoch|adoptConfig/,
    );
    expect(store.generation.activeGenerationId(note.id)).toBeNull();
  });
});

describe("indexNote end-to-end — both completion orders converge on the newer config", () => {
  it("new-then-old: the stale worker is superseded, newer generation stays live", async () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genNew = generationId(note, NEW_CFG);

    const newFirst = await indexNote(note, deps(NEW_CFG));
    expect(newFirst.kind).toBe("indexed");

    const oldSecond = await indexNote(note, deps(OLD_CFG));
    expect(oldSecond.kind).toBe("superseded");

    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
    // The live generation's chunks are complete and served.
    expect(await verifyComplete(table, genNew, chunkIdsOf(note, NEW_CFG))).toBe(true);
  });

  it("old-then-new: the newer generation supersedes and retires the old one", async () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genOld = generationId(note, OLD_CFG);
    const genNew = generationId(note, NEW_CFG);

    const oldFirst = await indexNote(note, deps(OLD_CFG));
    expect(oldFirst.kind).toBe("indexed");
    expect(store.generation.activeGenerationId(note.id)).toBe(genOld);

    const newSecond = await indexNote(note, deps(NEW_CFG));
    expect(newSecond.kind).toBe("indexed");
    if (newSecond.kind === "indexed") expect(newSecond.retiredChunks).toBeGreaterThan(0);

    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
    // The retired old generation is gone; only the live one remains.
    expect(await countGenerationChunks(table, genOld)).toBe(0);
    expect(await countGenerationChunks(table, genNew)).toBeGreaterThan(0);
  });

  it("re-running indexNote on an already-live generation is a no-op (unchanged)", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    expect((await indexNote(note, deps(OLD_CFG))).kind).toBe("indexed");
    const again = await indexNote(note, deps(OLD_CFG));
    expect(again.kind).toBe("unchanged");
  });
});

describe("orphaned/mixed generations — filtered from retrieval, later compacted", () => {
  it("a superseded generation's chunks are FILTERED FROM RETRIEVAL (real filter), then compacted", async () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genOld = generationId(note, OLD_CFG);
    const genNew = generationId(note, NEW_CFG);

    // Simulate a crash AFTER activate, BEFORE retire: write the new generation and
    // activate it, but skip retirement — leaving the old generation as an orphan.
    await indexNote(note, deps(OLD_CFG)); // genOld live
    const chunks = chunkNote(note, NEW_CFG);
    const rows = assembleRows(chunks, chunks.map(() => Array(DIMS).fill(0.2)), NEW_CFG, genNew);
    await writeGeneration(table, rows);
    expect(store.activateGeneration(note.id, genNew, note.contentHash, key(NEW_CFG))).toBe(true);
    // (no retire call — the crash point)

    // Both generations physically present…
    expect((await readGenerationChunkIds(table, genOld)).size).toBeGreaterThan(0);
    // …but the REAL retrieval filter serves ONLY the active generation's chunks:
    // the orphaned genOld chunks are invisible to queries.
    const live = await retrieveActiveChunks(table, store.generation, note.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((c) => c.generationId === genNew)).toBe(true);
    expect(live.some((c) => c.generationId === genOld)).toBe(false);

    // reconcileIndex converges the orphan away.
    await reconcileIndex({ ...deps(NEW_CFG), notes: () => [note] });
    expect(await countGenerationChunks(table, genOld)).toBe(0);
    expect(await countGenerationChunks(table, genNew)).toBeGreaterThan(0);
  });

  it("retrieveActiveChunks returns nothing for a never-indexed note", async () => {
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    expect(await retrieveActiveChunks(table, store.generation, note.id)).toEqual([]);
  });

  it("reconcileIndex compacts chunks of notes removed from the vault", async () => {
    adopt(OLD_CFG);
    const kept = makeNote("keep", "Kept body.", "hash-keep");
    const removed = makeNote("gone", "Gone body.", "hash-gone");
    insertNoteRow(store, kept);
    insertNoteRow(store, removed);
    await indexNote(kept, deps(OLD_CFG));
    await indexNote(removed, deps(OLD_CFG));
    const genGone = generationId(removed, OLD_CFG);

    // The note leaves the vault: drop its projection row (its active generation id is gone too).
    store.db.prepare(`DELETE FROM notes WHERE note_id = ?`).run(removed.id);

    // Reconcile over only the surviving note — the removed note's chunks are orphaned.
    const report = await reconcileIndex({ ...deps(OLD_CFG), notes: () => [kept] });
    expect(report.compactedChunks).toBeGreaterThan(0);
    expect(await countGenerationChunks(table, genGone)).toBe(0);
    expect(await countGenerationChunks(table, generationId(kept, OLD_CFG))).toBeGreaterThan(0);
  });
});

describe("retirement + compaction cannot race activation (round-2 findings 2 & 3)", () => {
  it("post-CAS retire: worker A paused mid-critical-section BLOCKS worker B's activation (no live-generation deletion)", async () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genOld = generationId(note, OLD_CFG);
    const genNew = generationId(note, NEW_CFG);
    const lock = createIndexMaintenanceLock();

    let aAtRetire!: () => void;
    const aReachedRetire = new Promise<void>((res) => (aAtRetire = res));
    let letAContinue!: () => void;
    const aContinue = new Promise<void>((res) => (letAContinue = res));

    // A (older config) activates genOld, then pauses INSIDE the locked section, just
    // before retire — holding the lock.
    const aPromise = indexNote(
      note,
      deps(OLD_CFG, {
        lock,
        hooks: {
          beforeRetire: async () => {
            aAtRetire();
            await aContinue;
          },
        },
      }),
    );
    await aReachedRetire;
    // A has activated genOld and holds the lock. Dispatch B (newer config); it must
    // BLOCK on the shared lock — it cannot activate genNew while A holds it.
    const bPromise = indexNote(note, deps(NEW_CFG, { lock }));
    await settle();
    expect(store.generation.activeGenerationId(note.id)).toBe(genOld); // B is blocked; A still live

    // Release A → it retires relative to the CURRENT active (genOld), never touching
    // genNew. Then B proceeds and supersedes cleanly.
    letAContinue();
    const [aOut, bOut] = await Promise.all([aPromise, bPromise]);
    expect(aOut.kind).toBe("indexed");
    expect(bOut.kind).toBe("indexed");
    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
    // The now-live generation's chunks are INTACT — A's retire did not delete them.
    expect(await verifyComplete(table, genNew, chunkIdsOf(note, NEW_CFG))).toBe(true);
    expect(await countGenerationChunks(table, genOld)).toBe(0);
  });

  it("fast-path retire: re-reads the CURRENT active under the lock (a blocked newer worker cannot be clobbered)", async () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genOld = generationId(note, OLD_CFG);
    const genNew = generationId(note, NEW_CFG);
    const lock = createIndexMaintenanceLock();

    // genOld is live + complete; leave a stray orphan (genNew written, not active).
    await indexNote(note, deps(OLD_CFG));
    const strayChunks = chunkNote(note, NEW_CFG);
    await writeGeneration(
      table,
      assembleRows(strayChunks, strayChunks.map(() => Array(DIMS).fill(0.3)), NEW_CFG, genNew),
    );

    let aAtRetire!: () => void;
    const aReachedRetire = new Promise<void>((res) => (aAtRetire = res));
    let letAContinue!: () => void;
    const aContinue = new Promise<void>((res) => (letAContinue = res));

    // A takes the FAST PATH (genOld already live+complete) and pauses before retire.
    const aPromise = indexNote(
      note,
      deps(OLD_CFG, {
        lock,
        hooks: {
          beforeRetire: async () => {
            aAtRetire();
            await aContinue;
          },
        },
      }),
    );
    await aReachedRetire;
    // A holds the lock (fast-path retire). B (a fresh NEW activation) must block.
    const bPromise = indexNote(note, deps(NEW_CFG, { lock }));
    await settle();
    expect(store.generation.activeGenerationId(note.id)).toBe(genOld);

    // Release A: its fast-path retire re-read the active under the lock (genOld) and
    // deleted the stray, leaving genOld live. Then B supersedes.
    letAContinue();
    const [aOut, bOut] = await Promise.all([aPromise, bPromise]);
    expect(aOut.kind).toBe("indexed"); // retired the stray genNew orphan
    expect(bOut.kind).toBe("indexed"); // then B activated a fresh genNew
    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
    expect(await verifyComplete(table, genNew, chunkIdsOf(note, NEW_CFG))).toBe(true);
  });

  it("compaction: a worker BLOCKS on the lock while the sweep holds it after snapshotting (finding 3)", async () => {
    adopt(OLD_CFG);
    const note1 = makeNote("n1", "One body.", "hash-1");
    const note2 = makeNote("n2", "Two body.", "hash-2");
    insertNoteRow(store, note1);
    insertNoteRow(store, note2);
    const lock = createIndexMaintenanceLock();
    const gen2 = generationId(note2, OLD_CFG);

    // note1 already indexed (its generation is in the active set the sweep snapshots).
    await indexNote(note1, deps(OLD_CFG, { lock }));

    let sweepSnapshotted!: () => void;
    const snapshotted = new Promise<void>((res) => (sweepSnapshotted = res));
    let releaseSweep!: () => void;
    const sweepContinue = new Promise<void>((res) => (releaseSweep = res));

    let bPromise: Promise<unknown> | undefined;
    // reconcile over [note1]; when compaction has snapshotted the active set (holding
    // the lock), dispatch worker B (indexNote note2) — it must block until the sweep
    // releases, so its generation can never be caught in the snapshot-then-delete gap.
    const reconcilePromise = reconcileIndex({
      ...deps(OLD_CFG, { lock }),
      notes: () => [note1],
      hooks: {
        afterCompactSnapshot: async () => {
          bPromise = indexNote(note2, deps(OLD_CFG, { lock }));
          sweepSnapshotted();
          await sweepContinue;
        },
      },
    });

    await snapshotted;
    await settle();
    // B is blocked on the lock the sweep holds — note2 is NOT yet active/written.
    expect(store.generation.activeGenerationId(note2.id)).toBeNull();
    expect(await countGenerationChunks(table, gen2)).toBe(0);

    releaseSweep();
    await reconcilePromise;
    await bPromise;
    // note1 survived the sweep; note2 indexed cleanly AFTER it (never wrongly deleted).
    expect(store.generation.activeGenerationId(note1.id)).toBe(generationId(note1, OLD_CFG));
    expect(store.generation.activeGenerationId(note2.id)).toBe(gen2);
    expect(await countGenerationChunks(table, gen2)).toBeGreaterThan(0);
  });
});

describe("the REQUIRED table-scoped lock serializes uncoordinated + cross-process callers (round-3 finding 1)", () => {
  it("two indexNote callers that share NO injected mutex still serialize + converge on the newer config", async () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genNew = generationId(note, NEW_CFG);
    const genOld = generationId(note, OLD_CFG);

    // NEITHER caller injects a lock — each derives the SAME table-scoped lock from
    // `lockLocation` (deps()), so they serialize despite never coordinating a mutex.
    const [a, b] = await Promise.all([indexNote(note, deps(NEW_CFG)), indexNote(note, deps(OLD_CFG))]);

    // Whatever the interleaving, the fence guarantees the newer config wins and the
    // index is never corrupted (no partial/mixed LIVE state). genOld may linger as an
    // ORPHAN (if OLD wrote its chunks then lost the CAS) — that is fine: retrieval
    // fences it out and compaction reclaims it later; a superseded pass never retires.
    //
    // BOTH lock orderings are legal and must be accepted — asserting one of them is a
    // flaky over-constraint (it reddens under load; see the note below):
    //   - NEW first ⇒ OLD's CAS finds a superseded config revision ⇒ `superseded`;
    //   - OLD first ⇒ OLD activates, then NEW's CAS legitimately wins ⇒ `indexed`.
    // What is INVARIANT (and is what this suite actually guards) is that the NEWER
    // config always ends up live, which the end-state assertions below pin exactly.
    expect(a.kind).toBe("indexed"); // the newer config always converges live
    expect(["indexed", "superseded"]).toContain(b.kind); // older: won-then-superseded, or lost the CAS
    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
    expect(await verifyComplete(table, genNew, chunkIdsOf(note, NEW_CFG))).toBe(true);
    // The REAL retrieval filter serves ONLY the live generation — never the orphan.
    const live = await retrieveActiveChunks(table, store.generation, note.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((c) => c.generationId === genNew)).toBe(true);
    // And a reconcile sweep compacts any genOld orphan away.
    await reconcileIndex({ ...deps(NEW_CFG), notes: () => [note] });
    expect(await countGenerationChunks(table, genOld)).toBe(0);
    expect(await countGenerationChunks(table, genNew)).toBeGreaterThan(0);
  });

  it("a foreign-held (cross-process) lockfile blocks activation until it is released", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const gen = generationId(note, OLD_CFG);

    // Simulate ANOTHER atlas process holding the table lock: create the O_EXCL
    // advisory lockfile by hand (exactly what tableMaintenanceLock's acquire does).
    const lockPath = indexMaintenanceLockPath(dir);
    const foreignFd = openSync(lockPath, "wx");

    // The worker derives the table lock from lockLocation and must BLOCK on the
    // foreign lockfile at the write→activate critical section (embed runs first,
    // outside the lock).
    const p = indexNote(note, deps(OLD_CFG));
    await settle();
    await settle();
    expect(store.generation.activeGenerationId(note.id)).toBeNull(); // blocked — not activated

    // The "other process" releases; our worker acquires and converges.
    closeSync(foreignFd);
    rmSync(lockPath, { force: true });
    const out = await p;
    expect(out.kind).toBe("indexed");
    expect(store.generation.activeGenerationId(note.id)).toBe(gen);
  });
});

describe("crash-safety — a crash between EVERY pipeline step converges on rerun", () => {
  it("crash between chunk and embed → rerun embeds/writes/activates", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    // (nothing persisted before the crash) — a fresh rerun converges.
    const out = await indexNote(note, deps(OLD_CFG));
    expect(out.kind).toBe("indexed");
    expect(store.generation.activeGenerationId(note.id)).toBe(generationId(note, OLD_CFG));
  });

  it("crash after embed, before write (failpoint) → nothing persisted; rerun writes and activates", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const gen = generationId(note, OLD_CFG);
    // Failpoint: throw right after embed, before the write. Distinct persisted state
    // from the post-write crash below: here NOTHING is in LanceDB yet.
    await expect(
      indexNote(note, deps(OLD_CFG, { hooks: { afterEmbed: () => { throw new Error("crash after embed"); } } })),
    ).rejects.toThrow("crash after embed");
    expect(await countGenerationChunks(table, gen)).toBe(0); // no rows written
    expect(store.generation.activeGenerationId(note.id)).toBeNull();

    const out = await indexNote(note, deps(OLD_CFG));
    expect(out.kind).toBe("indexed");
    expect(await verifyComplete(table, gen, chunkIdsOf(note, OLD_CFG))).toBe(true);
  });

  it("crash after write, before activate (failpoint) → chunks present but NOT active; rerun activates (idempotent, no dups)", async () => {
    adopt(OLD_CFG);
    const note = makeMultiNote("n1", "hash-1"); // multi-chunk: a real durable boundary
    insertNoteRow(store, note);
    const gen = generationId(note, OLD_CFG);
    const expected = chunkIdsOf(note, OLD_CFG);
    expect(expected.length).toBe(2);

    // Failpoint: throw right after the write, before verify/activate. Distinct
    // persisted state from the pre-write crash: chunks ARE in LanceDB, not active.
    await expect(
      indexNote(note, deps(OLD_CFG, { hooks: { afterWrite: () => { throw new Error("crash after write"); } } })),
    ).rejects.toThrow("crash after write");
    expect(await countGenerationChunks(table, gen)).toBe(2); // chunks durably written
    expect(store.generation.activeGenerationId(note.id)).toBeNull(); // but not activated

    const out = await indexNote(note, deps(OLD_CFG));
    expect(out.kind).toBe("indexed");
    expect(store.generation.activeGenerationId(note.id)).toBe(gen);
    // The idempotent re-write left EXACTLY the expected set — no duplicates.
    expect(await countGenerationChunks(table, gen)).toBe(2);
  });

  it("partial multi-chunk write (only some chunks landed) → verify-complete fails; rerun fills the gap and activates", async () => {
    adopt(OLD_CFG);
    const note = makeMultiNote("n1", "hash-1");
    insertNoteRow(store, note);
    const gen = generationId(note, OLD_CFG);
    const chunks = chunkNote(note, OLD_CFG);
    expect(chunks.length).toBe(2);
    const rows = assembleRows(chunks, chunks.map(() => Array(DIMS).fill(0.1)), OLD_CFG, gen);

    // Simulate a short batched write: only the FIRST chunk landed before the crash.
    await writeGeneration(table, [rows[0]!]);
    expect(await verifyComplete(table, gen, chunkIdsOf(note, OLD_CFG))).toBe(false); // gate holds
    expect(store.generation.activeGenerationId(note.id)).toBeNull(); // never activated partial

    // Rerun converges: re-writes only the missing chunk (idempotent), verifies, activates.
    const out = await indexNote(note, deps(OLD_CFG));
    expect(out.kind).toBe("indexed");
    expect(await countGenerationChunks(table, gen)).toBe(2);
    expect(store.generation.activeGenerationId(note.id)).toBe(gen);
  });

  it("crash after write, before activate (manual) → rerun sees chunks present and activates", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const gen = generationId(note, OLD_CFG);
    const chunks = chunkNote(note, OLD_CFG);
    await writeGeneration(table, assembleRows(chunks, chunks.map(() => Array(DIMS).fill(0.1)), OLD_CFG, gen));
    expect(store.generation.activeGenerationId(note.id)).toBeNull(); // not yet activated

    const out = await indexNote(note, deps(OLD_CFG));
    expect(out.kind).toBe("indexed");
    expect(store.generation.activeGenerationId(note.id)).toBe(gen);
    expect(await countGenerationChunks(table, gen)).toBe(chunks.length);
  });

  it("crash after activate, before retire → rerun retires the superseded generation (no orphaned active)", async () => {
    adopt(OLD_CFG);
    adopt(NEW_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const genOld = generationId(note, OLD_CFG);
    const genNew = generationId(note, NEW_CFG);
    await indexNote(note, deps(OLD_CFG)); // genOld live + retired (clean)

    // Now write+activate genNew but crash before retire (orphaned genOld left behind).
    const chunks = chunkNote(note, NEW_CFG);
    await writeGeneration(table, assembleRows(chunks, chunks.map(() => Array(DIMS).fill(0.2)), NEW_CFG, genNew));
    expect(store.activateGeneration(note.id, genNew, note.contentHash, key(NEW_CFG))).toBe(true);
    expect(await countGenerationChunks(table, genOld)).toBeGreaterThan(0); // orphan present

    // Rerun indexNote: the target generation is already live+complete, so the fast
    // path retires the stray superseded generation and converges.
    const out = await indexNote(note, deps(NEW_CFG));
    expect(out.kind).toBe("indexed"); // retired a stray generation
    expect(await countGenerationChunks(table, genOld)).toBe(0);
    expect(store.generation.activeGenerationId(note.id)).toBe(genNew);
  });

  it("crash after retire, before mark → rerun re-derives `unchanged` (marker IS the fence state)", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    await indexNote(note, deps(OLD_CFG));
    const out = await indexNote(note, deps(OLD_CFG));
    expect(out.kind).toBe("unchanged");
  });

  it("crash after LanceDB was lost entirely → rerun re-embeds and re-writes the active generation", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const gen = generationId(note, OLD_CFG);
    await indexNote(note, deps(OLD_CFG));
    expect(await countGenerationChunks(table, gen)).toBeGreaterThan(0);

    // Simulate a lost LanceDB dir: drop and recreate the table (SQLite still says active).
    await db.dropTable("search_chunks");
    table = await openSearchTable(db, OLD_CFG);
    expect(await countGenerationChunks(table, gen)).toBe(0);
    expect(store.generation.activeGenerationId(note.id)).toBe(gen); // SQLite still fenced

    // Rerun: active-but-incomplete ⇒ re-embed + re-write + idempotent re-activate.
    const out = await indexNote(note, deps(OLD_CFG));
    expect(out.kind).toBe("indexed");
    expect(await verifyComplete(table, gen, chunkIdsOf(note, OLD_CFG))).toBe(true);
  });
});

describe("empty-note policy — never activated into a divergent state (round-2 finding 6 + round-3 finding 2)", () => {
  it("a never-indexed zero-chunk note is a benign `empty` terminal (no chunks, no fence, retiredChunks 0)", async () => {
    adopt(OLD_CFG);
    const note = makeEmptyNote("n1", "hash-empty");
    insertNoteRow(store, note);
    expect(chunkNote(note, OLD_CFG).length).toBe(0); // precondition: genuinely zero chunks

    const out = await indexNote(note, deps(OLD_CFG));
    expect(out.kind).toBe("empty");
    if (out.kind === "empty") expect(out.retiredChunks).toBe(0);
    // Not activated ⇒ never the §4 "active generation with zero live chunks" divergence.
    expect(store.generation.activeGenerationId(note.id)).toBeNull();
    expect(await countGenerationChunks(table, generationId(note, OLD_CFG))).toBe(0);
    // Idempotent: a rerun re-derives `empty`.
    expect((await indexNote(note, deps(OLD_CFG))).kind).toBe("empty");
    // reconcile tolerates it — no compaction fallout, no active generation.
    const report = await reconcileIndex({ ...deps(OLD_CFG), notes: () => [note] });
    expect(report.outcomes[0]!.kind).toBe("empty");
  });

  it("nonempty-to-empty: a formerly-indexed note that loses all prose is TOMBSTONED + retired (finding 2)", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const gen = generationId(note, OLD_CFG);
    // Index it while it still has prose.
    expect((await indexNote(note, deps(OLD_CFG))).kind).toBe("indexed");
    expect(store.generation.activeGenerationId(note.id)).toBe(gen);
    expect(await countGenerationChunks(table, gen)).toBeGreaterThan(0);
    expect((await retrieveActiveChunks(table, store.generation, note.id)).length).toBeGreaterThan(0);

    // The note loses ALL prose → new (empty) content. The projection content_hash
    // updates to the empty note's hash (as `db rebuild` would before reconcile).
    const emptied = makeEmptyNote("n1", "hash-empty");
    expect(chunkNote(emptied, OLD_CFG).length).toBe(0);
    store.db.prepare(`UPDATE notes SET content_hash = ? WHERE note_id = ?`).run(emptied.contentHash, "n1");

    const out = await indexNote(emptied, deps(OLD_CFG));
    expect(out.kind).toBe("empty");
    if (out.kind === "empty") expect(out.retiredChunks).toBeGreaterThan(0); // prior chunks retired
    // The fence is CLEARED — retrieval no longer serves the stale content, and the
    // old chunks are gone (not preserved through compaction).
    expect(store.generation.activeGenerationId(note.id)).toBeNull();
    expect(await retrieveActiveChunks(table, store.generation, note.id)).toEqual([]);
    expect(await countGenerationChunks(table, gen)).toBe(0);

    // Idempotent: a rerun is a benign `empty` with nothing left to retire.
    const again = await indexNote(emptied, deps(OLD_CFG));
    expect(again.kind).toBe("empty");
    if (again.kind === "empty") expect(again.retiredChunks).toBe(0);
  });
});

describe("permanent embedding failure — a typed, repairable outcome", () => {
  it("a permanent provider error surfaces as embedding-failed (non-retryable), no activation", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const out = await indexNote(note, deps(OLD_CFG, { embed: permanentEmbed }));
    expect(out.kind).toBe("embedding-failed");
    if (out.kind === "embedding-failed") {
      expect(out.code).toBe("embedding-failed");
      expect(out.retryable).toBe(false);
      expect(out.providerKind).toBe("authentication");
    }
    // No chunks written, no activation — the note is left for `index repair`.
    expect(store.generation.activeGenerationId(note.id)).toBeNull();
    expect(await countGenerationChunks(table, generationId(note, OLD_CFG))).toBe(0);
  });

  it("a retryable provider error surfaces as embedding-retryable and carries retryAfterMs", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const out = await indexNote(note, deps(OLD_CFG, { embed: retryableEmbed }));
    expect(out.kind).toBe("embedding-failed");
    if (out.kind === "embedding-failed") {
      expect(out.code).toBe("embedding-retryable");
      expect(out.retryable).toBe(true);
      expect(out.retryAfterMs).toBe(2000);
    }
    expect(store.generation.activeGenerationId(note.id)).toBeNull();

    // A later repair with a working embedder converges the note.
    const repaired = await indexNote(note, deps(OLD_CFG));
    expect(repaired.kind).toBe("indexed");
    expect(store.generation.activeGenerationId(note.id)).toBe(generationId(note, OLD_CFG));
  });
});

describe("the capability-closing embedder adapter drives a REAL ModelsClient (round-3 finding 6)", () => {
  const RUN_ID = "01J9Z8Q0000000000000000000";

  /** A real minted, run-bound egress capability (D19) — the SECOND arg the real API requires. */
  function capability(): EgressCapability {
    return mintEgressCapability(
      { runId: RUN_ID },
      {
        operation: "embed",
        model: OLD_CFG.embedding_model,
        maxBytes: 1_000_000,
        maxTokens: 1_000_000,
        costCeiling: 1_000_000,
        allowedSensitivity: "internal",
      },
      { secret: "test-mint-secret" },
    );
  }

  /** A minimal receipt (the client just hands it to the sink; it is not re-validated). */
  const receipt = {} as unknown as ModelCallReceipt;

  /** Build a REAL ModelsClient over a fake transport `Invoker` (no socket/broker). */
  function realClient(invoker: Invoker): ModelsClient {
    return new ModelsClient(invoker, async () => {});
  }

  it("threads the capability into ModelsClient.embed(request, capability, options) and returns vectors", async () => {
    let seenCap: EgressCapability | undefined;
    const invoker: Invoker = async (params) => {
      seenCap = params.capability;
      const result: EmbedResult = {
        vectors: [Array(DIMS).fill(0.5), Array(DIMS).fill(0.5)],
        dimensions: DIMS,
        usage: { inputTokens: 2 },
        model: OLD_CFG.embedding_model,
      };
      return { ok: true, result, receipt };
    };
    const cap = capability();
    const embed = embedderFromClient(realClient(invoker), cap, OLD_CFG);
    const out = await embed(["alpha", "beta"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.vectors.length).toBe(2);
    // The adapter closed over the capability and passed it through to the real embed.
    expect(seenCap).toBeDefined();
    expect(seenCap!.claims.operation).toBe("embed");
    expect(seenCap!.claims.runId).toBe(RUN_ID);
  });

  it("a permanent ProviderCallError thrown across the real client becomes a non-retryable typed failure", async () => {
    const invoker: Invoker = async () => ({
      ok: false,
      providerError: new ProviderCallError({ kind: "authentication", retryable: false, message: "bad key" }),
      receipt,
    });
    const embed = embedderFromClient(realClient(invoker), capability(), OLD_CFG);
    const out = await embed(["a", "b"]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe("authentication");
      expect(out.retryable).toBe(false);
    }
  });

  it("a retryable ProviderCallError (rate_limit) becomes a retryable typed failure carrying retryAfterMs", async () => {
    const invoker: Invoker = async () => ({
      ok: false,
      providerError: new ProviderCallError({ kind: "rate_limit", retryable: true, retryAfter: 1500 }),
      receipt,
    });
    const embed = embedderFromClient(realClient(invoker), capability(), OLD_CFG);
    const out = await embed(["a"]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe("rate_limit");
      expect(out.retryable).toBe(true);
      expect(out.retryAfterMs).toBe(1500);
    }
  });

  it("driving indexNote through the real-client adapter: a permanent provider throw is the repairable typed outcome, not a rejection", async () => {
    adopt(OLD_CFG);
    const note = makeNote("n1", "Body text.", "hash-1");
    insertNoteRow(store, note);
    const invoker: Invoker = async () => ({
      ok: false,
      providerError: new ProviderCallError({ kind: "authentication", retryable: false }),
      receipt,
    });
    const embed = embedderFromClient(realClient(invoker), capability(), OLD_CFG);
    // The real provider fault path — indexNote must NOT throw; it returns the typed outcome.
    const out = await indexNote(note, deps(OLD_CFG, { embed }));
    expect(out.kind).toBe("embedding-failed");
    if (out.kind === "embedding-failed") {
      expect(out.retryable).toBe(false);
      expect(out.providerKind).toBe("authentication");
    }
    expect(store.generation.activeGenerationId(note.id)).toBeNull();
  });

  it("a non-provider throw (a bug) is NOT swallowed by the adapter", async () => {
    const buggy = { embed: async () => { throw new TypeError("boom"); } } satisfies EmbedClient<EgressCapability>;
    await expect(embedderFromClient(buggy, capability(), OLD_CFG)(["x"])).rejects.toThrow("boom");
  });
});

/** The complete expected chunk-id set for `note` under `cfg` (verify-complete input) —
 * recomputed via the same deterministic chunker + generation the write path uses. */
function chunkIdsOf(note: ParsedNote, cfg: IndexingConfig): string[] {
  const gen = generationId(note, cfg);
  return chunkNote(note, cfg).map((c) => chunkId(gen, c.sectionPath, c.ordinal));
}
