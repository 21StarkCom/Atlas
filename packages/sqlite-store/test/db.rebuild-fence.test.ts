/**
 * #212 regression — `db rebuild` must PRESERVE the generation fence columns
 * (`active_generation`, `active_generation_id`) across the projection replace.
 * They are activation state owned by `activateGeneration`/`tombstoneGeneration`
 * (retrieval-index-contract §2), not a projection of Markdown; the pre-#212
 * wipe forced a full-corpus re-embed after every rebuild and blanked retrieval
 * until `index repair`.
 */
import { describe, expect, it } from "vitest";
import { openStore, registerGenerationMigration, type Store } from "../src/index.js";
import { makeNote, snapshot } from "./helpers.js";

const CONFIG_KEY = "chunker=1|model=gemini-embedding-001|dims=768";
const GEN_A = "a".repeat(64);

function migrated(): Store {
  const store = openStore({ path: ":memory:" });
  registerGenerationMigration(store);
  store.migrate();
  return store;
}

function fenceRow(store: Store, noteId: string): { active_generation: number; active_generation_id: string | null } {
  return store.db
    .prepare(`SELECT active_generation, active_generation_id FROM notes WHERE note_id = ?`)
    .get(noteId) as { active_generation: number; active_generation_id: string | null };
}

describe("db.rebuild preserves the generation fence (#212)", () => {
  it("an identical snapshot keeps the fence byte-for-byte", () => {
    const store = migrated();
    try {
      const noteA = makeNote({ id: "note-a", path: "a.md" });
      store.rebuildProjections(snapshot([noteA]));
      store.generation.adoptConfig(CONFIG_KEY);
      expect(store.generation.activateGeneration("note-a", GEN_A, noteA.contentHash, CONFIG_KEY)).toBe(true);
      const before = fenceRow(store, "note-a");
      expect(before.active_generation_id).toBe(GEN_A);

      store.rebuildProjections(snapshot([noteA]));
      expect(fenceRow(store, "note-a")).toEqual(before);
      expect(store.generation.activeGenerationId("note-a")).toBe(GEN_A);
    } finally {
      store.close();
    }
  });

  it("a content change keeps the OLD fence — the designed `stale` state, not `missing`", () => {
    const store = migrated();
    try {
      const noteA = makeNote({ id: "note-a", path: "a.md" });
      store.rebuildProjections(snapshot([noteA]));
      store.generation.adoptConfig(CONFIG_KEY);
      expect(store.generation.activateGeneration("note-a", GEN_A, noteA.contentHash, CONFIG_KEY)).toBe(true);

      const edited = makeNote({ id: "note-a", path: "a.md", contentHash: "1".repeat(64) });
      store.rebuildProjections(snapshot([edited]));
      // The fence still points at the OLD generation: staleness classifies the note
      // `stale` (content trigger) and repair re-embeds exactly this note.
      expect(fenceRow(store, "note-a").active_generation_id).toBe(GEN_A);
      const row = store.db.prepare(`SELECT content_hash FROM notes WHERE note_id = 'note-a'`).get() as {
        content_hash: string;
      };
      expect(row.content_hash).toBe("1".repeat(64));
    } finally {
      store.close();
    }
  });

  it("a note removed from the snapshot drops entirely — no orphan fence row", () => {
    const store = migrated();
    try {
      const noteA = makeNote({ id: "note-a", path: "a.md" });
      const noteB = makeNote({ id: "note-b", path: "b.md" });
      store.rebuildProjections(snapshot([noteA, noteB]));
      store.generation.adoptConfig(CONFIG_KEY);
      expect(store.generation.activateGeneration("note-a", GEN_A, noteA.contentHash, CONFIG_KEY)).toBe(true);

      store.rebuildProjections(snapshot([noteB]));
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE note_id = 'note-a'`).get()).toEqual({ n: 0 });
      expect(store.generation.activeGenerationIds()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
