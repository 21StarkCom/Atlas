/**
 * `store-vault` (Task 4.11) — the production ValidationVault resolves note/identity/source
 * facts from the SQLite projections + the operational `source` registry, so a ChangePlan
 * validates against the real current vault state. v2 (#340): `hasSourceRef` resolves a
 * `sources:` id against the flat `source` REGISTRY (`0015_source_registry`), NOT the retired
 * v1 content-addressed provenance model. (The v1 claim/evidence resolvers were retired with
 * the claims model — #337.)
 */
import { describe, expect, it } from "vitest";
import { normalizeIdentityKey, type ParsedNote, type VaultSnapshot } from "@atlas/contracts";
import { openStore, rebuildProjections, SourceRepo, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { makeStoreValidationVault } from "../src/validation/store-vault.js";

function makeNote(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return { id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active", created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over };
}
function aliasedNote(): ParsedNote {
  const raw = ["---", "id: note-a", "type: concept", "schema_version: 1", "title: note-a", "created: 2026-07-11", "updated: 2026-07-11", "aliases:", "  - Alpha Note", "---", "", "# note-a", ""].join("\n");
  return makeNote(raw, { id: "note-a", path: "note-a.md", aliases: ["Alpha Note"] });
}
function storeWith(notes: ParsedNote[]): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  rebuildProjections(s.db, { notes, errors: [] } as VaultSnapshot);
  return s;
}

describe("store-backed ValidationVault (Task 4.11)", () => {
  it("resolves notes + `sources:` ids from the projections and the source registry", () => {
    const s = storeWith([aliasedNote()]);
    try {
      // Seed the operational `source` registry (what `source add`/`ingest` write).
      new SourceRepo(s.db).insert({ id: "src-abc", kind: "file", locator: "/inbox/a.md", addedAt: "2026-07-23T00:00:00Z" });
      const v = makeStoreValidationVault(s.db);
      expect(v.hasNoteId("note-a")).toBe(true);
      expect(v.hasNoteId("does-not-exist")).toBe(false);
      // v2 (#340): hasSourceRef resolves a `sources:` id against the `source` REGISTRY.
      expect(v.hasSourceRef("src-abc")).toBe(true);
      // An unknown id and a legacy v1 content handle both resolve to no registry row
      // (non-fatal — the validator never blocks on a dangling `sources:` ref).
      expect(v.hasSourceRef("src-unknown")).toBe(false);
      expect(v.hasSourceRef("sha256:cccc:text/plain:1:1")).toBe(false);
    } finally { s.close(); }
  });

  it("reports identity-key owners (id/slug/alias)", () => {
    const s = storeWith([aliasedNote()]);
    try {
      const v = makeStoreValidationVault(s.db);
      // The note owns its id key + its alias key (queried by the normalized key).
      expect(v.identityOwners(normalizeIdentityKey("note-a"))).toContain("note-a");
      expect(v.identityOwners(normalizeIdentityKey("Alpha Note"))).toContain("note-a");
      expect(v.identityOwners(normalizeIdentityKey("nonexistent-key"))).toEqual([]);
    } finally { s.close(); }
  });
});
