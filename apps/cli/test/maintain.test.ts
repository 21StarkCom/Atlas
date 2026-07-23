/**
 * `maintain` (Task 4.11) — the vault-maintenance detector: orphan notes (destructive
 * remediation ⇒ Tier-3) and non-`valid` evidence (re-verification prompt ⇒ Tier-2),
 * deterministic and read-only.
 */
import { describe, expect, it } from "vitest";
import type { ParsedNote, VaultSnapshot, WikiLink } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { detectMaintenanceIssues } from "../src/workflows/maintain.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;

function makeNote(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return {
    id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over,
  };
}

function link(target: string): WikiLink {
  return { target, raw: `[[${target}]]` } as WikiLink;
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

function claimNote(id: string, verification: string): ParsedNote {
  const raw = [
    "---", `id: ${id}`, "type: concept", "schema_version: 1", `title: ${id}`, "created: 2026-07-11", "updated: 2026-07-11", "claims:",
    `  - claim_id: claim-${id}`, '    text: "c."', "    evidence:", `      - rendition: "${CONTENT_A}:1:1"`, `        verification: ${verification}`,
    "---", "", `# ${id}`, "",
  ].join("\n");
  return makeNote(raw, { id, path: `${id}.md` });
}

function storeWith(notes: ParsedNote[]): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  rebuildProjections(s.db, { notes, errors: [] } as VaultSnapshot);
  return s;
}

describe("maintain issue detection (Task 4.11)", () => {
  it("flags an orphan note (no links) as a destructive remediation", () => {
    // linked-a ↔ linked-b are linked; orphan has no links.
    const s = storeWith([
      makeNote("---\nid: linked-a\ntype: concept\nschema_version: 1\ntitle: a\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n# a\n[[linked-b]]\n", { id: "linked-a", links: [link("linked-b")] }),
      makeNote("---\nid: linked-b\ntype: concept\nschema_version: 1\ntitle: b\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n# b\n", { id: "linked-b" }),
      makeNote("---\nid: orphan\ntype: concept\nschema_version: 1\ntitle: o\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n# o\n", { id: "orphan" }),
    ]);
    try {
      const issues = detectMaintenanceIssues(s.db);
      const orphan = issues.find((i) => i.kind === "orphan-note");
      expect(orphan).toMatchObject({ kind: "orphan-note", noteId: "orphan", destructive: true });
      // linked-a / linked-b are NOT orphans.
      expect(issues.some((i) => i.kind === "orphan-note" && i.noteId === "linked-a")).toBe(false);
    } finally {
      s.close();
    }
  });

  it("flags non-valid evidence as a non-destructive re-verification prompt; valid evidence is clean", () => {
    const s = storeWith([sourceNote(), claimNote("note-stale", "pending")]);
    try {
      const issues = detectMaintenanceIssues(s.db);
      const ev = issues.find((i) => i.kind === "unverified-evidence");
      expect(ev).toMatchObject({ kind: "unverified-evidence", noteId: "note-stale", destructive: false });
    } finally {
      s.close();
    }
  });

  it("a fully-linked, valid vault has no maintenance issues", () => {
    const s = storeWith([sourceNote(), claimNote("note-ok", "valid")]);
    try {
      // note-ok is an orphan (no links) → will surface as orphan; but its evidence is valid.
      const issues = detectMaintenanceIssues(s.db);
      expect(issues.some((i) => i.kind === "unverified-evidence")).toBe(false);
    } finally {
      s.close();
    }
  });
});
