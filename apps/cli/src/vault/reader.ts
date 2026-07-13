/**
 * The vault READER (Task 1.3). `readVault` enumerates every `.md` note under the
 * configured vault, parses each into a `ParsedNote`, then runs the two vault-wide
 * checks — duplicate `id`s and dangling `[[wiki-link]]`s — collecting every
 * problem as a typed `VaultError`. It NEVER throws for note-level or vault-level
 * data problems (review hint: errors are values); only a truly unreadable vault
 * root propagates.
 *
 * All values conform to the `@atlas/contracts` DTOs (D14); this module owns none
 * of the types.
 */
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { AtlasConfig } from "../config/schema.js";
import type { ParsedNote, VaultError, VaultSnapshot, WikiLink } from "@atlas/contracts";
import { splitFrontmatter, extractWikiLinks, buildSectionTree } from "../markdown/parse.js";
import { parseFrontmatter } from "./frontmatter.js";
import { normalizeIdentityKey } from "./identity.js";

/**
 * Read + parse the vault named by `cfg.vault.path`. Returns every successfully
 * parsed note plus every typed error (bad frontmatter, unsupported schema,
 * duplicate ids, broken links). Note order follows the sorted relative path so
 * the snapshot is deterministic.
 */
export async function readVault(cfg: AtlasConfig): Promise<VaultSnapshot> {
  const root = cfg.vault.path;
  const files = (await enumerateMarkdown(root)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const notes: ParsedNote[] = [];
  const errors: VaultError[] = [];

  for (const abs of files) {
    const rel = toPosix(relative(root, abs));
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (e) {
      errors.push({ path: rel, kind: "read-error", message: `cannot read note: ${(e as Error).message}` });
      continue;
    }

    const { frontmatter, body } = splitFrontmatter(raw);
    const fm = parseFrontmatter(frontmatter);
    if (!fm.ok) {
      errors.push({ path: rel, kind: fm.kind, message: fm.message });
      continue;
    }

    const links = extractWikiLinks(body);
    notes.push({
      id: fm.frontmatter.id,
      path: rel,
      type: fm.frontmatter.type,
      schemaVersion: fm.frontmatter.schemaVersion,
      title: fm.frontmatter.title,
      status: fm.frontmatter.status,
      created: fm.frontmatter.created,
      updated: fm.frontmatter.updated,
      aliases: fm.frontmatter.aliases,
      sources: fm.frontmatter.sources,
      declaredSensitivity: fm.frontmatter.declaredSensitivity,
      links,
      sections: buildSectionTree(body),
      contentHash: `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`,
      raw,
    });
  }

  errors.push(...detectDuplicateIds(notes));
  errors.push(...detectIdentityCollisions(notes));
  errors.push(...resolveLinks(notes));

  return { notes, errors };
}

/** Recursively collect `.md` files under `root`, skipping dotted dirs (`.git`, …). */
async function enumerateMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip .git, dotfiles
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

/** One `duplicate-id` error per offending note (BOTH offenders surface, not just one). */
function detectDuplicateIds(notes: readonly ParsedNote[]): VaultError[] {
  const byId = new Map<string, ParsedNote[]>();
  for (const note of notes) {
    const group = byId.get(note.id);
    if (group) group.push(note);
    else byId.set(note.id, [note]);
  }

  const errors: VaultError[] = [];
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const paths = group.map((n) => n.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const note of group) {
      const others = paths.filter((p) => p !== note.path);
      errors.push({
        path: note.path,
        kind: "duplicate-id",
        message: `id \`${id}\` is also declared by ${others.map((p) => `\`${p}\``).join(", ")}`,
      });
    }
  }
  return errors;
}

/**
 * Enforce the globally-unique normalized identity-key namespace (§2.7,
 * `note_identity_keys(normalized_key PRIMARY KEY)`). Every note OWNS a set of
 * normalized keys — its filename slug plus each declared alias — folded through
 * `atlas-identity-key-v1`. When two DISTINCT notes claim the same normalized
 * key (slug↔slug, alias↔alias, or slug↔alias), that key cannot be a primary
 * key, so it is a vault-wide `identity-collision` — surfaced eagerly here for
 * every offending owner, INDEPENDENT of whether any `[[wiki-link]]` ever
 * references it (a collision that only errored on reference would let an
 * incompatible snapshot look clean until used).
 *
 * Keys are deduplicated BY OWNING NOTE first: a single note whose aliases are
 * canonically equivalent (e.g. `Foo` and `foo`, or a slug equal to its own
 * alias) claims the key exactly once and is never in collision with itself.
 */
function detectIdentityCollisions(notes: readonly ParsedNote[]): VaultError[] {
  // normalized key → owning notes (each note counted at most once per key).
  const owners = new Map<string, ParsedNote[]>();
  for (const note of notes) {
    const keys = new Set<string>();
    keys.add(normalizeIdentityKey(fileSlug(note.path)));
    for (const alias of note.aliases) keys.add(normalizeIdentityKey(alias));
    for (const key of keys) {
      if (!key) continue; // an empty normalized key owns nothing
      push(owners, key, note);
    }
  }

  const errors: VaultError[] = [];
  for (const [key, group] of owners) {
    if (group.length < 2) continue;
    const paths = group.map((n) => n.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const note of group) {
      const others = paths.filter((p) => p !== note.path);
      errors.push({
        path: note.path,
        kind: "identity-collision",
        message: `normalized identity key \`${key}\` is also claimed by ${others
          .map((p) => `\`${p}\``)
          .join(", ")}`,
      });
    }
  }
  return errors;
}

/**
 * Resolve every `[[wiki-link]]` against ownership-aware indexes, applying the
 * normative precedence (§2.7):
 *
 *   1. exact note `id`
 *   2. exact filename slug (basename without `.md`)
 *   3. UNIQUE normalized alias (`atlas-identity-key-v1`)
 *
 * A target that matches none is a `broken-link`. A target that resolves only
 * via a tier where MULTIPLE notes collide (two files share a slug, or two notes
 * share a normalized alias) is an `ambiguous-link` — the ambiguity is surfaced,
 * never hidden by folding every identifier into one `Set`. Higher-precedence
 * exact matches always win over a lower-tier collision.
 */
function resolveLinks(notes: readonly ParsedNote[]): VaultError[] {
  const byId = new Map<string, ParsedNote>();
  const bySlug = new Map<string, ParsedNote[]>();
  const byAlias = new Map<string, ParsedNote[]>();
  for (const note of notes) {
    byId.set(note.id, note); // exact id (id duplicates are reported separately)
    push(bySlug, fileSlug(note.path), note); // exact filename slug
    // Alias ownership is counted by DISTINCT owning note, not by alias entry:
    // a note whose aliases fold to the same key (e.g. `Foo` and `foo`) owns
    // that key once, so `[[foo]]` is not falsely ambiguous against itself.
    const aliasKeys = new Set(note.aliases.map((a) => normalizeIdentityKey(a)));
    for (const key of aliasKeys) push(byAlias, key, note);
  }

  const errors: VaultError[] = [];
  for (const note of notes) {
    for (const link of note.links) {
      const target = linkTarget(link);

      // Tier 1: exact id.
      if (byId.has(target)) continue;

      // Tier 2: exact filename slug.
      const slugMatches = bySlug.get(target);
      if (slugMatches) {
        if (slugMatches.length > 1) {
          errors.push(ambiguous(note, link, "filename slug", target, slugMatches));
        }
        continue;
      }

      // Tier 3: unique normalized alias.
      const aliasMatches = byAlias.get(normalizeIdentityKey(target));
      if (aliasMatches) {
        if (aliasMatches.length > 1) {
          errors.push(ambiguous(note, link, "normalized alias", target, aliasMatches));
        }
        continue;
      }

      errors.push({
        path: note.path,
        kind: "broken-link",
        message: `wiki-link ${link.raw} resolves to no note in the vault`,
      });
    }
  }
  return errors;
}

/** Build an `ambiguous-link` error naming every colliding owner (sorted, stable). */
function ambiguous(
  note: ParsedNote,
  link: WikiLink,
  tier: string,
  target: string,
  owners: readonly ParsedNote[],
): VaultError {
  const paths = owners.map((n) => n.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    path: note.path,
    kind: "ambiguous-link",
    message: `wiki-link ${link.raw} is ambiguous by ${tier} \`${target}\`: matches ${paths
      .map((p) => `\`${p}\``)
      .join(", ")}`,
  };
}

/** Append `note` to the multi-map entry for `key` (creating it if absent). */
function push(map: Map<string, ParsedNote[]>, key: string, note: ParsedNote): void {
  const group = map.get(key);
  if (group) group.push(note);
  else map.set(key, [note]);
}

/** The filename slug of a vault-relative POSIX path: basename without `.md`. */
function fileSlug(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}

/** The identifier a wiki-link points at, ignoring any `#section` anchor suffix. */
function linkTarget(link: WikiLink): string {
  const hash = link.target.indexOf("#");
  return hash === -1 ? link.target : link.target.slice(0, hash);
}

/** Normalize OS path separators to POSIX so vault paths are stable across platforms. */
function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
