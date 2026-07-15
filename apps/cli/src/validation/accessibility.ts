/**
 * Markdown accessibility checks (Task 4.4) — deterministic, run during
 * `validate` so a change cannot apply if it degrades navigation (design §Markdown
 * accessibility). Checks the resulting note body for: one logical top-level
 * heading, non-skipped heading levels, descriptive link labels, valid list
 * structure, and image alt-text. Every violation is a blocking (`error`)
 * finding — accessibility is a gate, not a warning.
 *
 * Heading structure reuses the fence-aware section model (`markdown/sections`),
 * so a `#` inside a code fence is never mistaken for a heading. Inline scanning
 * for links/images strips fenced + inline code first for the same reason.
 */
import type { ValidationFinding } from "./index.js";
import { resolveSections } from "../markdown/sections.js";
import { openingFence, isClosingFence, type OpenFence } from "../markdown/fence.js";

/** Link/image text that carries no meaning out of context (non-descriptive labels). */
const NON_DESCRIPTIVE = new Set(["", "here", "click here", "click", "link", "this", "read more", "more", "see here"]);

function finding(code: string, detail: string): ValidationFinding {
  return { code: `accessibility:${code}`, severity: "error", detail };
}

/** Run every accessibility check over a note body, collecting blocking findings. */
export function checkAccessibility(body: string): ValidationFinding[] {
  return [
    ...checkHeadings(body),
    ...checkLinks(body),
    ...checkImages(body),
    ...checkLists(body),
  ];
}

/** One logical top-level heading, and no skipped levels when descending. */
function checkHeadings(body: string): ValidationFinding[] {
  const sections = resolveSections(body);
  if (sections.length === 0) return [];
  const out: ValidationFinding[] = [];

  const shallowest = Math.min(...sections.map((s) => s.level));
  const tops = sections.filter((s) => s.level === shallowest);
  if (tops.length > 1) {
    out.push(finding("multiple-top-level-headings", `${tops.length} headings at the top level (${shallowest}); expected one logical top-level heading`));
  }

  // A descent may deepen by at most one level at a time (no `#` → `###` jump).
  let prev = shallowest;
  for (const s of sections) {
    if (s.level > prev + 1) {
      out.push(finding("skipped-heading-level", `heading «${s.heading}» jumps from level ${prev} to ${s.level} (skips ${prev + 1})`));
    }
    prev = s.level;
  }
  return out;
}

/** Every markdown + wiki link must carry a descriptive label. */
function checkLinks(body: string): ValidationFinding[] {
  const scannable = stripCode(body);
  const out: ValidationFinding[] = [];

  // Inline links `[label](url)` — skip images (`![alt](src)`), handled separately.
  for (const m of scannable.matchAll(/(!?)\[([^\]]*)\]\(([^)]*)\)/g)) {
    if (m[1] === "!") continue;
    const label = m[2]!.trim();
    if (NON_DESCRIPTIVE.has(label.toLowerCase()) || label === m[3]!.trim()) {
      out.push(finding("non-descriptive-link", `link label «${label || "(empty)"}» is not descriptive`));
    }
  }
  // Wiki links `[[target|alias]]`: an alias, when present, must be descriptive.
  for (const m of scannable.matchAll(/\[\[([^\][\n|]+)(?:\|([^\][\n]+))?\]\]/g)) {
    const alias = m[2]?.trim();
    if (alias !== undefined && NON_DESCRIPTIVE.has(alias.toLowerCase())) {
      out.push(finding("non-descriptive-link", `wiki-link alias «${alias}» is not descriptive`));
    }
  }
  return out;
}

/** Every image must have non-empty alt text. */
function checkImages(body: string): ValidationFinding[] {
  const scannable = stripCode(body);
  const out: ValidationFinding[] = [];
  for (const m of scannable.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)) {
    if (m[1]!.trim() === "") {
      out.push(finding("missing-alt-text", `image (${m[2]!.trim() || "no src"}) has empty alt text`));
    }
  }
  return out;
}

/** List items must nest by consistent steps (no ragged indentation jumps). */
function checkLists(body: string): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const indents: number[] = [];
  for (const line of stripCode(body).split("\n")) {
    const m = /^(\s*)[-*+][ \t]+\S/.exec(line);
    if (!m) continue;
    const indent = m[1]!.replace(/\t/g, "  ").length;
    // A deeper item may only step in from a level already on the stack; a jump to
    // an indentation that matches no shallower item is a malformed nesting.
    while (indents.length > 0 && indents[indents.length - 1]! > indent) indents.pop();
    const top = indents[indents.length - 1];
    if (top === undefined || indent > top) {
      if (top !== undefined && indent - top > 4) {
        out.push(finding("invalid-list-structure", `list item indented ${indent} spaces jumps more than one level from ${top}`));
      }
      indents.push(indent);
    }
  }
  return out;
}

/** Blank out fenced code blocks and inline code spans so their contents are not scanned. */
function stripCode(body: string): string {
  const lines = body.split("\n");
  let fence: OpenFence | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    if (fence !== null) {
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
    kept.push(line.replace(/`[^`]*`/g, ""));
  }
  return kept.join("\n");
}
