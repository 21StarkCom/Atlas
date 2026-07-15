/**
 * The deterministic section chunker — v1 (Task 3.1, D4
 * `indexing.chunker_version = 1`; retrieval-index-contract §1).
 *
 * `chunkNote(note, cfg)` turns a `ParsedNote` into an ordered `Chunk[]`. The
 * same `ParsedNote` + `IndexingConfig` always produces a BYTE-IDENTICAL chunk
 * set — that determinism is the generation-fencing precondition (contract §1,
 * Task 3.1 acceptance).
 *
 * ## Carry-forward #2 (chunking vs SectionTree)
 * The `SectionTree` DTO (Task 1.3) carries a note's heading hierarchy and a
 * unique, addressable `path` per section, but NOT the section BODIES or their
 * source spans — the chunker needs the prose. So this module derives body spans
 * by re-scanning `note.raw` with the SAME heading/fence rules the section model
 * uses, then zips those spans onto the authoritative `SectionTree` (both are in
 * document order). Two distinct notions of "breadcrumb" fall out and MUST NOT be
 * conflated:
 *   - the **display breadcrumb** (`H1 › H2 › …`, raw heading text) — embedded in
 *     the chunk TEXT for retrieval context; may collide across duplicate
 *     headings (that is fine — it is not an identity).
 *   - the unique encoded **`SectionTree.path`** — the collision-free selector
 *     (duplicate headings get `-2`/`-3`; a literal `/` in a heading is
 *     percent-encoded), used for `Chunk.sectionPath` and the deterministic
 *     `chunkId` (`generation.ts`).
 *
 * D14: consumes only `@atlas/contracts` DTOs, never `apps/cli`.
 */
import type { Chunk, ParsedNote, SectionTree } from "@atlas/contracts";
import type { IndexingConfig } from "./generation.js";

/** The chunker version this module implements (D4). */
export const CHUNKER_VERSION = 1;

/** The display separator between heading levels in a chunk's breadcrumb. */
const BREADCRUMB_SEP = " › "; // " › "

/**
 * Chunk a parsed note into a deterministic, ordered `Chunk[]` (contract §1).
 *
 * One chunk is emitted per section that bears its OWN prose — the text between a
 * heading and its first sub-heading belongs to that heading's section, so both
 * leaf sections and parents-with-direct-prose ("parent prose") produce a chunk,
 * while a parent that holds only sub-headings does not. The note preamble (prose
 * before the first heading, front matter excluded) is emitted as the note's
 * root-section chunk. Chunks are ordered in document order; `Chunk.ordinal` is
 * their 0-based position in that note-wide sequence.
 *
 * Each chunk's text is `breadcrumb + title + aliases + body` (contract §1.2–3):
 * the display breadcrumb, the note's canonical title and declared aliases
 * (deduped, in declaration order), then the section body — all NFC-normalized so
 * mixed Hebrew/English content is byte-identical across platforms (§1.4).
 */
export function chunkNote(note: ParsedNote, cfg: IndexingConfig): Chunk[] {
  if (cfg.chunker_version !== CHUNKER_VERSION) {
    // Only v1 exists. A bumped version must add a branch here (and, being a
    // generation-identity component, opens a new generation by construction).
    throw new Error(
      `chunkNote: unsupported indexing.chunker_version ${cfg.chunker_version} (this build implements ${CHUNKER_VERSION})`,
    );
  }

  const body = stripFrontmatter(note.raw);
  const spans = scanHeadingSpans(body);
  const sections = flattenSections(note.sections);

  // The re-scan and the authoritative SectionTree must see the SAME headings in
  // the SAME order (identical ATX + fenced-code rules). A count-only check is not
  // enough: a renamed or reordered tree with the same number of headings would be
  // silently zipped to the wrong bodies, paths, and chunk IDs. So we verify each
  // scanned heading matches the flattened tree entry by LEVEL and TEXT (NFC-
  // compared, since `heading` text and `raw` may carry different normalization
  // forms — a rename changes the scalars and a reorder changes the sequence, so
  // NFC folding masks neither). Any divergence means the DTO and raw source
  // disagree — fail loudly rather than mis-zip bodies.
  if (spans.length !== sections.length) {
    throw new Error(
      `chunkNote: heading count mismatch — SectionTree has ${sections.length} section(s) but note.raw scans ${spans.length}; ` +
        `note.sections is stale relative to note.raw`,
    );
  }
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const section = sections[i]!;
    if (span.level !== section.level || nfc(span.text) !== nfc(section.heading)) {
      throw new Error(
        `chunkNote: heading mismatch at index ${i} — note.raw scans ` +
          `\`${"#".repeat(span.level)} ${span.text}\` but SectionTree has ` +
          `\`${"#".repeat(section.level)} ${section.heading}\` (path \`${section.path}\`); ` +
          `note.sections is stale relative to note.raw`,
      );
    }
  }

  const identity = composeIdentity(note);
  const chunks: Chunk[] = [];

  // Preamble: prose before the first heading (front matter already removed).
  const preambleEnd = spans.length > 0 ? spans[0]!.lineStart : body.length;
  const preamble = body.slice(0, preambleEnd);
  appendChunk(chunks, note, "", [], preamble, identity);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const span = spans[i]!;
    // A section's OWN body runs from just after its heading line to the start of
    // the next heading of any level (that heading opens a new section).
    const bodyStart = span.contentStart;
    const bodyEnd = i + 1 < spans.length ? spans[i + 1]!.lineStart : body.length;
    appendChunk(chunks, note, section.path, section.breadcrumb, body.slice(bodyStart, bodyEnd), identity);
  }

  return chunks;
}

