import { describe, it, expect } from "vitest";
import type { ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import {
  generatePatch,
  sectionContentHash,
  frontmatterValueHash,
  normalizeSectionBody,
  isPatchableOp,
  UnpatchableOperationError,
} from "../src/markdown/patch.js";
import { applyPatch } from "../src/markdown/apply.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { resolveSections, buildSectionTree } from "../src/markdown/sections.js";

/** Minimal `ParsedNote` — `generatePatch` reads only `id` + `raw`; the rest is filled for the type. */
function mkNote(raw: string, id = "note-a"): ParsedNote {
  const { body } = splitFrontmatter(raw);
  return {
    id,
    path: `${id}.md`,
    type: "concept",
    schemaVersion: 1,
    title: id,
    status: "active",
    created: "2026-07-11",
    updated: "2026-07-11",
    aliases: [],
    sources: [],
    declaredSensitivity: "internal",
    links: [],
    sections: buildSectionTree(body),
    contentHash: "sha256:0",
    raw,
  };
}

/** Read a section's current body text from raw markdown, by stable path. */
function sectionBody(raw: string, path: string): string {
  const { body } = splitFrontmatter(raw);
  const s = resolveSections(body).find((x) => x.path === path);
  if (!s) throw new Error(`no section ${path}`);
  return body.slice(s.bodyStart, s.bodyEnd);
}

const FIXTURE = `---
id: note-a
title: Alpha
status: draft
tags: [research, wip]
customField: keep-me
---
# Overview

Intro paragraph.

## Goals

- goal one
- goal two

# Log

First entry.
`;

const updateSection = (path: string, hash: string, newContent: string): ChangePlanOperation => ({
  op: "UpdateSection",
  opVersion: 1,
  selector: { path, expectedContentHash: hash },
  newContent,
});

describe("patch: UpdateSection round-trips", () => {
  it("replaces a section body and re-parses to the new content", () => {
    const note = mkNote(FIXTURE);
    const hash = sectionContentHash(sectionBody(FIXTURE, "Overview/Goals"));
    const patch = generatePatch(note, updateSection("Overview/Goals", hash, "- goal three\n- goal four\n"));
    const res = applyPatch(FIXTURE, patch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(normalizeSectionBody(sectionBody(res.next, "Overview/Goals"))).toBe("- goal three\n- goal four");
  });

  it("leaves every byte outside the target section untouched (no whole-file rewrite)", () => {
    const note = mkNote(FIXTURE);
    const hash = sectionContentHash(sectionBody(FIXTURE, "Log"));
    const patch = generatePatch(note, updateSection("Log", hash, "Rewritten log.\n"));
    const res = applyPatch(FIXTURE, patch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Overview + Goals + frontmatter are unchanged; only the Log tail differs.
    expect(res.next.startsWith(FIXTURE.slice(0, FIXTURE.indexOf("# Log")))).toBe(true);
    expect(sectionBody(res.next, "Overview/Goals")).toBe(sectionBody(FIXTURE, "Overview/Goals"));
  });

  it("round-trips a fixture note repeatedly with re-derived hashes (property-style)", () => {
    let raw = FIXTURE;
    for (const content of ["v1 body\n", "v2 body\nsecond line\n", "v3\n"]) {
      const hash = sectionContentHash(sectionBody(raw, "Log"));
      const patch = generatePatch(mkNote(raw), updateSection("Log", hash, content));
      const res = applyPatch(raw, patch);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      raw = res.next;
      expect(normalizeSectionBody(sectionBody(raw, "Log"))).toBe(normalizeSectionBody(content));
    }
  });
});

describe("patch: stale context fails safely", () => {
  it("returns content-hash-mismatch (not a thrown error) when the section changed", () => {
    const note = mkNote(FIXTURE);
    const patch = generatePatch(note, updateSection("Overview/Goals", `sha256:${"0".repeat(64)}`, "x\n"));
    const res = applyPatch(FIXTURE, patch);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("stale-context");
    expect(res.error.code).toBe("content-hash-mismatch");
  });

  it("returns section-not-found for a selector that resolves to nothing", () => {
    const note = mkNote(FIXTURE);
    const patch = generatePatch(note, updateSection("Nonexistent", `sha256:${"0".repeat(64)}`, "x\n"));
    const res = applyPatch(FIXTURE, patch);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("section-not-found");
  });

  it("tolerates insignificant whitespace churn in the pinned content", () => {
    const note = mkNote(FIXTURE);
    // Hash pinned over a trailing-whitespace + blank-line variant of the real body.
    const noisy = sectionBody(FIXTURE, "Log").replace(/\n$/, "  \n\n");
    const patch = generatePatch(note, updateSection("Log", sectionContentHash(noisy), "ok\n"));
    const res = applyPatch(FIXTURE, patch);
    expect(res.ok).toBe(true);
  });
});

describe("patch: AppendSection", () => {
  it("appends into an existing section, preserving prior content", () => {
    const op: ChangePlanOperation = {
      op: "AppendSection",
      opVersion: 1,
      selector: { path: "Overview/Goals" },
      content: "- goal three",
    };
    const res = applyPatch(FIXTURE, generatePatch(mkNote(FIXTURE), op));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const body = normalizeSectionBody(sectionBody(res.next, "Overview/Goals"));
    expect(body).toContain("- goal one");
    expect(body).toContain("- goal three");
  });

  it("creates an absent section when createIfAbsent is set", () => {
    const op: ChangePlanOperation = {
      op: "AppendSection",
      opVersion: 1,
      selector: { path: "Notes" },
      content: "a fresh note",
      createIfAbsent: true,
    };
    const res = applyPatch(FIXTURE, generatePatch(mkNote(FIXTURE), op));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const paths = resolveSections(splitFrontmatter(res.next).body).map((s) => s.path);
    expect(paths).toContain("Notes");
    expect(normalizeSectionBody(sectionBody(res.next, "Notes"))).toBe("a fresh note");
  });

  it("refuses an absent section without createIfAbsent", () => {
    const op: ChangePlanOperation = {
      op: "AppendSection",
      opVersion: 1,
      selector: { path: "Notes" },
      content: "x",
    };
    const res = applyPatch(FIXTURE, generatePatch(mkNote(FIXTURE), op));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("section-not-found");
  });
});

describe("patch: frontmatter", () => {
  const setField = (
    mode: "add" | "update",
    field: string,
    value: string,
    hash?: string,
  ): ChangePlanOperation => ({
    op: "SetFrontmatterField",
    opVersion: 1,
    mode,
    field,
    value,
    ...(hash ? { expectedCurrentValueHash: hash } : {}),
  });

  it("adds a new field and preserves unknown frontmatter keys", () => {
    const res = applyPatch(FIXTURE, generatePatch(mkNote(FIXTURE), setField("add", "priority", "high")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { frontmatter } = splitFrontmatter(res.next);
    expect(frontmatter).toContain("priority: high");
    expect(frontmatter).toContain("customField: keep-me"); // unknown key survives
    expect(frontmatter).toContain("tags: [research, wip]");
  });

  it("rejects an add when the field already exists", () => {
    const res = applyPatch(FIXTURE, generatePatch(mkNote(FIXTURE), setField("add", "status", "x")));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("field-exists");
  });

  it("updates a scalar with the correct value-hash precondition", () => {
    const hash = frontmatterValueHash("draft");
    const res = applyPatch(FIXTURE, generatePatch(mkNote(FIXTURE), setField("update", "status", "active", hash)));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(splitFrontmatter(res.next).frontmatter).toContain("status: active");
  });

  it("rejects an update whose pinned value hash is stale", () => {
    const res = applyPatch(
      FIXTURE,
      generatePatch(mkNote(FIXTURE), setField("update", "status", "active", `sha256:${"0".repeat(64)}`)),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("value-hash-mismatch");
  });
});

describe("patch: AddAlias", () => {
  const addAlias = (alias: string): ChangePlanOperation => ({ op: "AddAlias", opVersion: 1, alias });

  it("appends to a flow-style aliases array", () => {
    const raw = "---\nid: n\naliases: [one, two]\n---\n# H\n\nbody\n";
    const res = applyPatch(raw, generatePatch(mkNote(raw, "n"), addAlias("three")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(splitFrontmatter(res.next).frontmatter).toContain("aliases: [one, two, three]");
  });

  it("appends to a block-style aliases array", () => {
    const raw = "---\nid: n\naliases:\n  - one\n  - two\ntitle: T\n---\n# H\n\nbody\n";
    const res = applyPatch(raw, generatePatch(mkNote(raw, "n"), addAlias("three")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fm = splitFrontmatter(res.next).frontmatter;
    expect(fm).toContain("  - three");
    expect(fm).toContain("title: T"); // the block insert did not clobber the next key
  });

  it("rejects a duplicate alias (idempotency guard)", () => {
    const raw = "---\nid: n\naliases: [one, two]\n---\n# H\n\nbody\n";
    const res = applyPatch(raw, generatePatch(mkNote(raw, "n"), addAlias("two")));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("alias-exists");
  });

  it("creates an aliases field when the note has none", () => {
    const raw = "---\nid: n\ntitle: T\n---\n# H\n\nbody\n";
    const res = applyPatch(raw, generatePatch(mkNote(raw, "n"), addAlias("first")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(splitFrontmatter(res.next).frontmatter).toMatch(/aliases:\n {2}- first/);
  });
});

describe("patch: section resolution ignores fenced code", () => {
  it("does not treat a `#` inside a code fence as a heading", () => {
    const raw = "---\nid: n\n---\n# Real\n\n```\n## Fake Heading\n```\n\ntail\n";
    const paths = resolveSections(splitFrontmatter(raw).body).map((s) => s.path);
    expect(paths).toEqual(["Real"]);
    // Updating the real section leaves the fenced pseudo-heading verbatim.
    const hash = sectionContentHash(sectionBody(raw, "Real"));
    const res = applyPatch(raw, generatePatch(mkNote(raw, "n"), updateSection("Real", hash, "```\n## Fake Heading\n```\n\nnew tail\n")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.next).toContain("## Fake Heading");
  });
});

describe("patch: unpatchable operations", () => {
  it("throws UnpatchableOperationError for a proposal op", () => {
    const op: ChangePlanOperation = {
      op: "ProposeArchive",
      opVersion: 1,
      reason: "obsolete",
    } as ChangePlanOperation;
    expect(isPatchableOp("ProposeArchive")).toBe(false);
    expect(() => generatePatch(mkNote(FIXTURE), op)).toThrow(UnpatchableOperationError);
  });

  it("classifies the four note-text ops as patchable", () => {
    for (const op of ["UpdateSection", "AppendSection", "SetFrontmatterField", "AddAlias"] as const) {
      expect(isPatchableOp(op)).toBe(true);
    }
  });
});

describe("patch: summary is metadata-only", () => {
  it("renders a human-readable per-op summary without raw content", () => {
    const hash = sectionContentHash(sectionBody(FIXTURE, "Log"));
    const patch = generatePatch(mkNote(FIXTURE), updateSection("Log", hash, "new\n"));
    expect(patch.summary).toContain("Update section «Log»");
  });
});
