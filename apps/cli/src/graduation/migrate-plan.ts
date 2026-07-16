/**
 * `graduation/migrate-plan` — the DETERMINISTIC bootstrap-migration core (Task 5.3, bootstrap-
 * migration.md §2–§6). Pure function of the input vault + config (never wall-clock): two-pass id
 * derivation (reserve explicit ids, then derive the rest in sorted-path order with numeric-suffix
 * collision), type inference (frontmatter/folder/filename/default; unknown/malformed explicit type
 * REFUSED), wikilink rewrite + preservation, reader-required-field initialization, and §7 quarantine
 * classification. Produces the `graduation migrate` plan (the applied mutation + checkpoints are the
 * command's job). Validated byte-exactly against `docs/specs/fixtures/bootstrap-migration/`.
 */
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { splitFrontmatter } from "../markdown/parse.js";

/** The §3 known types (V1) migration can infer/assign. */
const KNOWN_TYPES = new Set(["note", "concept", "person", "source", "project"]);
/** Top-level folder → type (§3, case-sensitive). */
const FOLDER_TYPE: Record<string, string> = { People: "person", Concepts: "concept", Sources: "source", Projects: "project" };
const DEFAULT_SCHEMA_MAX = 1;

export interface MigrationInputFile {
  readonly path: string;
  readonly raw: string;
}
/** An operator-authorized release of a blocked (incompatible-link) note, keyed by note path. */
export interface ReleaseInput {
  readonly opaqueId: string;
  readonly authorization: string;
}
export interface MigrationPlanOptions {
  readonly bootstrapTimestamp: string;
  readonly supportedSchemaMax?: number;
  /** path → release authorization (from `quarantine resolve --resolution release`). */
  readonly released?: Readonly<Record<string, ReleaseInput>>;
}

export interface LinkRewrite {
  readonly from: string;
  readonly to: string;
  readonly targetId: string | null;
  readonly resolution: "rewritten" | "preserved-unresolved" | "preserved-ambiguous";
}
export interface NoteOutcome {
  readonly path: string;
  readonly oldId: string | null;
  readonly newId: string;
  readonly type: { readonly value: string; readonly source: "frontmatter" | "folder" | "filename" | "default" };
  readonly schemaVersion: number;
  readonly status: "migrated";
  readonly initializedFrontmatter: Record<string, unknown>;
  /** Present when a DERIVED id was numeric-suffixed off its base to avoid a collision. */
  readonly collision?: { readonly derivedId: string; readonly disambiguatedTo: string; readonly rule: "numeric-suffix-by-sorted-path" };
  readonly preservedFrontmatter?: string[];
  readonly released?: { readonly category: "incompatible-link"; readonly opaqueId: string; readonly resolution: "release" };
  readonly linkRewrites: LinkRewrite[];
}
export interface QuarantineEntry {
  readonly path: string;
  readonly category: "ambiguous-alias" | "duplicate-identity" | "incompatible-link";
  readonly assertedId?: string;
  readonly peers?: string[];
}
export interface RefusalEntry {
  readonly path: string;
  readonly category: "unknown-type" | "unsupported-schema-version";
  readonly assertedType?: string;
  readonly assertedSchemaVersion?: number;
  readonly supportedMax?: number;
  readonly outcome: "refused";
  readonly mutated: false;
}
export interface ReleaseRecord {
  readonly path: string;
  readonly category: "incompatible-link";
  readonly opaqueId: string;
  readonly resolution: "release";
  readonly authorization: string;
}
export interface MigrationPlan {
  readonly idMap: Record<string, string>;
  readonly notes: NoteOutcome[];
  readonly quarantined: QuarantineEntry[];
  readonly refused: RefusalEntry[];
  readonly releases: ReleaseRecord[];
}

/** §2.1 slug: NFKD → strip marks → lowercase → non-alnum runs → `-` → trim; empty ⇒ `note`. */
export function slugify(title: string): { slug: string; ambiguous: boolean } {
  const s = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? { slug: "note", ambiguous: true } : { slug: s, ambiguous: false };
}

interface Doc {
  path: string;
  fm: Record<string, unknown>;
  hasFm: boolean;
  body: string;
  title: string;
}

