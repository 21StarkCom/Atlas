/**
 * `brain note show | related | history` (Task 2.9 / #35) — the read-only note
 * surface over the vault projection + link/relationship graph + audit ledger. All
 * three are Tier-0 reads: no vault/projection/ledger mutation, no audit-ref write.
 *
 *  - `note show <id-or-slug>` — the note's canonical frontmatter fields, section
 *    outline, links (with resolution), and provenance sources. Sections are NOT a
 *    projected table — they exist only in the canonical Markdown — so `show` reads
 *    the vault (the projection's source of truth) via {@link readVault}, which
 *    yields a fully-consistent `ParsedNote` (sections + declaredSensitivity + raw
 *    aliases + per-link resolution in one read). Ambiguity is an error, never a
 *    silent pick.
 *  - `note related <id-or-slug>` — paginated related-notes traversal over the
 *    `note_links` graph (forward links, backlinks, typed relationships), ordered
 *    `(distance ASC, noteId ASC)`. `noteId` is unique, so the total order is fully
 *    resolved and offset pagination is deterministic.
 *  - `note history <id-or-slug>` — paginated change history from `audit_events`
 *    (allowlisted metadata only — identifiers/hashes; never raw content), ordered
 *    by the monotonic unique `seq DESC` (its own tie-breaker).
 *
 * `related`/`history` resolve the seed against the DB projection (`notes` +
 * `note_identity_keys`); `show` resolves against the freshly-parsed vault. Both
 * agree once `db rebuild` has projected the vault (the normal steady state).
 */
import type { ParsedNote, SectionTree, VaultSnapshot } from "@atlas/contracts";
import { DEFAULT_LINK_PREDICATE, type SqliteDatabase } from "@atlas/sqlite-store";
import { readVault } from "../vault/reader.js";
import { normalizeIdentityKey } from "../vault/identity.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import {
  DEFAULT_LIMIT,
  assertOffsetInRange,
  buildPagination,
  parseLimit,
  parseOffset,
  type PageRequest,
} from "./pagination.js";

// ---------------------------------------------------------------------------
// note show (vault-backed — sections live only in canonical Markdown)
// ---------------------------------------------------------------------------

/** The filename slug of a vault-relative POSIX path: basename without `.md`. */
function fileSlug(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.toLowerCase().endsWith(".md") ? base.slice(0, -3) : base;
}

/** Parse the single `<id-or-slug>` positional (no flags). */
function parseSeedArg(command: string, argv: string[]): string {
  let seed: string | undefined;
  for (const a of argv) {
    if (a.startsWith("-")) throw CliError.usage(`\`${command}\`: unknown flag ${a}`);
    if (seed !== undefined) throw CliError.usage(`\`${command}\`: unexpected extra argument ${a}`);
    seed = a;
  }
  if (seed === undefined) throw CliError.usage(`\`${command}\` requires an <id-or-slug> argument`);
  return seed;
}

