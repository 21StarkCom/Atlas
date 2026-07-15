/**
 * `schema.test` (Task 3.1) — the `SearchChunk` row assembly, the concrete Arrow
 * table schema, and the column descriptor.
 *
 * The write path (Task 3.2) consumes these, so the invariants that matter here
 * are: the row carries the full contract §1 field set, identity is DERIVED (not
 * re-invented or caller-injected) from the chunk + generation, the D7 dimension
 * guard rejects a vector whose length disagrees with `indexing.dimensions`, a
 * mismatched generation id is refused, colliding section paths still get distinct
 * chunk ids, and the Arrow schema actually round-trips through LanceDB.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { Chunk } from "@atlas/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SEARCH_CHUNK_COLUMNS,
  SEARCH_CHUNK_TABLE,
  chunkId,
  generationId,
  generationIdFor,
  searchChunkArrowSchema,
  searchChunkColumns,
  toSearchChunk,
  type IndexingConfig,
} from "../src/index.js";

const CFG: IndexingConfig = {
  chunker_version: 1,
  embedding_model: "gemini-embedding-001",
  dimensions: 4, // small for the fixture vector
};

const CHUNK: Chunk = {
  noteId: "note-a",
  sectionPath: "Overview/Goals",
  text: "Overview › Goals\n\nGoal text.",
  contentHash: "hash-a",
  ordinal: 0, // section-local (§1.6): v1 emits ≤1 chunk per section
};

// The ONLY generation id that matches CHUNK's (noteId, contentHash) under CFG.
const GEN = generationIdFor(CHUNK.noteId, CHUNK.contentHash, CFG);

describe("toSearchChunk — row assembly", () => {
  it("assembles a full SearchChunk row with derived identity", () => {
    const row = toSearchChunk(CHUNK, [0.1, 0.2, 0.3, 0.4], CFG, GEN);
    expect(row).toEqual({
      // chunkId derives from the section-local Chunk.ordinal (0) + sectionPath.
      chunkId: chunkId(GEN, "Overview/Goals", 0),
      text: CHUNK.text,
      noteId: "note-a",
      sectionPath: "Overview/Goals",
      contentHash: "hash-a",
      chunkerVersion: 1,
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 4,
      generationId: GEN,
      embedding: [0.1, 0.2, 0.3, 0.4],
    });
  });

  it("rejects an embedding whose length disagrees with indexing.dimensions (D7)", () => {
    expect(() => toSearchChunk(CHUNK, [0.1, 0.2, 0.3], CFG, GEN)).toThrow(/dimensions/i);
  });

  it("rejects a generation id that does not match the row tuple", () => {
    const wrong = generationIdFor("some-other-note", CHUNK.contentHash, CFG);
    expect(() => toSearchChunk(CHUNK, [0.1, 0.2, 0.3, 0.4], CFG, wrong)).toThrow(
      /generationId .* does not match/i,
    );
    // A different config (dimensions) also yields a mismatched id → refused.
    const wrongCfg = generationIdFor(CHUNK.noteId, CHUNK.contentHash, { ...CFG, dimensions: 8 });
    expect(() => toSearchChunk(CHUNK, [0.1, 0.2, 0.3, 0.4], CFG, wrongCfg)).toThrow(/does not match/i);
  });

  it("distinguishes the preamble from a top-level empty heading by sectionPath, not ordinal", () => {
    // §1.6: chunk-id uniqueness rests on unique sectionPaths. The preamble is the
    // sole `""` path; an empty heading is encoded to a reserved non-empty segment
    // (`%00`) by the section encoder, so the two never collide even though both
    // carry the section-local ordinal 0. (End-to-end via the real encoder in
    // chunker.test; here we assert the id property directly.)
    const preamble: Chunk = { noteId: "n", sectionPath: "", text: "pre", contentHash: "h", ordinal: 0 };
    const emptyHeading: Chunk = { noteId: "n", sectionPath: "%00", text: "body", contentHash: "h", ordinal: 0 };
    const gen = generationIdFor("n", "h", CFG);
    const a = toSearchChunk(preamble, [0, 0, 0, 0], CFG, gen);
    const b = toSearchChunk(emptyHeading, [0, 0, 0, 0], CFG, gen);
    expect(a.sectionPath).not.toEqual(b.sectionPath); // distinct paths…
    expect(a.chunkId).not.toEqual(b.chunkId); // …so distinct ids at ordinal 0
  });

  it("re-derives an identical chunkId for the same (generation, sectionPath, ordinal) — idempotent write", () => {
    // The fencing property: the expected chunk-id set is a pure function of the
    // generation + path + ordinal, so a resumed batch re-writes the same id.
    const chunk: Chunk = { noteId: "n", sectionPath: "Overview", text: "x", contentHash: "h", ordinal: 0 };
    const gen = generationIdFor("n", "h", CFG);
    const first = toSearchChunk(chunk, [0, 0, 0, 0], CFG, gen);
    const again = toSearchChunk(chunk, [0, 0, 0, 0], CFG, gen);
    expect(first.chunkId).toEqual(again.chunkId);
  });
});

describe("SearchChunk columns", () => {
  it("declares the full contract §1 column set including the vector", () => {
    const names = SEARCH_CHUNK_COLUMNS.map((c) => c.name);
    expect(names).toEqual([
      "chunkId",
      "text",
      "noteId",
      "sectionPath",
      "contentHash",
      "chunkerVersion",
      "embeddingModel",
      "embeddingDimensions",
      "generationId",
      "embedding",
    ]);
    expect(SEARCH_CHUNK_TABLE).toBe("search_chunks");
  });

  it("binds the vector column list size to the configured dimensions", () => {
    const cols = searchChunkColumns(CFG);
    const vec = cols.find((c) => c.name === "embedding")!;
    expect(vec.type).toBe("fixed-size-list<float32>");
    expect(vec.listSize).toBe(4);
  });
});

describe("searchChunkArrowSchema — the concrete LanceDB table schema", () => {
  it("builds a fixed-size-list<float32> vector column of the configured dimension", () => {
    const schema = searchChunkArrowSchema({ ...CFG, dimensions: 768 });
    expect(schema.fields.map((f) => f.name)).toEqual(SEARCH_CHUNK_COLUMNS.map((c) => c.name));
    const vec = schema.fields.find((f) => f.name === "embedding")!;
    // FixedSizeList<Float32>[768] — what LanceDB needs for an ANN index.
    expect(vec.type.toString()).toContain("FixedSizeList[768]");
    expect(vec.type.toString()).toContain("Float32");
  });

  describe("round-trips through a real LanceDB table", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "atlas-lancedb-schema-"));
    });
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it("creates a table whose read-back schema pins the configured vector dimensions", async () => {
      const dims = 16;
      const db = await lancedb.connect(dir);
      const table = await db.createEmptyTable(SEARCH_CHUNK_TABLE, searchChunkArrowSchema({ ...CFG, dimensions: dims }));
      const readBack = await table.schema();
      expect(readBack.fields.map((f) => f.name)).toEqual(SEARCH_CHUNK_COLUMNS.map((c) => c.name));
      const vec = readBack.fields.find((f) => f.name === "embedding")!;
      // LanceDB preserved the fixed-size-list length exactly (= configured dims).
      expect((vec.type as { listSize: number }).listSize).toBe(dims);
    });
  });
});

describe("generationId <-> chunkId wiring", () => {
  it("chunkId is deterministic and path-sensitive under a fixed generation", () => {
    const gen = generationId(
      {
        id: "n",
        path: "n.md",
        type: "concept",
        schemaVersion: 1,
        title: "N",
        status: "active",
        created: "2026-07-12T00:00:00.000Z",
        updated: "2026-07-12T00:00:00.000Z",
        aliases: [],
        sources: [],
        declaredSensitivity: "internal",
        links: [],
        sections: { heading: "", level: 0, path: "", children: [] },
        contentHash: "h",
        raw: "",
      },
      CFG,
    );
    expect(chunkId(gen, "A", 0)).toEqual(chunkId(gen, "A", 0));
    expect(chunkId(gen, "A", 0)).not.toEqual(chunkId(gen, "B", 0));
    expect(chunkId(gen, "A", 0)).not.toEqual(chunkId(gen, "A", 1));
  });
});