function firstH1(body: string): string | null {
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  return m ? m[1]!.trim() : null;
}
function stem(path: string): string {
  return basename(path).replace(/\.md$/, "");
}
function parseDoc(f: MigrationInputFile): Doc {
  const { frontmatter, body } = splitFrontmatter(f.raw);
  let fm: Record<string, unknown> = {};
  let hasFm = false;
  if (frontmatter !== null) {
    try {
      const parsed = parseYaml(frontmatter) as unknown;
      if (parsed && typeof parsed === "object") {
        fm = parsed as Record<string, unknown>;
        hasFm = true;
      }
    } catch {
      /* malformed YAML — treated as no usable frontmatter */
    }
  }
  const title = (typeof fm.title === "string" && fm.title.trim() !== "" ? fm.title.trim() : null) ?? firstH1(body) ?? stem(f.path);
  return { path: f.path, fm, hasFm, body, title };
}

type TypeResult = { kind: "ok"; value: string; source: NoteOutcome["type"]["source"] } | { kind: "unknown"; assertedType: string };
function inferType(d: Doc): TypeResult {
  const explicit = d.fm.type;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    if (typeof explicit === "string" && KNOWN_TYPES.has(explicit)) return { kind: "ok", value: explicit, source: "frontmatter" };
    return { kind: "unknown", assertedType: String(explicit) }; // unknown string OR non-string ⇒ refused
  }
  const top = d.path.includes("/") ? d.path.split("/")[0]! : "";
  if (top && FOLDER_TYPE[top]) return { kind: "ok", value: FOLDER_TYPE[top]!, source: "folder" };
  const pfx = /^([a-z]+)-/.exec(stem(d.path));
  if (pfx && KNOWN_TYPES.has(pfx[1]!)) return { kind: "ok", value: pfx[1]!, source: "filename" };
  return { kind: "ok", value: "note", source: "default" };
}

/** The managed reader-required keys migration writes (order = the initializedFrontmatter shape). */
const MANAGED_KEYS = ["id", "type", "schema_version", "title", "created", "updated"];

/**
 * Compute the deterministic bootstrap-migration plan for `files`. `released` authorizes blocked
 * (incompatible-link) notes to migrate as-is. Pure: no wall-clock, no filesystem writes.
 */
