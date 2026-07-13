/**
 * `db.rebuild` — transactional projection rebuild.
 *
 *  - rebuild after note edits converges (idempotent replace from the snapshot);
 *  - ledger rows survive a rebuild untouched (no cross-class FK, §8);
 *  - a crash mid-rebuild (failpoint) rolls back — the old projection stays
 *    readable (acceptance: transactional replace).
 */
import { describe, expect, it } from "vitest";
import { normalizeIdentityKey } from "@atlas/contracts";
import { openStore, SnapshotHasErrorsError, DanglingLinkError } from "../src/index.js";
import { makeNote, snapshot } from "./helpers.js";

function migrated() {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  return store;
}

describe("db.rebuild", () => {
  it("projects notes, identity keys (slug+alias), and resolved links", () => {
    const store = migrated();
    try {
      const snap = snapshot([
        makeNote({
          id: "note-a",
          path: "concepts/alpha.md",
          aliases: ["Alpha Prime"],
          links: [{ target: "beta", raw: "[[beta]]" }],
        }),
        makeNote({ id: "note-b", path: "concepts/beta.md" }),
      ]);
      const report = store.rebuildProjections(snap);
      expect(report.notes).toBe(2);
      // 2 slug keys + 1 alias key
      expect(report.identityKeys).toBe(3);
      expect(report.links).toBe(1);

      const noteA = store.projections.getNote("note-a")!;
      expect(noteA.slug).toBe("alpha");
      expect(noteA.file_path).toBe("concepts/alpha.md");

      // The link 'beta' resolved to note-b via its slug identity key.
      const link = store.db
        .prepare(`SELECT * FROM note_links WHERE source_note_id = 'note-a'`)
        .get() as { target_note_id: string; predicate: string };
      expect(link.target_note_id).toBe("note-b");

      const aliasKey = normalizeIdentityKey("Alpha Prime");
      const row = store.db
        .prepare(`SELECT note_id, kind FROM note_identity_keys WHERE normalized_key = ?`)
        .get(aliasKey) as { note_id: string; kind: string };
      expect(row).toEqual({ note_id: "note-a", kind: "alias" });

      // vault_schema_migrations reflects the one schema version present.
      const sv = store.db.prepare(`SELECT schema_version, note_count FROM vault_schema_migrations`).all();
      expect(sv).toEqual([{ schema_version: 1, note_count: 2 }]);
    } finally {
      store.close();
    }
  });

  it("deduplicates canonically-equivalent aliases owned by the same note (one row per normalized key)", () => {
    const store = migrated();
    try {
      // "Alpha Prime" and "alpha-prime!!!" both fold to the same normalized key;
      // the vault reader permits such equivalent aliases on one note. The rebuild
      // must collapse them to a single `note_identity_keys` row, not abort on the
      // primary-key constraint.
      const snap = snapshot([
        makeNote({
          id: "note-a",
          path: "concepts/alpha.md",
          aliases: ["Alpha Prime", "alpha-prime!!!", "Distinct Alias"],
        }),
      ]);
      const report = store.rebuildProjections(snap);
      // 1 slug + 2 distinct alias keys (the equivalent pair collapsed to one).
      expect(report.identityKeys).toBe(3);

      const equivKey = normalizeIdentityKey("Alpha Prime");
      const rows = store.db
        .prepare(`SELECT note_id, kind FROM note_identity_keys WHERE normalized_key = ?`)
        .all(equivKey) as { note_id: string; kind: string }[];
      expect(rows).toEqual([{ note_id: "note-a", kind: "alias" }]);

      // Total rows on the note: slug + 2 aliases.
      const count = store.db
        .prepare(`SELECT COUNT(*) AS c FROM note_identity_keys WHERE note_id = 'note-a'`)
        .get() as { c: number };
      expect(count.c).toBe(3);
    } finally {
      store.close();
    }
  });

  it("collapses a self-overlapping alias into the slug row (slug wins the overlap)", () => {
    const store = migrated();
    try {
      // The path yields slug "alpha"; an alias "Alpha" normalizes to the SAME key.
      // The slug row (inserted first) must win — no second row, no PK violation.
      const snap = snapshot([
        makeNote({ id: "note-a", path: "concepts/alpha.md", aliases: ["Alpha"] }),
      ]);
      const report = store.rebuildProjections(snap);
      // Only the slug key survives the overlap.
      expect(report.identityKeys).toBe(1);

      const slugKey = normalizeIdentityKey("alpha");
      const rows = store.db
        .prepare(`SELECT note_id, kind FROM note_identity_keys WHERE normalized_key = ?`)
        .all(slugKey) as { note_id: string; kind: string }[];
      expect(rows).toEqual([{ note_id: "note-a", kind: "slug" }]);
    } finally {
      store.close();
    }
  });

  it("projects title/status/created/updated verbatim from the note DTO (no fabrication)", () => {
    const store = migrated();
    try {
      store.rebuildProjections(
        snapshot([
          makeNote({
            id: "note-a",
            path: "concepts/alpha.md",
            // Canonical frontmatter values carried by the DTO — MUST be persisted as-is.
            title: "Canonical Title",
            status: "archived",
            created: "2024-01-02",
            updated: "2025-06-07",
            // A heading that must NOT be used as the title (proves no heading-derivation).
            sections: { heading: "A Different Heading", level: 1, path: "A Different Heading", children: [] },
          }),
        ]),
      );
      const row = store.projections.getNote("note-a")!;
      expect(row.title).toBe("Canonical Title");
      expect(row.status).toBe("archived");
      expect(row.created).toBe("2024-01-02");
      expect(row.updated).toBe("2025-06-07");
    } finally {
      store.close();
    }
  });

  it("rejects a snapshot carrying vault errors — the prior projection survives intact", () => {
    const store = migrated();
    try {
      // Seed a known-good projection.
      store.rebuildProjections(snapshot([makeNote({ id: "keep", path: "keep.md" })]));
      expect(store.projections.countNotes()).toBe(1);

      // A partial snapshot (one note parsed, one read-failed). It carries only the
      // parsed note in `notes` but a non-empty `errors`.
      const partial = {
        notes: [makeNote({ id: "survivor", path: "survivor.md" })],
        errors: [{ path: "gone.md", kind: "read-error", message: "cannot read note: EIO" }],
      };
      expect(() => store.rebuildProjections(partial)).toThrow(SnapshotHasErrorsError);

      // The old projection is untouched — no valid note was silently dropped.
      expect(store.projections.countNotes()).toBe(1);
      expect(store.projections.getNote("keep")).toBeDefined();
      expect(store.projections.getNote("survivor")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects an unresolved (dangling) link — rolls back, prior projection survives", () => {
    const store = migrated();
    try {
      store.rebuildProjections(snapshot([makeNote({ id: "keep", path: "keep.md" })]));
      expect(store.projections.countNotes()).toBe(1);

      // `notes` has no error flag but a link points at a note absent from the snapshot.
      const dangling = snapshot([
        makeNote({
          id: "note-a",
          path: "a.md",
          links: [{ target: "does-not-exist", raw: "[[does-not-exist]]" }],
        }),
      ]);
      expect(() => store.rebuildProjections(dangling)).toThrow(DanglingLinkError);

      // Rolled back: the OLD projection is intact, the new notes were not committed.
      expect(store.projections.countNotes()).toBe(1);
      expect(store.projections.getNote("keep")).toBeDefined();
      expect(store.projections.getNote("note-a")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("converges: re-running the same and an edited snapshot is deterministic", () => {
    const store = migrated();
    try {
      const v1 = snapshot([
        makeNote({ id: "note-a", path: "a.md", contentHash: "a".repeat(64) }),
        makeNote({ id: "note-b", path: "b.md", contentHash: "b".repeat(64) }),
      ]);
      store.rebuildProjections(v1);
      const first = store.projections.allNotes();
      store.rebuildProjections(v1);
      expect(store.projections.allNotes()).toEqual(first); // idempotent

      // Edit note-a's content; drop note-b. Rebuild converges to the new state.
      const v2 = snapshot([makeNote({ id: "note-a", path: "a.md", contentHash: "c".repeat(64) })]);
      const report = store.rebuildProjections(v2);
      expect(report.notes).toBe(1);
      expect(store.projections.countNotes()).toBe(1);
      expect(store.projections.getNote("note-a")!.content_hash).toBe("c".repeat(64));
      expect(store.projections.getNote("note-b")).toBeUndefined(); // removed, no leftover
    } finally {
      store.close();
    }
  });

  it("leaves ledger rows untouched across a rebuild", () => {
    const store = migrated();
    try {
      store.ledger.upsertAgentRun({
        run_id: "run-1",
        operation: "ingest",
        status: "planned",
        started_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
      });
      store.ledger.insertAuditEvent({
        seq: 1,
        run_id: "run-1",
        event_type: "run.started",
        payload_hash: "h".repeat(64),
        created_at: "2026-07-13T00:00:00Z",
      });
      const runBefore = store.ledger.getAgentRun("run-1");

      store.rebuildProjections(snapshot([makeNote({ id: "n", path: "n.md" })]));

      expect(store.ledger.countAgentRuns()).toBe(1);
      expect(store.ledger.countAuditEvents()).toBe(1);
      expect(store.ledger.getAgentRun("run-1")).toEqual(runBefore);
    } finally {
      store.close();
    }
  });

  it("crash mid-rebuild rolls back — the old projection stays readable (failpoint)", () => {
    const store = migrated();
    try {
      store.rebuildProjections(snapshot([makeNote({ id: "old", path: "old.md" })]));
      expect(store.projections.countNotes()).toBe(1);

      const boom = new Error("failpoint: crash mid-rebuild");
      expect(() =>
        store.rebuildProjections(snapshot([makeNote({ id: "new", path: "new.md" })]), {
          failpoint: (phase) => {
            if (phase === "after-clear") throw boom;
          },
        }),
      ).toThrow(boom);

      // Transaction rolled back: the OLD projection is intact, not the cleared/new one.
      expect(store.projections.countNotes()).toBe(1);
      expect(store.projections.getNote("old")).toBeDefined();
      expect(store.projections.getNote("new")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("does not touch db_schema_migrations", () => {
    const store = migrated();
    try {
      const before = store.db.prepare(`SELECT * FROM db_schema_migrations`).all();
      store.rebuildProjections(snapshot([makeNote({ id: "n", path: "n.md" })]));
      expect(store.db.prepare(`SELECT * FROM db_schema_migrations`).all()).toEqual(before);
    } finally {
      store.close();
    }
  });
});
