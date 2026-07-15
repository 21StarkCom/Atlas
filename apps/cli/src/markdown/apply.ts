/**
 * Section/AST-level patch APPLICATION (Task 4.2). `applyPatch` re-resolves each
 * {@link PatchOp} against the note's CURRENT text (never generation-time byte
 * offsets), after checking every {@link Precondition} up front — so a stale
 * section hash, a vanished section, or a concurrently changed frontmatter value
 * is a typed {@link StaleContextError} and the note is left byte-for-byte
 * untouched. On success every non-edited byte (unknown frontmatter, formatting,
 * sibling sections) is preserved verbatim: only the targeted span changes.
 */
import type {
  Patch,
  PatchOp,
  Precondition,
  StaleContextError,
  PatchFailureCode,
} from "./patch.js";
import { sectionContentHash, frontmatterValueHash } from "./patch.js";
import { resolveSections, sectionByPath, type ResolvedSection } from "./sections.js";

/** Success carries the rewritten note; failure carries the typed stale-context error. */
export type ApplyResult = { readonly ok: true; readonly next: string } | { readonly ok: false; readonly error: StaleContextError };

function fail(
  code: PatchFailureCode,
  precondition: Precondition,
  detail: string,
): { readonly ok: false; readonly error: StaleContextError } {
  return { ok: false, error: { kind: "stale-context", code, precondition, detail } };
}

/**
 * Apply a patch to raw note text. Preconditions are checked FIRST against the
 * unmodified text; only if all hold are the ops applied (in document order,
 * each re-resolved against the progressively-updated text). Line endings are
 * canonicalized to LF (the vault is git-backed LF); no other formatting is
 * touched.
 */
export function applyPatch(raw: string, patch: Patch): ApplyResult {
  const text = raw.replace(/\r\n/g, "\n");

  // 1. Gate on every precondition against the ORIGINAL text (all-or-nothing).
  for (const pre of patch.preconditions) {
    const failure = checkPrecondition(text, pre);
    if (failure) return failure;
  }

  // 2. Apply ops sequentially; each resolves its target against the current text.
  let current = text;
  for (const op of patch.ops) {
    const result = applyOp(current, op);
    if (!result.ok) return result;
    current = result.next;
  }
  return { ok: true, next: current };
}

// ─── Preconditions ────────────────────────────────────────────────────────────

function checkPrecondition(text: string, pre: Precondition): ReturnType<typeof fail> | null {
  const fm = locateFrontmatter(text);
  const body = text.slice(fm.bodyStart);

  switch (pre.kind) {
    case "section-present": {
      if (sectionByPath(body, pre.path)) return null;
      return fail("section-not-found", pre, `section «${pre.path}» not found`);
    }
    case "section-content-hash": {
      const section = sectionByPath(body, pre.path);
      if (!section) return fail("section-not-found", pre, `section «${pre.path}» not found`);
      const actual = sectionContentHash(body.slice(section.bodyStart, section.bodyEnd));
      if (actual === pre.expectedContentHash) return null;
      return fail("content-hash-mismatch", pre, `section «${pre.path}» changed since it was read`);
    }
    case "frontmatter-field-absent": {
      if (readFrontmatterField(text, pre.field) === null) return null;
      return fail("field-exists", pre, `frontmatter field '${pre.field}' already present`);
    }
    case "frontmatter-field-present": {
      if (readFrontmatterField(text, pre.field) !== null) return null;
      return fail("field-not-found", pre, `frontmatter field '${pre.field}' not present`);
    }
    case "frontmatter-value-hash": {
      const value = readFrontmatterField(text, pre.field);
      if (value === null) return fail("field-not-found", pre, `frontmatter field '${pre.field}' not present`);
      if (frontmatterValueHash(value) === pre.expectedValueHash) return null;
      return fail("value-hash-mismatch", pre, `frontmatter field '${pre.field}' changed since it was read`);
    }
    case "alias-absent": {
      if (!currentAliases(text).includes(pre.alias)) return null;
      return fail("alias-exists", pre, `alias «${pre.alias}» already present`);
    }
  }
}

// ─── Op application ─────────────────────────────────────────────────────────────

function applyOp(text: string, op: PatchOp): ApplyResult {
  switch (op.kind) {
    case "replace-section-body":
      return replaceSectionBody(text, op.path, op.newBody);
    case "append-to-section":
      return appendToSection(text, op.path, op.content, op.createIfAbsent);
    case "set-frontmatter-field":
      return setFrontmatterField(text, op.field, op.value, op.mode);
    case "add-alias":
      return addAlias(text, op.alias);
  }
}

/** Section body span offsets within the whole document (frontmatter-adjusted). */
function locateSectionInDoc(text: string, path: string): { section: ResolvedSection; bodyOffset: number } | null {
  const bodyOffset = locateFrontmatter(text).bodyStart;
  const section = sectionByPath(text.slice(bodyOffset), path);
  return section ? { section, bodyOffset } : null;
}

