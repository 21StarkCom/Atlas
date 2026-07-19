/**
 * `vault/note-matcher` — the ONE place that decides whether a vault-relative path
 * is a note (60-A task 1.1).
 *
 * Before adoption, note discovery was a hardcoded `.md` suffix check duplicated in
 * the vault reader. Adoption of a real vault needs to narrow discovery to a subtree
 * (e.g. `notes/**\/*.md`) so operational/config markdown never enters the projection.
 * `vault.note_globs` (config) is the SSOT; this module is the single matcher the CLI
 * VaultSnapshot builder and any git-tree discovery consume — never an inlined filter.
 *
 * Paths are matched as POSIX, vault-relative (`sep`-normalized by the caller). Glob
 * syntax is the familiar subset: `**` (any number of path segments, incl. zero), `*`
 * (any run WITHIN a segment), `?` (one non-separator char); everything else is literal.
 */

/** Translate one glob to an anchored RegExp over a POSIX path. */
function globToRegExp(glob: string): RegExp {
  const chars = [...glob];
  let re = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "*") {
      if (chars[i + 1] === "*") {
        // `**` — a globstar. `**/` collapses to "zero or more path segments";
        // a trailing `**` matches anything (including further separators).
        i++;
        if (chars[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)*";
        } else {
          re += ".*";
        }
      } else {
        // A single `*` stays within one path segment.
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Cache compiled matchers so a rebuild over thousands of files compiles each glob once. */
const cache = new Map<string, RegExp>();
function matcherFor(glob: string): RegExp {
  let re = cache.get(glob);
  if (re === undefined) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re;
}

/**
 * True iff `relPath` (vault-relative, POSIX) matches ANY of `globs`. An empty glob
 * list matches nothing (the config schema guarantees ≥ 1, so this is defensive).
 */
export function matchesNoteGlobs(relPath: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (matcherFor(g).test(relPath)) return true;
  }
  return false;
}

/**
 * The git pathspecs equivalent to `globs`, for a discovery pass that lists notes
 * from a git tree (`git ls-tree`/`ls-files`) rather than the working directory.
 * Each glob is wrapped in the `:(glob)` pathspec magic so git applies the SAME
 * `**`/`*` semantics as {@link matchesNoteGlobs}.
 */
export function noteGlobPathspec(globs: readonly string[]): string[] {
  return globs.map((g) => `:(glob)${g}`);
}
