/**
 * `sync/resolve-at-ref` — the CLI-side note resolver for the incremental projection
 * fold (60-B Task 2.2b).
 *
 * `foldNotesForPaths` (in `@atlas/sqlite-store`) reconciles the `notes` projection
 * for a set of note ids but takes a caller-supplied resolver so the store package
 * stays a leaf with NO git and NO parser dependency (D14). `resolveAtRef` is that
 * resolver: given the vault repo + a git ref, it returns `(noteId) => ParsedNote |
 * null` — reading the note's blob at the ref and parsing it (active) or returning
 * `null` when the note no longer resolves there (deleted/renamed away ⇒ archive).
 *
 * A note's frontmatter `id` need not match its path (a rename keeps the id, moves
 * the path — Phase 4's rename case), so resolution can't assume `noteId → path`.
 * The factory therefore builds a `id → ParsedNote` index over the note blobs AT THE
 * REF once (lazily, cached in the closure) and serves every lookup from it. Blobs
 * are read through the system `git` binary (`@atlas/git` keeps `runGit` unexported
 * and `Repo` exposes no blob read), scoped to `repo.dir`.
 */
import { execFileSync } from "node:child_process";
import type { ParsedNote } from "@atlas/contracts";
import type { Repo } from "@atlas/git";
import { parseNote } from "../vault/reader.js";
import { matchesNoteGlobs } from "../vault/note-matcher.js";

const MAX_BLOB_BYTES = 64 * 1024 * 1024; // mirror @atlas/git runGit maxBuffer

/** Read a value from git at `repo.dir`, or `null` on any git failure (unresolved
 * ref, missing path, non-repo) — the resolver treats "can't read" as "not there". */
function git(repo: Repo, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo.dir, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_BLOB_BYTES,
    });
  } catch {
    return null;
  }
}

/**
 * Build a note resolver bound to `repo` at `ref`. `globs` scopes which tree paths
 * count as notes (defaults to `**\/*.md`; Phase 4 passes `config.vault.note_globs`).
 * The `id → ParsedNote` index is built on first lookup and cached, so a fold over N
 * ids scans the ref's note tree exactly once.
 */
export function resolveAtRef(
  repo: Repo,
  ref: string,
  globs: readonly string[] = ["**/*.md"],
): (noteId: string) => ParsedNote | null {
  let index: Map<string, ParsedNote> | undefined;

  const build = (): Map<string, ParsedNote> => {
    const m = new Map<string, ParsedNote>();
    // NUL-separated so paths with spaces/newlines survive intact.
    const listing = git(repo, ["ls-tree", "-r", "-z", "--name-only", ref]);
    if (listing === null) return m; // ref does not resolve / not a repo ⇒ nothing resolvable
    for (const rel of listing.split("\0")) {
      if (rel.length === 0 || !matchesNoteGlobs(rel, globs)) continue;
      const raw = git(repo, ["cat-file", "blob", `${ref}:${rel}`]);
      if (raw === null) continue;
      const parsed = parseNote(rel, raw);
      // A blob that fails to parse (no/invalid frontmatter) is not a resolvable
      // note — skip it, exactly as the working-tree reader collects it as an error
      // and never emits a note. A duplicate id keeps the FIRST (sorted) path, which
      // git ls-tree already orders deterministically.
      if (parsed.ok && !m.has(parsed.note.id)) m.set(parsed.note.id, parsed.note);
    }
    return m;
  };

  return (noteId: string): ParsedNote | null => {
    if (index === undefined) index = build();
    return index.get(noteId) ?? null;
  };
}
