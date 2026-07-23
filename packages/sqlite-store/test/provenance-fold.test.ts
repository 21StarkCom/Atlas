/**
 * `provenance-fold` — `foldProvenanceManifests` reconstructs ALL four provenance
 * projections (`content_blobs`, `source_captures`, `source_renditions`,
 * `note_sources`) from canonical Markdown manifests, and a `db rebuild` on the
 * committed `source-heavy` fixture reproduces them from the manifests alone with
 * ONLY `0003_provenance` (retained PR-A) applied (acceptance §Acceptance-Criteria).
 *
 * The derived active-rendition pointer is asserted as the component column pair
 * (`active_extractor_version`, `active_normalizer_version`) — never a packed
 * string (plan Review-Hint). The fold is fail-closed: a malformed manifest or a
 * dangling `sources` reference rolls the rebuild back and preserves the prior
 * projection (fixes wing R2-F3).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseSourceHandle, type NoteType, type ParsedNote, type VaultSnapshot } from "@atlas/contracts";
import {
  openStore,
  captureId,
  MalformedManifestError,
  DanglingSourceError,
} from "../src/index.js";
import type { Store } from "../src/index.js";
import { makeNote, REPO_ROOT } from "./helpers.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;
const CONTENT_B = `sha256:${HEX_B}:text/plain`;

/**
 * Open a store and apply the retained PR-A migrations via the PUBLIC path —
 * `openStore` pre-registers `0001_core` + `0003_provenance` + `0004_claims`, so
 * `migrate()` creates the provenance (and claims) tables with NO manual
 * `registerMigration` (fixes wing R2-F1: the fold must not silently no-op on the
 * normal store path).
 */
function provenanceStore(): Store {
  const store = openStore({ path: ":memory:" });
  const report = store.migrate();
  expect(new Set(report.newlyApplied)).toEqual(
    new Set(["0001_core", "0003_provenance", "0004_claims", "0005_ledger_finalize", "0013_links_v2", "0014_evidence_v2"]),
  );
  return store;
}

/** A source-manifest note: frontmatter carries `contentId` + a `provenance:` block. */
function manifestNote(id: string, path: string, frontmatter: string, sources: string[] = []): ParsedNote {
  const raw = `---\nid: ${id}\ntype: source\nschema_version: 1\ntitle: ${id}\ncreated: 2026-07-11\nupdated: 2026-07-11\n${frontmatter}\n---\n\n# ${id}\n`;
  return makeNote({ id, path, type: "source", sources, raw });
}

function snap(notes: ParsedNote[]): VaultSnapshot {
  return { notes, errors: [] };
}

const SOURCE_HEAVY = join(REPO_ROOT, "fixtures", "source-heavy");

/** yaml parses bare dates to `Date`; project them back to a stable scalar string. */
function scalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * Build a `ParsedNote` from a COMMITTED `source-heavy` fixture file — the real
 * fixture/parser path: read the file, take its frontmatter + raw body verbatim,
 * and let the fold reconstruct provenance from the actual manifest (fixes wing
 * R2-F5: no reduced imitation).
 */
