/**
 * index-notes — the note-SCOPED reconcile `indexNotes` (60-B Task 2.3). Proves the
 * O(delta) contract at the library layer:
 *   - a drifted note in the payload is re-embedded (via the real fenced pipeline);
 *   - a current note hits the fast path (no embed spend);
 *   - a note absent from the payload's ParsedNotes is treated as removed (chunks dropped);
 *   - ids are de-duplicated and notes OUTSIDE the payload are provably never touched;
 *   - an empty id list is a caller error (throws);
 *   - the tally invariant `scanned === reembedded + unchanged + removed` holds.
 *
 * Uses a real LanceDB table + the real SQLite GenerationRepo (the ActivationStore) +
 * a deterministic embedder — the same harness shape as generation-fencing.test.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { ParsedNote } from "@atlas/contracts";
import { openStore, registerGenerationMigration, type Store } from "@atlas/sqlite-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  indexNote,
  indexNotes,
  indexingConfigKey,
  openSearchTable,
  sqlQuote,
  type Embedder,
  type IndexDeps,
  type IndexingConfig,
  type SearchTable,
} from "../src/index.js";

const DIMS = 4;
const CFG: IndexingConfig = { chunker_version: 1, embedding_model: "gemini-embedding-001", dimensions: DIMS };
const okEmbed: Embedder = async (texts) => ({ ok: true, vectors: texts.map(() => Array(DIMS).fill(0.1)) });

let store: Store;
let conn: lancedb.Connection;
let table: SearchTable;
let dir: string;

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

function insertNoteRow(note: ParsedNote): void {
  store.db
    .prepare(
      `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
       VALUES (@id, @id, @title, @type, 1, @status, @path, @hash, @created, @updated)
       ON CONFLICT(note_id) DO UPDATE SET content_hash = excluded.content_hash`,
    )
    .run({
      id: note.id,
      title: note.title,
      type: note.type,
      status: note.status,
      path: note.path,
      hash: note.contentHash,
      created: note.created,
      updated: note.updated,
    });
}

/** deps with a caller-scoped `notes` provider (the ParsedNotes this pass considers). */
function deps(notes: ParsedNote[]): IndexDeps {
  return {
    config: CFG,
    table,
    store: store.generation,
    embed: okEmbed,
    lockLocation: dir,
    notes: () => notes,
  };
}

/** Index the given notes so each has an active generation (seed a "current" corpus). */
async function seedIndexed(notes: ParsedNote[]): Promise<void> {
  store.generation.adoptConfig(indexingConfigKey(CFG));
  const d = deps(notes);
  for (const n of notes) {
    insertNoteRow(n);
    const outcome = await indexNote(n, d);
    expect(outcome.kind).toBe("indexed");
  }
}

function chunkCount(noteId: string): Promise<number> {
  return table.countRows(`noteId = ${sqlQuote(noteId)}`);
}

beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  registerGenerationMigration(store);
  store.migrate();
  dir = await mkdtemp(join(tmpdir(), "atlas-scoped-"));
  conn = await lancedb.connect(dir);
  table = await openSearchTable(conn, CFG);
});

afterEach(async () => {
  store.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("indexNotes — scoped reconcile", () => {
  it("re-embeds only the supplied notes and reports the tally", async () => {
    const n1 = makeNote("n1", "Alpha body.", "h1");
    const n2 = makeNote("n2", "Beta body.", "h2");
    const n3 = makeNote("n3", "Gamma body.", "h3");
    await seedIndexed([n1, n2, n3]);

    // n2's content changes ⇒ its projection hash moves; it is now stale.
    const n2b = makeNote("n2", "Beta body, revised.", "h2b");
    insertNoteRow(n2b);

    const report = await indexNotes(deps([n2b]), ["n2"]);
    expect(report.scanned).toBe(1);
    expect(report.reembedded).toBe(1);
    expect(report.unchanged).toBe(0);
    expect(report.removed).toBe(0);
    expect(report.results).toEqual([{ noteId: "n2", kind: "reembedded" }]);
    expect(report.scanned).toBe(report.reembedded + report.unchanged + report.removed);
  });

  it("hits the fast path (unchanged) without re-embedding a current note", async () => {
    const n1 = makeNote("n1", "Alpha body.", "h1");
    await seedIndexed([n1]);
    const report = await indexNotes(deps([n1]), ["n1"]);
    expect(report.unchanged).toBe(1);
    expect(report.reembedded).toBe(0);
    expect(report.results).toEqual([{ noteId: "n1", kind: "unchanged" }]);
  });

  it("reports removed for a note absent from the payload and drops its chunks", async () => {
    const n1 = makeNote("n1", "Alpha body.", "h1");
    await seedIndexed([n1]);
    expect(await chunkCount("n1")).toBeGreaterThan(0);

    // The note no longer resolves ⇒ the provider omits it ⇒ removed.
    const report = await indexNotes(deps([]), ["n1"]);
    expect(report.results).toEqual([{ noteId: "n1", kind: "removed" }]);
    expect(report.removed).toBe(1);
    expect(await chunkCount("n1")).toBe(0);
  });

  it("de-duplicates noteIds and never touches notes it was not handed", async () => {
    const n1 = makeNote("n1", "Alpha body.", "h1");
    const n2 = makeNote("n2", "Beta body.", "h2");
    await seedIndexed([n1, n2]);
    const n2Chunks = await chunkCount("n2");

    const n1b = makeNote("n1", "Alpha body, revised.", "h1b");
    insertNoteRow(n1b);
    const report = await indexNotes(deps([n1b]), ["n1", "n1"]); // duplicate id
    expect(report.scanned).toBe(1); // de-duplicated
    expect(report.reembedded).toBe(1);

    // n2 was neither in the id set nor the provider — provably untouched (O(delta)).
    expect(await chunkCount("n2")).toBe(n2Chunks);
    expect(store.generation.activeGenerationId("n2")).not.toBeNull();
  });

  it("throws on an empty noteIds array (caller error)", async () => {
    await expect(indexNotes(deps([]), [])).rejects.toThrow(/non-empty/);
  });

  it("throws when deps.notes is absent", async () => {
    const { notes: _omit, ...bare } = deps([]);
    void _omit;
    await expect(indexNotes(bare as IndexDeps, ["n1"])).rejects.toThrow(/deps\.notes/);
  });
});