/**
 * Push a chunk for a section iff its body bears prose. `breadcrumb` is the
 * ordered ancestor+self heading text (empty for the preamble). `ordinal` is the
 * chunk's 0-based position WITHIN its section (retrieval-index-contract §1.6);
 * the v1 chunker emits at most one chunk per unique `sectionPath`, so it is
 * always `0`. Chunk-id uniqueness rests on `sectionPath` uniqueness — the
 * preamble is the sole `""` path and every heading section has a non-empty
 * unique path (see `@atlas/*` section encoding) — not on the ordinal.
 */
function appendChunk(
  chunks: Chunk[],
  note: ParsedNote,
  sectionPath: string,
  breadcrumb: readonly string[],
  rawBody: string,
  identity: string,
): void {
  const body = normalizeBody(rawBody);
  if (body.length === 0) return; // sections with no direct prose bear no chunk
  chunks.push({
    noteId: note.id,
    sectionPath,
    text: composeText(breadcrumb, identity, body),
    contentHash: note.contentHash,
    ordinal: 0, // section-local (§1.6); v1 emits ≤1 chunk per section
  });
}

/** A flat, document-ordered section with its unique path + display breadcrumb. */
interface FlatSection {
  /** Unique encoded `SectionTree.path` — collision-free selector + id input. */
  readonly path: string;
  /** Ordered ancestor→self raw heading text (the display breadcrumb parts). */
  readonly breadcrumb: readonly string[];
  /** This section's own raw heading text — checked against the re-scan. */
  readonly heading: string;
  /** This section's heading level (1 = `#`, …) — checked against the re-scan. */
  readonly level: number;
}

/**
 * Pre-order (document-order) flatten of the `SectionTree`, EXCLUDING the level-0
 * root (which represents the preamble and carries no heading). Each entry keeps
 * the note's unique `path`, the full ancestor→self heading chain, and the
 * section's own heading text + level (the latter two let `chunkNote` verify the
 * re-scan matches the authoritative tree heading-by-heading, not just by count).
 */
function flattenSections(root: SectionTree): FlatSection[] {
  const out: FlatSection[] = [];
  const walk = (node: SectionTree, ancestors: readonly string[]): void => {
    const trail = [...ancestors, node.heading];
    out.push({ path: node.path, breadcrumb: trail, heading: node.heading, level: node.level });
    for (const child of node.children) walk(child, trail);
  };
  // Root is the preamble holder — descend into its children, don't emit it.
  for (const child of root.children) walk(child, []);
  return out;
}

/**
 * Assemble the chunk text: `breadcrumb + identity + body`, each non-empty
 * segment separated by a blank line (contract §1.2–1.3). The breadcrumb joins
 * the section's non-empty heading parts with ` › ` (empty ATX headings are
 * skipped so the display reads cleanly); it is empty for the preamble.
 */
function composeText(breadcrumb: readonly string[], identity: string, body: string): string {
  const crumb = breadcrumb
    .map((h) => nfc(h).trim())
    .filter((h) => h.length > 0)
    .join(BREADCRUMB_SEP);
  return [crumb, identity, body].filter((s) => s.length > 0).join("\n\n");
}

/**
 * The note's identity block — canonical title then declared aliases, deduped in
 * declaration order (contract §1.3). NFC-normalized and compared post-normalize
 * so an alias equal to the title (or a duplicate alias) is dropped exactly once.
 * This is invariant per note, so it is computed once and reused for every chunk.
 */
function composeIdentity(note: ParsedNote): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of [note.title, ...note.aliases]) {
    const value = nfc(raw).trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    lines.push(value);
  }
  return lines.join("\n");
}

