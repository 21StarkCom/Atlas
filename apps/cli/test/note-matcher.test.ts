/**
 * The shared note-matcher (60-A task 1.1) — the ONE discovery filter.
 *
 * Unit-tests `matchesNoteGlobs`/`noteGlobPathspec`, then proves the CLI VaultSnapshot
 * builder (`readVault`) honours `vault.note_globs`: with `['notes/**\/*.md']`,
 * `docs/x.md` never enters the snapshot (neither as a note nor as a parse error).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesNoteGlobs, noteGlobPathspec } from "../src/vault/note-matcher.js";
import { loadConfig } from "../src/config/load.js";
import { readVault } from "../src/vault/reader.js";
import type { AtlasConfig } from "../src/config/schema.js";

describe("matchesNoteGlobs", () => {
  it("['**/*.md'] matches any .md at any depth, not other extensions", () => {
    const g = ["**/*.md"];
    expect(matchesNoteGlobs("x.md", g)).toBe(true);
    expect(matchesNoteGlobs("a/b/c.md", g)).toBe(true);
    expect(matchesNoteGlobs("a/b.txt", g)).toBe(false);
    expect(matchesNoteGlobs("a/b.markdown", g)).toBe(false);
  });

  it("a subtree glob narrows to its subtree", () => {
    const g = ["notes/**/*.md"];
    expect(matchesNoteGlobs("notes/x.md", g)).toBe(true);
    expect(matchesNoteGlobs("notes/deep/y.md", g)).toBe(true);
    expect(matchesNoteGlobs("docs/x.md", g)).toBe(false);
    expect(matchesNoteGlobs("x.md", g)).toBe(false);
  });

  it("`*` stays within a segment; `?` is one non-separator char", () => {
    expect(matchesNoteGlobs("a.md", ["*.md"])).toBe(true);
    expect(matchesNoteGlobs("a/b.md", ["*.md"])).toBe(false); // no dir crossing
    expect(matchesNoteGlobs("ab.md", ["?b.md"])).toBe(true);
    expect(matchesNoteGlobs("a/b.md", ["?b.md"])).toBe(false);
  });

  it("matches ANY of several globs; empty list matches nothing", () => {
    expect(matchesNoteGlobs("docs/x.md", ["notes/**/*.md", "docs/**/*.md"])).toBe(true);
    expect(matchesNoteGlobs("x.md", [])).toBe(false);
  });

  it("noteGlobPathspec wraps each glob in :(glob) magic", () => {
    expect(noteGlobPathspec(["notes/**/*.md", "*.md"])).toEqual([":(glob)notes/**/*.md", ":(glob)*.md"]);
  });
});

describe("readVault honours vault.note_globs", () => {
  const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
  const EXAMPLE = readFileSync(join(REPO_ROOT, "brain.config.example.yaml"), "utf8");
  let dir: string;
  let vault: string;

  const note = (title: string, id: string): string =>
    `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${title}\ncreated: 2026-07-11\nupdated: 2026-07-11\ndeclaredSensitivity: internal\nsources: []\n---\n\n# ${title}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atlas-notematch-"));
    vault = join(dir, "vault");
    mkdirSync(join(vault, "notes"), { recursive: true });
    mkdirSync(join(vault, "docs"), { recursive: true });
    writeFileSync(join(vault, "notes", "alpha.md"), note("Alpha", "alpha"), "utf8");
    // Deliberately frontmatter-less: if the glob wrongly enumerated it, readVault
    // would surface a parse ERROR for docs/x.md — so its absence proves exclusion.
    writeFileSync(join(vault, "docs", "x.md"), "# not a note\n", "utf8");
    writeFileSync(join(dir, "brain.config.yaml"), EXAMPLE, "utf8");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function configWith(globs: string[]): AtlasConfig {
    const cfg = loadConfig(dir, {}).config;
    return { ...cfg, vault: { ...cfg.vault, path: vault, note_globs: globs } };
  }

  it("['notes/**/*.md'] excludes docs/x.md from the snapshot entirely", async () => {
    const snap = await readVault(configWith(["notes/**/*.md"]));
    expect(snap.notes.map((n) => n.path)).toEqual(["notes/alpha.md"]);
    expect(snap.notes.some((n) => n.path === "docs/x.md")).toBe(false);
    expect(snap.errors.some((e) => e.path === "docs/x.md")).toBe(false);
  });

  it("the default ['**/*.md'] would instead see docs/x.md (as a parse error)", async () => {
    const snap = await readVault(configWith(["**/*.md"]));
    // Proves the exclusion above is glob-driven, not incidental.
    expect(snap.errors.some((e) => e.path === "docs/x.md")).toBe(true);
  });
});
