/**
 * `store-vault` (Task 4.11) — the production ValidationVault resolves note/identity/provenance
 * facts from the SQLite projections, so a ChangePlan validates against the real current vault
 * state. (The v1 claim/evidence resolvers were retired with the claims model — #337.)
 */
import { describe, expect, it } from "vitest";
import { normalizeIdentityKey, type ParsedNote, type VaultSnapshot } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { makeStoreValidationVault } from "../src/validation/store-vault.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;

function makeNote(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return { id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active", created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over };
}
function sourceNote(): ParsedNote {
  const raw = ["---", "id: s-a", "type: source", "schema_version: 1", "title: s-a", "created: 2026-07-11", "updated: 2026-07-11",
    `contentId: "${CONTENT_A}"`, "origin: notes/a.txt", "provenance:", "  vault_path: sources/a.txt", "  size_bytes: 12", "  renditions:",
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`, "---", "", "# s-a", ""].join("\n");
  return makeNote(raw, { type: "source", id: "s-a", path: "sources/s-a.md" });
}
function claimNote(): ParsedNote {
  const raw = ["---", "id: note-a", "type: concept", "schema_version: 1", "title: note-a", "created: 2026-07-11", "updated: 2026-07-11", "aliases:", "  - Alpha Note", "claims:",
    "  - claim_id: claim-a", '    text: "A."', "    evidence:", `      - rendition: "${CONTENT_A}:1:1"`, "        verification: pending", "---", "", "# note-a", ""].join("\n");
  return makeNote(raw, { id: "note-a", path: "note-a.md", aliases: ["Alpha Note"] });
}
function storeWith(notes: ParsedNote[]): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  rebuildProjections(s.db, { notes, errors: [] } as VaultSnapshot);
  return s;
}

describe("store-backed ValidationVault (Task 4.11)", () => {
  it("resolves notes and provenance from the projections", () => {
    const s = storeWith([sourceNote(), claimNote()]);
    try {
      const v = makeStoreValidationVault(s.db);
      expect(v.hasNoteId("note-a")).toBe(true);
      expect(v.hasNoteId("does-not-exist")).toBe(false);
      expect(v.hasSourceRef(`${CONTENT_A}:1:1`)).toBe(true);
      expect(v.hasSourceRef(`sha256:${"c".repeat(64)}:text/plain:1:1`)).toBe(false);
      expect(v.hasSourceRef("garbage")).toBe(false);
    } finally { s.close(); }
  });

  it("reports identity-key owners (id/slug/alias)", () => {
    const s = storeWith([sourceNote(), claimNote()]);
    try {
      const v = makeStoreValidationVault(s.db);
      // The note owns its id key + its alias key (queried by the normalized key).
      expect(v.identityOwners(normalizeIdentityKey("note-a"))).toContain("note-a");
      expect(v.identityOwners(normalizeIdentityKey("Alpha Note"))).toContain("note-a");
      expect(v.identityOwners(normalizeIdentityKey("nonexistent-key"))).toEqual([]);
    } finally { s.close(); }
  });
});
