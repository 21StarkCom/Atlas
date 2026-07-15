/**
 * `ingest/manifests` — the canonical Markdown source-manifest writer + the
 * immutable raw-byte copy + the canonical re-projection used by capture (Task 2.6).
 *
 * Provenance is modeled as three linked entities (design §"Source manifest &
 * normalization"): a content blob, its origin-observation captures, and its
 * normalized renditions. They are serialized into ONE `.md` source-manifest note
 * per content blob (the form `foldProvenanceManifests` parses — a note carrying a
 * `contentId` + a `provenance:` block with embedded `captures:`/`renditions:`/
 * `active_rendition:`). The manifest is per content blob, so re-observing the same
 * bytes from a new origin adds a capture entry to the SAME manifest, and a
 * re-observation of an existing origin bumps that entry's counters — never a
 * duplicate manifest.
 *
 * DEFECT #6 (raw Markdown blobs poison the vault): the vault reader enumerates
 * every `.md` recursively, so a raw blob stored as `raw.md` would be parsed as an
 * Atlas note and could break `db rebuild`. The immutable raw copy is therefore
 * written with a NON-note extension (`.blob`); only the manifest is `.md`. The
 * source format is preserved in the manifest's `canonicalMediaType`, so
 * re-extraction stays deterministic without a note-shaped extension.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { serializeContentId, type ContentId } from "@atlas/contracts";
import type { Store } from "@atlas/sqlite-store";
import { foldProvenanceManifests } from "@atlas/sqlite-store";
import type { Repo } from "@atlas/git";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";

/** The vault-relative directory every capture artifact lives under. */
export const SOURCES_DIR = "sources";

/** A single origin-observation aggregate serialized into a manifest. */
export interface CaptureEntry {
  readonly origin: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly observationCount: number;
}

/** A single normalized rendition serialized into a manifest. */
export interface RenditionEntry {
  readonly extractorVersion: number;
  readonly normalizerVersion: number;
  readonly normalizedContentHash: string;
  readonly sizeBytes: number;
  readonly locatorScheme: string;
  readonly createdAt: string;
}

/** Everything the manifest for one content blob serializes. */
export interface SourceManifest {
  readonly noteId: string;
  readonly title: string;
  readonly contentId: ContentId;
  readonly sizeBytes: number;
  readonly vaultPath: string; // vault-relative path to the raw `.blob`
  readonly firstSeenAt: string;
  readonly declaredSensitivity: string;
  readonly captures: readonly CaptureEntry[];
  readonly renditions: readonly RenditionEntry[];
  readonly active: { extractorVersion: number; normalizerVersion: number } | null;
  /** RFC-3339 note `created`/`updated` timestamp. */
  readonly stamp: string;
}

/**
 * The stable, content-derived source-note id for a content blob. Derived ONLY from
 * the `contentId` (never the path), so identical bytes seen from different paths
 * resolve to the SAME manifest note, and changed bytes (a new `contentId`) get a
 * new manifest — never a filename collision across distinct blobs.
 */
export function sourceNoteId(contentId: ContentId): string {
  return `source-${contentId.rawContentHash.slice(0, 16)}`;
}

/** Vault-relative path to a blob's `.md` manifest note. */
export function manifestVaultPath(noteId: string): string {
  return `${SOURCES_DIR}/${noteId}.md`;
}

/**
 * Vault-relative path to a blob's immutable raw copy. Extension is `.blob`
 * (NON-`.md`) so the vault reader never enumerates it as a note (DEFECT #6).
 */
export function rawBlobVaultPath(noteId: string): string {
  return `${SOURCES_DIR}/${noteId}.blob`;
}

function yamlString(s: string): string {
  // Quote scalars that YAML could misparse (colons, leading specials); a bare
  // token is fine for simple slugs but quoting is always safe and deterministic.
  return JSON.stringify(s);
}

/** Render the canonical Markdown source manifest (byte-stable for a given input). */
export function renderSourceManifest(m: SourceManifest): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${m.noteId}`);
  lines.push("type: source");
  lines.push("schema_version: 1");
  lines.push(`title: ${yamlString(m.title)}`);
  lines.push(`created: ${m.stamp}`);
  lines.push(`updated: ${m.stamp}`);
  lines.push(`declaredSensitivity: ${m.declaredSensitivity}`);
  lines.push(`contentId: ${yamlString(serializeContentId(m.contentId))}`);
  lines.push("sources: []");
  lines.push("provenance:");
  lines.push(`  vault_path: ${m.vaultPath}`);
  lines.push(`  size_bytes: ${m.sizeBytes}`);
  lines.push(`  first_seen_at: ${m.firstSeenAt}`);
  lines.push("  captures:");
  for (const c of [...m.captures].sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0))) {
    lines.push(`    - origin: ${yamlString(c.origin)}`);
    lines.push(`      first_seen_at: ${c.firstSeenAt}`);
    lines.push(`      last_seen_at: ${c.lastSeenAt}`);
    lines.push(`      observation_count: ${c.observationCount}`);
  }
  if (m.renditions.length > 0) {
    lines.push("  renditions:");
    for (const r of [...m.renditions].sort((a, b) =>
      a.extractorVersion - b.extractorVersion || a.normalizerVersion - b.normalizerVersion,
    )) {
      lines.push(`    - extractor_version: ${r.extractorVersion}`);
      lines.push(`      normalizer_version: ${r.normalizerVersion}`);
      lines.push(`      normalized_content_hash: ${yamlString(r.normalizedContentHash)}`);
      lines.push(`      size_bytes: ${r.sizeBytes}`);
      lines.push(`      locator_scheme: ${yamlString(r.locatorScheme)}`);
      lines.push(`      created_at: ${r.createdAt}`);
    }
  }
  if (m.active) {
    lines.push("  active_rendition:");
    lines.push(`    extractor_version: ${m.active.extractorVersion}`);
    lines.push(`    normalizer_version: ${m.active.normalizerVersion}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${m.title}`);
  lines.push("");
  lines.push("Immutable captured source. The raw bytes live alongside this manifest as");
  lines.push(`\`${m.vaultPath.split("/").pop()}\` and are never edited.`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Write the immutable raw-byte copy + the manifest note into a worktree's
 * `sources/` directory. The raw copy is written FIRST (the manifest points at it);
 * both are byte-stable so re-running with the same inputs produces an identical
 * tree (deterministic capture commit).
 */
