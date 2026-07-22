/**
 * fold-notes-v2 — the v2 reconciling projection fold (#329). These tests pin the two
 * convergence properties the round-3 review flagged, both of which would otherwise
 * become PERMANENT drift once `content_hash` (which the fold advances) is the sync
 * cursor: a subsequent sync sees an unchanged tree and can never repair them.
 *
 * 1. A pure namespace TRANSFER (swap two filenames) must converge — the identity-key
 *    reconciliation deletes every affected owner's keys BEFORE inserting any, so the
 *    new owner's key never collides with the old owner's still-present PK row.
 * 2. A typed relationship (non-null `predicate`, owned by the `link` command, absent
 *    from the note's markdown) must SURVIVE a fold of its source note — the fold
 *    replaces only the plain (NULL-predicate) wikilinks.
 *
 * Leaf-package discipline (D14): a plain in-memory resolver, no git, no parser.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ParsedNote } from "@atlas/contracts";
import { openStore, type Store } from "../src/store.js";
import { foldNotesV2 } from "../src/fold-notes-v2.js";
import { ProjectionRepo } from "../src/repos/projections.js";
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

const resolverFrom =
  (byId: Map<string, ParsedNote | null>) =>
  (id: string): ParsedNote | null =>
    byId.get(id) ?? null;

function slugKey(store: Store, noteId: string): string | undefined {
  const row = store.db
    .prepare(`SELECT normalized_key FROM note_identity_keys WHERE note_id = ? AND kind = 'slug'`)
    .get(noteId) as { normalized_key: string } | undefined;
  return row?.normalized_key;
}

describe("foldNotesV2 — convergence", () => {
  it("converges a pure filename SWAP (a.md↔b.md) with no identity-key collision", () => {
    const store = migratedStore();
    // Seed: a→slug "alpha", b→slug "beta".
    const initial = new Map<string, ParsedNote | null>([
      ["a", makeNote({ id: "a", path: "alpha.md", title: "alpha" })],
      ["b", makeNote({ id: "b", path: "beta.md", title: "beta" })],
    ]);
    foldNotesV2(store, ["a", "b"], resolverFrom(initial));
    expect(slugKey(store, "a")).toBe("alpha");
    expect(slugKey(store, "b")).toBe("beta");

    // Swap the paths: a now lives at beta.md, b at alpha.md. A per-id
    // delete-then-insert would insert a's new key "beta" while b's old "beta" key
    // is still present → UNIQUE collision, failing deterministically every retry.
    const swapped = new Map<string, ParsedNote | null>([
      ["a", makeNote({ id: "a", path: "beta.md", title: "beta" })],
      ["b", makeNote({ id: "b", path: "alpha.md", title: "alpha" })],
    ]);
    expect(() => foldNotesV2(store, ["a", "b"], resolverFrom(swapped))).not.toThrow();
    expect(slugKey(store, "a")).toBe("beta");
    expect(slugKey(store, "b")).toBe("alpha");
  });

  it("preserves a typed relationship (non-null predicate) when folding its source note", () => {
    const store = migratedStore();
    const seed = new Map<string, ParsedNote | null>([
      ["src", makeNote({ id: "src", path: "src.md", title: "src" })],
      ["dst", makeNote({ id: "dst", path: "dst.md", title: "dst" })],
    ]);
    foldNotesV2(store, ["src", "dst"], resolverFrom(seed));

    // A typed relationship src→dst, as the `link` command would create it (a
    // non-null predicate; it lives in the projection, NOT in src's markdown).
    new ProjectionRepo(store.db).insertLink({
      source_note_id: "src",
      target_note_id: "dst",
      predicate: "supports",
      alias: null,
    });

    // Re-fold src (its markdown changed — e.g. a title edit adds no wikilinks).
    foldNotesV2(store, ["src"], resolverFrom(seed));

    const typed = store.db
      .prepare(`SELECT predicate FROM note_links WHERE source_note_id = 'src' AND target_note_id = 'dst'`)
      .all() as { predicate: string | null }[];
    expect(typed).toEqual([{ predicate: "supports" }]); // survived — not clobbered
  });
});
