/**
 * The `retrieve` orchestrator + identity resolver (Task 3.3, retrieval-index-contract
 * §5). This is the retrieval brain: it applies the strict layer precedence, runs the
 * statistical layers + RRF fusion (`./rrf.ts`, `@atlas/lancedb-index` `searchLayers`),
 * applies metadata filters, and persists layered per-channel provenance into
 * `retrieval_runs` / `retrieval_results` (the retained `0001_core` schema — no new
 * migration; carry-forward #3).
 *
 * ## Layer precedence (contract §5) — identity SHORT-CIRCUITS before fusion:
 *   exact id  →  slug  →  unique alias  →  fts / vector RRF fusion
 * The identity layers are exact, deterministic short-circuits. A normalized value
 * matching MORE THAN ONE note at the layer it resolves to is a **typed
 * {@link AmbiguousNoteError}** — never a silent pick (the load-bearing acceptance).
 *
 * ## Candidate unit = the note (§5). LanceDB ranks chunks; fusion folds them to
 * notes. Every candidate is active-generation fenced by `searchLayers` (§2).
 *
 * ## FTS-maturity fallback (§6) is ISOLATED in `@atlas/lancedb-index`'s `search.ts`;
 * this module only reads back the `degraded` flag + `layersUsed` it reports. It never
 * decides whether FTS participated.
 *
 * ## Provenance persistence — the retained schema (carry-forward #3):
 *   - `retrieval_runs.index_generation` (INTEGER) = the config epoch the query ran
 *     against (`notes.active_generation`); per-note composite generation ids are
 *     derivable from `active_generation_id`, so the single INTEGER is sufficient
 *     run-level provenance.
 *   - `retrieval_results` (PK `(retrieval_id, rank)`, `channel` enum
 *     `id|alias|fts|vector`) persists ONE ROW PER FUSED NOTE. The retained schema is
 *     authoritative (no migration; carry-forward #3): `rank` is the **1-based fused
 *     rank** (the data-dictionary definition — NOT a physical row sequence), and
 *     `channel` records the fused result's single contributing channel (the strongest
 *     contribution, ties broken by {@link LAYER_ORDER}). The PK `(retrieval_id, rank)`
 *     admits exactly one row per fused rank, so a per-(note, channel) normalization is
 *     structurally impossible without a forbidden migration; the FULL per-layer
 *     taxonomy + numeric folded ranks / weightedContributions therefore live in the
 *     returned {@link RankedItem.contributions}`[]` (contract §5's normative home for
 *     per-layer provenance), which Task 3.4 surfaces alongside the persisted rows.
 *
 * ## Persistence is a SEAM, not owned here (plan §2.8). This module PRODUCES the run +
 * result records and hands them to an injected {@link RetrievalRecorder}; it never
 * writes ledger tables itself. The real ledger write funnels through
 * `finalizeLedgerWrite` (§2.8: intent txn → broker audit append → ledger commit →
 * backup/watermark) inside Task 3.4's `brain query`. The acceptance suite injects an
 * in-memory capture recorder — there is no exported direct-write bypass of the audited
 * ledger protocol.
 */
import { normalizeIdentityKey } from "@atlas/contracts";
import {
  retrieveActiveChunks,
  searchLayers,
  type ChunkHit,
  type Embedder,
  type SearchLayersInput,
  type SearchLayersResult,
  type SearchTable,
} from "@atlas/lancedb-index";
import { CliError, EXIT } from "../errors/envelope.js";
import { fuse, type Contribution, type FusedItem, type Layer, type LayerCandidates, type StatLayer } from "./rrf.js";

export type { Layer, StatLayer, Contribution } from "./rrf.js";

/** The persisted `retrieval_results.channel` enum (dictionary §2 / 0001_core). */
export type Channel = "id" | "alias" | "fts" | "vector";
/** The persisted `retrieval_runs.mode` enum (0001_core). */
export type RunMode = "id" | "alias" | "fts" | "vector" | "hybrid";

/** Default + bounds for `--k` (query.schema.json flag constraint 1..100). */
const DEFAULT_K = 10;
const MAX_K = 100;

