/**
 * #212 end-to-end regression — a `db rebuild` (projection replace) in which ONE
 * note's content changed must cost exactly ONE re-embed on the next `index
 * repair`, and retrieval must keep serving between the two (no fail-closed
 * outage window). Pre-#212, the rebuild wiped every note's generation fence, so
 * repair re-embedded the whole corpus and queries returned 0 results until it
 * finished.
 *
 * Also pins the fail-closed complement: a CONFIG change (different embedding
 * model ⇒ different generationId) still re-embeds everything — content-keyed
 * skipping must never weaken config invalidation. And the re-attach path: a
 * fence lost OUTSIDE rebuild (raw wipe) converges via `re-activated` with zero
 * embed calls because the chunks are still durably present.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { openStore, registerGenerationMigration, type Store } from "@atlas/sqlite-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  indexRepair,
  indexingConfigKey,
  openSearchTable,
  reconcileIndex,
  retrieveActiveChunks,
  type Embedder,
  type IndexDeps,
  type IndexingConfig,
  type SearchTable,
} from "../src/index.js";

const DIMS = 4;
const CFG: IndexingConfig = { chunker_version: 1, embedding_model: "gemini-embedding-001", dimensions: DIMS };
const OTHER_CFG: IndexingConfig = { chunker_version: 1, embedding_model: "gemini-embedding-002", dimensions: DIMS };

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

function vaultSnapshot(notes: ParsedNote[]): VaultSnapshot {
  return { notes, errors: [] };
}

let store: Store;
let db: lancedb.Connection;
let table: SearchTable;
let dir: string;
let embedCalls: number;

/** A counting embedder — the regression's measurement instrument. */
const countingEmbed: Embedder = async (texts) => {
  embedCalls += 1;
  return { ok: true, vectors: texts.map(() => Array(DIMS).fill(0.1)) };
};

function deps(config: IndexingConfig, notes: ParsedNote[]): IndexDeps & { notes: () => ParsedNote[] } {
  return {
    config,
    table,
    store: store.generation,
    embed: countingEmbed,
    lockLocation: dir,
    notes: () => notes,
  };
}

beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  registerGenerationMigration(store);
  store.migrate();
  dir = await mkdtemp(join(tmpdir(), "atlas-212-"));
  db = await lancedb.connect(dir);
  table = await openSearchTable(db, CFG);
  embedCalls = 0;
});

afterEach(async () => {
  store.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("db rebuild → index repair (#212)", () => {
  const noteA = makeNote("note-a", "Alpha body prose.", "a".repeat(64));
  const noteB = makeNote("note-b", "Beta body prose.", "b".repeat(64));
  const noteC = makeNote("note-c", "Gamma body prose.", "c".repeat(64));

  async function indexAll(notes: ParsedNote[]): Promise<void> {
    store.rebuildProjections(vaultSnapshot(notes));
    store.generation.adoptConfig(indexingConfigKey(CFG));
    await reconcileIndex(deps(CFG, notes));
  }

  it("single-note edit + rebuild ⇒ repair re-embeds exactly one note; retrieval never blanks", async () => {
    await indexAll([noteA, noteB, noteC]);
    expect(embedCalls).toBe(3);

    // The "db rebuild" after one edit: same snapshot, one changed content hash.
    const editedA = makeNote("note-a", "Alpha body prose, edited.", "d".repeat(64));
    const rebuiltNotes = [editedA, noteB, noteC];
    store.rebuildProjections(vaultSnapshot(rebuiltNotes));

    // No fail-closed outage window: the unchanged notes' fences survive, so
    // retrieval keeps serving BEFORE any repair runs (pre-#212: zero results here).
    expect(store.generation.activeGenerationIds().length).toBe(3);
    for (const id of ["note-b", "note-c"]) {
      const live = await retrieveActiveChunks(table, store.generation, id);
      expect(live.length, `retrieval must keep serving ${id} between rebuild and repair`).toBeGreaterThan(0);
    }

    embedCalls = 0;
    const report = await indexRepair(deps(CFG, rebuiltNotes));
    expect(embedCalls).toBe(1);
    expect(report.repaired).toEqual([
      { noteId: "note-a", action: "re-embedded", generationId: expect.any(String) },
    ]);
    expect(report.unresolved).toEqual([]);
  });

  it("fail-closed complement: a config change still re-embeds EVERYTHING", async () => {
    await indexAll([noteA, noteB, noteC]);
    embedCalls = 0;

    store.generation.adoptConfig(indexingConfigKey(OTHER_CFG));
    const otherTable = await openSearchTable(db, OTHER_CFG);
    const report = await indexRepair({ ...deps(OTHER_CFG, [noteA, noteB, noteC]), table: otherTable });
    expect(embedCalls).toBe(3);
    expect(report.repaired.map((r) => r.action)).toEqual(["re-embedded", "re-embedded", "re-embedded"]);
  });

  it("a fence lost outside rebuild re-attaches with ZERO embed spend (`re-activated`)", async () => {
    await indexAll([noteA, noteB, noteC]);
    embedCalls = 0;

    // Simulate the fence-loss class the rebuild fix does not cover (e.g. an
    // older-backup restore): raw wipe of the activation state.
    store.db.prepare(`UPDATE notes SET active_generation = 0, active_generation_id = NULL`).run();
    expect(store.generation.activeGenerationIds()).toEqual([]);

    const report = await indexRepair(deps(CFG, [noteA, noteB, noteC]));
    expect(embedCalls).toBe(0);
    expect(report.repaired.map((r) => r.action)).toEqual(["re-activated", "re-activated", "re-activated"]);
    expect(store.generation.activeGenerationIds().length).toBe(3);
    for (const id of ["note-a", "note-b", "note-c"]) {
      const live = await retrieveActiveChunks(table, store.generation, id);
      expect(live.length).toBeGreaterThan(0);
    }
  });
});