function readFixtureNote(relPath: string): ParsedNote {
  const raw = readFileSync(join(SOURCE_HEAVY, relPath), "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const fm = (m ? (parseYaml(m[1]!) as Record<string, unknown>) : {}) ?? {};
  const srcs = Array.isArray(fm.sources) ? (fm.sources as unknown[]).map(String) : [];
  return makeNote({
    id: String(fm.id),
    path: relPath,
    type: (fm.type as NoteType) ?? "concept",
    title: scalar(fm.title ?? fm.id),
    created: scalar(fm.created ?? "2026-07-11"),
    updated: scalar(fm.updated ?? "2026-07-11"),
    sources: srcs,
    raw,
  });
}

describe("provenance-fold", () => {
  it("minimal manifest → blob + single capture, NULL active-rendition pointer", () => {
    const store = provenanceStore();
    try {
      const fm = [
        `contentId: "${CONTENT_A}"`,
        `origin: notes/a.txt`,
        `provenance:`,
        `  vault_path: sources/a.txt`,
        `  size_bytes: 42`,
        `  first_seen_at: 2026-07-11T00:00:00Z`,
      ].join("\n");
      store.rebuildProjections(snap([manifestNote("s-a", "sources/s-a.md", fm)]));

      const blobs = store.provenance.allBlobs();
      expect(blobs).toHaveLength(1);
      expect(blobs[0]).toMatchObject({
        raw_content_hash: HEX_A,
        canonical_media_type: "text/plain",
        size_bytes: 42,
        vault_path: "sources/a.txt",
        first_seen_at: "2026-07-11T00:00:00Z",
        active_extractor_version: null,
        active_normalizer_version: null,
      });

      const captures = store.provenance.allCaptures();
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({
        capture_id: captureId(HEX_A, "text/plain", "notes/a.txt"),
        origin: "notes/a.txt",
        observation_count: 1,
      });

      expect(store.provenance.allRenditions()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("rich manifest rebuilds to EXACT rows incl. the DERIVED active-rendition pointer", () => {
    const store = provenanceStore();
    try {
      // Two renditions, no explicit active_rendition → highest (extractor,normalizer) is derived.
      const fm = [
        `contentId: "${CONTENT_A}"`,
        `provenance:`,
        `  size_bytes: 2048`,
        `  vault_path: sources/blobs/a.txt`,
        `  first_seen_at: 2026-07-10T09:00:00Z`,
        `  captures:`,
        `    - origin: notes/a.txt`,
        `      first_seen_at: 2026-07-10T09:00:00Z`,
        `      last_seen_at: 2026-07-11T10:00:00Z`,
        `      observation_count: 3`,
        `    - origin: mirror/a.txt`,
        `      first_seen_at: 2026-07-11T00:00:00Z`,
        `      last_seen_at: 2026-07-11T00:00:00Z`,
        `      observation_count: 1`,
        `  renditions:`,
        `    - extractor_version: 1`,
        `      normalizer_version: 1`,
        `      normalized_content_hash: "${HEX_B}"`,
        `      size_bytes: 1900`,
        `      locator_scheme: char`,
        `      created_at: 2026-07-10T09:05:00Z`,
        `    - extractor_version: 2`,
        `      normalizer_version: 1`,
        `      normalized_content_hash: "${HEX_C}"`,
        `      size_bytes: 1950`,
        `      locator_scheme: char`,
        `      created_at: 2026-07-11T09:05:00Z`,
      ].join("\n");
      store.rebuildProjections(snap([manifestNote("s-a", "sources/s-a.md", fm)]));

      const blob = store.provenance.allBlobs()[0]!;
      expect(blob).toMatchObject({
        raw_content_hash: HEX_A,
        canonical_media_type: "text/plain",
        size_bytes: 2048,
        vault_path: "sources/blobs/a.txt",
        first_seen_at: "2026-07-10T09:00:00Z",
        // DERIVED pointer = highest version pair (2,1), as component columns.
        active_extractor_version: 2,
        active_normalizer_version: 1,
      });

      const renditions = store.provenance.allRenditions();
      expect(renditions).toHaveLength(2);
      expect(renditions.map((r) => [r.extractor_version, r.normalizer_version])).toEqual([
        [1, 1],
        [2, 1],
      ]);
      expect(renditions[1]).toMatchObject({
        normalized_content_hash: HEX_C,
        size_bytes: 1950,
        locator_scheme: "char",
      });

      const captures = store.provenance.allCaptures();
      expect(captures).toHaveLength(2);
      const byOrigin = Object.fromEntries(captures.map((c) => [c.origin, c]));
      expect(byOrigin["notes/a.txt"]).toMatchObject({ observation_count: 3, last_seen_at: "2026-07-11T10:00:00Z" });
      expect(byOrigin["mirror/a.txt"]).toMatchObject({ observation_count: 1 });
    } finally {
      store.close();
    }
  });

  it("explicit active_rendition wins over the derived highest-version default", () => {
    const store = provenanceStore();
    try {
      const fm = [
        `contentId: "${CONTENT_A}"`,
        `origin: notes/a.txt`,
        `provenance:`,
        `  vault_path: sources/a.txt`,
        `  size_bytes: 12`,
        `  renditions:`,
        `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
        `    - { extractor_version: 2, normalizer_version: 1, normalized_content_hash: "${HEX_C}", size_bytes: 11, locator_scheme: char }`,
        `  active_rendition: { extractor_version: 1, normalizer_version: 1 }`,
      ].join("\n");
      store.rebuildProjections(snap([manifestNote("s-a", "sources/s-a.md", fm)]));
      const blob = store.provenance.allBlobs()[0]!;
      expect(blob.active_extractor_version).toBe(1);
      expect(blob.active_normalizer_version).toBe(1);
    } finally {
      store.close();
    }
  });

  it("note_sources: blob-general citation from a `sources: [noteId]` reference", () => {
    const store = provenanceStore();
    try {
      const source = manifestNote(
        "s-a",
        "sources/s-a.md",
        [`contentId: "${CONTENT_A}"`, `origin: notes/a.txt`, `provenance:`, `  vault_path: sources/a.txt`, `  size_bytes: 5`].join("\n"),
      );
      const citing = makeNote({ id: "synth", path: "synth.md", sources: ["s-a"] });
      // notes projection needs both notes; rebuild handles that.
      store.rebuildProjections(snap([source, citing]));

      const ns = store.provenance.allNoteSources();
      expect(ns).toHaveLength(1);
      expect(ns[0]).toMatchObject({
        note_id: "synth",
        raw_content_hash: HEX_A,
        canonical_media_type: "text/plain",
        extractor_version: null, // blob-general
        normalizer_version: null,
      });
    } finally {
      store.close();
    }
  });

  it("note_sources: rendition-specific citation from a serialized renditionId handle", () => {
    const store = provenanceStore();
    try {
      const fm = [
        `contentId: "${CONTENT_A}"`,
        `origin: notes/a.txt`,
        `provenance:`,
        `  vault_path: sources/a.txt`,
        `  size_bytes: 5`,
        `  renditions:`,
        `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
      ].join("\n");
      const source = manifestNote("s-a", "sources/s-a.md", fm);
      const citing = makeNote({
        id: "synth",
        path: "synth.md",
        sources: [`sha256:${HEX_A}:text/plain:1:1`],
      });
      store.rebuildProjections(snap([source, citing]));

      const ns = store.provenance.allNoteSources();
      expect(ns).toHaveLength(1);
      expect(ns[0]).toMatchObject({
        note_id: "synth",
        raw_content_hash: HEX_A,
        canonical_media_type: "text/plain",
        extractor_version: 1,
        normalizer_version: 1,
      });
    } finally {
      store.close();
    }
  });

  it("rebuild is convergent (folding the same manifests twice yields identical rows)", () => {
    const store = provenanceStore();
    try {
      const fm = [
        `contentId: "${CONTENT_A}"`,
        `origin: notes/a.txt`,
        `provenance:`,
        `  vault_path: sources/a.txt`,
        `  size_bytes: 5`,
        `  renditions:`,
        `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
      ].join("\n");
      const notes = [manifestNote("s-a", "sources/s-a.md", fm), makeNote({ id: "synth", path: "synth.md", sources: ["s-a"] })];
      store.rebuildProjections(snap(notes));
      const first = JSON.stringify([
        store.provenance.allBlobs(),
        store.provenance.allCaptures(),
        store.provenance.allRenditions(),
        store.provenance.allNoteSources(),
      ]);
      store.rebuildProjections(snap(notes));
      const second = JSON.stringify([
        store.provenance.allBlobs(),
        store.provenance.allCaptures(),
        store.provenance.allRenditions(),
        store.provenance.allNoteSources(),
      ]);
      expect(second).toEqual(first);
    } finally {
      store.close();
    }
  });

  it("resolveSourceHandle: contentId → active rendition FULL row; renditionId → itself; unknown → null", () => {
    const store = provenanceStore();
    try {
      const fm = [
        `contentId: "${CONTENT_A}"`,
        `origin: notes/a.txt`,
        `provenance:`,
        `  vault_path: sources/a.txt`,
        `  size_bytes: 5`,
        `  first_seen_at: 2026-07-11T00:00:00Z`,
        `  renditions:`,
        `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char, created_at: 2026-07-11T00:00:00Z }`,
        `    - { extractor_version: 2, normalizer_version: 1, normalized_content_hash: "${HEX_C}", size_bytes: 11, locator_scheme: char, created_at: 2026-07-11T00:00:00Z }`,
      ].join("\n");
      store.rebuildProjections(snap([manifestNote("s-a", "sources/s-a.md", fm)]));

      // contentId resolves through the DERIVED active pointer (2,1) to the FULL row.
      expect(store.provenance.resolveSourceHandle(parseSourceHandle(CONTENT_A))).toEqual({
        raw_content_hash: HEX_A,
        canonical_media_type: "text/plain",
        extractor_version: 2,
        normalizer_version: 1,
        normalized_content_hash: HEX_C,
        size_bytes: 11,
        locator_scheme: "char",
        created_at: "2026-07-11T00:00:00Z",
      });
      // an explicit renditionId resolves to that rendition's full row.
      expect(store.provenance.resolveSourceHandle(parseSourceHandle(`sha256:${HEX_A}:text/plain:1:1`))).toMatchObject({
        extractor_version: 1,
        normalizer_version: 1,
        normalized_content_hash: HEX_B,
        size_bytes: 10,
      });
      // an unknown blob → null.
      expect(store.provenance.resolveSourceHandle(parseSourceHandle(CONTENT_B))).toBeNull();
      // a nonexistent rendition of a known blob → null.
      expect(store.provenance.resolveSourceHandle(parseSourceHandle(`sha256:${HEX_A}:text/plain:9:9`))).toBeNull();
    } finally {
      store.close();
    }
  });

  it("db rebuild on the COMMITTED source-heavy fixture reproduces provenance from manifests ALONE", () => {
    const store = provenanceStore();
    try {
      // Read the actual committed fixture files — the real manifest/parser path.
      const wcag = readFixtureNote("sources/source-2026-07-11-wcag-notes.md");
      const interview = readFixtureNote("sources/source-2026-07-11-interview.md");
      const synth = readFixtureNote("research-synthesis-accessibility.md");
      const analyst = readFixtureNote("person-analyst.md");

      store.rebuildProjections(snap([wcag, interview, synth, analyst]));

      // Two blobs, with the EXACT vault_path (immutable raw .txt) + size from the fixtures.
      const blobs = store.provenance.allBlobs();
      expect(blobs).toHaveLength(2);
      const byHash = Object.fromEntries(blobs.map((b) => [b.raw_content_hash, b]));
      const WCAG = "11a1c0ffee11a1c0ffee11a1c0ffee11a1c0ffee11a1c0ffee11a1c0ffee0001";
      const INTERVIEW = "22b2c0ffee22b2c0ffee22b2c0ffee22b2c0ffee22b2c0ffee22b2c0ffee0002";
      expect(byHash[WCAG]).toMatchObject({
        canonical_media_type: "text/plain",
        vault_path: "sources/source-2026-07-11-wcag-notes.txt",
        size_bytes: 160,
        active_extractor_version: null,
        active_normalizer_version: null,
      });
      expect(byHash[INTERVIEW]).toMatchObject({
        vault_path: "sources/source-2026-07-11-interview.txt",
        size_bytes: 137,
      });

      // Two captures (one per manifest's `origin` shorthand).
      const captures = store.provenance.allCaptures();
      expect(captures).toHaveLength(2);
      expect(new Set(captures.map((c) => c.origin))).toEqual(
        new Set(["notes/wcag.txt", "transcripts/analyst.txt"]),
      );

      expect(store.provenance.allRenditions()).toHaveLength(0);

      // THREE note_sources rows: synthesis cites both sources, person-analyst cites
      // the interview (fixes wing R2-F5 — the analyst citation was previously dropped).
      const ns = store.provenance.allNoteSources();
      expect(ns).toHaveLength(3);
      expect(ns.every((r) => r.extractor_version === null && r.normalizer_version === null)).toBe(true);
      const pairs = ns.map((r) => [r.note_id, r.raw_content_hash]).sort();
      expect(pairs).toEqual(
        [
          ["person-analyst", INTERVIEW],
          ["research-synthesis-accessibility", INTERVIEW],
          ["research-synthesis-accessibility", WCAG],
        ].sort(),
      );

      // db verify's active-rendition + note_sources invariants hold.
      expect(store.verify().ok).toBe(true);
    } finally {
      store.close();
    }
  });

  it("fail-closed: a malformed manifest THROWS and preserves the prior projection", () => {
    const store = provenanceStore();
    try {
      // Seed a valid projection.
      const good = manifestNote(
        "s-a",
        "sources/s-a.md",
        [`contentId: "${CONTENT_A}"`, `origin: notes/a.txt`, `provenance:`, `  vault_path: sources/a.txt`, `  size_bytes: 5`].join("\n"),
      );
      store.rebuildProjections(snap([good]));
      expect(store.provenance.allBlobs()).toHaveLength(1);

      // A source manifest missing the required `provenance` block → throw, roll back.
      const bad = manifestNote("s-b", "sources/s-b.md", `contentId: "${CONTENT_B}"\norigin: notes/b.txt`);
      expect(() => store.rebuildProjections(snap([bad]))).toThrow(MalformedManifestError);

      // The prior projection survives (fail-closed rebuild — dictionary §8).
      const blobs = store.provenance.allBlobs();
      expect(blobs).toHaveLength(1);
      expect(blobs[0]!.raw_content_hash).toBe(HEX_A);
    } finally {
      store.close();
    }
  });

  it("fail-closed: a dangling `sources` reference THROWS and preserves the prior projection", () => {
    const store = provenanceStore();
    try {
      const good = manifestNote(
        "s-a",
        "sources/s-a.md",
        [`contentId: "${CONTENT_A}"`, `origin: notes/a.txt`, `provenance:`, `  vault_path: sources/a.txt`, `  size_bytes: 5`].join("\n"),
      );
      store.rebuildProjections(snap([good]));

      // A note citing an unknown source id → dangling → throw, roll back.
      const citing = makeNote({ id: "synth", path: "synth.md", sources: ["no-such-source"] });
      expect(() => store.rebuildProjections(snap([good, citing]))).toThrow(DanglingSourceError);

      // Prior projection intact; no note_sources committed.
      expect(store.provenance.allBlobs()).toHaveLength(1);
      expect(store.provenance.allNoteSources()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
