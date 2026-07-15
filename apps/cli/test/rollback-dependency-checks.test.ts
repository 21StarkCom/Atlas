/**
 * `rollback-dependency-checks` (Task 4.9) — the rollback operation-class classifier + the
 * rendition dependency enumeration: a capture whose rendition nothing cites is `capture-only`;
 * a capture whose rendition IS cited by current evidence is refused `has-dependents` (listing
 * the dependents); a synthesis run is `self-contained`.
 */
import { describe, expect, it } from "vitest";
import type { ContentId, ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { classifyRollback, renditionDependents, type RunToRollback } from "../src/workflows/rollback.js";

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
  const raw = [
    "---", "id: s-a", "type: source", "schema_version: 1", "title: s-a",
    "created: 2026-07-11", "updated: 2026-07-11",
    `contentId: "${CONTENT_A}"`, "origin: notes/a.txt", "provenance:",
    "  vault_path: sources/a.txt", "  size_bytes: 12", "  renditions:",
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
    "---", "", "# s-a", "",
  ].join("\n");
  return makeNote(raw, { type: "source", id: "s-a", path: "sources/s-a.md" });
}

function claimNote(): ParsedNote {
  const raw = [
    "---", "id: note-a", "type: concept", "schema_version: 1", "title: note-a",
    "created: 2026-07-11", "updated: 2026-07-11", "claims:",
    "  - claim_id: claim-a", '    text: "A."', "    evidence:",
    `      - rendition: "${CONTENT_A}:1:1"`, "        verification: pending",
    "---", "", "# note-a", "",
  ].join("\n");
  return makeNote(raw, { id: "note-a", path: "note-a.md" });
}

function snap(notes: ParsedNote[]): VaultSnapshot {
  return { notes, errors: [] };
}

function storeWith(notes: ParsedNote[]): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  rebuildProjections(s.db, snap(notes));
  return s;
}

describe("rollback dependency checks (Task 4.9)", () => {
  it("a capture whose rendition nothing cites → capture-only", () => {
    const s = storeWith([sourceNote()]);
    try {
      const run: RunToRollback = { runId: "run-cap", operation: "source-add", producedRendition: CONTENT_ID };
      const cls = classifyRollback(run, { dependentsOf: () => renditionDependents(s.db, CONTENT_ID) });
      expect(cls).toEqual({ kind: "rollback", rollbackClass: "capture-only" });
    } finally {
      s.close();
    }
  });

  it("a capture whose rendition IS cited by current evidence → has-dependents (listed)", () => {
    const s = storeWith([sourceNote(), claimNote()]);
    try {
      const run: RunToRollback = { runId: "run-cap", operation: "ingest", producedRendition: CONTENT_ID };
      const deps = renditionDependents(s.db, CONTENT_ID);
      expect(deps).toEqual(["claim-a"]);
      const cls = classifyRollback(run, { dependentsOf: () => deps });
      expect(cls).toEqual({ kind: "has-dependents", dependents: ["claim-a"] });
    } finally {
      s.close();
    }
  });

  it("a synthesis run with no dependents → self-contained", () => {
    const run: RunToRollback = { runId: "run-syn", operation: "enrich" };
    const cls = classifyRollback(run, { dependentsOf: () => [] });
    expect(cls).toEqual({ kind: "rollback", rollbackClass: "self-contained" });
  });
});
