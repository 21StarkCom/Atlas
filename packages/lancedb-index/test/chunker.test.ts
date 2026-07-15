/**
 * `chunker.test` (Task 3.1) — the deterministic v1 section chunker + generation
 * identity (retrieval-index-contract §1/§2).
 *
 * Determinism (byte-identical chunk set) is the generation-fencing precondition,
 * so it is asserted first and hardest. The other cases exercise the
 * carry-forward #2 hazards explicitly: duplicate headings (unique encoded path
 * vs colliding display breadcrumb), preambles, parent prose, slash-in-heading,
 * fenced-code "headings", and rune-safety on mixed Hebrew/English.
 *
 * D14: SectionTree fixtures are hand-built here (NOT imported from apps/cli), so
 * this file both honors the no-app-import invariant and serves as an independent
 * oracle for the section model's paths.
 */
import type { Chunk, ParsedNote, SectionTree } from "@atlas/contracts";
import { describe, expect, it } from "vitest";
import { chunkNote, generationId, chunkId, type IndexingConfig } from "../src/index.js";

const CFG: IndexingConfig = {
  chunker_version: 1,
  embedding_model: "gemini-embedding-001",
  dimensions: 768,
};

/** Build a `SectionTree` node (the DTO shape) for fixtures. */
function sec(heading: string, level: number, path: string, children: SectionTree[] = []): SectionTree {
  return { heading, level, path, children };
}

