/**
 * `rebuild-from-git` (Task 4.11) — DR rebuild from canonical Markdown surfaces every gap and
 * never silently drops: a clean vault rebuilds its projections (with the ledger classes reported
 * as always-present gaps); a tampered/unreadable file becomes a named data-loss gap while the
 * clean subset still rebuilds.
 */
import { describe, expect, it } from "vitest";
import type { ParsedNote, VaultError, VaultSnapshot } from "@atlas/contracts";
import { openStore, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { rebuildFromGit } from "../src/workflows/rebuild-from-git.js";

function makeNote(id: string, links: string[] = []): ParsedNote {
  const raw = `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n# ${id}\n`;
  const { body } = splitFrontmatter(raw);
  return {
    id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal",
    links: links.map((t) => ({ target: t, raw: `[[${t}]]` })) as ParsedNote["links"], sections: buildSectionTree(body), contentHash: "sha256:0", raw,
  };
}

function store(): Store {
  const s = openStore({ path: ":memory:" });
  s.migrate();
  return s;
}

describe("rebuild from git (DR, Task 4.11)", () => {
  it("rebuilds projections from a clean vault; the ledger classes are always-present gaps", () => {
    const s = store();
    try {
      const snap: VaultSnapshot = { notes: [makeNote("a"), makeNote("b")], errors: [] };
      const report = rebuildFromGit(s.db, snap);
      expect(report.rebuilt.notes).toBe(2);
      expect(report.clean).toBe(true); // no data-loss gaps from the vault
      // The three ledger/audit classes are reported (recoverable only from the audit ref/backup).
      const classes = report.gaps.map((g) => g.storageClass);
      expect(classes).toContain("agent_runs");
      expect(classes).toContain("audit_events");
      expect(classes).toContain("workflow_idempotency");
      // The projection was actually written.
      const n = s.db.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number };
      expect(n.n).toBe(2);
    } finally {
      s.close();
    }
  });

  it("surfaces a tampered/unreadable file as a data-loss gap and still rebuilds the clean subset", () => {
    const s = store();
    try {
      const err: VaultError = { path: "corrupt.md", kind: "parse-error", message: "bad frontmatter" };
      const snap: VaultSnapshot = { notes: [makeNote("a")], errors: [err] };
      const report = rebuildFromGit(s.db, snap);
      expect(report.clean).toBe(false); // a vault gap requires operator attention
      expect(report.gaps.some((g) => g.storageClass === "notes" && g.detail?.includes("corrupt.md"))).toBe(true);
      // The clean note still rebuilt (best-effort, never all-or-nothing on DR).
      expect(report.rebuilt.notes).toBe(1);
    } finally {
      s.close();
    }
  });
});