/** Flatten a `SectionTree` to its section paths in document (pre-order) order, excluding the root. */
function flattenSections(root: SectionTree): string[] {
  const out: string[] = [];
  const visit = (node: SectionTree): void => {
    out.push(node.path);
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  return out;
}

/**
 * Resolve a seed to exactly one parsed note via the NORMATIVE tiered precedence
 * (finding W4) — NOT a flat union across identity spaces (which makes an exact id
 * ambiguous the moment another note reuses that value as a slug or alias). Tiers
 * are tried in order and the FIRST non-empty tier decides:
 *
 *   1. exact `id`               2. exact filename slug               3. unique normalized alias
 *
 * A tier with a single match resolves; a tier with >1 match is a genuine collision
 * within one identity space (`ambiguous-note`); if no tier matches, `note-not-found`.
 */
function resolveParsedNote(command: string, notes: readonly ParsedNote[], seed: string): ParsedNote {
  const norm = normalizeIdentityKey(seed);
  const tiers: readonly ParsedNote[][] = [
    notes.filter((n) => n.id === seed),
    notes.filter((n) => fileSlug(n.path) === seed),
    notes.filter((n) => n.aliases.some((a) => normalizeIdentityKey(a) === norm)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return tier[0]!;
    if (tier.length > 1) throw ambiguousNote(command, seed, tier.map((n) => n.id));
  }
  throw noteNotFound(command, seed);
}

function noteNotFound(command: string, seed: string): CliError {
  return new CliError({
    code: "note-not-found",
    message: `\`${command}\`: no note matches "${seed}"`,
    hint: "Pass an exact note id, filename slug, or alias.",
    exitCode: EXIT.VALIDATION,
  });
}

function ambiguousNote(command: string, seed: string, ids: string[]): CliError {
  return new CliError({
    code: "ambiguous-note",
    message: `\`${command}\`: "${seed}" matches more than one note (${ids.join(", ")})`,
    hint: "Disambiguate with the exact note id.",
    exitCode: EXIT.VALIDATION,
  });
}

/**
 * Read the freshly-parsed vault snapshot (the projection's source of truth). Shared by
 * `note show` (which needs the whole snapshot) and by the declared-alias tier of
 * `note related`/`note history` (which need the parsed aliases) so all three resolve
 * against the SAME vault. A read failure surfaces as `internal` (exit 4): the immutable
 * CLI contracts for all three commands declare ONLY `internal`/`note-not-found`/`usage`
 * (NOT `vault-error` — that code is declared for db-rebuild/doctor/git-*, not these), so
 * the error class must be one they declare or the envelope violates the contract.
 */
async function loadVaultSnapshot(command: string, ctx: RunContext): Promise<VaultSnapshot> {
  try {
    return await readVault(ctx.config.config);
  } catch (e) {
    throw new CliError({
      code: "internal",
      message: `\`${command}\`: cannot read the vault: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Check that vault.path in brain.config.yaml exists and is readable.",
      exitCode: EXIT.INTERNAL,
    });
  }
}

async function noteShow(ctx: RunContext): Promise<number> {
  const seed = parseSeedArg("note show", ctx.argv);
  const snapshot = await loadVaultSnapshot("note show", ctx);
  const note = resolveParsedNote("note show", snapshot.notes, seed);

  // Per-link resolution against the vault's normative precedence (id → unique
  // slug → unique normalized alias). Any target that resolves is `resolved: true`.
  const byId = new Set(snapshot.notes.map((n) => n.id));
  const bySlug = countKeys(snapshot.notes.map((n) => fileSlug(n.path)));
  const byAlias = countKeys(
    snapshot.notes.flatMap((n) => [...new Set(n.aliases.map((a) => normalizeIdentityKey(a)))]),
  );
  const links = note.links.map((l) => {
    const target = l.target.includes("#") ? l.target.slice(0, l.target.indexOf("#")) : l.target;
    const resolved =
      byId.has(target) || bySlug.get(target) === 1 || byAlias.get(normalizeIdentityKey(target)) === 1;
    const out: Record<string, unknown> = { target: l.target, resolved };
    if (l.alias !== undefined) out.alias = l.alias;
    return out;
  });

  const noteOut: Record<string, unknown> = {
    id: note.id,
    path: note.path,
    type: note.type,
    title: note.title,
    status: note.status,
    aliases: [...note.aliases],
    links,
    sources: [...note.sources],
    sections: flattenSections(note.sections),
    contentHash: note.contentHash,
  };
  if (note.declaredSensitivity !== undefined) noteOut.declaredSensitivity = note.declaredSensitivity;

  const out = { command: "note show", note: noteOut };
  if (ctx.output.mode === "json") emitJson(out);
  else ctx.render(`${note.id} — ${note.title} (${links.length} link(s), ${note.sources.length} source(s))`);
  return EXIT.OK;
}

/** Count occurrences of each key (for the "unique match" link-resolution tiers). */
function countKeys(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------------------
// DB-side seed resolution (note related / note history)
// ---------------------------------------------------------------------------

/**
 * Resolve a seed to exactly one `note_id` via the SAME normative tiered precedence
 * as {@link resolveParsedNote} (finding W4 / #1): exact `note_id`, then exact `slug`,
 * then unique DECLARED alias normalizing to the seed — first non-empty tier wins, so
 * an exact id is never made ambiguous by another note reusing that value as a slug/
 * alias. Tiers 1–2 read the projection (`notes.note_id` PK, `notes.slug` UNIQUE →
 * ≤1 each); `note-not-found` (exit 1) when no tier matches.
 *
 * The third tier must match the vault's DECLARED-alias semantics EXACTLY so `note
 * related`/`note history` resolve the same seed as `note show`. It CANNOT be derived
 * from `note_identity_keys` alone:
 *
 *  - Filtering to `kind = 'alias'` DROPS a slug-equivalent declared alias. Projection
 *    rebuild COLLAPSES a declared alias that normalizes to the note's own slug into
 *    the single required `kind = 'slug'` row (the `one-slug-per-note` verify invariant
 *    permits exactly one slug key per note, and `normalized_key` is the PRIMARY KEY,
 *    so no separate `kind = 'alias'` row can exist). `note show` still resolves it
 *    against the vault → divergence.
 *  - Matching ANY kind wrongly accepts a BARE slug as an alias: a note with slug
 *    `atlas-engine` and NO declared alias would resolve `"Atlas Engine"` here while
 *    `note show` (whose alias tier consults only DECLARED aliases) returns
 *    not-found → divergence in the other direction.
 *
 * The projection simply cannot distinguish a slug-equivalent declared alias from a
 * bare slug (both are one `kind = 'slug'` row). So the third tier CONSULTS the
 * declared-alias source of truth — the same parsed vault `note show` reads (via
 * `loadNotes`) — and the vault's CURRENT declared aliases are AUTHORITATIVE. The
 * persisted `kind = 'alias'` projection rows are DELIBERATELY NOT unioned in (round-3
 * finding): a projection can lag the vault, so a STALE row (an alias since removed) or
 * a REMAPPED row (an alias since moved to another note) would otherwise keep the old
 * resolution alive here — or make the seed ambiguous by unioning a superseded owner
 * with the current one — while `note show` (reading only current vault declarations)
 * no longer agrees. Resolving the alias tier purely from the freshly-parsed vault keeps
 * all three commands byte-identical against the same source of truth. `loadNotes` is
 * invoked LAZILY, only when tiers 1–2 miss, so an exact id/slug lookup never needs the
 * vault; the de-duplicated set still resolves to at most one note (>1 ⇒ `ambiguous-note`).
 */
async function resolveNoteId(
  command: string,
  db: SqliteDatabase,
  seed: string,
  loadNotes: () => Promise<readonly ParsedNote[]>,
): Promise<string> {
  const decide = (ids: readonly string[]): string | undefined => {
    const unique = [...new Set(ids)];
    if (unique.length === 1) return unique[0]!;
    if (unique.length > 1) throw ambiguousNote(command, seed, unique.sort());
    return undefined;
  };

  const byId = (db.prepare(`SELECT note_id FROM notes WHERE note_id = ?`).all(seed) as { note_id: string }[]).map((r) => r.note_id);
  const idHit = decide(byId);
  if (idHit !== undefined) return idHit;

  const bySlug = (db.prepare(`SELECT note_id FROM notes WHERE slug = ?`).all(seed) as { note_id: string }[]).map((r) => r.note_id);
  const slugHit = decide(bySlug);
  if (slugHit !== undefined) return slugHit;

  // Tier 3: unique DECLARED alias normalizing to `norm`, sourced SOLELY from the
  // vault's CURRENT declarations (authoritative). Persisted `kind = 'alias'` rows are
  // intentionally not consulted so a stale/remapped projection row can never diverge
  // this from `note show` (round-3 finding). Recovers the collapsed slug-equivalent
  // alias and rejects a bare slug, because it reads the same parsed aliases `show` does.
  const norm = normalizeIdentityKey(seed);
  const aliasIds = new Set<string>();
  for (const n of await loadNotes()) {
    if (n.aliases.some((a) => normalizeIdentityKey(a) === norm)) aliasIds.add(n.id);
  }
  const aliasHit = decide([...aliasIds]);
  if (aliasHit !== undefined) return aliasHit;

  throw noteNotFound(command, seed);
}

// ---------------------------------------------------------------------------
// note related
// ---------------------------------------------------------------------------

function parseRelatedArgs(argv: string[]): { seed: string; req: PageRequest; depth: number } {
  let seed: string | undefined;
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  let depth = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw CliError.usage(`\`note related\`: ${a} requires a value`);
      return v;
    };
    if (a === "--limit") limit = parseLimit("note related", need());
    else if (a.startsWith("--limit=")) limit = parseLimit("note related", a.slice("--limit=".length));
    else if (a === "--offset") offset = parseOffset("note related", need());
    else if (a.startsWith("--offset=")) offset = parseOffset("note related", a.slice("--offset=".length));
    else if (a === "--depth" || a.startsWith("--depth=")) {
      const raw = a === "--depth" ? need() : a.slice("--depth=".length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw CliError.usage(`\`note related\`: --depth must be an integer >= 1 (got "${raw}")`);
      depth = n;
    } else if (a.startsWith("-")) throw CliError.usage(`\`note related\`: unknown flag ${a}`);
    else if (seed === undefined) seed = a;
    else throw CliError.usage(`\`note related\`: unexpected extra argument ${a}`);
  }
  if (seed === undefined) throw CliError.usage("`note related` requires an <id-or-slug> argument");
  return { seed, req: { limit, offset }, depth };
}

/** One related-note entry: how it was reached and the shortest distance to it. */
interface RelatedEntry {
  readonly noteId: string;
  readonly via: "link" | "backlink" | "relationship";
  readonly predicate?: string;
  readonly distance: number;
}

/** Deterministic rank so a node discovered by multiple edges at one distance picks a stable representative. */
const VIA_RANK: Record<RelatedEntry["via"], number> = { link: 0, backlink: 1, relationship: 2 };

/**
 * BFS the link/relationship graph from `seedId` up to `depth`, returning one entry
 * per distinct reachable note (shortest distance; deterministic representative
 * edge). Exported for the pagination contract test.
 */
export function traverseRelated(db: SqliteDatabase, seedId: string, depth: number): RelatedEntry[] {
  // Migration-frontier detection, ONCE per traversal (mirrors verify.ts's
  // migrationApplied): after `0013_links_v2` a plain [[wikilink]] carries a NULL
  // predicate and every non-null predicate is a deliberate typed edge (migrated
  // "references" rows intentionally stay typed). BEFORE 0013 the schema had no
  // NULL predicates — plain links carry the synthetic DEFAULT_LINK_PREDICATE —
  // so classifying on nullability alone would emit them as via="relationship".
  const linksV2 =
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get("db_schema_migrations") !== undefined
    ) &&
    db.prepare(`SELECT 1 FROM db_schema_migrations WHERE id = ?`).get("0013_links_v2") !==
      undefined;
  const isPlainLink = (predicate: string | null): boolean =>
    linksV2 ? predicate === null : predicate === null || predicate === DEFAULT_LINK_PREDICATE;
  const found = new Map<string, RelatedEntry>();
  let frontier: string[] = [seedId];
  const seen = new Set<string>([seedId]);
  for (let distance = 1; distance <= depth && frontier.length > 0; distance++) {
    // Process the frontier in a fixed order so discovery (and thus the recorded
    // representative edge) is deterministic regardless of insertion order.
    const next: string[] = [];
    for (const node of [...frontier].sort()) {
      const edges: { target: string; via: RelatedEntry["via"]; predicate?: string }[] = [];
      for (const r of db
        .prepare(`SELECT target_note_id, predicate FROM note_links WHERE source_note_id = ?`)
        .all(node) as { target_note_id: string; predicate: string | null }[]) {
        // Classification is migration-frontier-aware (see `isPlainLink` above):
        // post-0013 a NULL predicate is a PLAIN `[[wikilink]]` and every non-null
        // predicate is a typed relationship edge; pre-0013 the synthetic
        // DEFAULT_LINK_PREDICATE marks a plain link. Either way a plain link never
        // emits via="relationship" with a null predicate (JSON-schema violation).
        edges.push(
          isPlainLink(r.predicate)
            ? { target: r.target_note_id, via: "link" }
            : {
                target: r.target_note_id,
                via: "relationship",
                predicate: r.predicate as string,
              },
        );
      }
      for (const r of db
        .prepare(`SELECT source_note_id FROM note_links WHERE target_note_id = ?`)
        .all(node) as { source_note_id: string }[]) {
        edges.push({ target: r.source_note_id, via: "backlink" });
      }
      edges.sort(
        (a, b) =>
          a.target < b.target ? -1
          : a.target > b.target ? 1
          : VIA_RANK[a.via] - VIA_RANK[b.via] ||
            (a.predicate ?? "").localeCompare(b.predicate ?? ""),
      );
      for (const e of edges) {
        if (e.target === seedId || found.has(e.target)) continue;
        found.set(e.target, {
          noteId: e.target,
          via: e.via,
          distance,
          ...(e.predicate !== undefined ? { predicate: e.predicate } : {}),
        });
        if (!seen.has(e.target)) {
          seen.add(e.target);
          next.push(e.target);
        }
      }
    }
    frontier = next;
  }
  return [...found.values()].sort((a, b) => a.distance - b.distance || (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
}

async function noteRelated(ctx: RunContext): Promise<number> {
  const { seed, req, depth } = parseRelatedArgs(ctx.argv);
  const store = openMigratedStore(ctx);
  try {
    const noteId = await resolveNoteId(
      "note related",
      store.db,
      seed,
      async () => (await loadVaultSnapshot("note related", ctx)).notes,
    );
    const all = traverseRelated(store.db, noteId, depth);
    const total = all.length;
    assertOffsetInRange("note related", req.offset, total);
    const page = all.slice(req.offset, req.offset + req.limit);
    const out = {
      command: "note related",
      noteId,
      related: page.map((e) => ({
        noteId: e.noteId,
        via: e.via,
        ...(e.predicate !== undefined ? { predicate: e.predicate } : {}),
        distance: e.distance,
      })),
      pagination: buildPagination(req, total, page.length),
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`related to ${noteId}: ${page.length} of ${total}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// note history
// ---------------------------------------------------------------------------

function parseHistoryArgs(argv: string[]): { seed: string; req: PageRequest } {
  let seed: string | undefined;
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw CliError.usage(`\`note history\`: ${a} requires a value`);
      return v;
    };
    if (a === "--limit") limit = parseLimit("note history", need());
    else if (a.startsWith("--limit=")) limit = parseLimit("note history", a.slice("--limit=".length));
    else if (a === "--offset") offset = parseOffset("note history", need());
    else if (a.startsWith("--offset=")) offset = parseOffset("note history", a.slice("--offset=".length));
    else if (a.startsWith("-")) throw CliError.usage(`\`note history\`: unknown flag ${a}`);
    else if (seed === undefined) seed = a;
    else throw CliError.usage(`\`note history\`: unexpected extra argument ${a}`);
  }
  if (seed === undefined) throw CliError.usage("`note history` requires an <id-or-slug> argument");
  return { seed, req: { limit, offset } };
}

/**
 * A page of audit events for a note. Exported for the pagination contract test.
 *
 * `canonical_commit` is the run's CANONICAL commit hash, read from the integrated
 * `git_operations` artifact (`op_type = 'integrated'`, whose `commit_sha` is the
 * canonical-ref advance the broker recorded at integration). It is DELIBERATELY NOT
 * `audit_events.git_head` — that column is the `refs/audit/runs` audit-chain head,
 * a different hash space from the canonical commit the schema's `commit` field means.
 * A LEFT JOIN yields `null` for runs that never integrated, and each `(run_id,
 * 'integrated')` is a natural key so the join never multiplies rows.
 */
export function queryNoteHistory(
  db: SqliteDatabase,
  noteId: string,
  req: PageRequest,
): { rows: { seq: number; created_at: string; event_type: string; run_id: string; canonical_commit: string | null }[]; total: number } {
  const total = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM audit_events ae
         JOIN agent_runs ar ON ar.run_id = ae.run_id
        WHERE ar.target_note_id = ?`,
    )
    .get(noteId) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT ae.seq, ae.created_at, ae.event_type, ae.run_id, gi.commit_sha AS canonical_commit
         FROM audit_events ae
         JOIN agent_runs ar ON ar.run_id = ae.run_id
         LEFT JOIN git_operations gi
           ON gi.run_id = ae.run_id AND gi.op_type = 'integrated'
        WHERE ar.target_note_id = ?
        ORDER BY ae.seq DESC
        LIMIT ? OFFSET ?`,
    )
    .all(noteId, req.limit, req.offset) as {
    seq: number;
    created_at: string;
    event_type: string;
    run_id: string;
    canonical_commit: string | null;
  }[];
  return { rows, total };
}

async function noteHistory(ctx: RunContext): Promise<number> {
  const { seed, req } = parseHistoryArgs(ctx.argv);
  const store = openMigratedStore(ctx);
  try {
    const noteId = await resolveNoteId(
      "note history",
      store.db,
      seed,
      async () => (await loadVaultSnapshot("note history", ctx)).notes,
    );
    const { rows, total } = queryNoteHistory(store.db, noteId, req);
    assertOffsetInRange("note history", req.offset, total);
    const out = {
      command: "note history",
      noteId,
      events: rows.map((r) => {
        const e: Record<string, unknown> = { seq: r.seq, at: r.created_at, kind: r.event_type, runId: r.run_id };
        // `commit` is the CANONICAL commit hash (schema field), applicable only to the
        // integration event and only when the run recorded an integrated artifact —
        // omitted otherwise. Sourced from git_operations, never audit_events.git_head.
        if (r.event_type === "run.integrated" && r.canonical_commit !== null) e.commit = r.canonical_commit;
        return e;
      }),
      pagination: buildPagination(req, total, rows.length),
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`history of ${noteId}: ${rows.length} of ${total}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("note show", noteShow);
registerCommand("note related", noteRelated);
registerCommand("note history", noteHistory);

// `resolveNoteId` + `loadVaultSnapshot` are the SHARED seed-resolution surface:
// `link` grounds its <source>/<target> through the same tiered id → slug →
// declared-alias precedence these commands use, so a seed can never resolve
// differently across the note read surface and the link mutation.
export { noteShow, noteRelated, noteHistory, resolveNoteId, loadVaultSnapshot };