// ---------------------------------------------------------------------------
// Public query / result shapes (plan §Phase-3 Task 3.3 interfaces).
// ---------------------------------------------------------------------------

/** Metadata filters (contract §5 / query.schema flags). `type` restricts the note
 * type; sensitivity is a **pass-through** (surfaced on each item, never a filter). */
export interface RetrievalFilters {
  readonly type?: string;
}

/** A retrieval query. `k` defaults to {@link DEFAULT_K}; `filters` optional. */
export interface RetrievalQuery {
  readonly text: string;
  readonly k?: number;
  readonly filters?: RetrievalFilters;
}

/** A packed-ready section of a result note (dedup unit for packing). */
export interface RankedSection {
  /** The chunk's unique encoded section path (§1). */
  readonly sectionPath: string;
  /** Embedded chunk text (breadcrumb + title + aliases + body). */
  readonly text: string;
}

/** One ranked result — the RRF candidate unit is the NOTE (chunks folded, §5). */
export interface RankedItem {
  readonly noteId: string;
  /** Best-ranked matching section's path for this note (§5 provenance). */
  readonly sectionPath: string;
  readonly score: number;
  /** Every layer that surfaced this note, with folded rank + weighted contribution. */
  readonly contributions: Contribution[];
  /** The note's declared sensitivity — surfaced (pass-through), never used to filter. */
  readonly sensitivity: string;
  /** Evidence trust: `unverified` ⇒ surfaced-but-unverified per the gating rules
   * (design §gating). Packing flags it; it is never silently dropped. */
  readonly trust: NoteTrust;
  /** This note's matched sections, deduped by section path, best-rank first — the
   * section-aware assembly input for `packContext`. */
  readonly sections: RankedSection[];
}

/** Evidence trust flag surfaced onto a result note. */
export type NoteTrust = "verified" | "unverified";

/** The retrieval result (plan interface). `mode`/`degraded` mirror what is persisted
 * + the §6 fallback state; `retrievalRunId` correlates the persisted rows. */
export interface RetrievalResult {
  readonly items: RankedItem[];
  readonly layersUsed: Layer[];
  readonly retrievalRunId: string;
  readonly mode: RunMode;
  /** True when the FTS-maturity fallback (§6) dropped the fts layer for this query. */
  readonly degraded: boolean;
}

// ---------------------------------------------------------------------------
// Dependency seams (all external state is injected — the module is pure of I/O
// wiring so `retrieval.test` can drive it against a real store + LanceDB or fakes).
// ---------------------------------------------------------------------------

/** Note metadata the retriever needs for filtering + surfacing (backed by the
 * `notes` projection + claims/evidence gating in production; a fake in tests). */
export interface NoteMeta {
  readonly type: string;
  readonly sensitivity: string;
  /** Evidence gating result: `unverified` when the note carries only non-`valid`
   * evidence (surfaced-but-unverified — design §gating). Ownership of the gating
   * computation stays with the claims store; this module only surfaces the flag. */
  readonly trust: NoteTrust;
}

/**
 * Identity resolution (Task 1.4). Backed by `notes` (exact id / canonical slug) +
 * `note_identity_keys` (normalized slug/alias keys). Each resolver returns the FULL
 * candidate set at its layer so {@link retrieve} can detect ambiguity and refuse a
 * silent pick — even though `note_identity_keys.normalized_key` is unique per vault
 * (PK), the typed-error guard is structural, not incidental.
 */
export interface IdentityResolver {
  /** A note whose canonical id EXACTLY equals the raw query, or `null`. */
  resolveExactId(rawText: string): string | null;
  /** Note ids whose canonical slug normalizes to `normalizedKey`. */
  resolveSlug(normalizedKey: string): string[];
  /** Note ids one of whose declared aliases normalizes to `normalizedKey`. */
  resolveAlias(normalizedKey: string): string[];
}

/**
 * The record-production seam. {@link retrieve} builds the run + result records and
 * passes them here; the concrete recorder decides how they durably land. In
 * production Task 3.4's `brain query` supplies a recorder that funnels the write
 * through §2.8's `finalizeLedgerWrite` (intent txn → broker audit append → ledger
 * commit → backup/watermark); the acceptance suite supplies an in-memory capture
 * recorder. This module deliberately exports NO direct ledger-table writer, so there
 * is no way to bypass the audited protocol.
 */
