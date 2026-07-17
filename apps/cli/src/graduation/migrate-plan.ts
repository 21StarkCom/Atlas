/**
 * `graduation/migrate-plan` — the DETERMINISTIC bootstrap-migration core (Task 5.3, bootstrap-
 * migration.md §2–§6). Pure function of the input vault + config (never wall-clock): two-pass id
 * derivation (reserve explicit ids, then derive the rest in sorted-path order with numeric-suffix
 * collision), type inference (frontmatter/folder/filename/default — OPEN type system, #151: ANY
 * asserted type is accepted and normalized via `@atlas/contracts` `resolveType`, never refused;
 * an unsupported explicit schema_version is likewise coerced to SCHEMA_VERSION, never refused),
 * wikilink rewrite + preservation, reader-required-field initialization, and §7 quarantine
 * classification. Produces the `graduation migrate` plan (the applied mutation + checkpoints are the
 * command's job). Validated byte-exactly against `docs/specs/fixtures/bootstrap-migration/`.
 */
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveType, isRegisteredType, SCHEMA_VERSION, normalizeIdentityKey, classificationToSensitivity } from "@atlas/contracts";
import { splitFrontmatter } from "../markdown/parse.js";

/** Top-level folder → type (§3, case-sensitive) — vault folders included. */
const FOLDER_TYPE: Record<string, string> = {
  People: "person", Concepts: "concept", Sources: "source", Projects: "project",
  Repos: "repo", Teams: "team", Meetings: "meeting", Conversations: "conversation", Tools: "tool",
};

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
  /** path → release authorization (from `quarantine resolve --resolution release`). */
  readonly released?: Readonly<Record<string, ReleaseInput>>;
  /**
   * Working-tree paths the secret-scan gate flagged as credential-bearing (Task 5.1 handshake).
   * Each is EXCLUDED from `migrable` — never migrated, never renamed, never a link target — and
   * emitted as a `detected-credential` quarantine so apply deletes it from the copy.
   */
  readonly credentialPaths?: readonly string[];
}

