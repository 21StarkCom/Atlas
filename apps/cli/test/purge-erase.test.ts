/**
 * `purge-erase` (Task 4.10) — applied ordinary erasure: an authorized purge deletes every matched
 * row in purge order and VERIFIES no copy survives; an UNAUTHORIZED purge (broker refusal / digest
 * mismatch) erases nothing (fail-closed, refused before any deletion).
 */
import { describe, expect, it } from "vitest";
import type { ContentId, ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { applyErasure, ErasureError } from "../src/purge/erase.js";
import { computeErasureInventory } from "../src/purge/inventory.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;
const CONTENT_ID: ContentId = { kind: "content", rawContentHash: HEX_A, canonicalMediaType: "text/plain" };

function makeNote(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return {
    id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over,
  };
}
function sourceNote(): ParsedNote {
  const raw = ["---", "id: s-a", "type: source", "schema_version: 1", "title: s-a", "created: 2026-07-11", "updated: 2026-07-11",
    `contentId: "${CONTENT_A}"`, "origin: notes/a.txt", "provenance:", "  vault_path: sources/a.txt", "  size_bytes: 12", "  renditions:",
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`, "---", "", "# s-a", ""].join("\n");
  return makeNote(raw, { type: "source", id: "s-a", path: "sources/s-a.md" });
}
function claimNote(): ParsedNote {
  const raw = ["---", "id: note-a", "type: concept", "schema_version: 1", "title: note-a", "created: 2026-07-11", "updated: 2026-07-11", "claims:",
    "  - claim_id: claim-a", '    text: "A."', "    evidence:", `      - rendition: "${CONTENT_A}:1:1"`, "        verification: pending", "---", "", "# note-a", ""].join("\n");
  return makeNote(raw, { id: "note-a", path: "note-a.md" });
}
function storeWith(notes: ParsedNote[]): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  rebuildProjections(s.db, { notes, errors: [] } as VaultSnapshot);
  return s;
}

describe("purge applied erasure (Task 4.10)", () => {
  it("an authorized source purge erases the provenance chain + dependents and verifies empty", async () => {
    const s = storeWith([sourceNote(), claimNote()]);
    try {
      expect((s.db.prepare(`SELECT COUNT(*) AS n FROM content_blobs`).get() as { n: number }).n).toBe(1);
      const result = await applyErasure(s.db, { kind: "source", value: CONTENT_ID }, { authorizeTombstone: async () => {} });
      expect(result.verified).toBe(true);
      expect(result.refReplaced).toBe(false);
      expect(result.erasedClasses).toContain("content_blobs");
      // Every matched row is gone; the inventory now resolves to nothing.
      expect((s.db.prepare(`SELECT COUNT(*) AS n FROM content_blobs`).get() as { n: number }).n).toBe(0);
      expect((s.db.prepare(`SELECT COUNT(*) AS n FROM claim_evidence`).get() as { n: number }).n).toBe(0);
      expect(computeErasureInventory(s.db, { kind: "source", value: CONTENT_ID }).classes).toHaveLength(0);
    } finally { s.close(); }
  });

  it("an UNAUTHORIZED purge (broker refusal) erases NOTHING (refused before any deletion)", async () => {
    const s = storeWith([sourceNote(), claimNote()]);
    try {
      const refusing = { authorizeTombstone: async () => { throw Object.assign(new Error("denied"), { code: "authz.signer_not_permitted" }); } };
      await expect(applyErasure(s.db, { kind: "source", value: CONTENT_ID }, refusing)).rejects.toThrow(/denied/);
      // Fail-closed: the projection is untouched.
      expect((s.db.prepare(`SELECT COUNT(*) AS n FROM content_blobs`).get() as { n: number }).n).toBe(1);
      expect((s.db.prepare(`SELECT COUNT(*) AS n FROM claim_evidence`).get() as { n: number }).n).toBe(1);
    } finally { s.close(); }
  });

  it("a note purge erases the note + owned claims/evidence/links, verified", async () => {
    const s = storeWith([sourceNote(), claimNote()]);
    try {
      await applyErasure(s.db, { kind: "note", value: "note-a" }, { authorizeTombstone: async () => {} });
      expect((s.db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE note_id='note-a'`).get() as { n: number }).n).toBe(0);
      expect((s.db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE owning_note_id='note-a'`).get() as { n: number }).n).toBe(0);
      // The source blob (a different selector) is untouched.
      expect((s.db.prepare(`SELECT COUNT(*) AS n FROM content_blobs`).get() as { n: number }).n).toBe(1);
    } finally { s.close(); }
  });

  void ErasureError;
});
