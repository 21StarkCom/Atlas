/**
 * Shared cross-boundary DTOs (D14). These are STRUCTURAL types with zero
 * runtime footprint. They live in `@atlas/contracts` so workspace packages
 * (`sqlite-store`, `lancedb-index`, and the CLI-internal `vault`/`sources`
 * modules) consume them FROM here — never from `apps/cli` — which breaks the
 * package→app build cycle. Producing tasks emit *values* of these types; this
 * package owns only the types.
 */
import type { ContentId } from "./ids.js";

/** Sensitivity classification (plan §2.5 default: `internal`). */
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";

/** Note kind in the wiki taxonomy (project/concept/person/…); open-ended. */
export type NoteType = string;

/** How a rendition's text locators are expressed (e.g. char offsets, lines). */
export type LocatorScheme = string;

/** A parsed `[[wiki-link]]` occurrence within a note. */
export interface WikiLink {
  /** The link target's natural identifier (resolved or raw). */
  readonly target: string;
  /** Optional display alias (`[[target|alias]]`). */
  readonly alias?: string;
  /** The raw link text exactly as it appeared in the source. */
  readonly raw: string;
}

/**
 * A typed, directed relationship from the note's frontmatter `related` list
 * (v2, #331) — the markdown representation of a `CreateRelationship` edge. Unlike
 * a {@link WikiLink} (plain, `predicate` NULL), a relationship carries a non-null
 * `predicate` and is projected into a distinct `note_links` row.
 */
export interface Relationship {
  /** The related note's natural identifier (raw; resolved to a note id at fold time). */
  readonly target: string;
  /** The relationship predicate (non-empty — this is what makes the edge "typed"). */
  readonly predicate: string;
  /** Optional display alias for the edge. */
  readonly alias?: string;
}

/** A recursive tree of a note's sections (headings). */
export interface SectionTree {
  /** Heading text (empty for the note root/preamble). */
  readonly heading: string;
  /** Heading depth (0 = root, 1 = `#`, 2 = `##`, …). */
  readonly level: number;
  /** Stable section path within the note (e.g. `Overview/Goals`). */
  readonly path: string;
  /** Child sections nested under this one. */
  readonly children: readonly SectionTree[];
}

/** A fully parsed vault note (produced by the `vault` module, D14). */
export interface ParsedNote {
  readonly id: string;
  readonly path: string;
  readonly type: NoteType;
  readonly schemaVersion: number;
  /**
   * Canonical human-readable title from frontmatter `title`. This is
   * authoritative projection input for `notes.title` — consumers MUST NOT
   * fabricate it from headings or constants (dictionary §0: projections are
   * projected from canonical Markdown, never invented).
   */
  readonly title: string;
  /**
   * Canonical lifecycle status from frontmatter `status` (defaults to `active`
   * when the note omits it). Authoritative projection input for `notes.status`.
   */
  readonly status: string;
  /** Canonical creation timestamp from frontmatter `created` (projected verbatim). */
  readonly created: string;
  /** Canonical last-update timestamp from frontmatter `updated` (projected verbatim). */
  readonly updated: string;
  readonly aliases: readonly string[];
  readonly sources: readonly string[];
  readonly declaredSensitivity: Sensitivity;
  readonly links: readonly WikiLink[];
  /**
   * Typed, directed relationships declared in the note's frontmatter `related`
   * list — the markdown home of a `CreateRelationship` edge (v2, #331). Distinct
   * from {@link links} (plain `[[wiki-link]]` body occurrences, `predicate` NULL):
   * a relationship carries a non-null `predicate`, so it is markdown-DERIVED and
   * rebuildable (`db rebuild` + the v2 sync fold both re-derive it from here — it
   * is NOT projection-authored state). Absent ⇒ `[]`.
   */
  readonly relationships: readonly Relationship[];
  readonly sections: SectionTree;
  readonly contentHash: string;
  readonly raw: string;
}

/** A typed error surfaced while reading the vault (never thrown — collected). */
export interface VaultError {
  readonly path: string;
  readonly kind: string;
  readonly message: string;
}

/** The whole-vault read result (`readVault(cfg): Promise<VaultSnapshot>`). */
export interface VaultSnapshot {
  readonly notes: readonly ParsedNote[];
  readonly errors: readonly VaultError[];
}

/** A gap the normalizer could not faithfully represent in extracted text. */
export interface RepresentedGap {
  readonly kind: string;
  readonly locator?: string;
  readonly note?: string;
}

/** A normalized rendition of captured source content (produced by `normalize`). */
export interface NormalizedRendition {
  readonly contentId: ContentId;
  readonly extractorVersion: number;
  readonly normalizerVersion: number;
  readonly normalizedContentHash: string;
  readonly sizeBytes: number;
  readonly locatorScheme: LocatorScheme;
  readonly text: string;
  readonly gaps: readonly RepresentedGap[];
}

/** A retrieval/index chunk derived from a note section (produced by chunking). */
export interface Chunk {
  readonly noteId: string;
  readonly sectionPath: string;
  readonly text: string;
  readonly contentHash: string;
  /** Position of this chunk within its note's chunk sequence. */
  readonly ordinal: number;
}