export function planBootstrapMigration(files: readonly MigrationInputFile[], opts: MigrationPlanOptions): MigrationPlan {
  const supportedMax = opts.supportedSchemaMax ?? DEFAULT_SCHEMA_MAX;
  const released = opts.released ?? {};
  const docs = [...files].map(parseDoc).sort((a, b) => a.path.localeCompare(b.path));

  const refused: RefusalEntry[] = [];
  const quarantined: QuarantineEntry[] = [];

  // ── Refusals (never mutated): unsupported schema version, then unknown/malformed type. ──
  const refusedPaths = new Set<string>();
  const migrable: { doc: Doc; type: { value: string; source: NoteOutcome["type"]["source"] } }[] = [];
  for (const d of docs) {
    const sv = d.fm.schema_version;
    if (typeof sv === "number" && sv > supportedMax) {
      refused.push({ path: d.path, category: "unsupported-schema-version", assertedSchemaVersion: sv, supportedMax, outcome: "refused", mutated: false });
      refusedPaths.add(d.path);
      continue;
    }
    const t = inferType(d);
    if (t.kind === "unknown") {
      refused.push({ path: d.path, category: "unknown-type", assertedType: t.assertedType, outcome: "refused", mutated: false });
      refusedPaths.add(d.path);
      continue;
    }
    migrable.push({ doc: d, type: { value: t.value, source: t.source } });
  }

  // ── Pass 1: reserve explicit ids; a shared explicit id ⇒ duplicate-identity quarantine. ──
  const explicitById = new Map<string, string[]>(); // id → paths
  for (const { doc } of migrable) {
    const eid = doc.fm.id;
    if (typeof eid === "string" && eid.trim() !== "") (explicitById.get(eid) ?? explicitById.set(eid, []).get(eid)!).push(doc.path);
  }
  const dupIdPaths = new Set<string>();
  const reserved = new Set<string>();
  for (const [id, paths] of explicitById) {
    if (paths.length > 1) {
      for (const p of [...paths].sort()) {
        quarantined.push({ path: p, category: "duplicate-identity", assertedId: id, peers: paths.filter((x) => x !== p).sort() });
        dupIdPaths.add(p);
      }
    } else {
      reserved.add(id); // a single explicit owner reserves the id
    }
  }

  // ── Pass 2: derive ids in sorted-path order, suffixing derived collisions against reserved+assigned. ──
  const assigned = new Set<string>(reserved);
  const idMap: Record<string, string> = {};
  const collisionByPath = new Map<string, { derivedId: string; disambiguatedTo: string; rule: "numeric-suffix-by-sorted-path" }>();
  const notes: NoteOutcome[] = [];
  const releases: ReleaseRecord[] = [];
  const ambiguousAlias = new Set<string>();
  const incompatibleLink = new Set<string>();

  // Build the wikilink resolution index (title / filename-stem → migrable note paths), lowercased.
  const migrablePaths = new Set(migrable.filter((m) => !dupIdPaths.has(m.doc.path)).map((m) => m.doc.path));
  const byKey = new Map<string, string[]>();
  const addKey = (k: string, path: string): void => {
    const key = k.toLowerCase();
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(path);
  };
  for (const { doc } of migrable) {
    if (!migrablePaths.has(doc.path)) continue;
    addKey(doc.title, doc.path);
    addKey(stem(doc.path), doc.path);
  }

  for (const { doc, type } of migrable) {
    if (dupIdPaths.has(doc.path)) continue;
    const eid = typeof doc.fm.id === "string" && doc.fm.id.trim() !== "" ? doc.fm.id : null;
    let newId: string;
    if (eid !== null) {
      newId = eid; // explicit owner keeps its bare id (already reserved)
    } else {
      const { slug, ambiguous } = slugify(doc.title);
      if (ambiguous) ambiguousAlias.add(doc.path);
      const base = `${type.value}-${slug}`;
      newId = base;
      for (let n = 2; assigned.has(newId); n++) newId = `${base}-${n}`;
      assigned.add(newId);
      if (newId !== base) collisionByPath.set(doc.path, { derivedId: base, disambiguatedTo: newId, rule: "numeric-suffix-by-sorted-path" });
    }
    idMap[doc.path] = newId;
  }

  // Resolve links + build per-note outcomes (in sorted-path order; only migrable, non-dup notes).
  for (const { doc, type } of migrable) {
    if (dupIdPaths.has(doc.path)) continue;
    const newId = idMap[doc.path]!;
    const linkRewrites: LinkRewrite[] = [];
    let hasUnresolved = false;
    // Wikilinks: [[Target]] / [[Target|Display]].
    for (const m of doc.body.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
      const from = m[0];
      const target = m[1]!.trim();
      const display = m[2]?.trim();
      const owners = (byKey.get(target.toLowerCase()) ?? []).filter((p) => p !== doc.path);
      const uniq = [...new Set(owners)];
      if (uniq.length === 1) {
        const targetId = idMap[uniq[0]!]!;
        linkRewrites.push({ from, to: `[[${targetId}|${display ?? target}]]`, targetId, resolution: "rewritten" });
      } else {
        hasUnresolved = true;
        linkRewrites.push({ from, to: from, targetId: null, resolution: uniq.length === 0 ? "preserved-unresolved" : "preserved-ambiguous" });
      }
    }
    // A note with an unresolved/ambiguous link is BLOCKED unless the operator released it. A
    // released note MIGRATES (link left verbatim) and is NOT listed in migrate.quarantined; a
    // still-blocked note is quarantined incompatible-link and does not migrate. (The audit's
    // category inventory records the defect either way — that is `graduation audit`, not this plan.)
    const release = released[doc.path];
    if (hasUnresolved && release === undefined) {
      incompatibleLink.add(doc.path);
      continue;
    }

    const initialized: Record<string, unknown> = {
      id: newId,
      type: type.value,
      schema_version: 1,
      title: doc.title,
      created: opts.bootstrapTimestamp,
      updated: opts.bootstrapTimestamp,
    };
    const preserved = doc.hasFm ? Object.keys(doc.fm).filter((k) => !MANAGED_KEYS.includes(k)).sort() : [];
    const outcome: NoteOutcome = {
      path: doc.path,
      oldId: typeof doc.fm.id === "string" && doc.fm.id.trim() !== "" ? doc.fm.id : null,
      newId,
      type,
      schemaVersion: 1,
      status: "migrated",
      ...(collisionByPath.has(doc.path) ? { collision: collisionByPath.get(doc.path)! } : {}),
      initializedFrontmatter: initialized,
      ...(preserved.length > 0 ? { preservedFrontmatter: preserved } : {}),
      ...(hasUnresolved && release ? { released: { category: "incompatible-link" as const, opaqueId: release.opaqueId, resolution: "release" as const } } : {}),
      linkRewrites,
    };
    notes.push(outcome);
    if (hasUnresolved && release) releases.push({ path: doc.path, category: "incompatible-link", opaqueId: release.opaqueId, resolution: "release", authorization: release.authorization });
  }

  // Quarantine the alias/link defects (in sorted-path order, after dup-identity).
  for (const p of [...ambiguousAlias].sort()) quarantined.push({ path: p, category: "ambiguous-alias" });
  for (const p of [...incompatibleLink].sort()) quarantined.push({ path: p, category: "incompatible-link" });

  return { idMap, notes, quarantined, refused, releases };
}