export async function writeCaptureArtifacts(
  worktreeDir: string,
  raw: Uint8Array,
  manifest: SourceManifest,
): Promise<void> {
  const sourcesDir = join(worktreeDir, SOURCES_DIR);
  await mkdir(sourcesDir, { recursive: true });
  await writeFile(join(worktreeDir, manifest.vaultPath), Buffer.from(raw));
  await writeFile(join(worktreeDir, manifestVaultPath(manifest.noteId)), renderSourceManifest(manifest), "utf8");
}

/**
 * A deterministic hash of the capture artifacts staged under `sources/` in a
 * worktree — the `worktree-applied` gating evidence (DEFECT #5: the applied-tree
 * evidence is persisted BEFORE the commit, so a crash between applying and
 * committing is recoverable). Hashes sorted (relpath, bytes) so it is stable
 * regardless of directory-read order and reproducible by the reconciler's
 * `hashWorktree` hook.
 */
export async function hashCaptureTree(worktreeDir: string): Promise<string> {
  const sourcesDir = join(worktreeDir, SOURCES_DIR);
  const files: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      const relPath = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(abs, relPath);
      else if (e.isFile()) files.push(relPath);
    }
  }
  await walk(sourcesDir, "");
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f, "utf8");
    h.update(Buffer.from([0]));
    h.update(await readFile(join(sourcesDir, f)));
    h.update(Buffer.from([0]));
  }
  return `sha256:${h.digest("hex")}`;
}

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly path: string;
}

async function lsTree(repo: Repo, ref: string): Promise<GitTreeEntry[]> {
  // Read the canonical tree via git plumbing. `Repo` intentionally exposes no raw
  // exec, so use the same child-process convention `@atlas/git` uses internally.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("git", ["-C", repo.dir, "ls-tree", "-r", "-z", ref], { maxBuffer: 64 * 1024 * 1024 });
  const out: GitTreeEntry[] = [];
  for (const rec of stdout.split("\u0000")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    out.push({ mode: meta[0]!, type: meta[1]!, sha: meta[2]!, path: rec.slice(tab + 1) });
  }
  return out;
}

async function showBlob(repo: Repo, sha: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("git", ["-C", repo.dir, "cat-file", "-p", sha], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout as string;
}

function parseNoteFrontmatter(raw: string): { id: string; sources: string[]; created: string } | null {
  const m = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(raw);
  if (!m) return null;
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch {
    return null;
  }
  if (!fm || typeof fm !== "object") return null;
  const rec = fm as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id : "";
  const created = rec.created instanceof Date ? rec.created.toISOString() : typeof rec.created === "string" ? rec.created : "";
  const sources = Array.isArray(rec.sources) ? rec.sources.filter((s): s is string => typeof s === "string") : [];
  if (id === "") return null;
  return { id, sources, created };
}

/**
 * Re-derive the provenance projections from the CANONICAL git tree by folding
 * every source manifest committed at `ref`. Idempotent (the fold clears + rebuilds
 * the four provenance tables from the manifests), so it is safe to run on the live
 * post-integration path AND replay verbatim from the startup reconciler's capture
 * re-projection hook (DEFECT #3: post-integration projection is replayable for the
 * same run, re-derived from the immutable canonical commit rather than in-memory
 * state). Returns the canonical head sha it projected against.
 */
export async function foldProvenanceFromCanonical(store: Store, repo: Repo, ref: string): Promise<string> {
  const head = await repo.readRef(ref);
  if (head === null) throw new Error(`canonical ref ${ref} does not resolve`);
  const entries = (await lsTree(repo, head)).filter((e) => e.type === "blob" && e.path.toLowerCase().endsWith(".md"));
  const notes: ParsedNote[] = [];
  for (const e of entries) {
    const raw = await showBlob(repo, e.sha);
    const fm = parseNoteFrontmatter(raw);
    if (!fm) continue;
    notes.push({
      id: fm.id,
      path: e.path,
      type: "source",
      schemaVersion: 1,
      title: fm.id,
      status: "",
      created: fm.created,
      updated: fm.created,
      aliases: [],
      sources: fm.sources,
      declaredSensitivity: "internal",
      links: [],
      sections: { headings: [] } as unknown as ParsedNote["sections"],
      contentHash: "",
      raw,
    });
  }
  const snapshot: VaultSnapshot = { notes, errors: [] };
  foldProvenanceManifests(snapshot, store.db);
  return head;
}

void dirname; // reserved for future nested-manifest layouts
