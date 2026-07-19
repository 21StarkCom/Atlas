/**
 * fold-notes-for-paths — the incremental, note-scoped `notes`-projection fold
 * (60-B Task 2.2). The caller supplies the resolver `(noteId) => ParsedNote | null`;
 * these tests use a plain in-memory resolver (no git, no parser — the store package
 * is a leaf, D14). Covers active-upsert, archive (`status='archived'`, non-destructive),
 * re-add, scope (only the requested ids), and idempotency for both cases.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ParsedNote } from "@atlas/contracts";
import { openStore, type Store } from "../src/store.js";
import { foldNotesForPaths } from "../src/fold-notes-for-paths.js";
import { makeNote } from "./helpers.js";

let open: Store | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

function migratedStore(): Store {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  open = store;
  return store;
}

/** A resolver backed by a mutable map: id → ParsedNote (present) or absent (archive). */
function resolverFrom(byId: Map<string, ParsedNote>): (id: string) => ParsedNote | null {
  return (id) => byId.get(id) ?? null;
}

function noteRow(store: Store, id: string): Record<string, unknown> | undefined {
  return store.db.prepare(`SELECT * FROM notes WHERE note_id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

describe("foldNotesForPaths", () => {
  it("active-upserts a note's row from its ParsedNote (only the requested ids)", () => {
    const store = migratedStore();
    const notes = new Map<string, ParsedNote>([
      ["n1", makeNote({ id: "n1", path: "n1.md", title: "One", contentHash: "a".repeat(64) })],
      ["n2", makeNote({ id: "n2", path: "n2.md", title: "Two" })],
    ]);
    foldNotesForPaths(store, ["n1"], resolverFrom(notes));

    const r1 = noteRow(store, "n1");
    expect(r1).toMatchObject({ note_id: "n1", slug: "n1", title: "One", status: "active", content_hash: "a".repeat(64) });
    // n2 was NOT in the requested id set — the fold must not touch it.
    expect(noteRow(store, "n2")).toBeUndefined();
  });

  it("archives a note whose resolver returns null (status='archived', row + hash retained)", () => {
    const store = migratedStore();
    const notes = new Map<string, ParsedNote>([
      ["n1", makeNote({ id: "n1", path: "n1.md", contentHash: "a".repeat(64) })],
    ]);
    foldNotesForPaths(store, ["n1"], resolverFrom(notes));
    expect(noteRow(store, "n1")).toMatchObject({ status: "active" });

    // The note no longer resolves at the ref ⇒ archive.
    notes.delete("n1");
    foldNotesForPaths(store, ["n1"], resolverFrom(notes));
    const archived = noteRow(store, "n1");
    expect(archived).toMatchObject({ status: "archived", content_hash: "a".repeat(64) }); // non-destructive
  });

  it("re-adds an archived note (status back to active) on a later fold", () => {
    const store = migratedStore();
    const notes = new Map<string, ParsedNote>([["n1", makeNote({ id: "n1", path: "n1.md" })]]);
    foldNotesForPaths(store, ["n1"], resolverFrom(notes));
    notes.delete("n1");
    foldNotesForPaths(store, ["n1"], resolverFrom(notes));
    expect(noteRow(store, "n1")).toMatchObject({ status: "archived" });

    // The note comes back.
    notes.set("n1", makeNote({ id: "n1", path: "n1.md", title: "Reborn" }));
    foldNotesForPaths(store, ["n1"], resolverFrom(notes));
    expect(noteRow(store, "n1")).toMatchObject({ status: "active", title: "Reborn" });
  });

  it("does not clear the generation fence when re-deriving a modified note", () => {
    const store = migratedStore();
    const notes = new Map<string, ParsedNote>([["n1", makeNote({ id: "n1", path: "n1.md", contentHash: "a".repeat(64) })]]);
    foldNotesForPaths(store, ["n1"], resolverFrom(notes));
    // Simulate the note being indexed: a fence points at a generation.
    store.db.prepare(`UPDATE notes SET active_generation = 1, active_generation_id = 'gen-x' WHERE note_id = 'n1'`).run();

    // Content changes ⇒ re-derive. The fence must be preserved (the stale state a reconcile re-embeds).
    notes.set("n1", makeNote({ id: "n1", path: "n1.md", contentHash: "b".repeat(64) }));
    foldNotesForPaths(store, ["n1"], resolverFrom(notes));
    const r = noteRow(store, "n1");
    expect(r).toMatchObject({ content_hash: "b".repeat(64), active_generation: 1, active_generation_id: "gen-x" });
  });

  it("is idempotent — re-running yields byte-identical rows (active and archived)", () => {
    const store = migratedStore();
    const notes = new Map<string, ParsedNote>([
      ["n1", makeNote({ id: "n1", path: "n1.md", title: "One" })],
      ["n2", makeNote({ id: "n2", path: "n2.md", title: "Two" })],
    ]);
    foldNotesForPaths(store, ["n1", "n2"], resolverFrom(notes));
    notes.delete("n2"); // n2 archived
    foldNotesForPaths(store, ["n1", "n2"], resolverFrom(notes));
    const first1 = noteRow(store, "n1");
    const first2 = noteRow(store, "n2");

    // Re-run the same fold — nothing should change.
    foldNotesForPaths(store, ["n1", "n2"], resolverFrom(notes));
    expect(noteRow(store, "n1")).toEqual(first1);
    expect(noteRow(store, "n2")).toEqual(first2);
    expect(first2).toMatchObject({ status: "archived" });
  });

  it("dedups requested ids and is a no-op on an empty list", () => {
    const store = migratedStore();
    const notes = new Map<string, ParsedNote>([["n1", makeNote({ id: "n1", path: "n1.md" })]]);
    foldNotesForPaths(store, ["n1", "n1"], resolverFrom(notes));
    expect(noteRow(store, "n1")).toMatchObject({ note_id: "n1" });
    // Empty list: no throw, no rows.
    expect(() => foldNotesForPaths(store, [], resolverFrom(notes))).not.toThrow();
  });
});
