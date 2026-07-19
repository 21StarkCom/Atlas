/**
 * resolve-at-ref — the CLI-side note resolver `resolveAtRef(repo, ref)` (60-B Task
 * 2.2b), the caller-supplied resolver `foldNotesForPaths` drives. Exercises it
 * against a REAL git repo with committed note blobs:
 *   - resolves a note's ParsedNote by id at a ref (id != filename supported);
 *   - returns null for a note absent at the ref (deleted/renamed away ⇒ archive);
 *   - resolves against the OLD ref independently of the working tree / newer refs;
 *   - skips non-note blobs (no valid frontmatter) and honors note globs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRepo } from "@atlas/git";
import { resolveAtRef } from "../src/sync/resolve-at-ref.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function git(d: string, args: string[]): string {
  return execFileSync("git", args, { cwd: d, encoding: "utf8" }).trim();
}

function note(id: string, title: string): string {
  return `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${title}\ncreated: 2026-07-11\nupdated: 2026-07-11\ndeclaredSensitivity: internal\nsources: []\n---\n\n# ${title}\n\nBody of ${title}.\n`;
}

function initRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "atlas-resolve-"));
  git(d, ["init", "--initial-branch=main"]);
  git(d, ["config", "user.email", "test@test"]);
  git(d, ["config", "user.name", "Test"]);
  return d;
}

function write(d: string, rel: string, content: string): void {
  const abs = join(d, rel);
  const slash = abs.lastIndexOf("/");
  if (slash > 0) mkdirSync(abs.slice(0, slash), { recursive: true });
  writeFileSync(abs, content);
}

function commitAll(d: string, msg: string): string {
  git(d, ["add", "-A"]);
  git(d, ["commit", "-m", msg, "--author=Test <test@test>", "--date=2020-01-01T00:00:00Z"]);
  return git(d, ["rev-parse", "HEAD"]);
}

describe("resolveAtRef", () => {
  it("resolves a note's ParsedNote by id at a ref (id independent of filename)", () => {
    dir = initRepo();
    // Filename deliberately DIFFERS from the note id.
    write(dir, "concepts/alpha-file.md", note("note-alpha", "Alpha"));
    write(dir, "beta.md", note("note-beta", "Beta"));
    const head = commitAll(dir, "two notes");

    const resolve = resolveAtRef(openRepo(dir), head);
    const alpha = resolve("note-alpha");
    expect(alpha).not.toBeNull();
    expect(alpha).toMatchObject({ id: "note-alpha", path: "concepts/alpha-file.md", title: "Alpha", type: "concept" });
    expect(alpha!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(resolve("note-beta")).toMatchObject({ id: "note-beta", path: "beta.md" });
    expect(resolve("no-such-note")).toBeNull();
  });

  it("returns null for a note deleted at the ref (archive signal)", () => {
    dir = initRepo();
    write(dir, "a.md", note("note-a", "A"));
    write(dir, "b.md", note("note-b", "B"));
    const first = commitAll(dir, "a + b");

    rmSync(join(dir, "b.md"));
    const second = commitAll(dir, "drop b");

    // At the FIRST ref, note-b still resolves.
    expect(resolveAtRef(openRepo(dir), first)("note-b")).toMatchObject({ id: "note-b" });
    // At the SECOND ref, it is gone ⇒ null (fold will archive it).
    expect(resolveAtRef(openRepo(dir), second)("note-b")).toBeNull();
    // note-a still present at head.
    expect(resolveAtRef(openRepo(dir), second)("note-a")).toMatchObject({ id: "note-a" });
  });

  it("follows a rename (same id, new path) at the newer ref", () => {
    dir = initRepo();
    write(dir, "old/name.md", note("note-x", "X"));
    const first = commitAll(dir, "x at old path");
    mkdirSync(join(dir, "new"), { recursive: true }); // git mv does not create the target dir
    git(dir, ["mv", "old/name.md", "new/renamed.md"]);
    const second = commitAll(dir, "rename x");

    expect(resolveAtRef(openRepo(dir), first)("note-x")).toMatchObject({ path: "old/name.md" });
    expect(resolveAtRef(openRepo(dir), second)("note-x")).toMatchObject({ path: "new/renamed.md" });
  });

  it("skips non-note blobs and honors note globs", () => {
    dir = initRepo();
    write(dir, "real.md", note("note-real", "Real"));
    write(dir, "README.md", "# Just prose, no frontmatter\n"); // .md but not a note
    write(dir, "notes/scoped.md", note("note-scoped", "Scoped"));
    const head = commitAll(dir, "mixed");

    // Default globs (**/*.md): README has no frontmatter ⇒ not resolvable.
    const all = resolveAtRef(openRepo(dir), head);
    expect(all("note-real")).toMatchObject({ id: "note-real" });
    expect(all("note-scoped")).toMatchObject({ id: "note-scoped" });

    // Scoped globs: only notes/** count — note-real is out of scope now.
    const scoped = resolveAtRef(openRepo(dir), head, ["notes/**/*.md"]);
    expect(scoped("note-scoped")).toMatchObject({ id: "note-scoped" });
    expect(scoped("note-real")).toBeNull();
  });

  it("returns null for every id when the ref does not resolve", () => {
    dir = initRepo();
    write(dir, "a.md", note("note-a", "A"));
    commitAll(dir, "a");
    const resolve = resolveAtRef(openRepo(dir), "refs/atlas/does-not-exist");
    expect(resolve("note-a")).toBeNull();
  });
});
