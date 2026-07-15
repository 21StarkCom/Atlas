/**
 * The section MODEL (Task 1.3) — a note's heading hierarchy as a `SectionTree`
 * with stable, addressable section selectors. This is shared by the vault reader
 * (which attaches it to every `ParsedNote`) and the Phase-4 patcher (Task 4.2),
 * which resolves a `sectionPath` back to a span via {@link resolveSections}.
 *
 * `SectionTree` (the shape) is owned by `@atlas/contracts` (D14); this module
 * produces VALUES of it. The root node has `level 0` and an empty heading/path
 * and holds the note preamble plus every top-level heading as children.
 *
 * Both the tree ({@link buildSectionTree}) and the offset-annotated span list
 * ({@link resolveSections}) are assembled from ONE core walk ({@link
 * computeSections}) so a selector minted against the tree resolves byte-for-byte
 * to the same span — the two views can never drift on path encoding.
 */
import type { SectionTree } from "@atlas/contracts";
import { openingFence, isClosingFence, type OpenFence } from "./fence.js";

/** A mutable builder mirror of `SectionTree` (frozen into the readonly DTO on return). */
interface MutableSection {
  heading: string;
  level: number;
  path: string;
  children: MutableSection[];
}

/**
 * A section resolved to its span in the note body: the same stable `path` the
 * `SectionTree` carries, plus the byte offsets the patcher (Task 4.2) needs to
 * cut/replace the section without re-serializing the whole note.
 *
 * - `headingStart` — offset of the section's ATX heading line.
 * - `bodyStart` — offset just past the heading line's newline (start of body).
 * - `bodyEnd` — offset of the NEXT heading at level ≤ this section's level (i.e.
 *   the next sibling-or-shallower heading), or the body length. The `[bodyStart,
 *   bodyEnd)` span therefore covers this section's content AND every nested
 *   subsection — replacing it replaces the whole subtree body, never the heading.
 */
