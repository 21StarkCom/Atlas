import { describe, it, expect, vi } from "vitest";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Fault-injection seam for the writer: wrap `open` so a test can hand back a
// FileHandle whose writeFile/sync/close reject, without disturbing any other
// fs/promises call (everything else passes through to the real implementation).
const fsControl = vi.hoisted(() => ({ actualOpen: null as unknown, openImpl: null as unknown }));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  fsControl.actualOpen = actual.open;
  return {
    ...actual,
    open: (...args: unknown[]) =>
      (fsControl.openImpl as typeof actual.open | null ?? actual.open)(...(args as [never])),
  };
});
import { withFixtureVault } from "@atlas/testing";
import type { SectionTree } from "@atlas/contracts";
import type { AtlasConfig } from "../src/config/schema.js";
import { readVault } from "../src/vault/reader.js";
import { normalizeIdentityKey } from "../src/vault/identity.js";
import { writeNoteFile } from "../src/vault/writer.js";
import { buildSectionTree, extractWikiLinks, splitFrontmatter } from "../src/markdown/parse.js";

/** A minimal `AtlasConfig` pointing the reader at a fixture vault dir. */
function cfgFor(vaultDir: string): AtlasConfig {
  return { vault: { path: vaultDir } } as unknown as AtlasConfig;
}

