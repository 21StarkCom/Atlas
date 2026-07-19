/**
 * fold-rebuild-parity — the shared-derivation guard (60-B Task 2.2).
 *
 * `rebuildProjections` (full) and `foldNotesForPaths` (incremental) both derive a
 * `notes` row through the ONE `deriveAndPersistNote` primitive. This test pins that
 * they agree: for the same canonical tree, a full rebuild and an incremental fold
 * over the union produce **byte-identical `notes` rows (every column) for notes
 * present in the canonical snapshot** — the extraction is behavior-preserving.
 *
 * Archived rows are DELIBERATELY excluded from byte-parity and asserted separately
 * as an intentional divergence: a full rebuild clears `notes` and recreates only
 * what the snapshot contains (a deleted note leaves NO row), while the incremental
 * fold retains an `archived` row by design (non-destructive, reversible).
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ParsedNote } from "@atlas/contracts";
import { openStore, type Store } from "../src/store.js";
import { foldNotesForPaths } from "../src/fold-notes-for-paths.js";
import { makeNote, snapshot } from "./helpers.js";

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function migratedStore(): Store {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  stores.push(store);
  return store;
}

function allNoteRows(store: Store): Record<string, unknown>[] {
  return store.db.prepare(`SELECT * FROM notes ORDER BY note_id`).all() as Record<string, unknown>[];
}

const CANONICAL: ParsedNote[] = [
  makeNote({ id: "note-a", path: "concepts/alpha.md", title: "Alpha", aliases: ["Alpha Prime"], contentHash: "a".repeat(64) }),
  makeNote({ id: "note-b", path: "projects/beta.md", type: "project", title: "Beta", status: "draft", contentHash: "b".repeat(64) }),
  makeNote({ id: "note-c", path: "gamma.md", title: "Gamma", created: "2025-01-02", updated: "2026-03-04", contentHash: "c".repeat(64) }),
];

describe("fold ↔ rebuild parity", () => {
  it("produces byte-identical notes rows for notes present in the canonical tree", () => {
    // Full rebuild.
    const full = migratedStore();
    full.rebuildProjections(snapshot(CANONICAL));

    // Incremental fold over the union, on a fresh store, from the same tree.
    const incr = migratedStore();
    const byId = new Map(CANONICAL.map((n) => [n.id, n]));
    foldNotesForPaths(
      incr,
      CANONICAL.map((n) => n.id),
      (id) => byId.get(id) ?? null,
    );

    expect(allNoteRows(incr)).toEqual(allNoteRows(full));
  });

  it("is byte-identical for a re-added note too (fold upsert == rebuild insert)", () => {
    const full = migratedStore();
    full.rebuildProjections(snapshot(CANONICAL));

    const incr = migratedStore();
    const byId = new Map(CANONICAL.map((n) => [n.id, n]));
    // Fold twice — the second pass upserts over existing rows (the re-add path).
    const ids = CANONICAL.map((n) => n.id);
    foldNotesForPaths(incr, ids, (id) => byId.get(id) ?? null);
    foldNotesForPaths(incr, ids, (id) => byId.get(id) ?? null);

    expect(allNoteRows(incr)).toEqual(allNoteRows(full));
  });

  it("diverges intentionally on deletion: rebuild drops the row, fold retains an archived one", () => {
    // A tree WITHOUT note-c.
    const survivors = CANONICAL.filter((n) => n.id !== "note-c");

    const full = migratedStore();
    full.rebuildProjections(snapshot(survivors));
    // Full rebuild: note-c simply does not exist.
    expect(full.db.prepare(`SELECT * FROM notes WHERE note_id = 'note-c'`).get()).toBeUndefined();

    // Incremental: start from the full tree, then fold the deletion of note-c.
    const incr = migratedStore();
    incr.rebuildProjections(snapshot(CANONICAL));
    const byId = new Map(survivors.map((n) => [n.id, n]));
    foldNotesForPaths(incr, ["note-c"], (id) => byId.get(id) ?? null);

    // Incremental fold: note-c RETAINED as archived (the intentional divergence).
    const c = incr.db.prepare(`SELECT * FROM notes WHERE note_id = 'note-c'`).get() as Record<string, unknown>;
    expect(c).toMatchObject({ note_id: "note-c", status: "archived" });

    // But the SURVIVING notes are byte-identical between the two paths.
    const strip = (rows: Record<string, unknown>[]) => rows.filter((r) => r["note_id"] !== "note-c");
    expect(strip(allNoteRows(incr))).toEqual(strip(allNoteRows(full)));
  });
});