/** Assemble a `ParsedNote` with sensible defaults + the fixture-specific bits. */
function note(over: Partial<ParsedNote> & Pick<ParsedNote, "id" | "raw" | "sections" | "contentHash">): ParsedNote {
  return {
    path: `${over.id}.md`,
    type: "concept",
    schemaVersion: 1,
    title: "Test Note",
    status: "active",
    created: "2026-07-12T00:00:00.000Z",
    updated: "2026-07-12T00:00:00.000Z",
    aliases: [],
    sources: [],
    declaredSensitivity: "internal",
    links: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Fixture A — one note exercising every carry-forward hazard at once. The lines
// array keeps triple-backtick fences literal without escaping template strings.
// ---------------------------------------------------------------------------
const FENCE = "```";
const RAW_A = [
  "---",
  "title: Test Note",
  "---",
  "Preamble prose here.",
  "",
  "# Overview",
  "Parent prose under overview.",
  "",
  "## Goals",
  "Goal text.",
  "",
  "## Goals",
  "Second goals text.",
  "",
  "# A/B",
  "Slash body.",
  "",
  "# Code",
  FENCE,
  "# not a heading",
  FENCE,
  "After fence body.",
  "",
  "# עברית and English",
  "שלום world — mixed שלום content.",
  "",
].join("\n");

// The authoritative SectionTree buildSectionTree(body) would produce for RAW_A:
// duplicate `Goals` disambiguated to `Goals-2`; `A/B` percent-encoded to `A%2FB`;
// the fenced `# not a heading` is NOT a section.
const SECTIONS_A: SectionTree = sec("", 0, "", [
  sec("Overview", 1, "Overview", [
    sec("Goals", 2, "Overview/Goals"),
    sec("Goals", 2, "Overview/Goals-2"),
  ]),
  sec("A/B", 1, "A%2FB"),
  sec("Code", 1, "Code"),
  sec("עברית and English", 1, "עברית and English"),
]);

const NOTE_A = note({
  id: "note-a",
  raw: RAW_A,
  sections: SECTIONS_A,
  contentHash: "hash-a",
  aliases: ["Test Note", "TN", "בדיקה"],
});

const bySection = (chunks: readonly Chunk[], path: string): Chunk[] =>
  chunks.filter((c) => c.sectionPath === path);

describe("chunkNote — determinism (fencing precondition)", () => {
  it("produces a byte-identical chunk set for the same input", () => {
    const a = chunkNote(NOTE_A, CFG);
    const b = chunkNote(NOTE_A, CFG);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("emits chunks in document order with a section-local 0 ordinal (§1.6)", () => {
    const chunks = chunkNote(NOTE_A, CFG);
    // v1 emits ≤1 chunk per section → every ordinal is the section-local 0.
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map(() => 0));
    expect(chunks.map((c) => c.sectionPath)).toEqual([
      "", // preamble
      "Overview", // parent prose
      "Overview/Goals",
      "Overview/Goals-2",
      "A%2FB",
      "Code",
      "עברית and English",
    ]);
  });

  it("tags every chunk with the note's id and contentHash", () => {
    for (const c of chunkNote(NOTE_A, CFG)) {
      expect(c.noteId).toBe("note-a");
      expect(c.contentHash).toBe("hash-a");
    }
  });
});

describe("chunkNote — sectioning hazards (carry-forward #2)", () => {
  const chunks = chunkNote(NOTE_A, CFG);

  it("emits a preamble chunk with no breadcrumb, front matter excluded", () => {
    const [preamble] = bySection(chunks, "");
    expect(preamble).toBeDefined();
    expect(preamble!.text).toContain("Preamble prose here.");
    // Preamble carries identity but no heading breadcrumb — it starts with the title.
    expect(preamble!.text.startsWith("Test Note")).toBe(true);
    // Front matter is metadata, never body.
    expect(preamble!.text).not.toContain("title: Test Note");
  });

  it("emits a chunk for a parent's own prose (parent prose)", () => {
    const [overview] = bySection(chunks, "Overview");
    expect(overview).toBeDefined();
    expect(overview!.text).toContain("Parent prose under overview.");
  });

  it("gives duplicate headings distinct encoded paths but the same display breadcrumb", () => {
    const first = bySection(chunks, "Overview/Goals")[0]!;
    const second = bySection(chunks, "Overview/Goals-2")[0]!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Same DISPLAY breadcrumb (heading hierarchy present in the text)…
    expect(first.text).toContain("Overview › Goals");
    expect(second.text).toContain("Overview › Goals");
    // …but distinct chunk bodies and distinct unique paths.
    expect(first.text).toContain("Goal text.");
    expect(second.text).toContain("Second goals text.");
    expect(first.sectionPath).not.toEqual(second.sectionPath);
  });

  it("keeps duplicate-heading chunk IDs distinct (id uses the unique path, not the breadcrumb)", () => {
    const gen = generationId(NOTE_A, CFG);
    const first = chunkId(gen, "Overview/Goals", 0);
    const second = chunkId(gen, "Overview/Goals-2", 0);
    expect(first).not.toEqual(second);
  });

  it("percent-encodes a slash in the path while showing the literal slash in the breadcrumb", () => {
    const [slash] = bySection(chunks, "A%2FB");
    expect(slash).toBeDefined();
    expect(slash!.text).toContain("A/B"); // display breadcrumb decodes the slash
    expect(slash!.text).toContain("Slash body.");
  });

  it("does not treat a `#` inside a fenced code block as a heading", () => {
    const code = bySection(chunks, "Code");
    // Exactly ONE chunk for the Code section — the fenced `# not a heading`
    // produced no section of its own.
    expect(code).toHaveLength(1);
    expect(code[0]!.text).toContain("# not a heading"); // fence content is body
    expect(code[0]!.text).toContain("After fence body.");
    // The fenced line never became its own section path.
    expect(bySection(chunks, "not a heading")).toHaveLength(0);
  });
});

describe("chunkNote — body normalization preserves indentation", () => {
  it("keeps the leading indentation of an indented code block intact", () => {
    // An indented (four-space) Markdown code block on the FIRST content line must
    // survive normalization — a naive `/^\s+/` strip would eat those spaces and
    // silently turn the code block into ordinary prose, changing the body.
    const raw = ["# Snippet", "    const x = 1;", "    return x;", ""].join("\n");
    const sections = sec("", 0, "", [sec("Snippet", 1, "Snippet")]);
    const n = note({ id: "indent", raw, sections, contentHash: "h-indent" });
    const [snippet] = bySection(chunkNote(n, CFG), "Snippet");
    expect(snippet).toBeDefined();
    // Indentation on every content line (including the first) is preserved verbatim.
    expect(snippet!.text).toContain("    const x = 1;\n    return x;");
    // The body segment (after the breadcrumb + identity) still leads with the four spaces.
    expect(snippet!.text.endsWith("    const x = 1;\n    return x;")).toBe(true);
  });

  it("still drops leading and trailing blank lines around the content", () => {
    const raw = ["# S", "", "", "    indented", "", ""].join("\n");
    const sections = sec("", 0, "", [sec("S", 1, "S")]);
    const n = note({ id: "blanks", raw, sections, contentHash: "h-blanks" });
    const [s] = bySection(chunkNote(n, CFG), "S");
    expect(s!.text.endsWith("    indented")).toBe(true);
  });
});

describe("chunkNote — identity block (title + aliases)", () => {
  const chunks = chunkNote(NOTE_A, CFG);

  it("includes the title and every deduped alias in every chunk", () => {
    for (const c of chunks) {
      expect(c.text).toContain("Test Note");
      expect(c.text).toContain("TN");
      expect(c.text).toContain("בדיקה");
    }
  });

  it("dedupes an alias equal to the title exactly once", () => {
    // aliases include "Test Note" (== title); it must appear once, not twice.
    const [preamble] = chunks;
    const occurrences = preamble!.text.split("Test Note").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("chunkNote — rune-safety on mixed Hebrew/English", () => {
  it("preserves mixed-script content intact and byte-identically", () => {
    const chunks = chunkNote(NOTE_A, CFG);
    const [hebrew] = bySection(chunks, "עברית and English");
    expect(hebrew).toBeDefined();
    // Body preserved intact across scripts (Hebrew RTL + Latin + em dash).
    expect(hebrew!.text).toContain("שלום world — mixed שלום content.");
    // Breadcrumb heading is the mixed-script heading itself.
    expect(hebrew!.text).toContain("עברית and English");
    // Determinism holds for the mixed-script chunk specifically.
    expect(chunkNote(NOTE_A, CFG).at(-1)!.text).toEqual(hebrew!.text);
  });

  it("is rune-safe: no lone surrogate / replacement char leaks into any chunk", () => {
    for (const c of chunkNote(NOTE_A, CFG)) {
      expect(c.text).not.toContain("�"); // replacement char
      // Code-point iteration equals the round-tripped string (no split scalars).
      expect([...c.text].join("")).toEqual(c.text);
    }
  });
});

describe("chunkNote — version guard", () => {
  it("rejects an unsupported chunker_version", () => {
    expect(() => chunkNote(NOTE_A, { ...CFG, chunker_version: 2 })).toThrow(/unsupported.*chunker_version/i);
  });

  it("throws when the SectionTree is stale relative to note.raw (heading-count mismatch)", () => {
    const stale = note({
      id: "note-stale",
      raw: RAW_A,
      contentHash: "hash-a",
      sections: sec("", 0, "", [sec("Overview", 1, "Overview")]), // too few sections
    });
    expect(() => chunkNote(stale, CFG)).toThrow(/mismatch/i);
  });

  // A count-only guard would silently zip a renamed or reordered tree onto the
  // wrong bodies/paths/IDs. These same-count cases must be rejected by the
  // per-heading (level + text) staleness check.
  const RENAME_RAW = ["# Alpha", "body a", "", "# Beta", "body b", ""].join("\n");

  it("rejects a same-count SectionTree with a RENAMED heading", () => {
    const renamed = note({
      id: "renamed",
      raw: RENAME_RAW,
      contentHash: "h",
      sections: sec("", 0, "", [sec("Alpha", 1, "Alpha"), sec("Gamma", 1, "Gamma")]), // Beta → Gamma
    });
    expect(() => chunkNote(renamed, CFG)).toThrow(/mismatch/i);
  });

  it("rejects a same-count SectionTree with REORDERED headings", () => {
    const reordered = note({
      id: "reordered",
      raw: RENAME_RAW,
      contentHash: "h",
      sections: sec("", 0, "", [sec("Beta", 1, "Beta"), sec("Alpha", 1, "Alpha")]), // swapped
    });
    expect(() => chunkNote(reordered, CFG)).toThrow(/mismatch/i);
  });

  it("rejects a same-count SectionTree with a changed heading LEVEL", () => {
    const releveled = note({
      id: "releveled",
      raw: RENAME_RAW,
      contentHash: "h",
      // Same text + order, but Beta claims level 2 while raw scans it at level 1.
      sections: sec("", 0, "", [sec("Alpha", 1, "Alpha"), sec("Beta", 2, "Alpha/Beta")]),
    });
    expect(() => chunkNote(releveled, CFG)).toThrow(/mismatch/i);
  });
});

describe("chunkNote — a note that is all headings, no prose", () => {
  it("emits no chunks (nothing bears content)", () => {
    const raw = ["# A", "## B", "# C"].join("\n");
    const sections = sec("", 0, "", [
      sec("A", 1, "A", [sec("B", 2, "A/B")]),
      sec("C", 1, "C"),
    ]);
    const n = note({ id: "empty", raw, sections, contentHash: "h" });
    expect(chunkNote(n, CFG)).toEqual([]);
  });
});

describe("generationId — immutable, pure, tuple-sensitive (§2)", () => {
  it("is a stable 64-hex hash, identical for identical inputs (never a timestamp)", () => {
    const a = generationId(NOTE_A, CFG);
    const b = generationId(NOTE_A, CFG);
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY of the five identity components changes", () => {
    const base = generationId(NOTE_A, CFG);
    expect(generationId({ ...NOTE_A, id: "other" }, CFG)).not.toEqual(base); // noteId
    expect(generationId({ ...NOTE_A, contentHash: "hash-b" }, CFG)).not.toEqual(base); // contentHash
    expect(generationId(NOTE_A, { ...CFG, chunker_version: 2 })).not.toEqual(base); // chunkerVersion
    expect(generationId(NOTE_A, { ...CFG, embedding_model: "other-model" })).not.toEqual(base); // model
    expect(generationId(NOTE_A, { ...CFG, dimensions: 1536 })).not.toEqual(base); // dimensions (D7)
  });

  it("is independent of note fields OUTSIDE the identity tuple", () => {
    const base = generationId(NOTE_A, CFG);
    // title/aliases/status/etc. are not identity components — same tuple, same id.
    expect(generationId({ ...NOTE_A, title: "Different", status: "archived" }, CFG)).toEqual(base);
  });
});
