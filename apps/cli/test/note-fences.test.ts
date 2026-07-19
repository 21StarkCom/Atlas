/**
 * note-fences — `noteFences` (now exported) + the bounded `noteFencesForNotes`
 * scoped helper (60-B Task 2.1). The scoped helper is the O(delta) input to
 * `indexNotes`: it reads fences for ONLY the requested note ids via an indexed
 * `WHERE note_id IN (...)`, never a full-corpus scan, and ids absent from `notes`
 * simply drop out (their fence is `undefined` ⇒ archived/deleted to the reconcile).
 */
import { describe, it, expect, afterEach } from "vitest";
import { openStore, type Store } from "@atlas/sqlite-store";
import { noteFences, noteFencesForNotes } from "../src/commands/index-ops.js";

let open: Store | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

interface NoteSeed {
  noteId: string;
  contentHash: string;
  activeGenerationId: string | null;
}

/** A migrated in-memory store seeded with the given note fences. */
function storeWithNotes(seeds: NoteSeed[]): Store {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  const insert = store.db.prepare(
    `INSERT INTO notes
       (note_id, slug, title, type, schema_version, status, file_path,
        content_hash, active_generation_id, created, updated)
     VALUES (@id, @slug, @title, 'concept', 1, 'active', @path,
             @hash, @gen, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  for (const s of seeds) {
    insert.run({
      id: s.noteId,
      slug: s.noteId,
      title: s.noteId,
      path: `${s.noteId}.md`,
      hash: s.contentHash,
      gen: s.activeGenerationId,
    });
  }
  open = store;
  return store;
}

function storeWithManyNotes(n: number): Store {
  const seeds: NoteSeed[] = [];
  for (let i = 0; i < n; i++) seeds.push({ noteId: `n${i}`, contentHash: `h${i}`, activeGenerationId: `g${i}` });
  return storeWithNotes(seeds);
}

describe("noteFencesForNotes", () => {
  it("returns fences for only the requested noteIds, preserving fence fields", () => {
    const store = storeWithNotes([
      { noteId: "n1", contentHash: "h1", activeGenerationId: "g1" },
      { noteId: "n2", contentHash: "h2", activeGenerationId: "g2" },
      { noteId: "n3", contentHash: "h3", activeGenerationId: "g3" },
    ]);
    const out = noteFencesForNotes(store, ["n1", "n3"]);
    expect(out.map((f) => f.noteId).sort()).toEqual(["n1", "n3"]);
    expect(out.find((f) => f.noteId === "n1")).toMatchObject({ contentHash: "h1", activeGenerationId: "g1" });
  });

  it("drops ids absent from the notes projection (archived/deleted ⇒ no fence)", () => {
    const store = storeWithNotes([{ noteId: "n1", contentHash: "h1", activeGenerationId: "g1" }]);
    const out = noteFencesForNotes(store, ["n1", "n-missing"]);
    expect(out.map((f) => f.noteId)).toEqual(["n1"]);
  });

  it("dedups the requested ids and is a no-op on an empty list (no query, no IN ())", () => {
    const store = storeWithNotes([{ noteId: "n1", contentHash: "h1", activeGenerationId: "g1" }]);
    expect(noteFencesForNotes(store, ["n1", "n1"]).map((f) => f.noteId)).toEqual(["n1"]);
    expect(noteFencesForNotes(store, [])).toEqual([]);
  });

  it("scopes the DB scan to the requested ids (O(delta), not O(corpus))", () => {
    const store = storeWithManyNotes(5000);
    let lastSql = "";
    const origPrepare = store.db.prepare.bind(store.db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store.db as any).prepare = (sql: string) => {
      lastSql = sql;
      return origPrepare(sql);
    };
    noteFencesForNotes(store, ["n42"]);
    expect(lastSql).toMatch(/WHERE note_id IN/); // bounded query, no full-table fence scan
  });
});

describe("noteFences (whole corpus)", () => {
  it("returns every note's fence, sorted by note_id", () => {
    const store = storeWithNotes([
      { noteId: "n2", contentHash: "h2", activeGenerationId: "g2" },
      { noteId: "n1", contentHash: "h1", activeGenerationId: null },
    ]);
    const out = noteFences(store);
    expect(out.map((f) => f.noteId)).toEqual(["n1", "n2"]);
    expect(out[0]).toMatchObject({ noteId: "n1", contentHash: "h1", activeGenerationId: null });
  });
});
