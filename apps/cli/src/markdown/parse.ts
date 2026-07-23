/**
 * Markdown read primitives (Task 1.3): split the YAML frontmatter fence from the
 * body, extract `[[wiki-link]]` occurrences, and delegate to the section model.
 * Purely syntactic — no vault-wide resolution happens here (that lives in the
 * reader). Values produced conform to the `@atlas/contracts` DTOs (D14).
 */
import type { WikiLink } from "@atlas/contracts";
import { buildSectionTree } from "./sections.js";
import { openingFence, isClosingFence, type OpenFence } from "./fence.js";

export interface SplitDocument {
  /** Raw YAML text between the leading `---` fences, or `null` if absent. */
  readonly frontmatter: string | null;
  /** Everything after the closing frontmatter fence (or the whole doc if none). */
  readonly body: string;
}

/**
 * Split a leading YAML frontmatter block (`---\n…\n---`) from the body. The fence
 * must be the very first line. Returns `frontmatter: null` when no well-formed
 * leading block is present (the caller surfaces that as a typed error).
 */
export function splitFrontmatter(raw: string): SplitDocument {
  // Normalize CRLF so line handling is deterministic across platforms.
  const text = raw.replace(/\r\n/g, "\n");
  if (!/^---[ \t]*\n/.test(text)) {
    return { frontmatter: null, body: text };
  }
  // Find the closing fence: a line that is exactly `---` (optional trailing ws).
  const closing = /\n---[ \t]*(?:\n|$)/.exec(text.slice(3));
  if (!closing) {
    return { frontmatter: null, body: text };
  }
  const fmStart = text.indexOf("\n") + 1;
  const fmEnd = 3 + closing.index + 1; // index of the closing `---` line start
  const frontmatter = text.slice(fmStart, fmEnd);
  const afterClose = 3 + closing.index + closing[0].length;
  return { frontmatter, body: text.slice(afterClose) };
}

// A `[[target]]` or `[[target|alias]]` occurrence. Targets/aliases cannot span
// lines or contain `]` / `[`; that keeps the scan robust against malformed text.
// Exported so `link`'s body surgery matches occurrences with the EXACT syntax the
// extractor recognizes — never a second, drifting regex.
export const WIKILINK_RE = /\[\[([^\][\n|]+)(?:\|([^\][\n]+))?\]\]/g;

/**
 * Extract every `[[wiki-link]]` from the body in document order. Inline code
 * spans (`` `…` ``) and fenced code blocks are stripped first so a link written
 * as documentation inside code is not treated as a real reference.
 */
export function extractWikiLinks(body: string): WikiLink[] {
  const scannable = stripCode(body);
  const links: WikiLink[] = [];
  for (const m of scannable.matchAll(WIKILINK_RE)) {
    const target = m[1]!.trim();
    const aliasRaw = m[2]?.trim();
    links.push(
      aliasRaw ? { target, alias: aliasRaw, raw: m[0] } : { target, raw: m[0] },
    );
  }
  return links;
}

/** Replace fenced code blocks and inline code spans with blanks (length-preserving-ish). */
function stripCode(body: string): string {
  const lines = body.split("\n");
  let fence: OpenFence | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    if (fence !== null) {
      // Inside a block: only a valid closing fence (same char, ≥ opener length,
      // trailing whitespace only) ends it. Every such line is code → blanked.
      if (isClosingFence(line, fence)) fence = null;
      kept.push("");
      continue;
    }
    const open = openingFence(line);
    if (open) {
      fence = open;
      kept.push("");
      continue;
    }
    // Drop inline code spans so `[[x]]` written inside backticks is ignored.
    // Spans may be delimited by a RUN of N backticks (double/triple/…), closed
    // by the next run of EXACTLY N backticks — a single-backtick regex would
    // miss `` [[hidden]] `` and leak the link.
    kept.push(stripInlineCode(line));
  }
  return kept.join("\n");
}

/**
 * Remove CommonMark inline code spans from a single line. A span opens on a run
 * of N backticks and closes on the next run of EXACTLY N backticks (a longer
 * run is not a valid closer). An unclosed run is left as literal text.
 */
function stripInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i++;
      continue;
    }
    // Measure the opening backtick run.
    let open = i;
    while (line[open] === "`") open++;
    const runLen = open - i;
    // Find a closing run of exactly `runLen` backticks.
    let k = open;
    let closeEnd = -1;
    while (k < line.length) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      let run = k;
      while (line[run] === "`") run++;
      if (run - k === runLen) {
        closeEnd = run;
        break;
      }
      k = run; // longer/shorter run: not a closer, keep scanning
    }
    if (closeEnd === -1) {
      // No closer on this line: the backtick run is literal text.
      out += line.slice(i, open);
      i = open;
    } else {
      // Drop the entire span (delimiters + content).
      i = closeEnd;
    }
  }
  return out;
}

export { buildSectionTree };
