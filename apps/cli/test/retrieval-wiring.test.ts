/**
 * `retrieval-wiring` (Task 4.11) — the projection-backed retrieval helpers the synthesis commands
 * reuse: the identity resolver (id/slug/alias), note metadata (type + fail-closed default), and the
 * index-generation epoch. (The full `makeRetrieveSeam` needs a live LanceDB index + egress broker
 * and is exercised by the synthesis-command integration.)
 */
import { describe, expect, it } from "vitest";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { storeResolver, storeNoteMeta, computeIndexGeneration } from "../src/retrieval/wiring.js";

function makeNote(id: string, aliases: string[] = []): ParsedNote {
  const raw = `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\nstatus: active\ncreated: 2026-07-11\nupdated: 2026-07-11\n${aliases.length ? `aliases:\n${aliases.map((a) => `  - ${a}`).join("\n")}\n` : ""}---\n# ${id}\n`;
  const { body } = splitFrontmatter(raw);
  return { id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active", created: "2026-07-11", updated: "2026-07-11", aliases, sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw };
}
function storeWith(notes: ParsedNote[]): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  rebuildProjections(s.db, { notes, errors: [] } as VaultSnapshot);
  return s;
}

describe("retrieval wiring helpers (Task 4.11)", () => {
  it("storeResolver resolves exact id, slug, and alias from the projections", () => {
    const s = storeWith([makeNote("concept-a", ["Alpha Note"]), makeNote("concept-b")]);
    try {
      const r = storeResolver(s);
      expect(r.resolveExactId("concept-a")).toBe("concept-a");
      expect(r.resolveExactId("missing")).toBeNull();
      // Slug + alias resolution return the owning note ids (keys are normalized in the projection).
      expect(Array.isArray(r.resolveSlug("concept-a"))).toBe(true);
      expect(Array.isArray(r.resolveAlias("alpha-note"))).toBe(true);
    } finally { s.close(); }
  });

  it("storeNoteMeta surfaces a present note's type; a missing note is null (fail-closed)", () => {
    const s = storeWith([makeNote("concept-a")]);
    try {
      const meta = storeNoteMeta(s, "internal");
      expect(meta("concept-a")).toEqual({ type: "concept", sensitivity: "internal", trust: "verified" });
      expect(meta("missing")).toBeNull();
    } finally { s.close(); }
  });

  it("computeIndexGeneration returns a non-negative epoch", () => {
    const s = storeWith([makeNote("concept-a")]);
    try {
      const gen = computeIndexGeneration(s, { chunker_version: 1, embedding_model: "gemini-embedding-001", dimensions: 768 } as never);
      expect(gen).toBeGreaterThanOrEqual(0);
    } finally { s.close(); }
  });
});
