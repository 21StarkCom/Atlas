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
