/**
 * `workflows/capture-scope` — the path-scope gate of a Tier-1 capture commit
 * (v2, #334). Moved VERBATIM from the retired `@atlas/broker` (`src/refs.ts`) —
 * the broker process is gone, but the scope predicates survive as the
 * in-process integrator's containment check ({@link
 * import("./direct-integrator.js").makeDirectCaptureIntegration}): a capture
 * commit may only touch the paths its scope names, whoever installs it.
 */

/**
 * True iff `p` is an allowed source-capture path: anything under `sources/`, or a
 * capture manifest file (`manifest.json` / `manifest.yaml` / `manifest.yml`,
 * top-level or nested).
 */
export function isCaptureAllowedPath(p: string): boolean {
  if (p.startsWith("sources/")) return true;
  return /(^|\/)manifest\.(json|ya?ml)$/.test(p);
}

/**
 * The enforced scope of a Tier-1 capture commit (#262, #266):
 * - `"sources"` (default): any path under `sources/**` + capture manifests,
 *   adds AND updates (recaptures rewrite the observation manifest in place).
 * - `"note"`: authored-note ingest — ADDITIONS ONLY of `*.md` files OUTSIDE
 *   `sources/`, over the whole `base..commit` range.
 * - `"sync"`: the absorb-commit scope — may ADD/MODIFY/DELETE/RENAME `*.md`
 *   outside `sources/` (both sides of a rename path-validated).
 */
export type CaptureScope = "sources" | "note" | "sync";

/**
 * True iff `p` may be ADDED by a `"note"`-scoped capture: a markdown file
 * outside `sources/`, with no `.git` component and no traversal/absolute
 * segment. These checks are the ENFORCEMENT boundary (the CLI's `deriveDestPath`
 * is only advisory), done on the observed committed path, case-insensitively
 * (the vault may live on a case-insensitive filesystem).
 */
export function isNoteAddAllowedPath(p: string): boolean {
  if (!p.endsWith(".md")) return false;
  // Normalize separators defensively; git reports forward slashes, but a crafted
  // commit could carry a backslash on the path.
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("/")) return false; // no absolute paths
  const segments = norm.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false; // no empty/traversal
    if (seg.toLowerCase() === ".git") return false; // never poison the git dir
  }
  if (segments[0]!.toLowerCase() === "sources") return false; // capture-only namespace
  return true;
}

/**
 * True iff `p` may be TOUCHED (added, modified, deleted, or either side of a
 * rename/copy) by a `"sync"`-scoped absorb commit — TODAY exactly
 * {@link isNoteAddAllowedPath}'s checks, delegated rather than aliased so the
 * sync contract reads by name and can diverge without touching the note gate.
 */
export function isSyncAllowedPath(p: string): boolean {
  return isNoteAddAllowedPath(p);
}