export interface ResolvedSection {
  readonly path: string;
  readonly level: number;
  readonly heading: string;
  readonly headingStart: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/**
 * Reserved path segment for a heading with empty text (`#`, `## `, `### ###`).
 * An empty heading would otherwise encode to `""`, which (a) collides with the
 * note preamble/root path `""` and (b) collapses a chain of nested empty
 * headings onto a single `""` path (a truthy-parent-path join skips the empty
 * segment). A real heading can never encode to `%00`: any literal `%` in its
 * text becomes `%25`, so the NUL escape is unreachable from non-empty input.
 * This keeps every emitted section path unique AND non-empty — leaving `""`
 * as the preamble's sole, unambiguous path (retrieval-index-contract §1.6:
 * `chunkId = f(generationId, sectionPath, ordinal)` relies on path uniqueness,
 * with `ordinal` section-local, not a note-wide disambiguator).
 */
const EMPTY_HEADING_SEGMENT = "%00";

/**
 * Encode a heading into a path segment that cannot be confused with the `/`
 * separator. A heading containing a literal slash (e.g. `A/B`) would otherwise
 * produce the same selector as nested headings `A` then `B`, making section
 * selectors ambiguous. We percent-encode `%` then `/` so the mapping is
 * reversible and every segment is unambiguous. Empty headings map to the
 * reserved {@link EMPTY_HEADING_SEGMENT} so no section path is ever empty.
 */
function encodeSegment(heading: string): string {
  if (heading.length === 0) return EMPTY_HEADING_SEGMENT;
  return heading.replace(/%/g, "%25").replace(/\//g, "%2F");
}

/**
 * Build the heading tree for a note body. Headings are ATX (`#`..`######`) on
 * their own line; Setext headings and headings inside fenced code blocks are
 * intentionally ignored (a `#` inside ``` ``` ``` is content, not structure).
 *
 * Section selectors (`path`) are `/`-joined heading segments. Sibling headings
 * that share text are disambiguated with a `-2`, `-3`, … suffix on the colliding
 * segment so every selector in a note is unique and stable.
 */
export function buildSectionTree(body: string): SectionTree {
  const root: MutableSection = { heading: "", level: 0, path: "", children: [] };
  // Stack of currently-open ancestor sections, deepest last; root is never popped.
  const stack: MutableSection[] = [root];

  for (const section of computeSections(body)) {
    // Close every section at or deeper than this heading's level.
    while (stack.length > 1 && stack[stack.length - 1]!.level >= section.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!;
    const node: MutableSection = {
      heading: section.heading,
      level: section.level,
      path: section.path,
      children: [],
    };
    parent.children.push(node);
    stack.push(node);
  }

  return root as SectionTree;
}

/**
 * Resolve every heading section in `body` to its stable path + body span. The
 * paths are byte-identical to those {@link buildSectionTree} emits (both share
 * {@link computeSections}), so a `SectionSelector.path` produced against the
 * tree indexes straight into this list. Order is document order.
 */
export function resolveSections(body: string): ResolvedSection[] {
  return computeSections(body);
}

/**
 * Look up a single section by its stable path. Returns `null` when no section
 * carries that path (a `section-not-found` at the patch layer). Paths are unique
 * within a note, so a hit is unambiguous.
 */
export function sectionByPath(body: string, path: string): ResolvedSection | null {
  return computeSections(body).find((s) => s.path === path) ?? null;
}

interface ScannedHeading {
  readonly level: number;
  readonly text: string;
  /** Offset of the heading line's first character in `body`. */
  readonly headingStart: number;
  /** Offset just past the heading line's trailing newline (start of its body). */
  readonly bodyStart: number;
}

/**
 * The shared core: scan headings (fence-aware), assign each the same unique,
 * `/`-joined stable path {@link buildSectionTree} uses, and annotate it with the
 * body span. `bodyEnd` for section `i` is the `headingStart` of the next section
 * whose level ≤ `section[i].level`, else the body length — computed in a second
 * pass once every heading's offset is known.
 */
function computeSections(body: string): ResolvedSection[] {
  const headings = scanHeadings(body);

  // Path assignment mirrors buildSectionTree's stack + per-parent de-dup exactly.
  interface Frame {
    level: number;
    path: string;
    childSegments: Set<string>;
  }
  const rootFrame: Frame = { level: 0, path: "", childSegments: new Set() };
  const stack: Frame[] = [rootFrame];
  const partial: Omit<ResolvedSection, "bodyEnd">[] = [];

  for (const h of headings) {
    while (stack.length > 1 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    const parent = stack[stack.length - 1]!;
    const segment = uniqueSegment(parent.childSegments, encodeSegment(h.text));
    parent.childSegments.add(segment);
    const path = parent.path ? `${parent.path}/${segment}` : segment;
    partial.push({
      path,
      level: h.level,
      heading: h.text,
      headingStart: h.headingStart,
      bodyStart: h.bodyStart,
    });
    stack.push({ level: h.level, path, childSegments: new Set() });
  }

  return partial.map((s, i) => {
    let bodyEnd = body.length;
    for (let j = i + 1; j < partial.length; j++) {
      if (partial[j]!.level <= s.level) {
        bodyEnd = partial[j]!.headingStart;
        break;
      }
    }
    return { ...s, bodyEnd };
  });
}

/** Yield ATX headings in document order (with offsets), skipping fenced code blocks. */
function scanHeadings(body: string): ScannedHeading[] {
  const out: ScannedHeading[] = [];
  let fence: OpenFence | null = null; // the open fence while inside a code block
  const lines = body.split("\n");
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingStart = offset;
    // Every split segment except the last was followed by a `\n` in the source.
    const hasNewline = i < lines.length - 1;
    const bodyStart = headingStart + line.length + (hasNewline ? 1 : 0);
    offset = bodyStart;

    if (fence !== null) {
      // Only a valid closing fence (same char, ≥ opener length, trailing
      // whitespace only) ends the block; everything until then is code.
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const open = openingFence(line);
    if (open) {
      fence = open;
      continue;
    }

    const heading = parseAtxHeading(line);
    if (heading) out.push({ level: heading.level, text: heading.text, headingStart, bodyStart });
  }
  return out;
}

/**
 * Parse one line as a CommonMark ATX heading, or return `null`. Rules (§4.2):
 *  - up to 3 leading spaces of indentation (4+ would be an indented code block);
 *  - 1–6 `#`, then either end-of-line OR at least one space/tab before content;
 *  - an OPTIONAL closing sequence of `#`s at the end, but ONLY when preceded by
 *    whitespace — so `# foo###` keeps the literal `foo###`, while `# foo ###`
 *    and `### ###` strip the closing run (the latter yielding an empty heading);
 *  - empty headings (`#`, `###`, `#   `) are valid, with empty text.
 */
function parseAtxHeading(line: string): { level: number; text: string } | null {
  const m = /^( {0,3})(#{1,6})(?:[ \t]|$)/.exec(line);
  if (!m) return null;
  const level = m[2]!.length;
  // Remainder after the opening hashes (begins with a space/tab, or is empty).
  const rest = line.slice(m[1]!.length + level);
  // Strip an optional trailing closing sequence (whitespace + hashes) then trim.
  const text = rest.replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level, text };
}

/** Produce a unique child-path segment given a parent's taken segments. */
function uniqueSegment(taken: ReadonlySet<string>, segment: string): string {
  if (!taken.has(segment)) return segment;
  for (let n = 2; ; n++) {
    const candidate = `${segment}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