function replaceSectionBody(text: string, path: string, newBody: string): ApplyResult {
  const hit = locateSectionInDoc(text, path);
  if (!hit) return fail("section-not-found", { kind: "section-present", path }, `section «${path}» not found`);
  const start = hit.bodyOffset + hit.section.bodyStart;
  const end = hit.bodyOffset + hit.section.bodyEnd;
  // Keep the following heading (if any) on its own line by ensuring a trailing newline.
  const followed = end < text.length;
  let replacement = newBody.replace(/\r\n/g, "\n");
  if (followed && !replacement.endsWith("\n")) replacement += "\n";
  return { ok: true, next: text.slice(0, start) + replacement + text.slice(end) };
}

function appendToSection(text: string, path: string, content: string, createIfAbsent: boolean): ApplyResult {
  const hit = locateSectionInDoc(text, path);
  const piece = content.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!hit) {
    if (!createIfAbsent) {
      return fail("section-not-found", { kind: "section-present", path }, `section «${path}» not found`);
    }
    const created = createSection(text, path, piece);
    if (!created) return fail("section-not-found", { kind: "section-present", path }, `parent of «${path}» not found`);
    return { ok: true, next: created };
  }
  const insertAt = hit.bodyOffset + hit.section.bodyEnd;
  // Separate the appended block from prior content with a blank line, and keep a
  // trailing newline so a following heading stays on its own line.
  const before = text.slice(0, insertAt).replace(/\n*$/, "");
  const after = text.slice(insertAt);
  const sep = before === "" ? "" : "\n\n";
  const tail = after.startsWith("\n") || after === "" ? "\n" : "\n\n";
  return { ok: true, next: `${before}${sep}${piece}${tail}${after.replace(/^\n+/, "")}` };
}

/** Create an absent section from a selector path (single-level or under an existing parent). */
function createSection(text: string, path: string, content: string): string | null {
  const bodyOffset = locateFrontmatter(text).bodyStart;
  const segments = path.split("/");
  const heading = decodeSegment(segments[segments.length - 1]!);

  if (segments.length === 1) {
    // Top-level: a level-1 heading pops to root, so its path is exactly `heading`.
    const before = text.replace(/\n*$/, "");
    const sep = before === "" ? "" : "\n\n";
    return `${before}${sep}# ${heading}\n\n${content}\n`;
  }

  const parentPath = segments.slice(0, -1).join("/");
  const parent = resolveSections(text.slice(bodyOffset)).find((s) => s.path === parentPath);
  if (!parent) return null;
  const level = Math.min(6, parent.level + 1);
  const insertAt = bodyOffset + parent.bodyEnd;
  const before = text.slice(0, insertAt).replace(/\n*$/, "");
  const after = text.slice(insertAt);
  const hashes = "#".repeat(level);
  return `${before}\n\n${hashes} ${heading}\n\n${content}\n${after.startsWith("\n") ? "" : "\n"}${after.replace(/^\n+/, "")}`;
}

// ─── Frontmatter ────────────────────────────────────────────────────────────────

interface FrontmatterRegion {
  readonly present: boolean;
  /** Offset of the first inner frontmatter line (past the opening `---`). */
  readonly innerStart: number;
  /** Offset of the closing `---` line's first character. */
  readonly innerEnd: number;
  /** Offset where the note body begins (past the closing `---` line). */
  readonly bodyStart: number;
}

/** Locate the leading YAML frontmatter fence with offsets (LF-normalized text). */
function locateFrontmatter(text: string): FrontmatterRegion {
  if (!/^---[ \t]*\n/.test(text)) return { present: false, innerStart: 0, innerEnd: 0, bodyStart: 0 };
  const closing = /\n---[ \t]*(?:\n|$)/.exec(text.slice(3));
  if (!closing) return { present: false, innerStart: 0, innerEnd: 0, bodyStart: 0 };
  const innerStart = text.indexOf("\n") + 1;
  const innerEnd = 3 + closing.index + 1; // first char of the closing `---` line
  const bodyStart = 3 + closing.index + closing[0].length;
  return { present: true, innerStart, innerEnd, bodyStart };
}

/** A top-level frontmatter key line: `key: value` with no leading indentation. */
const FM_KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_-]*):[ \t]?(.*)$/;

interface FmField {
  readonly key: string;
  readonly valueText: string;
  readonly lineStart: number;
  readonly lineEnd: number; // offset just past the line's newline
}

/** Enumerate top-level frontmatter key lines (ignoring nested/indented lines). */
function frontmatterFields(text: string): FmField[] {
  const fm = locateFrontmatter(text);
  if (!fm.present) return [];
  const region = text.slice(fm.innerStart, fm.innerEnd);
  const out: FmField[] = [];
  let offset = fm.innerStart;
  for (const line of region.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length + 1; // every inner line is newline-terminated
    offset = lineEnd;
    const m = FM_KEY_LINE.exec(line);
    if (m) out.push({ key: m[1]!, valueText: m[2]!.trim(), lineStart, lineEnd });
  }
  return out;
}

