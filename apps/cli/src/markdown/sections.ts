/**
 * The section MODEL (Task 1.3) — a note's heading hierarchy as a `SectionTree`
 * with stable, addressable section selectors. This is shared by the vault reader
 * (which attaches it to every `ParsedNote`) and the future Phase-4 patcher (Task
 * 4.2), which resolves a `sectionPath` back to a span. Patch GENERATION is NOT
 * here — this ships the model only.
 *
 * `SectionTree` (the shape) is owned by `@atlas/contracts` (D14); this module
 * produces VALUES of it. The root node has `level 0` and an empty heading/path
 * and holds the note preamble plus every top-level heading as children.
 */
import type { SectionTree } from "@atlas/contracts";
import { openingFence, isClosingFence, type OpenFence } from "./fence.js";

/** A mutable builder mirror of `SectionTree` (frozen into the readonly DTO on return). */
interface MutableSection {
  heading: string;
  level: number;
  path: string;
  /** This node's own (already encoded + de-duplicated) path segment. */
  segment: string;
  children: MutableSection[];
}

/**
 * Encode a heading into a path segment that cannot be confused with the `/`
 * separator. A heading containing a literal slash (e.g. `A/B`) would otherwise
 * produce the same selector as nested headings `A` then `B`, making section
 * selectors ambiguous. We percent-encode `%` then `/` so the mapping is
 * reversible and every segment is unambiguous.
 */
function encodeSegment(heading: string): string {
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
  const root: MutableSection = { heading: "", level: 0, path: "", segment: "", children: [] };
  // Stack of currently-open ancestor sections, deepest last; root is never popped.
  const stack: MutableSection[] = [root];

  for (const heading of scanHeadings(body)) {
    // Close every section at or deeper than this heading's level.
    while (stack.length > 1 && stack[stack.length - 1]!.level >= heading.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!;
    const segment = uniqueSegment(parent, encodeSegment(heading.text));
    const node: MutableSection = {
      heading: heading.text,
      level: heading.level,
      path: parent.path ? `${parent.path}/${segment}` : segment,
      segment,
      children: [],
    };
    parent.children.push(node);
    stack.push(node);
  }

  return root as SectionTree;
}

interface ScannedHeading {
  readonly level: number;
  readonly text: string;
}

/** Yield ATX headings in document order, skipping fenced code blocks. */
function scanHeadings(body: string): ScannedHeading[] {
  const out: ScannedHeading[] = [];
  let fence: OpenFence | null = null; // the open fence while inside a code block

  for (const line of body.split("\n")) {
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
    if (heading) out.push(heading);
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
function parseAtxHeading(line: string): ScannedHeading | null {
  const m = /^( {0,3})(#{1,6})(?:[ \t]|$)/.exec(line);
  if (!m) return null;
  const level = m[2]!.length;
  // Remainder after the opening hashes (begins with a space/tab, or is empty).
  const rest = line.slice(m[1]!.length + level);
  // Strip an optional trailing closing sequence (whitespace + hashes) then trim.
  const text = rest.replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level, text };
}

/** Produce a unique child-path segment under `parent`, suffixing on collision. */
function uniqueSegment(parent: MutableSection, segment: string): string {
  const taken = new Set(parent.children.map((c) => c.segment));
  if (!taken.has(segment)) return segment;
  for (let n = 2; ; n++) {
    const candidate = `${segment}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
