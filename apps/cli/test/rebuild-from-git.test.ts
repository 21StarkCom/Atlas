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

function makeNote(id: string, links: string[] = [], opts: { path?: string; aliases?: string[] } = {}): ParsedNote {
  const path = opts.path ?? `${id}.md`;
  const raw = `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n# ${id}\n`;
  const { body } = splitFrontmatter(raw);
  return {
    id, path, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-11", updated: "2026-07-11", aliases: opts.aliases ?? [], sources: [], declaredSensitivity: "internal",
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

  it("#147: a pairwise IDENTITY-KEY collision drops both offenders as gaps and rebuilds the rest", () => {
    const s = store();
    try {
      // Two DISTINCT notes (distinct ids/paths) that each individually parse, but
      // both alias-claim the same normalized key `<slug>` — exactly the template
      // stubs that crashed the live drive with a raw note_identity_keys PK violation.
      const person = makeNote("person-tmpl", [], { path: "Templates/person.md", aliases: ["<slug>"] });
      const project = makeNote("project-tmpl", [], { path: "Templates/project.md", aliases: ["<slug>"] });
      const clean1 = makeNote("keeper-1");
      const clean2 = makeNote("keeper-2");
      const snap: VaultSnapshot = { notes: [person, project, clean1, clean2], errors: [] };
      const report = rebuildFromGit(s.db, snap); // must NOT throw
      // Both colliding notes are gaps; neither is silently kept.
      const collisionGaps = report.gaps.filter((g) => g.storageClass === "note_identity_keys");
      expect(collisionGaps.length).toBe(2);
      // The gap detail names the NORMALIZED key (`<slug>` → `slug`) that collided.
      expect(collisionGaps.every((g) => g.detail?.includes("`slug`"))).toBe(true);
      expect(report.clean).toBe(false); // data-loss gap
      // The two clean notes still rebuilt.
      expect(report.rebuilt.notes).toBe(2);
      const rows = s.db.prepare(`SELECT note_id FROM notes ORDER BY note_id`).all() as { note_id: string }[];
      expect(rows.map((r) => r.note_id)).toEqual(["keeper-1", "keeper-2"]);
    } finally {
      s.close();
    }
  });

  it("#147: a duplicate note_id collision drops both offenders as gaps and rebuilds the rest", () => {
    const s = store();
    try {
      // Same note_id from two different paths (notes PK conflict).
      const a = makeNote("dup", [], { path: "a/dup.md" });
      const b = makeNote("dup", [], { path: "b/dup.md" });
      const clean = makeNote("solo");
      const snap: VaultSnapshot = { notes: [a, b, clean], errors: [] };
      const report = rebuildFromGit(s.db, snap); // must NOT throw
      const idGaps = report.gaps.filter((g) => g.storageClass === "notes" && g.detail?.includes("note id"));
      expect(idGaps.length).toBe(2);
      expect(report.rebuilt.notes).toBe(1);
      expect((s.db.prepare(`SELECT note_id FROM notes`).get() as { note_id: string }).note_id).toBe("solo");
    } finally {
      s.close();
    }
  });
});