export interface RetrievalRecorder {
  record(run: RetrievalRunRecord, results: readonly RetrievalResultRecord[]): void;
}

/** A `retrieval_runs` row (0001_core). */
export interface RetrievalRunRecord {
  readonly retrievalId: string;
  readonly runId: string | null;
  readonly queryText: string;
  readonly mode: RunMode;
  readonly indexGeneration: number;
  readonly createdAt: string;
}

/** A `retrieval_results` row (0001_core) — one per fused note. `rank` is the 1-based
 * fused rank (dictionary definition; PK `(retrieval_id, rank)`); `channel` is the
 * fused result's single contributing channel. */
export interface RetrievalResultRecord {
  readonly rank: number;
  readonly noteId: string;
  readonly score: number;
  readonly channel: Channel;
}

/** Everything {@link retrieve} needs, injected. */
export interface RetrievalDeps {
  /** The `retrieval` config section (RRF k/weights + FTS switch) — never inlined. */
  readonly config: {
    readonly rrf: { readonly k: number; readonly weights: Readonly<Record<StatLayer, number>> };
    readonly fts: { readonly enabled: boolean };
  };
  readonly resolver: IdentityResolver;
  readonly table: SearchTable;
  /** The retrieval-live generation set (`GenerationRepo.activeGenerationIds()`). */
  readonly activeGenerationIds: () => readonly string[];
  /** A note's fenced active generation id (`GenerationRepo.activeGenerationId`) —
   * the {@link retrieveActiveChunks} authority for identity short-circuit packing. */
  readonly activeGenerationId: (noteId: string) => string | null;
  /** Query embedding via the egress broker (2.8) — the single-text query vector. */
  readonly embed: Embedder;
  /** The statistical-layer search seam. Defaults to `@atlas/lancedb-index`'s
   * {@link searchLayers} (which owns the FTS-maturity fallback, §6); injectable so the
   * acceptance suite can exercise fusion + provenance without depending on LanceDB's
   * FTS index maturity. */
  readonly search?: (table: SearchTable, input: SearchLayersInput) => Promise<SearchLayersResult>;
  readonly noteMeta: (noteId: string) => NoteMeta | null;
  readonly recorder: RetrievalRecorder;
  /** The config epoch the query ran against (`notes.active_generation`, §2). */
  readonly indexGeneration: number;
  /** Owning workflow run id, or `null` for an ad-hoc query. */
  readonly runId?: string | null;
  /** Mints the correlating `retrieval_id`. */
  readonly newRetrievalId: () => string;
  /** RFC3339 `created_at` supplier. */
  readonly now: () => string;
}

// ---------------------------------------------------------------------------
// Typed errors.
// ---------------------------------------------------------------------------

/**
 * The TYPED ambiguity error (contract §5.3, review hint). Raised when a normalized
 * query matches MORE THAN ONE note at the identity layer it resolves to — the
 * resolver MUST NEVER silently pick one. Extends {@link CliError} with the
 * `ambiguous-note` code (exit 1, per query.schema.json), so it flows through the
 * error envelope AND is catchable by `instanceof`.
 */
export class AmbiguousNoteError extends CliError {
  readonly candidateNoteIds: readonly string[];
  constructor(normalizedKey: string, layer: "slug" | "unique-alias", candidateNoteIds: readonly string[]) {
    super({
      code: "ambiguous-note",
      message: `query "${normalizedKey}" matches ${candidateNoteIds.length} notes at the ${layer} layer; refusing a silent pick`,
      exitCode: EXIT.VALIDATION,
      hint: "disambiguate by exact note id, or rename the colliding aliases",
      details: { normalizedKey, layer, candidateNoteIds: [...candidateNoteIds] },
    });
    this.name = "AmbiguousNoteError";
    this.candidateNoteIds = candidateNoteIds;
  }
}