/** Read a top-level frontmatter field's raw inline value text, or `null` if absent. */
function readFrontmatterField(text: string, field: string): string | null {
  const found = frontmatterFields(text).find((f) => f.key === field);
  return found ? found.valueText : null;
}

function setFrontmatterField(
  text: string,
  field: string,
  value: string | number | boolean | null | readonly string[],
  mode: "add" | "update",
): ApplyResult {
  const serialized = serializeValue(value);
  const fm = locateFrontmatter(text);

  if (mode === "update") {
    const found = frontmatterFields(text).find((f) => f.key === field);
    if (!found) return fail("field-not-found", { kind: "frontmatter-field-present", field }, `field '${field}' not present`);
    const next = `${text.slice(0, found.lineStart)}${field}: ${serialized}\n${text.slice(found.lineEnd)}`;
    return { ok: true, next };
  }

  // add
  if (readFrontmatterField(text, field) !== null) {
    return fail("field-exists", { kind: "frontmatter-field-absent", field }, `field '${field}' already present`);
  }
  if (!fm.present) {
    // No frontmatter block yet — synthesize one at the top of the note.
    return { ok: true, next: `---\n${field}: ${serialized}\n---\n${text}` };
  }
  const line = `${field}: ${serialized}\n`;
  return { ok: true, next: `${text.slice(0, fm.innerEnd)}${line}${text.slice(fm.innerEnd)}` };
}

/** Parse the current `aliases` list from flow (`[a, b]`) or block (`- a`) form. */
function currentAliases(text: string): string[] {
  const fm = locateFrontmatter(text);
  if (!fm.present) return [];
  const field = frontmatterFields(text).find((f) => f.key === "aliases");
  if (!field) return [];
  const flow = parseFlowArray(field.valueText);
  if (flow !== null) return flow;
  // Block form: `  - item` lines following the `aliases:` line until the next
  // top-level key or the end of the frontmatter.
  const out: string[] = [];
  const region = text.slice(field.lineEnd, fm.innerEnd);
  for (const line of region.split("\n")) {
    if (/^[A-Za-z0-9_]/.test(line)) break; // next top-level key
    const m = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (m) out.push(unquote(m[1]!.trim()));
  }
  return out;
}

function addAlias(text: string, alias: string): ApplyResult {
  if (currentAliases(text).includes(alias)) {
    return fail("alias-exists", { kind: "alias-absent", alias }, `alias «${alias}» already present`);
  }
  const fm = locateFrontmatter(text);
  const field = fm.present ? frontmatterFields(text).find((f) => f.key === "aliases") : undefined;

  if (!field) {
    // No aliases field — add a block-form one (create the frontmatter if needed).
    const block = `aliases:\n  - ${serializeScalarString(alias)}\n`;
    if (!fm.present) return { ok: true, next: `---\n${block}---\n${text}` };
    return { ok: true, next: `${text.slice(0, fm.innerEnd)}${block}${text.slice(fm.innerEnd)}` };
  }

  const flow = parseFlowArray(field.valueText);
  if (flow !== null) {
    // Flow form: rewrite the value line with the alias appended.
    const next = [...flow, alias].map(serializeScalarString).join(", ");
    const line = `aliases: [${next}]\n`;
    return { ok: true, next: `${text.slice(0, field.lineStart)}${line}${text.slice(field.lineEnd)}` };
  }

  // Block form: insert a new item after the last existing block item (or after
  // the `aliases:` line when there are none yet).
  let insertAt = field.lineEnd;
  const region = text.slice(field.lineEnd, fm.innerEnd);
  let scan = field.lineEnd;
  for (const line of region.split("\n")) {
    const lineEnd = scan + line.length + 1;
    if (/^[A-Za-z0-9_]/.test(line)) break;
    if (/^[ \t]*-[ \t]+/.test(line)) insertAt = lineEnd;
    scan = lineEnd;
  }
  const item = `  - ${serializeScalarString(alias)}\n`;
  return { ok: true, next: `${text.slice(0, insertAt)}${item}${text.slice(insertAt)}` };
}

// ─── Value (de)serialization — a minimal, deterministic YAML subset ──────────────

function serializeValue(value: string | number | boolean | null | readonly string[]): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(serializeScalarString).join(", ")}]`;
  return serializeScalarString(value as string);
}

/** Quote a string only when a bare YAML scalar would be misread; else emit it raw. */
function serializeScalarString(s: string): string {
  const needsQuote =
    s === "" ||
    /^[\s]|[\s]$/.test(s) ||
    /[:#\[\]{}",'&*!|>%@`]/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /^[-+]?[0-9]/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Parse a YAML flow array `[a, "b", c]` into its string items, or `null` if not flow. */
function parseFlowArray(valueText: string): string[] | null {
  const t = valueText.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => unquote(part.trim()));
}

/** Strip a single layer of matching quotes from a scalar. */
function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

/** Reverse {@link import("./sections.js")} segment encoding (`%2F`→`/`, `%25`→`%`, `%00`→""). */
function decodeSegment(segment: string): string {
  if (segment === "%00") return "";
  return segment.replace(/%2F/g, "/").replace(/%25/g, "%");
}
