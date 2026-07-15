/**
 * Human-readable diff summaries for a {@link Patch} (Task 4.2). A summary is
 * one line per op, allowlisted metadata only — section paths, field names, and
 * line counts — never raw note content (plan §2.5: summaries and diagnostics
 * carry metadata, not payloads). Rendered at generation time so a preview
 * (`enrich`/`reconcile` without `--apply`) can show intent before any mutation.
 */
import type { ParsedNote } from "@atlas/contracts";
import type { Patch, PatchOp } from "./patch.js";
import { splitFrontmatter } from "./parse.js";
import { sectionByPath } from "./sections.js";

/** Count the lines in a body span, treating an empty/whitespace-only span as 0. */
function lineCount(text: string): number {
  const trimmed = text.replace(/^\n+/, "").replace(/\n+$/, "");
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

/** Render one op against `note`'s current text as a single human-readable line. */
function summarizeOp(note: ParsedNote, op: PatchOp): string {
  const { body } = splitFrontmatter(note.raw);
  switch (op.kind) {
    case "replace-section-body": {
      const current = sectionByPath(body, op.path);
      const before = current ? lineCount(body.slice(current.bodyStart, current.bodyEnd)) : 0;
      const after = lineCount(op.newBody);
      return `Update section «${op.path}» (${before} → ${after} lines)`;
    }
    case "append-to-section": {
      const added = lineCount(op.content);
      const exists = sectionByPath(body, op.path) !== null;
      const verb = exists ? "Append" : op.createIfAbsent ? "Create section + append" : "Append";
      return `${verb} ${added} line${added === 1 ? "" : "s"} to section «${op.path}»`;
    }
    case "set-frontmatter-field": {
      const verb = op.mode === "add" ? "Add" : "Update";
      const rendered = Array.isArray(op.value) ? `[${op.value.length} items]` : String(op.value);
      return `${verb} frontmatter \`${op.field}\` = ${rendered}`;
    }
    case "add-alias":
      return `Add alias «${op.alias}»`;
  }
}

/** Render every op in document order into a newline-joined summary block. */
export function summarizeOps(note: ParsedNote, ops: readonly PatchOp[]): string {
  return ops.map((op) => summarizeOp(note, op)).join("\n");
}

/** The pre-rendered summary carried on a {@link Patch}. */
export function summarizePatch(patch: Patch): string {
  return patch.summary;
}