/**
 * A TYPED query-embed failure (contract query.schema `embedding-retryable` /
 * `embedding-failed`). Retrieval consumes the {@link Embedder} seam, which returns a
 * typed outcome rather than throwing; a failure surfaces HERE as this error carrying
 * the provider classification. The `query` command (Task 3.4) maps it to the exit
 * code (7 retryable / 4 permanent) — this module owns the classification, not the
 * exit-code set.
 */
export class QueryEmbedError extends Error {
  readonly code: "embedding-retryable" | "embedding-failed";
  readonly retryable: boolean;
  readonly providerKind: string;
  readonly retryAfterMs: number | undefined;
  constructor(init: { retryable: boolean; providerKind: string; message?: string; retryAfterMs?: number }) {
    super(init.message ?? `query embedding failed (${init.providerKind})`);
    this.name = "QueryEmbedError";
    this.code = init.retryable ? "embedding-retryable" : "embedding-failed";
    this.retryable = init.retryable;
    this.providerKind = init.providerKind;
    this.retryAfterMs = init.retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Channel / mode mapping (the 5-value layer taxonomy → the persisted 4-value enum).
// ---------------------------------------------------------------------------

/** The precise-layer → persisted-channel collapse. The identity layers fold into
 * `id` (canonical: exact id + the note's own slug) vs `alias` (a secondary label);
 * the statistical layers keep their names. The full 5-value taxonomy is preserved
 * in `RankedItem.contributions[]`, so no provenance is lost at the output. */
function layerToChannel(layer: Layer): Channel {
  switch (layer) {
    case "exact-id":
      return "id";
    case "slug":
      return "id";
    case "unique-alias":
      return "alias";
    case "fts":
      return "fts";
    case "vector":
      return "vector";
  }
}

/** Fixed layer order for deterministic persistence + tie-breaks. */
const LAYER_ORDER: readonly Layer[] = ["exact-id", "slug", "unique-alias", "fts", "vector"];

/**
 * The single contributing channel persisted for a fused note (retained
 * `retrieval_results`: PK `(retrieval_id, rank)` + a scalar `channel` enum with no
 * `hybrid` member ⇒ exactly one channel per fused rank). It is the channel of the
 * note's STRONGEST contribution (highest `weightedContribution`); ties break by
 * {@link LAYER_ORDER} precedence, so the pick is deterministic. The full per-layer
 * taxonomy + numeric contributions are NOT collapsed away — they remain in the
 * returned `RankedItem.contributions[]` (contract §5's normative home). This is the
 * authoritative resolution of the retained-schema constraint (no migration allowed):
 * the row names the dominant channel, the result object carries the rest.
 */
function primaryChannel(contributions: readonly Contribution[]): Channel {
  let best = contributions[0]!; // a fused/identity note always has ≥1 contribution
  for (const c of contributions) {
    if (c.weightedContribution > best.weightedContribution) best = c;
    else if (
      c.weightedContribution === best.weightedContribution &&
      LAYER_ORDER.indexOf(c.layer) < LAYER_ORDER.indexOf(best.layer)
    ) {
      best = c;
    }
  }
  return layerToChannel(best.layer);
}

/** The `retrieval_runs.mode` for a statistical query, from the layers that ran. */
function statisticalMode(layersUsed: readonly StatLayer[]): RunMode {
  const hasFts = layersUsed.includes("fts");
  const hasVector = layersUsed.includes("vector");
  if (hasFts && hasVector) return "hybrid";
  if (hasFts) return "fts";
  return "vector"; // vector-only (§6 fallback) or the empty-set default
}

// ---------------------------------------------------------------------------
// Identity resolution.
// ---------------------------------------------------------------------------

/** A resolved identity short-circuit. */
interface IdentityHit {
  readonly noteId: string;
  readonly layer: Extract<Layer, "exact-id" | "slug" | "unique-alias">;
}

/**
 * Resolve the query through the identity layers in strict precedence (§5): exact id
 * → slug → unique alias. Returns the hit, or `null` when no identity layer resolves
 * (the caller falls through to statistical fusion). A layer that matches MORE THAN
 * ONE note throws {@link AmbiguousNoteError} — never a silent pick.
 */
function resolveIdentity(rawText: string, resolver: IdentityResolver): IdentityHit | null {
  // 1. exact id — the raw query IS a canonical note id (unique by construction).
  const exact = resolver.resolveExactId(rawText);
  if (exact !== null) return { noteId: exact, layer: "exact-id" };

  const key = normalizeIdentityKey(rawText);

  // 2. slug — the query normalizes to a note's canonical slug.
  const slugs = resolver.resolveSlug(key);
  if (slugs.length > 1) throw new AmbiguousNoteError(key, "slug", slugs);
  if (slugs.length === 1) return { noteId: slugs[0]!, layer: "slug" };

  // 3. unique alias — the query normalizes to exactly one note's alias.
  const aliases = resolver.resolveAlias(key);
  if (aliases.length > 1) throw new AmbiguousNoteError(key, "unique-alias", aliases);
  if (aliases.length === 1) return { noteId: aliases[0]!, layer: "unique-alias" };

  return null;
}

// ---------------------------------------------------------------------------
// Section assembly.
// ---------------------------------------------------------------------------

/** Collapse a note's chunk hits to deduped sections, best-rank first (the
 * section-aware, note-deduped packing input, §5 / plan). */
function sectionsFromHits(hits: readonly ChunkHit[]): RankedSection[] {
  const byPath = new Map<string, { text: string; rank: number }>();
  for (const h of hits) {
    const existing = byPath.get(h.sectionPath);
    if (existing === undefined || h.rank < existing.rank) byPath.set(h.sectionPath, { text: h.text, rank: h.rank });
  }
  return [...byPath.entries()]
    .sort((a, b) => a[1].rank - b[1].rank || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([sectionPath, v]) => ({ sectionPath, text: v.text }));
}

/** Sections for an identity short-circuit note: its live (active-generation) chunks,
 * deduped by path, ordered by section path (no statistical rank exists). */
async function identitySections(deps: RetrievalDeps, noteId: string): Promise<RankedSection[]> {
  const chunks = await retrieveActiveChunks(deps.table, { activeGenerationId: deps.activeGenerationId }, noteId);
  const byPath = new Map<string, string>();
  for (const c of chunks) if (!byPath.has(c.sectionPath)) byPath.set(c.sectionPath, c.text);
  return [...byPath.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([sectionPath, text]) => ({ sectionPath, text }));
}

/**
 * A note surfaced from the index whose metadata projection is missing is a
 * data-integrity anomaly. We MUST NOT fail open (treat it as trusted + low
 * sensitivity), so the fallback is the CONSERVATIVE metadata: `trust: "unverified"`
 * (never treated as trusted grounding — design §gating) and the most-restrictive
 * `sensitivity: "restricted"`. `type: ""` matches no `--type` filter, so an unknown
 * note is also excluded from a type-restricted query. (Sensitivity is pass-through;
 * the restrictive default only affects how downstream handling treats the note, never
 * whether it is surfaced.)
 */
const MISSING_META: NoteMeta = { type: "", sensitivity: "restricted", trust: "unverified" };

/** Look up a note's metadata, defaulting a missing projection to conservative,
 * fail-closed {@link MISSING_META} (never a fail-open verified/internal). */
function metaOf(deps: RetrievalDeps, noteId: string): NoteMeta {
  return deps.noteMeta(noteId) ?? MISSING_META;
}

// ---------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------

/**
 * Hybrid retrieval (contract §5). Resolves the query through the layer precedence,
 * fuses the statistical layers with config-owned RRF, applies the metadata filters,
 * persists the layered per-channel provenance, and returns the ranked notes. An
 * identity short-circuit returns a single note with a single-entry `contributions[]`
 * and a deterministic score of 1 (§5).
 */
export async function retrieve(q: RetrievalQuery, deps: RetrievalDeps): Promise<RetrievalResult> {
  const k = resolveK(q.k);
  const retrievalId = deps.newRetrievalId();
  const createdAt = deps.now();
  const filters = q.filters ?? {};
  const runId = deps.runId ?? null;

  // Identity short-circuit (exact id → slug → unique alias). Ambiguity throws here.
  const identity = resolveIdentity(q.text, deps.resolver);
  if (identity !== null) {
    const meta = metaOf(deps, identity.noteId);
    // A `--type` filter that excludes the resolved note yields an empty result — the
    // identity resolved, but not to a note the caller asked for.
    const excluded = filters.type !== undefined && meta.type !== filters.type;
    const items: RankedItem[] = excluded
      ? []
      : [
          {
            noteId: identity.noteId,
            sectionPath: "",
            score: 1, // identity short-circuit: deterministic score (§5)
            contributions: [{ layer: identity.layer, rank: 1, weightedContribution: 1 }],
            sensitivity: meta.sensitivity,
            trust: meta.trust,
            sections: await identitySections(deps, identity.noteId),
          },
        ];
    if (items.length === 1) items[0] = { ...items[0]!, sectionPath: items[0]!.sections[0]?.sectionPath ?? "" };

    const mode: RunMode = layerToChannel(identity.layer) === "id" ? "id" : "alias";
    persist(deps, { retrievalId, runId, queryText: q.text, mode, indexGeneration: deps.indexGeneration, createdAt }, items);
    return { items, layersUsed: [identity.layer], retrievalRunId: retrievalId, mode, degraded: false };
  }

  // Statistical layers: embed the query, search (active-generation fenced), fuse.
  // Short-circuit an empty index BEFORE embedding: with no active generation there
  // is nothing to search, so we must not spend a (costly, ledger-recorded) query
  // embed. The run is still recorded (the query happened). NO statistical layer
  // actually participated — `layersUsed` is [] and `mode` is derived from that empty
  // set (`statisticalMode([]) === "vector"`, the degenerate no-layer default), so the
  // persisted mode and the reported layers are consistent (never reporting fts/vector
  // as having run when nothing was searched).
  const activeGenerationIds = deps.activeGenerationIds();
  if (activeGenerationIds.length === 0) {
    const layersUsed: Layer[] = [];
    const mode = statisticalMode([]); // no statistical layer ran ⇒ degenerate default
    persist(deps, { retrievalId, runId, queryText: q.text, mode, indexGeneration: deps.indexGeneration, createdAt }, []);
    return { items: [], layersUsed, retrievalRunId: retrievalId, mode, degraded: !deps.config.fts.enabled };
  }

  const queryVector = await embedQuery(deps.embed, q.text);
  const runSearch = deps.search ?? searchLayers;
  // `--type` metadata filter: pushed INTO the search as a note-level eligibility
  // predicate so filtering happens before the per-note cap/paging (a matching note
  // below nonmatching top-k chunks is not lost). Sensitivity is pass-through.
  const noteFilter =
    filters.type === undefined ? undefined : (noteId: string): boolean => metaOf(deps, noteId).type === filters.type;
  const search = await runSearch(deps.table, {
    queryText: q.text,
    queryVector,
    activeGenerationIds,
    limit: k,
    ftsEnabled: deps.config.fts.enabled,
    ...(noteFilter !== undefined ? { noteFilter } : {}),
  });

  // Defensive post-filter: the default `searchLayers` already applied `noteFilter`
  // during paging; this re-drops any non-matching hit an INJECTED search seam (a test
  // double) may not have filtered. A no-op on the real path.
  const filtered = applyTypeFilter(search, filters.type, deps);

  const candidates: LayerCandidates[] = [];
  if (filtered.fts !== null) candidates.push({ layer: "fts", hits: filtered.fts });
  candidates.push({ layer: "vector", hits: filtered.vector });

  const fused = fuse(candidates, { k: deps.config.rrf.k, weights: deps.config.rrf.weights });
  const top = fused.slice(0, k);

  // Collect each fused note's matched sections across the (filtered) layers.
  const hitsByNote = groupHitsByNote(filtered);
  const items: RankedItem[] = top.map((f) => enrichFused(f, deps, hitsByNote.get(f.noteId) ?? []));

  const mode = statisticalMode(search.layersUsed);
  persist(deps, { retrievalId, runId, queryText: q.text, mode, indexGeneration: deps.indexGeneration, createdAt }, items);
  return { items, layersUsed: search.layersUsed, retrievalRunId: retrievalId, mode, degraded: search.degraded };
}

/** Validate + default `--k` (1..{@link MAX_K}); out-of-range is a usage error (exit 5). */
function resolveK(k: number | undefined): number {
  if (k === undefined) return DEFAULT_K;
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
    throw CliError.usage(`--k must be an integer in [1, ${MAX_K}] (got ${k})`);
  }
  return k;
}

/** Embed the query text to its dense vector, mapping a typed failure outcome to a
 * {@link QueryEmbedError} (contract query.schema embedding-* codes). */
async function embedQuery(embed: Embedder, text: string): Promise<number[]> {
  const out = await embed([text]);
  if (!out.ok) {
    throw new QueryEmbedError({
      retryable: out.retryable,
      providerKind: out.kind,
      ...(out.message !== undefined ? { message: out.message } : {}),
      ...(out.retryAfterMs !== undefined ? { retryAfterMs: out.retryAfterMs } : {}),
    });
  }
  const vector = out.vectors[0];
  if (vector === undefined) {
    throw new QueryEmbedError({ retryable: false, providerKind: "validation", message: "embedder returned no query vector" });
  }
  return [...vector];
}

/** Drop chunk hits whose note does not match the `--type` filter (both layers). */
function applyTypeFilter(search: SearchLayersResult, type: string | undefined, deps: RetrievalDeps): SearchLayersResult {
  if (type === undefined) return search;
  const ok = (noteId: string): boolean => metaOf(deps, noteId).type === type;
  return {
    ...search,
    vector: search.vector.filter((h) => ok(h.noteId)),
    fts: search.fts === null ? null : search.fts.filter((h) => ok(h.noteId)),
  };
}

/** Group every layer's (filtered) chunk hits by note id, for section assembly. */
function groupHitsByNote(search: SearchLayersResult): Map<string, ChunkHit[]> {
  const byNote = new Map<string, ChunkHit[]>();
  const add = (h: ChunkHit): void => {
    const list = byNote.get(h.noteId);
    if (list === undefined) byNote.set(h.noteId, [h]);
    else list.push(h);
  };
  for (const h of search.vector) add(h);
  if (search.fts !== null) for (const h of search.fts) add(h);
  return byNote;
}

/** Build a {@link RankedItem} from a fused note + its matched chunk hits. */
function enrichFused(f: FusedItem, deps: RetrievalDeps, hits: readonly ChunkHit[]): RankedItem {
  const meta = metaOf(deps, f.noteId);
  return {
    noteId: f.noteId,
    sectionPath: f.sectionPath,
    score: f.score,
    contributions: f.contributions,
    sensitivity: meta.sensitivity,
    trust: meta.trust,
    sections: sectionsFromHits(hits),
  };
}

/**
 * Produce the run + result records and hand them to the injected
 * {@link RetrievalRecorder} (retained `0001_core`; no new migration — carry-forward
 * #3). Emits ONE `retrieval_results` record per FUSED NOTE: `rank` is the 1-based
 * fused rank (the data-dictionary definition — never a physical row sequence), `score`
 * is the fused RRF score, and `channel` is the note's single dominant contributing
 * channel ({@link primaryChannel}). The retained PK `(retrieval_id, rank)` permits
 * exactly one row per fused rank, so this single-row-per-note shape is the only one
 * the schema can hold without a forbidden migration; the full per-layer ranks +
 * weightedContributions live in the returned `RankedItem.contributions[]` (contract
 * §5's normative home). This module NEVER writes ledger tables — the real durable
 * write funnels through §2.8's `finalizeLedgerWrite` inside Task 3.4's `brain query`;
 * the recorder here is only the record-production seam.
 */
function persist(deps: RetrievalDeps, run: RetrievalRunRecord, items: readonly RankedItem[]): void {
  const results: RetrievalResultRecord[] = items.map((item, i) => ({
    rank: i + 1, // 1-based FUSED rank (retrieval_results.rank, dictionary definition)
    noteId: item.noteId,
    score: item.score,
    channel: primaryChannel(item.contributions),
  }));
  deps.recorder.record(run, results);
}