/**
 * Normalize a section body for embedding: NFC (so Hebrew/English mixed content
 * is byte-identical across platforms — §1.4), then drop leading and trailing
 * BLANK lines only. Crucially, indentation on content lines is preserved — a
 * `/^\s+/` strip would eat the four leading spaces of an indented Markdown code
 * block on the first content line and silently turn it into ordinary prose,
 * changing the indexed body. A blank line is one that is empty or whitespace-
 * only; interior blank lines and content-line indentation are left untouched.
 * Returns "" for prose-free bodies (only blank lines, or nothing).
 */
function normalizeBody(rawBody: string): string {
  const lines = nfc(rawBody).split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim().length === 0) start++;
  while (end > start && lines[end - 1]!.trim().length === 0) end--;
  return lines.slice(start, end).join("\n");
}

/** NFC-normalize — the repo's cross-platform Unicode-identity discipline. */
function nfc(s: string): string {
  return s.normalize("NFC");
}

// ---------------------------------------------------------------------------
// Raw-source scanning. These reproduce the section model's frontmatter/heading/
// fence rules (apps/cli `markdown/{parse,sections,fence}.ts`) closely enough to
// recover section body SPANS — which the SectionTree DTO does not expose (D14
// forbids importing that code). The heading/fence rules MUST stay in lock-step
// with the section model; the count-mismatch guard in `chunkNote` catches drift.
// ---------------------------------------------------------------------------

/**
 * Strip a leading YAML frontmatter block (`---\n…\n---`) and return the body,
 * with CRLF normalized to LF so spans are deterministic across platforms.
 * Mirrors `splitFrontmatter` (parse.ts).
 */
function stripFrontmatter(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (!/^---[ \t]*\n/.test(text)) return text;
  const closing = /\n---[ \t]*(?:\n|$)/.exec(text.slice(3));
  if (!closing) return text;
  const afterClose = 3 + closing.index + closing[0].length;
  return text.slice(afterClose);
}

/** A scanned heading's source offsets within the (frontmatter-stripped) body. */
interface HeadingSpan {
  /** Char index of the first char of the heading line. */
  readonly lineStart: number;
  /** Char index just after the heading line's newline — where its body begins. */
  readonly contentStart: number;
  /** Heading level (1 = `#`, …), for the per-heading staleness check. */
  readonly level: number;
  /** Parsed heading text (mirrors the section model), for the staleness check. */
  readonly text: string;
}

interface OpenFence {
  readonly char: "`" | "~";
  readonly len: number;
}

/**
 * Scan the body for ATX headings in document order, tracking each heading line's
 * start and content-start offsets plus its parsed level and text. Headings inside
 * fenced code blocks are skipped (a `#` in ``` ``` ``` is content). Offsets index
 * the JS string; every boundary is at a `\n` (a BMP scalar), so slicing on them
 * never splits a surrogate pair — the spans are rune-safe (§1.4).
 */
function scanHeadingSpans(body: string): HeadingSpan[] {
  const out: HeadingSpan[] = [];
  let fence: OpenFence | null = null;
  let offset = 0;

  for (const line of body.split("\n")) {
    const lineStart = offset;
    // Advance past this line + its (implicit) trailing "\n" for the next line.
    const contentStart = offset + line.length + 1;
    offset = contentStart;

    if (fence !== null) {
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    const open = openingFence(line);
    if (open) {
      fence = open;
      continue;
    }
    const heading = parseAtxHeading(line);
    if (heading) {
      out.push({ lineStart, contentStart, level: heading.level, text: heading.text });
    }
  }
  return out;
}

/**
 * Parse one line as a CommonMark ATX heading (level + text), or `null`. This
 * MIRRORS the section model's `parseAtxHeading` (apps/cli markdown/sections.ts)
 * exactly — same optional trailing-`#` closing-sequence rule — so the re-scanned
 * heading text matches the authoritative `SectionTree.heading` and the
 * per-heading staleness check compares like with like.
 */
function parseAtxHeading(line: string): { level: number; text: string } | null {
  const m = /^( {0,3})(#{1,6})(?:[ \t]|$)/.exec(line);
  if (!m) return null;
  const level = m[2]!.length;
  const rest = line.slice(m[1]!.length + level);
  const text = rest.replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level, text };
}

/** Mirrors `openingFence` (fence.ts). */
function openingFence(line: string): OpenFence | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const char = m[1]![0] as "`" | "~";
  if (char === "`" && m[2]!.includes("`")) return null;
  return { char, len: m[1]!.length };
}

/** Mirrors `isClosingFence` (fence.ts). */
function isClosingFence(line: string, fence: OpenFence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!m) return false;
  return m[1]![0] === fence.char && m[1]!.length >= fence.len;
}