describe("readVault", () => {
  it("parses small-valid with zero errors", async () => {
    await withFixtureVault("small-valid", async ({ vaultDir }) => {
      const snap = await readVault(cfgFor(vaultDir));
      expect(snap.errors).toEqual([]);
      expect(snap.notes.map((n) => n.id).sort()).toEqual([
        "concept-retrieval",
        "person-aryeh",
        "project-meridian",
      ]);

      const meridian = snap.notes.find((n) => n.id === "project-meridian")!;
      expect(meridian.type).toBe("project");
      expect(meridian.schemaVersion).toBe(1);
      expect(meridian.declaredSensitivity).toBe("internal");
      expect(meridian.aliases).toEqual(["Meridian cockpit"]);
      expect(meridian.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(meridian.links.map((l) => l.target).sort()).toEqual([
        "concept-retrieval",
        "person-aryeh",
      ]);
      // Section model: root preamble → `# Meridian` → `## Status` nested under it.
      expect(meridian.sections.level).toBe(0);
      expect(meridian.sections.children.map((c) => c.path)).toEqual(["Meridian"]);
      expect(meridian.sections.children[0]!.children.map((c) => c.path)).toEqual(["Meridian/Status"]);
    });
  });

  it("surfaces broken links as typed errors, not throws", async () => {
    await withFixtureVault("broken-links", async ({ vaultDir }) => {
      const snap = await readVault(cfgFor(vaultDir));
      const broken = snap.errors.filter((e) => e.kind === "broken-link");
      expect(broken.length).toBe(2);
      // The two dangling targets are reported; the real one (anchor-note) is not.
      expect(broken.every((e) => e.path === "note-with-dangling-links.md")).toBe(true);
      expect(broken.some((e) => e.message.includes("does-not-exist"))).toBe(true);
      expect(broken.some((e) => e.message.includes("another-missing-note"))).toBe(true);
      expect(snap.errors.some((e) => e.message.includes("anchor-note"))).toBe(false);
    });
  });

  it("surfaces BOTH offenders for a duplicate id", async () => {
    await withFixtureVault("duplicate-ids", async ({ vaultDir }) => {
      const snap = await readVault(cfgFor(vaultDir));
      const dupes = snap.errors.filter((e) => e.kind === "duplicate-id");
      expect(dupes.map((e) => e.path).sort()).toEqual([
        "first-offender.md",
        "second-offender.md",
      ]);
      // Each offender names the other in its message.
      const first = dupes.find((e) => e.path === "first-offender.md")!;
      expect(first.message).toContain("second-offender.md");
    });
  });

  it("rejects unsupported/newer schema versions as a typed error", async () => {
    await withFixtureVault("small-valid", async ({ vaultDir }) => {
      const note = join(vaultDir, "project-meridian.md");
      const raw = await readFile(note, "utf8");
      await writeNoteFile(note, raw.replace("schema_version: 1", "schema_version: 2"));
      const snap = await readVault(cfgFor(vaultDir));
      const bad = snap.errors.filter((e) => e.kind === "unsupported-schema-version");
      expect(bad.length).toBe(1);
      expect(bad[0]!.path).toBe("project-meridian.md");
    });
  });

  it("empty vault yields an empty, error-free snapshot", async () => {
    await withFixtureVault("empty", async ({ vaultDir }) => {
      const snap = await readVault(cfgFor(vaultDir));
      expect(snap).toEqual({ notes: [], errors: [] });
    });
  });
});

describe("normalizeIdentityKey", () => {
  it("collapses case, whitespace, and punctuation deterministically", () => {
    expect(normalizeIdentityKey("Aryeh Stark")).toBe("aryeh stark");
    expect(normalizeIdentityKey("  Aryeh   Stark  ")).toBe("aryeh stark");
    expect(normalizeIdentityKey("Aryeh-Stark!")).toBe("aryeh stark");
    // Idempotent: normalizing an already-normalized key is a no-op.
    const once = normalizeIdentityKey("Project: Meridian (v2)");
    expect(normalizeIdentityKey(once)).toBe(once);
  });

  it("is rune-safe on mixed Hebrew/English and NFC-stable", () => {
    // Decomposed vs precomposed forms must normalize identically (NFC).
    const decomposed = "Café"; // e + combining acute
    const precomposed = "Café"; // é
    expect(normalizeIdentityKey(decomposed)).toBe(normalizeIdentityKey(precomposed));

    // Hebrew is caseless: only whitespace/punctuation fold; letters are preserved.
    expect(normalizeIdentityKey("אריה  שטארק")).toBe("אריה שטארק");
    expect(normalizeIdentityKey("Aryeh — אריה")).toBe("aryeh אריה");
    // Every code point survives intact (no surrogate splitting on a caseless run).
    expect([...normalizeIdentityKey("אריה")].length).toBe(4);
  });
});

describe("markdown primitives", () => {
  it("splits leading YAML frontmatter from the body", () => {
    const { frontmatter, body } = splitFrontmatter("---\nid: x\n---\n# Head\n\nbody\n");
    expect(frontmatter).toBe("id: x\n");
    expect(body.trimStart().startsWith("# Head")).toBe(true);
  });

  it("returns null frontmatter when there is no leading fence", () => {
    expect(splitFrontmatter("# Just a heading\n").frontmatter).toBeNull();
  });

  it("extracts wiki-links with aliases and ignores links inside code", () => {
    const links = extractWikiLinks("See [[target|Nice Name]] and `[[ignored]]` and [[plain]].");
    expect(links).toEqual([
      { target: "target", alias: "Nice Name", raw: "[[target|Nice Name]]" },
      { target: "plain", raw: "[[plain]]" },
    ]);
  });

  it("builds a stable section tree and disambiguates duplicate siblings", () => {
    const tree: SectionTree = buildSectionTree("# A\n## B\n## B\n# C\n");
    expect(tree.children.map((c) => c.heading)).toEqual(["A", "C"]);
    const a = tree.children[0]!;
    expect(a.children.map((c) => c.path)).toEqual(["A/B", "A/B-2"]);
  });

  it("ignores ATX headings inside fenced code blocks", () => {
    const tree = buildSectionTree("# Real\n```\n# Not A Heading\n```\n");
    expect(tree.children.map((c) => c.heading)).toEqual(["Real"]);
  });

  it("strips multi-backtick inline code spans so wiki-links inside them don't leak", () => {
    // Double- and triple-backtick spans must be stripped, not just single ones.
    const links = extractWikiLinks(
      "``[[hidden]]`` and ```[[also-hidden]]``` but [[real]] shows.",
    );
    expect(links.map((l) => l.target)).toEqual(["real"]);
    // A double-backtick span may itself contain a lone backtick.
    expect(extractWikiLinks("`` a ` [[x]] `` [[y]]").map((l) => l.target)).toEqual(["y"]);
    // An unclosed run is literal text, so a following real link still resolves.
    expect(extractWikiLinks("`` unclosed [[z]]").map((l) => l.target)).toEqual(["z"]);
  });
});

describe("ATX heading selectors (CommonMark §4.2)", () => {
  it("recognizes headings indented up to three spaces, but not four", () => {
    expect(buildSectionTree("   # Indented\n").children.map((c) => c.heading)).toEqual([
      "Indented",
    ]);
    // Four spaces → indented code block, not a heading.
    expect(buildSectionTree("    # Code\n").children).toEqual([]);
  });

  it("includes empty headings with empty text", () => {
    const tree = buildSectionTree("#\n## \n### ###\n");
    expect(tree.children.map((c) => c.level)).toEqual([1]);
    expect(tree.children[0]!.heading).toBe("");
    // `## ` (level 2, empty) nests under the level-1 empty heading.
    const lvl2 = tree.children[0]!.children;
    expect(lvl2.map((c) => c.level)).toEqual([2]);
    expect(lvl2[0]!.heading).toBe("");
    // `### ###` (level 3, empty via closing sequence) nests under it.
    expect(lvl2[0]!.children.map((c) => c.heading)).toEqual([""]);
  });

  it("strips a whitespace-preceded closing hash run but keeps attached hashes", () => {
    // Closing sequence must be preceded by whitespace.
    expect(buildSectionTree("# foo ###\n").children[0]!.heading).toBe("foo");
    // No preceding whitespace → the hashes are literal content.
    expect(buildSectionTree("# foo###\n").children[0]!.heading).toBe("foo###");
    // A `#` with no following space is not a heading at all.
    expect(buildSectionTree("#foo\n").children).toEqual([]);
  });
});

describe("wiki-link resolution precedence + collisions", () => {
  /** Author a note into `dir` with the given id/aliases/body via the writer. */
  async function note(
    dir: string,
    file: string,
    id: string,
    aliases: readonly string[],
    body = "",
  ): Promise<void> {
    const fm = `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\ncreated: 2026-07-11\nupdated: 2026-07-11\naliases: [${aliases
      .map((a) => JSON.stringify(a))
      .join(", ")}]\n---\n# ${id}\n${body}`;
    await writeNoteFile(join(dir, file), fm);
  }

  it("resolves via exact id, then filename slug, then unique normalized alias", async () => {
    await withFixtureVault("empty", async ({ vaultDir }) => {
      await note(vaultDir, "alpha.md", "id-alpha", ["The Alpha One"]);
      // Link by id, by filename slug, and by (case/space-folded) alias.
      await note(vaultDir, "beta.md", "id-beta", [], "[[id-alpha]] [[alpha]] [[the alpha  one]]\n");
      const snap = await readVault(cfgFor(vaultDir));
      expect(snap.errors).toEqual([]);
    });
  });

  it("surfaces an ambiguous-link when two notes share a normalized alias", async () => {
    await withFixtureVault("empty", async ({ vaultDir }) => {
      await note(vaultDir, "one.md", "id-one", ["Shared Alias"]);
      await note(vaultDir, "two.md", "id-two", ["shared  alias"]); // folds to same key
      await note(vaultDir, "src.md", "id-src", [], "[[Shared Alias]]\n");
      const snap = await readVault(cfgFor(vaultDir));
      const amb = snap.errors.filter((e) => e.kind === "ambiguous-link");
      expect(amb.length).toBe(1);
      expect(amb[0]!.path).toBe("src.md");
      expect(amb[0]!.message).toContain("one.md");
      expect(amb[0]!.message).toContain("two.md");
    });
  });

  it("surfaces an ambiguous-link when two files share a filename slug", async () => {
    await withFixtureVault("empty", async ({ vaultDir }) => {
      await mkdir(join(vaultDir, "sub"), { recursive: true });
      await note(vaultDir, "dup.md", "id-a", []);
      await note(join(vaultDir, "sub"), "dup.md", "id-b", []);
      await note(vaultDir, "src.md", "id-src", [], "[[dup]]\n");
      const snap = await readVault(cfgFor(vaultDir));
      const amb = snap.errors.filter((e) => e.kind === "ambiguous-link");
      expect(amb.length).toBe(1);
      expect(amb[0]!.message).toContain("filename slug");
    });
  });

  it("emits identity-collision for a shared normalized alias, independent of any link", async () => {
    await withFixtureVault("empty", async ({ vaultDir }) => {
      // No wiki-links anywhere: the collision must still surface eagerly.
      await note(vaultDir, "one.md", "id-one", ["Shared Alias"]);
      await note(vaultDir, "two.md", "id-two", ["shared  alias"]); // folds to same key
      const snap = await readVault(cfgFor(vaultDir));
      const coll = snap.errors.filter((e) => e.kind === "identity-collision");
      expect(coll.map((e) => e.path).sort()).toEqual(["one.md", "two.md"]);
      expect(coll.every((e) => e.message.includes("shared alias"))).toBe(true);
    });
  });

  it("emits identity-collision when a slug collides with another note's alias", async () => {
    await withFixtureVault("empty", async ({ vaultDir }) => {
      // "alpha.md" owns slug key `alpha`; "beta.md" aliases "Alpha" → same key.
      await note(vaultDir, "alpha.md", "id-alpha", []);
      await note(vaultDir, "beta.md", "id-beta", ["Alpha"]);
      const snap = await readVault(cfgFor(vaultDir));
      const coll = snap.errors.filter((e) => e.kind === "identity-collision");
      expect(coll.map((e) => e.path).sort()).toEqual(["alpha.md", "beta.md"]);
    });
  });

  it("does NOT flag a single note whose own aliases are canonically equivalent", async () => {
    await withFixtureVault("empty", async ({ vaultDir }) => {
      // One note owns "Alpha One" and "alpha  one" — canonically equal aliases.
      // It owns the key once: no self-collision, and `[[alpha one]]` is not
      // falsely ambiguous against itself (finding: dedup ownership by note).
      await note(vaultDir, "owner.md", "id-owner", ["Alpha One", "alpha  one"]);
      await note(vaultDir, "ref.md", "id-ref", [], "[[alpha one]]\n");
      const snap = await readVault(cfgFor(vaultDir));
      expect(snap.errors.filter((e) => e.kind === "identity-collision")).toEqual([]);
      expect(snap.errors.filter((e) => e.kind === "ambiguous-link")).toEqual([]);
      expect(snap.errors.filter((e) => e.kind === "broken-link")).toEqual([]);
    });
  });

  it("lets an exact id win over a lower-tier alias collision", async () => {
    await withFixtureVault("empty", async ({ vaultDir }) => {
      // Two notes collide on the alias "target", but a note's id is exactly "target".
      await note(vaultDir, "canonical.md", "target", []);
      await note(vaultDir, "x.md", "id-x", ["target"]);
      await note(vaultDir, "y.md", "id-y", ["target"]);
      await note(vaultDir, "src.md", "id-src", [], "[[target]]\n");
      const snap = await readVault(cfgFor(vaultDir));
      // Exact-id tier 1 resolves; the alias collision is never consulted.
      expect(snap.errors.filter((e) => e.kind === "ambiguous-link")).toEqual([]);
      expect(snap.errors.filter((e) => e.kind === "broken-link")).toEqual([]);
    });
  });
});

describe("section selectors: slash-containing headings", () => {
  it("encodes a slash in a heading so it cannot collide with nesting", () => {
    const withSlash = buildSectionTree("# A/B\n");
    expect(withSlash.children.map((c) => c.path)).toEqual(["A%2FB"]);

    const nested = buildSectionTree("# A\n## B\n");
    expect(nested.children[0]!.children.map((c) => c.path)).toEqual(["A/B"]);

    // The two selectors are provably distinct.
    expect(withSlash.children[0]!.path).not.toBe(nested.children[0]!.children[0]!.path);
  });
});

describe("fenced code block edge cases", () => {
  it("a four-backtick fence is not closed by a three-backtick line", () => {
    const tree = buildSectionTree("````\n# Not A Heading\n```\n# Still Code\n````\n# Real\n");
    expect(tree.children.map((c) => c.heading)).toEqual(["Real"]);
  });

  it("a same-character line with trailing content does not close the block", () => {
    // The ```` ```js ```` line has an info string → not a valid closing fence,
    // so `# Hidden` stays inside the code block and is not a heading.
    const tree = buildSectionTree("```\n# Hidden\n```js\n# Still Hidden\n```\n# Real\n");
    expect(tree.children.map((c) => c.heading)).toEqual(["Real"]);
  });

  it("does not leak links out of a four-backtick block via a short fence", () => {
    const links = extractWikiLinks("````\n[[leaked]]\n```\n[[also-leaked]]\n````\n[[real]]\n");
    expect(links.map((l) => l.target)).toEqual(["real"]);
  });
});

describe("writeNoteFile", () => {
  /** Route the writer's `open` through `impl` for the duration of `fn`. */
  async function withOpenImpl(
    impl: (typeof import("node:fs/promises"))["open"],
    fn: () => Promise<void>,
  ): Promise<void> {
    fsControl.openImpl = impl;
    try {
      await fn();
    } finally {
      fsControl.openImpl = null;
    }
  }
  const realOpen = () => fsControl.actualOpen as (typeof import("node:fs/promises"))["open"];

  it("atomically writes content and leaves no temp files behind", async () => {
    await withFixtureVault("small-valid", async ({ vaultDir }) => {
      const target = join(vaultDir, "person-aryeh.md");
      await writeNoteFile(target, "---\nid: person-aryeh\ntype: person\nschema_version: 1\n---\n# New\n");
      expect((await stat(target)).isFile()).toBe(true);
      const contents = await readFile(target, "utf8");
      expect(contents).toContain("# New");
      // No `.atlas-tmp` residue in the note's directory.
      const leftovers = (await readdir(vaultDir)).filter((f) => f.includes("atlas-tmp"));
      expect(leftovers).toEqual([]);
    });
  });

  it("removes the temp file and preserves the error when sync() fails", async () => {
    await withFixtureVault("small-valid", async ({ vaultDir }) => {
      await withOpenImpl(
        (async (...args: Parameters<ReturnType<typeof realOpen>>) => {
          const handle = await realOpen()(...args);
          handle.sync = () => Promise.reject(new Error("sync boom"));
          return handle;
        }) as ReturnType<typeof realOpen>,
        async () => {
          const target = join(vaultDir, "person-aryeh.md");
          await expect(writeNoteFile(target, "x")).rejects.toThrow("sync boom");
          const leftovers = (await readdir(vaultDir)).filter((f) => f.includes("atlas-tmp"));
          expect(leftovers).toEqual([]);
        },
      );
    });
  });

  it("removes the temp file and preserves the error when writeFile() fails", async () => {
    await withFixtureVault("small-valid", async ({ vaultDir }) => {
      await withOpenImpl(
        (async (...args: Parameters<ReturnType<typeof realOpen>>) => {
          const handle = await realOpen()(...args);
          handle.writeFile = () => Promise.reject(new Error("write boom"));
          return handle;
        }) as ReturnType<typeof realOpen>,
        async () => {
          const target = join(vaultDir, "person-aryeh.md");
          await expect(writeNoteFile(target, "x")).rejects.toThrow("write boom");
          const leftovers = (await readdir(vaultDir)).filter((f) => f.includes("atlas-tmp"));
          expect(leftovers).toEqual([]);
        },
      );
    });
  });

  it("removes the temp file when the final rename() fails", async () => {
    await withFixtureVault("small-valid", async ({ vaultDir }) => {
      // Renaming a file over an existing directory fails → cleanup must fire.
      await mkdir(join(vaultDir, "adir"), { recursive: true });
      await expect(writeNoteFile(join(vaultDir, "adir"), "x")).rejects.toBeInstanceOf(Error);
      const leftovers = (await readdir(vaultDir)).filter((f) => f.includes("atlas-tmp"));
      expect(leftovers).toEqual([]);
    });
  });
});
