/**
 * `purge-inventory` (Task 4.10) — the default-safe erasure-inventory resolver: it enumerates
 * the rows a selector would erase across storage classes in normative purge order (dependents
 * first, ledger/audit last + tombstone-only), and stamps a deterministic digest. Non-mutating.
 */
import { describe, expect, it } from "vitest";
import type { ContentId, ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
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
  const raw = [
    "---", "id: s-a", "type: source", "schema_version: 1", "title: s-a", "created: 2026-07-11", "updated: 2026-07-11",
    `contentId: "${CONTENT_A}"`, "origin: notes/a.txt", "provenance:", "  vault_path: sources/a.txt", "  size_bytes: 12", "  renditions:",
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
    "---", "", "# s-a", "",
  ].join("\n");
  return makeNote(raw, { type: "source", id: "s-a", path: "sources/s-a.md" });
}

function claimNote(): ParsedNote {
  const raw = [
    "---", "id: note-a", "type: concept", "schema_version: 1", "title: note-a", "created: 2026-07-11", "updated: 2026-07-11", "claims:",
    "  - claim_id: claim-a", '    text: "A."', "    evidence:", `      - rendition: "${CONTENT_A}:1:1"`, "        verification: pending",
    "---", "", "# note-a", "",
  ].join("\n");
  return makeNote(raw, { id: "note-a", path: "note-a.md" });
}

function storeWith(notes: ParsedNote[]): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  rebuildProjections(s.db, { notes, errors: [] } as VaultSnapshot);
  return s;
}

describe("purge erasure inventory (Task 4.10)", () => {
  it("a source selector enumerates the provenance chain + dependents in purge order, audit last", () => {
    const s = storeWith([sourceNote(), claimNote()]);
    try {
      const inv = computeErasureInventory(s.db, { kind: "source", value: CONTENT_ID });
      const order = inv.classes.map((c) => c.storageClass);
      // Dependents (evidence) precede provenance children precede the blob; audit is LAST.
      expect(order.indexOf("claim_evidence")).toBeLessThan(order.indexOf("source_renditions"));
      expect(order.indexOf("source_renditions")).toBeLessThan(order.indexOf("content_blobs"));
      expect(order[order.length - 1]).toBe("audit_events");
      expect(inv.classes.find((c) => c.storageClass === "audit_events")!.disposition).toBe("tombstone");
      expect(inv.classes.find((c) => c.storageClass === "content_blobs")!.disposition).toBe("hard");
      expect(inv.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      s.close();
    }
  });

  it("a note selector enumerates owned claims + evidence + links, note last before audit", () => {
    const s = storeWith([sourceNote(), claimNote()]);
    try {
      const inv = computeErasureInventory(s.db, { kind: "note", value: "note-a" });
      const order = inv.classes.map((c) => c.storageClass);
      expect(order).toContain("claims");
      expect(order.indexOf("claim_evidence")).toBeLessThan(order.indexOf("claims"));
      expect(order.indexOf("notes")).toBeLessThan(order.indexOf("audit_events"));
    } finally {
      s.close();
    }
  });

  it("is deterministic: the same selector + state yields the same digest", () => {
    const a = storeWith([sourceNote(), claimNote()]);
    const b = storeWith([sourceNote(), claimNote()]);
    try {
      expect(computeErasureInventory(a.db, { kind: "source", value: CONTENT_ID }).digest).toBe(
        computeErasureInventory(b.db, { kind: "source", value: CONTENT_ID }).digest,
      );
    } finally {
      a.close();
      b.close();
    }
  });

  it("an empty selector match yields no classes (nothing to erase, no audit tombstone)", () => {
    const s = storeWith([sourceNote()]);
    try {
      const inv = computeErasureInventory(s.db, { kind: "note", value: "does-not-exist" });
      expect(inv.classes).toHaveLength(0);
    } finally {
      s.close();
    }
  });
});