export interface LinkRewrite {
  readonly from: string;
  readonly to: string;
  readonly targetId: string | null;
  /**
   * `rewritten` — resolved to exactly one owner; stays a canonical `[[id|display]]` wikilink.
   * `flattened-unresolved` — zero owners; the wikilink is replaced by its display/target TEXT.
   * `flattened-ambiguous` — multiple owners; likewise flattened to text (nothing survives as a link).
   */
  readonly resolution: "rewritten" | "flattened-unresolved" | "flattened-ambiguous";
}
export interface NoteOutcome {
  readonly path: string;
  /**
   * Present when the reader-fatal filename-SLUG collision (two files fold to the same normalized
   * identity key) is resolved by RENAMING this note's file. `newPath` is the deterministic
   * destination (dir + `<stem>-<type>[-n].md`); apply writes here and removes `path`.
   */
  readonly newPath?: string;
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
  /**
   * The only SHAPE-defect category migration still quarantines is `detected-credential` (populated
   * by the secret-scan gate, not this pure planner). Duplicate ids are numeric-suffix-disambiguated,
   * slug collisions are renamed, and unresolved/ambiguous links are flattened — none quarantine.
   */
  readonly category: "detected-credential";
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
/** A deterministic file rename applied to resolve a reader-fatal filename-slug collision. */
export interface Rename {
  readonly from: string;
  readonly to: string;
}
/**
 * One note's TOTAL normalization report (Task 4, #151): every managed field whose emitted value
 * was FILLED (absent in the source) or COERCED (present but differed from the schema-valid emit),
 * plus a Task-3 file `rename` recorded as a `coerced: ["path"]`. `filled`/`coerced` are capped at
 * 32 entries each; `note` at 120 chars.
 */
export interface NormalizedEntry {
  readonly path: string;
  readonly filled: string[];
  readonly coerced: string[];
  readonly note: string;
}
export interface MigrationPlan {
  readonly idMap: Record<string, string>;
  readonly notes: NoteOutcome[];
  readonly quarantined: QuarantineEntry[];
  readonly refused: RefusalEntry[];
  readonly releases: ReleaseRecord[];
  /** Slug-collision renames (original path → renamed path), sorted by source path. */
  readonly renames: Rename[];
  /**
   * Alias-collision losers: path → sorted array of the original alias strings whose identity-key
   * claim lost to another note and must be dropped (Task 4 strips them from the emitted `aliases`
   * field). Paths with nothing to drop are omitted.
   */
  readonly aliasDrops: Record<string, string[]>;
  /** Per-note total normalization report (fills + coercions); notes with no change are omitted. */
  readonly normalized: NormalizedEntry[];
}

/**
 * Route EVERY managed-field assignment through this so the `normalized[]` report is TOTAL: an
 * ABSENT original is a `fill`, a present original that differs from the emitted value is a
 * `coerce` (structural compare via JSON so arrays/objects diff correctly).
 */
function track(key: string, original: unknown, emitted: unknown, filled: string[], coerced: string[]): void {
  if (original === undefined) filled.push(key);
  else if (JSON.stringify(original) !== JSON.stringify(emitted)) coerced.push(key);
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

type TypeResult = { value: string; source: NoteOutcome["type"]["source"] };
function inferType(d: Doc): TypeResult {
  const explicit = d.fm.type;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    // ANY asserted type is accepted (open registry). resolveType() owns trimming +
    // fallback, so we emit the canonical name (e.g. "  repo " → "repo"), never raw.
    return { value: resolveType(String(explicit)).name, source: "frontmatter" };
  }
  const top = d.path.includes("/") ? d.path.split("/")[0]! : "";
  if (top && FOLDER_TYPE[top]) return { value: FOLDER_TYPE[top]!, source: "folder" };
  const pfx = /^([a-z]+)-/.exec(stem(d.path));
  if (pfx && isRegisteredType(pfx[1]!)) return { value: pfx[1]!, source: "filename" };
  return { value: "note", source: "default" };
}

/**
 * Compute the deterministic bootstrap-migration plan for `files`. Pure: no wall-clock, no
 * filesystem writes. Every migrable note migrates — SHAPE defects are made TOTAL rather than
 * quarantined: duplicate explicit ids are numeric-suffix-disambiguated (reserve-all-first);
 * reader-fatal filename-slug collisions are resolved by a deterministic file RENAME; and
 * unresolved/ambiguous wikilinks are FLATTENED to their display text. The only quarantine that
 * remains is `detected-credential` — produced by the secret-scan gate, never by this planner.
 */
export function planBootstrapMigration(files: readonly MigrationInputFile[], opts: MigrationPlanOptions): MigrationPlan {
  // Credential-bearing paths (from the scan handshake) are EXCLUDED before any planning: they never
  // become migrable, so they can't take an id, own a slug/alias key, or be a wikilink target — and
  // are re-surfaced below as `detected-credential` quarantines (deterministic, sorted).
  const credentialPaths = new Set(opts.credentialPaths ?? []);
  const docs = [...files].filter((f) => !credentialPaths.has(f.path)).map(parseDoc).sort((a, b) => a.path.localeCompare(b.path));

  const normalized: NormalizedEntry[] = []; // per-note total fill/coerce report (Task 4)
  const refused: RefusalEntry[] = []; // retained in the shape; now always empty (open type + schema-version coercion)
  const quarantined: QuarantineEntry[] = [...credentialPaths].sort().map((path) => ({ path, category: "detected-credential" as const }));
  const releases: ReleaseRecord[] = []; // retained shape; now always empty (links flatten, nothing is blocked)

  const migrable: { doc: Doc; type: TypeResult }[] = [];
  for (const d of docs) migrable.push({ doc: d, type: inferType(d) });

  // ── Pass 1: duplicate explicit ids → numeric-suffix disambiguation (reserve-all-first). ──
  // Reserve EVERY explicit id up front so a later owner's suffix can never collide with another
  // note's bare id; then the sorted-path-first owner keeps the bare id and each later owner takes
  // the next free `${id}-${n}` against the complete reservation set.
  const explicitById = new Map<string, string[]>(); // id → paths
  for (const { doc } of migrable) {
    const eid = typeof doc.fm.id === "string" ? doc.fm.id.trim() : "";
    if (eid !== "") { const arr = explicitById.get(eid) ?? []; arr.push(doc.path); explicitById.set(eid, arr); }
  }
  const assigned = new Set<string>();
  for (const id of explicitById.keys()) assigned.add(id); // Phase A
  const supersededExplicit = new Map<string, string>(); // path → disambiguated explicit id (Phase B)
  for (const [id, paths] of explicitById) {
    if (paths.length < 2) continue;
    const sorted = [...paths].sort();
    let n = 2;
    for (const p of sorted.slice(1)) {
      let candidate = `${id}-${n}`;
      while (assigned.has(candidate)) candidate = `${id}-${++n}`;
      assigned.add(candidate); supersededExplicit.set(p, candidate); n++;
    }
  }

  // ── Slug/alias identity collisions (reader-fatal) → deterministic rename / alias drop. ──
  // The strict reader (reader.ts detectIdentityCollisions) collides on a shared NORMALIZED identity
  // key, where each note owns its filename slug (stem) PLUS every declared alias — keyed via the
  // contracts' own `normalizeIdentityKey` (full Unicode fold, NOT trim().toLowerCase()). Build one
  // ownership map over both kinds, dedup by owning path, and resolve each real collision by kind: a
  // SLUG loser is fixed by renaming the file (only a rename changes a slug); an ALIAS loser is fixed
  // by dropping that alias (threaded into Task 4's aliases fill — aliases are not emitted here yet).
  type Claim = { path: string; kind: "slug" | "alias"; alias?: string };
  const owners = new Map<string, Claim[]>();
  const claim = (key: string, c: Claim): void => {
    if (key === "") return; // an empty normalized key owns nothing (reader parity)
    const a = owners.get(key) ?? [];
    owners.set(key, a);
    if (!a.some((x) => x.path === c.path)) a.push(c); // dedup by owning path
  };
  for (const { doc } of migrable) {
    claim(normalizeIdentityKey(stem(doc.path)), { path: doc.path, kind: "slug" });
    const al = Array.isArray(doc.fm.aliases) ? (doc.fm.aliases as unknown[]) : [];
    for (const a of al) if (typeof a === "string" && a.trim() !== "") claim(normalizeIdentityKey(a), { path: doc.path, kind: "alias", alias: a });
  }
  const renames = new Map<string, string>(); // original path → renamed path (slug losers)
  const aliasDrops = new Map<string, Set<string>>(); // path → aliases to drop (alias losers; Task 4)
  const taken = new Set<string>(owners.keys()); // normalized keys already claimed (rename target guard)
  for (const [, claims] of owners) {
    if (claims.length < 2) continue; // deduped by path ⇒ a real collision
    // deterministic winner: sort by (path, kind) so the first claim keeps the key.
    const sorted = [...claims].sort((x, y) => x.path.localeCompare(y.path) || x.kind.localeCompare(y.kind));
    for (const loser of sorted.slice(1)) {
      if (loser.kind === "slug") {
        const t = migrable.find((m) => m.doc.path === loser.path)!.type.value;
        const dir = loser.path.slice(0, loser.path.lastIndexOf("/") + 1);
        let base = `${stem(loser.path)}-${t}`;
        let cand = normalizeIdentityKey(base);
        for (let n = 2; taken.has(cand); n++) { base = `${stem(loser.path)}-${t}-${n}`; cand = normalizeIdentityKey(base); }
        taken.add(cand);
        renames.set(loser.path, `${dir}${base}.md`);
      } else {
        const s = aliasDrops.get(loser.path) ?? new Set<string>();
        aliasDrops.set(loser.path, s);
        s.add(loser.alias!);
      }
    }
  }

  // ── Pass 2: derive the remaining ids in sorted-path order, suffixing derived collisions. ──
  const idMap: Record<string, string> = {};
  const collisionByPath = new Map<string, { derivedId: string; disambiguatedTo: string; rule: "numeric-suffix-by-sorted-path" }>();
  const notes: NoteOutcome[] = [];
  const ambiguousAlias = new Set<string>(); // ambiguous slugify() titles — feeds Task 4's normalized[]

  // Build the wikilink resolution index (title / filename-stem → migrable note paths), lowercased.
  const byKey = new Map<string, string[]>();
  const addKey = (k: string, path: string): void => {
    const key = k.toLowerCase();
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(path);
  };
  for (const { doc } of migrable) {
    addKey(doc.title, doc.path);
    addKey(stem(doc.path), doc.path);
  }

  for (const { doc, type } of migrable) {
    const superseded = supersededExplicit.get(doc.path);
    const eid = typeof doc.fm.id === "string" && doc.fm.id.trim() !== "" ? doc.fm.id : null;
    let newId: string;
    if (superseded !== undefined) {
      newId = superseded; // duplicate explicit id, disambiguated
    } else if (eid !== null) {
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

  // Resolve links + build per-note outcomes (in sorted-path order).
  for (const { doc, type } of migrable) {
    const newId = idMap[doc.path]!;
    const linkRewrites: LinkRewrite[] = [];
    // Wikilinks: [[Target]] / [[Target|Display]]. Zero owners ⇒ flattened-unresolved; multiple ⇒
    // flattened-ambiguous (both replace the wikilink with its display/target TEXT); exactly one ⇒
    // rewritten (stays a canonical `[[id|display]]` wikilink). Nothing survives as an unresolved link.
    for (const m of doc.body.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
      const from = m[0];
      const target = m[1]!.trim();
      const display = m[2]?.trim();
      const owners2 = (byKey.get(target.toLowerCase()) ?? []).filter((p) => p !== doc.path);
      const uniq = [...new Set(owners2)];
      if (uniq.length === 1) {
        const targetId = idMap[uniq[0]!]!;
        linkRewrites.push({ from, to: `[[${targetId}|${display ?? target}]]`, targetId, resolution: "rewritten" });
      } else {
        linkRewrites.push({ from, to: display ?? target, targetId: null, resolution: uniq.length === 0 ? "flattened-unresolved" : "flattened-ambiguous" });
      }
    }

    // ── Strict base-field fill/coerce against the REAL vault schema + TOTAL normalized[] report. ──
    // Every managed-field assignment flows through put() (→ track()), so a fill or coercion of ANY
    // field is recorded. Always-managed fields first; then, for a STRICT type, the full base set is
    // filled/coerced to schema-valid values (valid existing values are PRESERVED, not reset).
    const def = resolveType(type.value);
    const filled: string[] = [];
    const coerced: string[] = [];
    const initialized: Record<string, unknown> = {};
    const put = (k: string, orig: unknown, val: unknown): void => { track(k, orig, val, filled, coerced); initialized[k] = val; };

    put("id", doc.fm.id, newId);
    put("type", doc.fm.type, type.value);
    // schema_version: any non-current value (missing, string, number ≠ SCHEMA_VERSION) is normalized + recorded.
    put("schema_version", doc.fm.schema_version, SCHEMA_VERSION);
    put("title", doc.fm.title, doc.title);
    // timestamps: preserve a valid ISO string verbatim; otherwise fill/replace with the bootstrap ts + record.
    const validTs = (v: unknown): boolean => typeof v === "string" && !Number.isNaN(Date.parse(v));
    put("created", doc.fm.created, validTs(doc.fm.created) ? doc.fm.created : opts.bootstrapTimestamp);
    put("updated", doc.fm.updated, validTs(doc.fm.updated) ? doc.fm.updated : opts.bootstrapTimestamp);

    if (def.tier === "strict") {
      const STATUS = ["active", "draft", "needs-review", "stale", "archived", "deprecated"];
      const CONF = ["low", "medium", "high"];
      const CLASS = ["public", "personal", "internal"];
      const enumField = (k: string, allowed: string[], dflt: string): void => {
        const raw = doc.fm[k];
        const ok = typeof raw === "string" && allowed.includes(raw.trim().toLowerCase());
        put(k, raw, ok ? (raw as string).trim().toLowerCase() : dflt);
      };
      enumField("status", STATUS, "active");
      enumField("confidence", CONF, "medium");
      enumField("classification", CLASS, "internal");
      // source is a STRUCTURED LIST (vault tolerates the bare ["manual"]) — NEVER the file path.
      // A valid non-empty array is kept verbatim; anything else defaults to ["manual"].
      const rawSrc = doc.fm.source;
      const srcOk = Array.isArray(rawSrc) && rawSrc.length > 0;
      put("source", rawSrc, srcOk ? rawSrc : ["manual"]);
      for (const k of ["aliases", "tags", "related"]) {
        const raw = doc.fm[k];
        let val: unknown[] = Array.isArray(raw) ? raw : [];
        // An alias that LOST an identity-collision (Task 3) is dropped here + recorded coerced.
        if (k === "aliases") {
          const drop = aliasDrops.get(doc.path);
          if (drop) val = val.filter((a) => typeof a === "string" && !drop.has(a));
        }
        put(k, raw, val);
      }
      // declaredSensitivity flows through put() against its ORIGINAL value (compared, never against
      // undefined), re-derived from the coerced classification (public→public else internal).
      put("declaredSensitivity", doc.fm.declaredSensitivity, classificationToSensitivity(initialized.classification as string));
    } else {
      // loose: NOT force-filled with strict base fields; still derive declaredSensitivity (tracked).
      put("declaredSensitivity", doc.fm.declaredSensitivity, classificationToSensitivity(typeof doc.fm.classification === "string" ? doc.fm.classification : undefined));
    }
    if ((renames.get(doc.path) ?? doc.path) !== doc.path) coerced.push("path"); // Task-3 rename recorded as a coercion

    if (filled.length || coerced.length) {
      normalized.push({
        path: doc.path,
        filled: filled.slice(0, 32).sort(),
        coerced: coerced.slice(0, 32).sort(),
        note: `${def.tier} type '${type.value}'`.slice(0, 120),
      });
    }

    // PER-NOTE against what THIS note actually emitted into `initialized` — not the static 14-key
    // MANAGED_FRONTMATTER list. A strict note emits all 14 managed keys, so behavior is unchanged.
    // A loose note emits only 7 (id/type/schema_version/title/created/updated/declaredSensitivity),
    // so its other original managed-named fields (status/aliases/tags/related/confidence/
    // classification/source) are correctly preserved verbatim instead of being silently dropped.
    const preserved = doc.hasFm ? Object.keys(doc.fm).filter((k) => !(k in initialized)).sort() : [];
    const outcome: NoteOutcome = {
      path: doc.path,
      ...(renames.has(doc.path) ? { newPath: renames.get(doc.path)! } : {}),
      oldId: typeof doc.fm.id === "string" && doc.fm.id.trim() !== "" ? doc.fm.id : null,
      newId,
      type,
      schemaVersion: SCHEMA_VERSION,
      status: "migrated",
      ...(collisionByPath.has(doc.path) ? { collision: collisionByPath.get(doc.path)! } : {}),
      initializedFrontmatter: initialized,
      ...(preserved.length > 0 ? { preservedFrontmatter: preserved } : {}),
      linkRewrites,
    };
    notes.push(outcome);
  }

  void ambiguousAlias; // retained for Task 4's per-note normalized[] report (ambiguous slug titles)

  const renameList: Rename[] = [...renames.entries()].map(([from, to]) => ({ from, to })).sort((a, b) => a.from.localeCompare(b.from));
  const aliasDropsRecord: Record<string, string[]> = {};
  for (const [path, aliases] of [...aliasDrops.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (aliases.size > 0) aliasDropsRecord[path] = [...aliases].sort();
  }
  return { idMap, notes, quarantined, refused, releases, renames: renameList, aliasDrops: aliasDropsRecord, normalized };
}
