/**
 * `fts.test` — the `text` FTS inverted-index builder (`ensureFtsIndex`,
 * retrieval-index-contract §6, #156). Verifies the analyzer constant, that the index
 * is built with English stemming + stop-word removal over the `text` column, that the
 * analyzer is actually applied at query time (stemming makes "run" match "running";
 * stop words carry no signal), and that an empty table is a safe no-op.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { ParsedNote } from "@atlas/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SEARCH_FTS_ANALYZER,
  assembleRows,
  chunkNote,
  ensureFtsIndex,
  generationId,
  openSearchTable,
  writeGeneration,
  type IndexingConfig,
  type SearchTable,
} from "../src/index.js";

const CFG: IndexingConfig = { chunker_version: 1, embedding_model: "test-embed", dimensions: 4 };

function makeNote(id: string, body: string): ParsedNote {
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
    contentHash: `hash-${id}`,
    raw: body,
  };
}

/** Chunk a note, pair each chunk with a dummy unit vector, and write the generation. */
async function writeNote(table: SearchTable, note: ParsedNote): Promise<void> {
  const chunks = chunkNote(note, CFG);
  const gen = generationId(note, CFG);
  const rows = assembleRows(chunks, chunks.map(() => [0.1, 0.1, 0.1, 0.1]), CFG, gen);
  await writeGeneration(table, rows);
}

/** The noteIds a raw fullTextSearch over `text` returns, best-first. */
async function ftsNotes(table: SearchTable, query: string): Promise<string[]> {
  const rows = (await table
    .query()
    .fullTextSearch(query, { columns: ["text"] })
    .select(["noteId", "_score"])
    .limit(50)
    .toArray()) as { noteId: string }[];
  const seen: string[] = [];
  for (const r of rows) if (!seen.includes(r.noteId)) seen.push(r.noteId);
  return seen;
}

let dir: string;
let table: SearchTable;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atlas-fts-"));
  table = await openSearchTable(await lancedb.connect(dir), CFG);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SEARCH_FTS_ANALYZER — the v1 English analyzer (§6, #156)", () => {
  it("stems, removes stop words, and folds ASCII over the simple base tokenizer", () => {
    expect(SEARCH_FTS_ANALYZER).toEqual({
      baseTokenizer: "simple",
      language: "English",
      stem: true,
      removeStopWords: true,
      asciiFolding: true,
      withPosition: false,
    });
  });
});

describe("ensureFtsIndex", () => {
  it("is a no-op on an empty table (LanceDB cannot index zero rows)", async () => {
    await ensureFtsIndex(table);
    expect(await table.listIndices()).toHaveLength(0);
  });

  it("builds an FTS index on `text` with stemming + stop-word removal", async () => {
    await writeNote(table, makeNote("n1", "The quarterly revenue forecast for the platform team."));
    await ensureFtsIndex(table);

    const indices = await table.listIndices();
    const fts = indices.find((i) => i.indexType === "FTS");
    expect(fts).toBeDefined();
    expect(fts!.columns).toEqual(["text"]);
    const details = (fts as unknown as { indexDetails?: Record<string, unknown> }).indexDetails;
    expect(details?.stem).toBe(true);
    expect(details?.remove_stop_words).toBe(true);
  });

  it("applies the analyzer at query time — stemming matches inflected forms", async () => {
    await writeNote(table, makeNote("running-note", "The engineer is running the migration."));
    await writeNote(table, makeNote("other-note", "A wholly unrelated document about gardening."));
    await ensureFtsIndex(table);

    // "run" only matches "running" once the index stems both to the same root.
    expect(await ftsNotes(table, "run")).toContain("running-note");
    expect(await ftsNotes(table, "run")).not.toContain("other-note");
  });

  it("removes stop words — a content term ranks above one buried in stop words", async () => {
    // The target says "budget" once; the decoy is almost all stop words + one "budget".
    // With stop words removed, both score on the single content term rather than the
    // decoy winning on stop-word term frequency.
    await writeNote(table, makeNote("target", "The approved budget covers the migration."));
    await writeNote(table, makeNote("decoy", "And so it was that they had been the ones who would."));
    await ensureFtsIndex(table);

    // A pure stop-word query carries no signal → no hits (proves stop words are dropped).
    expect(await ftsNotes(table, "the and it was")).toEqual([]);
    // A content query still finds the content-bearing note.
    expect(await ftsNotes(table, "budget")).toContain("target");
  });

  it("re-derives the index over rows added after the first build (idempotent replace)", async () => {
    await writeNote(table, makeNote("first", "Initial content about deployment pipelines."));
    await ensureFtsIndex(table);
    await writeNote(table, makeNote("second", "Later content about observability dashboards."));
    await ensureFtsIndex(table);

    expect(await ftsNotes(table, "observability")).toContain("second");
    expect(await table.listIndices()).toHaveLength(1);
  });
});
