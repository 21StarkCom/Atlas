/**
 * `retrieval.test` — the Task 3.3 acceptance suite (retrieval-index-contract §5/§6).
 *
 * Asserts:
 *   1. **Resolver precedence** — exact id beats slug beats alias (contract §5).
 *   2. **Typed ambiguity, never a silent pick** — a normalized value matching more
 *      than one note at its layer is an `AmbiguousNoteError` (code `ambiguous-note`,
 *      exit 1); nothing is persisted (review hint / acceptance).
 *   3. **RRF fusion deterministic** — folding, re-densify, weighted sum, and the
 *      score-desc / noteId-asc tie-break are reproducible (contract §5).
 *   4. **Layered provenance produced** — a real query (REAL LanceDB search + REAL
 *      SQLite generation state) produces the `retrieval_runs` + `retrieval_results`
 *      records for the retained `0001_core` schema: one row per fused note, `rank` =
 *      the 1-based fused rank, `channel` = the dominant contributing channel. The
 *      records are captured through an in-memory recorder seam — the real durable
 *      write is Task 3.4's `finalizeLedgerWrite` path (§2.8), NOT this module.
 *   5. **FTS-maturity fallback isolated to `search.ts`** — a missing FTS index or the
 *      `retrieval.fts.enabled=false` switch degrades to vector-only; no other module
 *      sees FTS drop out (contract §6).
 *   6. **Context packing** — dedup by note, section-aware assembly, evidence trust
 *      flags surfaced-but-unverified, token-budget truncation.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { ParsedNote } from "@atlas/contracts";
import { openStore, registerGenerationMigration, type Store } from "@atlas/sqlite-store";
import {
  assembleRows,
  chunkNote,
  generationId,
  indexingConfigKey,
  openSearchTable,
  searchLayers,
  writeGeneration,
  type Embedder,
  type IndexingConfig,
  type SearchLayersResult,
  type SearchTable,
} from "@atlas/lancedb-index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fuse, type LayerCandidates } from "../src/retrieval/rrf.js";
import {
  AmbiguousNoteError,
  QueryEmbedError,
  retrieve,
  type IdentityResolver,
  type NoteMeta,
  type RetrievalDeps,
  type RetrievalResultRecord,
  type RetrievalRunRecord,
} from "../src/retrieval/layers.js";
import { packContext } from "../src/retrieval/pack.js";
import { CliError } from "../src/errors/envelope.js";

const DIMS = 3;
const CFG: IndexingConfig = { chunker_version: 1, embedding_model: "test-embed", dimensions: DIMS };

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

/** A resolver returning fixed sets per layer (so ambiguity/precedence are drivable). */
function fakeResolver(init: {
  exact?: Record<string, string>;
  slug?: Record<string, string[]>;
  alias?: Record<string, string[]>;
}): IdentityResolver {
  return {
    resolveExactId: (raw) => init.exact?.[raw] ?? null,
    resolveSlug: (key) => init.slug?.[key] ?? [],
    resolveAlias: (key) => init.alias?.[key] ?? [],
  };
}

/** A recorder that captures what would be persisted (used when no real store is needed). */
function captureRecorder(): {
  runs: RetrievalRunRecord[];
  results: RetrievalResultRecord[][];
  recorder: RetrievalDeps["recorder"];
} {
  const runs: RetrievalRunRecord[] = [];
  const results: RetrievalResultRecord[][] = [];
  return {
    runs,
    results,
    recorder: {
      record(run, res) {
        runs.push(run);
        results.push([...res]);
      },
    },
  };
}

const okEmbed: Embedder = async (texts) => ({ ok: true, vectors: texts.map(() => Array(DIMS).fill(0)) });

/** A minimal deps builder; every field overridable per test. */
function makeDeps(over: Partial<RetrievalDeps>): RetrievalDeps {
  const cap = captureRecorder();
  return {
    config: { rrf: { k: 60, weights: { fts: 1, vector: 1 } }, fts: { enabled: true } },
    resolver: fakeResolver({}),
    table: {} as unknown as SearchTable, // unused unless the statistical/identity-chunk path runs
    activeGenerationIds: () => [],
    activeGenerationId: () => null,
    embed: okEmbed,
    noteMeta: () => ({ type: "concept", sensitivity: "internal", trust: "verified" }),
    recorder: cap.recorder,
    indexGeneration: 1,
    runId: null,
    newRetrievalId: () => "rr-test",
    now: () => "2026-07-12T00:00:00Z",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Resolver precedence.
// ---------------------------------------------------------------------------

describe("resolver precedence — exact id beats slug beats alias (contract §5)", () => {
  it("exact id short-circuits even when slug + alias also match", async () => {
    const cap = captureRecorder();
    const deps = makeDeps({
      resolver: fakeResolver({ exact: { "concept-atlas": "concept-atlas" }, slug: { "concept-atlas": ["other"] }, alias: { "concept-atlas": ["other2"] } }),
      recorder: cap.recorder,
    });
    const r = await retrieve({ text: "concept-atlas" }, deps);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.noteId).toBe("concept-atlas");
    expect(r.layersUsed).toEqual(["exact-id"]);
    expect(r.items[0]!.contributions).toEqual([{ layer: "exact-id", rank: 1, weightedContribution: 1 }]);
    expect(r.items[0]!.score).toBe(1);
    // Persisted as the `id` channel/mode.
    expect(cap.runs[0]!.mode).toBe("id");
    expect(cap.results[0]![0]).toMatchObject({ rank: 1, noteId: "concept-atlas", channel: "id", score: 1 });
  });

  it("slug beats alias when both match the normalized value", async () => {
    const cap = captureRecorder();
    const deps = makeDeps({
      resolver: fakeResolver({ slug: { meridian: ["note-slug"] }, alias: { meridian: ["note-alias"] } }),
      recorder: cap.recorder,
    });
    const r = await retrieve({ text: "Meridian" }, deps); // normalizes to "meridian"
    expect(r.items[0]!.noteId).toBe("note-slug");
    expect(r.layersUsed).toEqual(["slug"]);
    expect(cap.runs[0]!.mode).toBe("id"); // slug collapses to the `id` channel
    expect(cap.results[0]![0]!.channel).toBe("id");
  });

  it("unique alias resolves when neither exact id nor slug match", async () => {
    const cap = captureRecorder();
    const deps = makeDeps({ resolver: fakeResolver({ alias: { meridian: ["note-alias"] } }), recorder: cap.recorder });
    const r = await retrieve({ text: "meridian" }, deps);
    expect(r.items[0]!.noteId).toBe("note-alias");
    expect(r.layersUsed).toEqual(["unique-alias"]);
    expect(r.items[0]!.contributions).toEqual([{ layer: "unique-alias", rank: 1, weightedContribution: 1 }]);
    expect(cap.runs[0]!.mode).toBe("alias");
    expect(cap.results[0]![0]!.channel).toBe("alias");
  });

  it("a --type filter excluding the resolved identity note yields an empty result", async () => {
    const deps = makeDeps({
      resolver: fakeResolver({ exact: { "concept-atlas": "concept-atlas" } }),
      noteMeta: () => ({ type: "source", sensitivity: "internal", trust: "verified" }),
    });
    const r = await retrieve({ text: "concept-atlas", filters: { type: "concept" } }, deps);
    expect(r.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Typed ambiguity — never a silent pick.
// ---------------------------------------------------------------------------

describe("ambiguity is a TYPED error, never a silent pick (review hint)", () => {
  it("an alias normalizing to >1 note throws AmbiguousNoteError (code ambiguous-note, exit 1)", async () => {
    const cap = captureRecorder();
    const deps = makeDeps({ resolver: fakeResolver({ alias: { meridian: ["note-a", "note-b"] } }), recorder: cap.recorder });
    const err = await retrieve({ text: "meridian" }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousNoteError);
    expect(err).toBeInstanceOf(CliError);
    const ambig = err as AmbiguousNoteError;
    expect(ambig.code).toBe("ambiguous-note");
    expect(ambig.exitCode).toBe(1);
    expect(ambig.candidateNoteIds).toEqual(["note-a", "note-b"]);
    // NEVER a silent pick: nothing was persisted.
    expect(cap.runs).toHaveLength(0);
    expect(cap.results).toHaveLength(0);
  });

  it("a slug normalizing to >1 note throws AmbiguousNoteError at the slug layer", async () => {
    const deps = makeDeps({ resolver: fakeResolver({ slug: { meridian: ["s1", "s2"] } }) });
    const err = await retrieve({ text: "meridian" }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousNoteError);
    expect((err as AmbiguousNoteError).details).toMatchObject({ layer: "slug" });
  });

  it("higher-precedence exact id wins BEFORE a lower-precedence alias ambiguity is even reached", async () => {
    const deps = makeDeps({
      resolver: fakeResolver({ exact: { meridian: "the-note" }, alias: { meridian: ["a", "b"] } }),
    });
    const r = await retrieve({ text: "meridian" }, deps); // must NOT throw
    expect(r.items[0]!.noteId).toBe("the-note");
    expect(r.layersUsed).toEqual(["exact-id"]);
  });
});

// ---------------------------------------------------------------------------
// 3. RRF fusion determinism (pure).
// ---------------------------------------------------------------------------

describe("RRF fusion deterministic (contract §5)", () => {
  const config = { k: 60, weights: { fts: 1, vector: 1 } };

  it("folds chunks→notes (best rank), re-densifies, and fuses with the config weights/k", () => {
    const layers: LayerCandidates[] = [
      {
        layer: "fts",
        hits: [
          { noteId: "n1", sectionPath: "A", rank: 1 },
          { noteId: "n2", sectionPath: "B", rank: 2 },
          { noteId: "n1", sectionPath: "A2", rank: 3 }, // same note, worse rank → folded away
        ],
      },
      {
        layer: "vector",
        hits: [
          { noteId: "n2", sectionPath: "B", rank: 1 },
          { noteId: "n3", sectionPath: "C", rank: 2 },
        ],
      },
    ];
    const fused = fuse(layers, config);
    // n1: fts dense-rank 1 → 1/61. n2: fts 2, vector 1 → 1/62 + 1/61. n3: vector 2 → 1/62.
    const score = (contribs: [string, number][]): number =>
      contribs.reduce((s, [, rank]) => s + 1 / (60 + rank), 0);
    const byId = Object.fromEntries(fused.map((f) => [f.noteId, f]));
    expect(byId.n2!.score).toBeCloseTo(score([["fts", 2], ["vector", 1]]), 12);
    expect(byId.n1!.score).toBeCloseTo(1 / 61, 12);
    expect(byId.n3!.score).toBeCloseTo(1 / 62, 12);
    // n2 is top (appears in both layers). Order is by descending score.
    expect(fused.map((f) => f.noteId)).toEqual(["n2", "n1", "n3"]);
    // Σ weightedContribution === score, and n1 folded to its best (rank-1) chunk's section.
    for (const f of fused) {
      expect(f.contributions.reduce((s, c) => s + c.weightedContribution, 0)).toBeCloseTo(f.score, 12);
    }
    expect(byId.n1!.sectionPath).toBe("A");
    expect(byId.n2!.contributions.map((c) => c.layer).sort()).toEqual(["fts", "vector"]);
  });

  it("ties on score break by ascending noteId, and output is reproducible", () => {
    // Two notes each appearing once at rank 1 in a different single layer → equal scores.
    const layers: LayerCandidates[] = [
      { layer: "fts", hits: [{ noteId: "zzz", sectionPath: "A", rank: 1 }] },
      { layer: "vector", hits: [{ noteId: "aaa", sectionPath: "B", rank: 1 }] },
    ];
    const first = fuse(layers, config);
    const second = fuse(layers, config);
    expect(first[0]!.score).toBeCloseTo(first[1]!.score, 12);
    expect(first.map((f) => f.noteId)).toEqual(["aaa", "zzz"]); // tie → noteId asc
    expect(second).toEqual(first); // deterministic
  });

  it("breaks score ties by UTF-8 byte order, not UTF-16 code units (Unicode note ids)", () => {
    // "Ａ" (U+FF21, BMP) vs "\u{1F600}" (U+1F600, supplementary). By code
    // point / UTF-8 byte order U+FF21 < U+1F600, so FF21 sorts FIRST. JS string
    // `<` compares UTF-16 code units, where the emoji's lead surrogate 0xD83D
    // (55357) < 0xFF21 (65313) would WRONGLY sort the emoji first.
    const layers: LayerCandidates[] = [
      { layer: "fts", hits: [{ noteId: "\u{1F600}", sectionPath: "A", rank: 1 }] },
      { layer: "vector", hits: [{ noteId: "Ａ", sectionPath: "B", rank: 1 }] },
    ];
    const fused = fuse(layers, config);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 12); // equal scores → tie
    expect(fused.map((f) => f.noteId)).toEqual(["Ａ", "\u{1F600}"]); // UTF-8 order
  });

  it("respects config-owned weights (not hardcoded 1.0)", () => {
    const layers: LayerCandidates[] = [
      { layer: "fts", hits: [{ noteId: "n1", sectionPath: "A", rank: 1 }] },
      { layer: "vector", hits: [{ noteId: "n2", sectionPath: "B", rank: 1 }] },
    ];
    const fused = fuse(layers, { k: 60, weights: { fts: 0.1, vector: 5 } });
    // vector-weighted n2 must outrank fts-weighted n1.
    expect(fused[0]!.noteId).toBe("n2");
    expect(fused.find((f) => f.noteId === "n2")!.score).toBeCloseTo(5 / 61, 12);
    expect(fused.find((f) => f.noteId === "n1")!.score).toBeCloseTo(0.1 / 61, 12);
  });
});

// ---------------------------------------------------------------------------
// search.ts — over-fetch/paging (multi-chunk) + deterministic tie ordering.
// ---------------------------------------------------------------------------

describe("searchLayers over-fetches + orders deterministically (search.ts)", () => {
  /** A stub table whose vector query returns `rows` (in the given provider order),
   * sliced to the requested `.limit(n)`. Records every requested limit so paging is
   * observable. `_distance` drives relevance; a short page (< requested) signals
   * exhaustion, exactly like the real provider. */
  function stubVectorTable(rows: Record<string, unknown>[]): { table: SearchTable; limits: number[] } {
    const limits: number[] = [];
    // Mimic the real provider: `.limit(n)` returns the top-n BY RELEVANCE (ascending
    // `_distance`). Array.sort is stable, so the caller's input order controls ONLY the
    // arbitrary tie order among equal distances — exactly the provider's unspecified
    // tie behavior the deterministic-boundary logic must be robust to.
    const byRelevance = [...rows].sort((a, b) => (a._distance as number) - (b._distance as number));
    const table = {
      query() {
        let lim = Number.POSITIVE_INFINITY;
        const builder: Record<string, unknown> = {
          nearestTo: () => builder,
          fullTextSearch: () => builder,
          where: () => builder,
          select: () => builder,
          limit: (n: number) => {
            lim = n;
            limits.push(n);
            return builder;
          },
          toArray: async () => byRelevance.slice(0, lim),
        };
        return builder;
      },
    } as unknown as SearchTable;
    return { table, limits };
  }

  const chunk = (chunkId: string, noteId: string, distance: number): Record<string, unknown> => ({
    chunkId,
    noteId,
    sectionPath: chunkId,
    text: `text-${chunkId}`,
    generationId: "g-live",
    _distance: distance,
  });

  it("pages past a multi-chunk note so lower-ranked distinct notes still surface (finding: multi-chunk)", async () => {
    // "big" owns the top 20 chunks; "small" is a single chunk ranked below all of them.
    // A naive limit=k=2 CHUNK cap would return only big's chunks and hide small; the
    // note-level over-fetch must page until 2 distinct notes appear.
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i++) rows.push(chunk(`big-${String(i).padStart(2, "0")}`, "big", 0.01 * (i + 1)));
    rows.push(chunk("small-0", "small", 1)); // ranked last
    const { table, limits } = stubVectorTable(rows);

    const result = await searchLayers(table, {
      queryText: "x",
      queryVector: [0, 0, 0],
      activeGenerationIds: ["g-live"],
      limit: 2,
      ftsEnabled: false,
    });

    const notes = new Set(result.vector.map((h) => h.noteId));
    expect(notes).toEqual(new Set(["big", "small"])); // both distinct notes surfaced
    expect(Math.max(...limits)).toBeGreaterThan(2); // it over-fetched beyond k chunks
    expect(limits.length).toBeGreaterThan(1); // and paged (grew the fetch) at least once
  });

  it("equal distances rank by chunkId regardless of provider order (finding: unstable ties)", async () => {
    // Two notes, one chunk each, EQUAL distance — the provider may return them in any
    // order. The assigned ranks must be identical (chunkId secondary key) either way.
    const forward = stubVectorTable([chunk("a-chunk", "na", 0.5), chunk("z-chunk", "nz", 0.5)]);
    const reversed = stubVectorTable([chunk("z-chunk", "nz", 0.5), chunk("a-chunk", "na", 0.5)]);
    const input = {
      queryText: "x",
      queryVector: [0, 0, 0],
      activeGenerationIds: ["g-live"],
      limit: 10,
      ftsEnabled: false,
    } as const;

    const rf = await searchLayers(forward.table, input);
    const rr = await searchLayers(reversed.table, input);
    const ranksOf = (r: SearchLayersResult): [string, number][] => r.vector.map((h) => [h.chunkId, h.rank]);
    // "a-chunk" < "z-chunk" ⇒ rank 1 vs 2 in BOTH orderings.
    expect(ranksOf(rf)).toEqual([["a-chunk", 1], ["z-chunk", 2]]);
    expect(ranksOf(rr)).toEqual(ranksOf(rf));
  });

  it("pages PAST the old 4096-row cap to reach k distinct notes (finding: crowding beyond the cap)", async () => {
    // "big" owns 4100 chunks (better relevance than "small"), so the top 4096 rows are
    // ALL big — the removed hard cap would have stopped there and hidden "small". The
    // note-level paging must grow past 4096 until 2 distinct notes appear.
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 4100; i++) rows.push(chunk(`big-${String(i).padStart(4, "0")}`, "big", 0.0001 * (i + 1)));
    rows.push(chunk("small-0", "small", 1)); // 4101st row, worst relevance
    const { table, limits } = stubVectorTable(rows);

    const result = await searchLayers(table, {
      queryText: "x",
      queryVector: [0, 0, 0],
      activeGenerationIds: ["g-live"],
      limit: 2,
      ftsEnabled: false,
    });

    const notes = new Set(result.vector.map((h) => h.noteId));
    expect(notes).toEqual(new Set(["big", "small"])); // both surfaced despite crossing 4096
    expect(Math.max(...limits)).toBeGreaterThan(4096); // it grew past the old cap
  });

  it("equal-score ties straddling the fetch boundary select notes deterministically (finding: unstable ties)", async () => {
    // n_a (best) then a LARGE tie group of single-chunk notes at the SAME distance, then
    // a strictly-worse tail note. With limit=2 the 2nd slot must go to the smallest
    // chunkId in the tie group — regardless of provider order or where the initial fetch
    // window cut through the tie. The layer must grow until the tie group is fully
    // materialized so selection can't flip with the window.
    const tie: Record<string, unknown>[] = [];
    for (let i = 1; i <= 30; i++) tie.push(chunk(`t-${String(i).padStart(3, "0")}`, `n-${String(i).padStart(3, "0")}`, 0.5));
    const head = chunk("a", "n-a", 0.1);
    const tail = chunk("z", "n-z", 0.9); // strictly worse ⇒ proves the tie group is complete
    const input = {
      queryText: "x",
      queryVector: [0, 0, 0],
      activeGenerationIds: ["g-live"],
      limit: 2,
      ftsEnabled: false,
    } as const;

    const forward = stubVectorTable([head, ...tie, tail]);
    const reversed = stubVectorTable([tail, ...[...tie].reverse(), head]);
    const rf = await searchLayers(forward.table, input);
    const rr = await searchLayers(reversed.table, input);

    const notesOf = (r: SearchLayersResult): string[] => [...new Set(r.vector.map((h) => h.noteId))];
    // 2nd note is n-001 (smallest chunkId "t-001" in the tie), NOT whatever the window
    // happened to catch — and it is identical across provider orders.
    expect(notesOf(rf)).toEqual(["n-a", "n-001"]);
    expect(notesOf(rr)).toEqual(notesOf(rf));
    // n-z (strictly worse) is excluded: it lost the k=2 race.
    expect(notesOf(rf)).not.toContain("n-z");
  });
});

// ---------------------------------------------------------------------------
// 4/5. Real store + LanceDB: provenance persistence + FTS fallback isolation.
// ---------------------------------------------------------------------------

describe("layered retrieval over a real store + LanceDB", () => {
  let store: Store;
  let db: lancedb.Connection;
  let table: SearchTable;
  let dir: string;
  let cap: ReturnType<typeof captureRecorder>;

  function insertNoteRow(id: string, contentHash: string): void {
    store.db
      .prepare(
        `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
         VALUES (@id, @id, @id, 'concept', 1, 'active', @path, @hash, '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z')`,
      )
      .run({ id, path: `${id}.md`, hash: contentHash });
  }

  function makeNote(id: string, body: string, contentHash: string): ParsedNote {
    return {
      id,
      path: `${id}.md`,
      type: "concept",
      schemaVersion: 1,
      title: id,
      status: "active",
      created: "2026-07-12T00:00:00Z",
      updated: "2026-07-12T00:00:00Z",
      aliases: [],
      sources: [],
      declaredSensitivity: "internal",
      links: [],
      sections: { heading: "", level: 0, path: "", children: [] },
      contentHash,
      raw: body,
    };
  }

  /** Chunk, embed (with a caller-supplied vector), write, and activate a note. */
  async function indexNote(id: string, body: string, hash: string, embedding: number[]): Promise<void> {
    insertNoteRow(id, hash);
    const note = makeNote(id, body, hash);
    const chunks = chunkNote(note, CFG);
    const gen = generationId(note, CFG);
    const rows = assembleRows(chunks, chunks.map(() => embedding), CFG, gen);
    await writeGeneration(table, rows);
    store.generation.adoptConfig(indexingConfigKey(CFG));
    const ok = store.activateGeneration(id, gen, hash, indexingConfigKey(CFG));
    expect(ok).toBe(true);
  }

  const noteMeta = (id: string): NoteMeta =>
    id === "beta"
      ? { type: "concept", sensitivity: "confidential", trust: "unverified" }
      : { type: "concept", sensitivity: "internal", trust: "verified" };

  beforeEach(async () => {
    store = openStore({ path: ":memory:" });
    registerGenerationMigration(store);
    store.migrate();
    dir = await mkdtemp(join(tmpdir(), "atlas-retrieval-"));
    db = await lancedb.connect(dir);
    table = await openSearchTable(db, CFG);
    cap = captureRecorder();
  });

  afterEach(async () => {
    store.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function storeDeps(over: Partial<RetrievalDeps> = {}): RetrievalDeps {
    return makeDeps({
      table,
      activeGenerationIds: () => store.generation.activeGenerationIds(),
      activeGenerationId: (noteId) => store.generation.activeGenerationId(noteId),
      noteMeta,
      // Capture the produced records (the in-memory seam) — the retrieval module never
      // writes ledger tables itself; §2.8's finalizeLedgerWrite is Task 3.4's job.
      recorder: cap.recorder,
      config: { rrf: { k: 60, weights: { fts: 1, vector: 1 } }, fts: { enabled: false } },
      ...over,
    });
  }

  it("vector layer returns active-gen-filtered notes and PRODUCES fused-rank provenance (retained 0001_core)", async () => {
    await indexNote("alpha", "alpha content about meridian", "h-alpha", [1, 0, 0]);
    await indexNote("beta", "beta content about atlas", "h-beta", [0, 1, 0]);

    // FTS disabled → vector-only fallback; query vector closest to alpha.
    const deps = storeDeps({
      embed: async () => ({ ok: true, vectors: [[1, 0, 0]] }),
      newRetrievalId: () => "rr-real-1",
    });
    const r = await retrieve({ text: "meridian" }, deps);

    expect(r.degraded).toBe(true);
    expect(r.layersUsed).toEqual(["vector"]);
    expect(r.mode).toBe("vector");
    expect(r.items.map((i) => i.noteId)).toEqual(["alpha", "beta"]); // alpha nearer [1,0,0]
    expect(r.items[0]!.contributions).toEqual([{ layer: "vector", rank: 1, weightedContribution: 1 / 61 }]);
    // Sensitivity pass-through + trust flag surfaced.
    expect(r.items.find((i) => i.noteId === "beta")!.sensitivity).toBe("confidential");
    expect(r.items.find((i) => i.noteId === "beta")!.trust).toBe("unverified");

    // The produced run record (retained schema shape).
    const run = cap.runs[0]!;
    expect(run.retrievalId).toBe("rr-real-1");
    expect(run.mode).toBe("vector");
    expect(run.indexGeneration).toBe(1);
    expect(run.queryText).toBe("meridian");
    // One row per fused note; rank = 1-based FUSED rank (NOT a physical sequence).
    const results = cap.results[0]!.map((x) => ({ rank: x.rank, note_id: x.noteId, channel: x.channel }));
    expect(results).toEqual([
      { rank: 1, note_id: "alpha", channel: "vector" },
      { rank: 2, note_id: "beta", channel: "vector" },
    ]);
  });

  it("a --type filter restricts the candidate set (metadata filter)", async () => {
    await indexNote("alpha", "alpha content", "h-alpha", [1, 0, 0]);
    await indexNote("beta", "beta content", "h-beta", [0, 1, 0]);
    const deps = storeDeps({
      embed: async () => ({ ok: true, vectors: [[1, 0, 0]] }),
      noteMeta: (id) => ({ type: id === "alpha" ? "concept" : "source", sensitivity: "internal", trust: "verified" }),
    });
    const r = await retrieve({ text: "x", filters: { type: "concept" } }, deps);
    expect(r.items.map((i) => i.noteId)).toEqual(["alpha"]); // beta (type=source) filtered out
  });

  it("FTS-maturity fallback (§6) isolated in search.ts: fts.enabled=false ⇒ vector-only, no FTS query", async () => {
    await indexNote("alpha", "alpha content", "h-alpha", [1, 0, 0]);
    const result = await searchLayers(table, {
      queryText: "alpha",
      queryVector: [1, 0, 0],
      activeGenerationIds: store.generation.activeGenerationIds(),
      limit: 10,
      ftsEnabled: false,
    });
    expect(result.fts).toBeNull(); // FTS layer dropped by the config switch
    expect(result.degraded).toBe(true);
    expect(result.layersUsed).toEqual(["vector"]);
    expect(result.vector.map((h) => h.noteId)).toEqual(["alpha"]);
  });

  it("FTS-maturity fallback (§6): a THROWN FTS query is caught in search.ts and degrades — the error never escapes", async () => {
    // A stub table whose FTS query throws (immaturity: no index / unsupported).
    // Only search.ts sees the throw; the caller gets vector-only + degraded=true.
    const stub = {
      query() {
        const builder = {
          nearestTo: () => builder,
          fullTextSearch: () => {
            throw new Error("no inverted index for column 'text'");
          },
          where: () => builder,
          select: () => builder,
          limit: () => builder,
          toArray: async () => [] as unknown[],
        };
        return builder;
      },
    } as unknown as SearchTable;
    const result = await searchLayers(stub, {
      queryText: "x",
      queryVector: [0, 0, 0],
      activeGenerationIds: ["g-live"],
      limit: 5,
      ftsEnabled: true,
    });
    expect(result.fts).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.layersUsed).toEqual(["vector"]);
  });

  it("hybrid fusion + provenance via an injected search seam (both layers participate)", async () => {
    // Inject a search result so the hybrid path is exercised deterministically without
    // depending on LanceDB FTS maturity. Fusion + persistence are the module's own.
    const fakeSearch = async (): Promise<SearchLayersResult> => ({
      vector: [
        { noteId: "alpha", sectionPath: "A", chunkId: "c1", text: "alpha body", generationId: "g", rank: 1 },
        { noteId: "beta", sectionPath: "B", chunkId: "c2", text: "beta body", generationId: "g", rank: 2 },
      ],
      fts: [{ noteId: "alpha", sectionPath: "A", chunkId: "c1", text: "alpha body", generationId: "g", rank: 1 }],
      degraded: false,
      layersUsed: ["fts", "vector"],
    });
    const deps = storeDeps({
      config: { rrf: { k: 60, weights: { fts: 1, vector: 1 } }, fts: { enabled: true } },
      activeGenerationIds: () => ["g"], // non-empty live set so the fake search runs
      embed: async () => ({ ok: true, vectors: [[0, 0, 1]] }),
      search: fakeSearch,
      newRetrievalId: () => "rr-hybrid",
    });
    const r = await retrieve({ text: "x" }, deps);
    expect(r.mode).toBe("hybrid");
    expect(r.layersUsed).toEqual(["fts", "vector"]);
    // alpha surfaced by both layers → 2 contributions, and it outranks beta.
    expect(r.items[0]!.noteId).toBe("alpha");
    expect(r.items[0]!.contributions.map((c) => c.layer).sort()).toEqual(["fts", "vector"]);
    const results = cap.results[0]!.map((x) => ({ rank: x.rank, note_id: x.noteId, channel: x.channel }));
    // One row per fused note, rank = 1-based fused rank; alpha's dominant channel is
    // fts (contributions tie, LAYER_ORDER breaks it fts-first).
    expect(results[0]).toMatchObject({ rank: 1, note_id: "alpha", channel: "fts" });
    expect(results.every((x) => x.channel === "fts" || x.channel === "vector")).toBe(true);
  });

  it("a hybrid (fts+vector) note lands ONE row at its fused rank; full per-layer provenance stays in the result (finding)", async () => {
    // Retained-schema resolution: PK (retrieval_id, rank) + a scalar `channel` enum
    // (no `hybrid`) ⇒ exactly one row per fused rank. `rank` is the 1-based FUSED rank,
    // NOT a physical row sequence; `channel` is the dominant contributing channel. The
    // FULL per-layer taxonomy lives in the returned RankedItem.contributions[] (§5).
    const fakeSearch = async (): Promise<SearchLayersResult> => ({
      vector: [
        { noteId: "alpha", sectionPath: "A", chunkId: "c1", text: "a", generationId: "g", rank: 1 },
        { noteId: "beta", sectionPath: "B", chunkId: "c2", text: "b", generationId: "g", rank: 2 },
      ],
      fts: [{ noteId: "alpha", sectionPath: "A", chunkId: "c1", text: "a", generationId: "g", rank: 1 }],
      degraded: false,
      layersUsed: ["fts", "vector"],
    });
    const deps = storeDeps({
      config: { rrf: { k: 60, weights: { fts: 1, vector: 1 } }, fts: { enabled: true } },
      activeGenerationIds: () => ["g"],
      embed: async () => ({ ok: true, vectors: [[0, 0, 1]] }),
      search: fakeSearch,
      newRetrievalId: () => "rr-both",
    });
    const r = await retrieve({ text: "x" }, deps);
    // The RETURNED result keeps the full numeric per-layer provenance (contract §5).
    expect(r.items[0]!.contributions.map((c) => c.layer).sort()).toEqual(["fts", "vector"]);

    // The PRODUCED rows: alpha → one row (fused rank 1), beta → one row (fused rank 2).
    const rows = cap.results[0]!;
    expect(rows.map((x) => x.rank)).toEqual([1, 2]); // 1-based fused ranks, one per note
    expect(rows.map((x) => x.noteId)).toEqual(["alpha", "beta"]); // fused order (alpha outranks beta)
    // alpha's dominant channel is fts (its two contributions tie, LAYER_ORDER → fts).
    expect(rows[0]!.channel).toBe("fts");
    expect(rows[1]!.channel).toBe("vector");
    // Each row carries its note's fused RRF score.
    expect(rows[0]!.score).toBeCloseTo(r.items[0]!.score, 12);
  });

  it("empty active-generation set serves nothing, reports layersUsed=[] and a consistent mode (finding)", async () => {
    const deps = storeDeps({ embed: async () => ({ ok: true, vectors: [[1, 0, 0]] }), newRetrievalId: () => "rr-empty" });
    const r = await retrieve({ text: "nothing indexed" }, deps);
    expect(r.items).toHaveLength(0);
    expect(r.layersUsed).toEqual([]); // NO layer participated — not reported as fts/vector
    const run = cap.runs[0]!;
    expect(run).toBeTruthy();
    expect(run.mode).toBe(r.mode); // produced mode matches the returned mode (consistent)
    expect(cap.results[0]).toEqual([]); // nothing served ⇒ no result rows
  });
});

// ---------------------------------------------------------------------------
// Missing metadata fails CLOSED (never fail-open verified/internal).
// ---------------------------------------------------------------------------

describe("missing note metadata defaults conservatively (finding)", () => {
  it("null metadata ⇒ trust unverified + most-restrictive sensitivity, not verified/internal", async () => {
    const deps = makeDeps({
      resolver: fakeResolver({ exact: { "concept-atlas": "concept-atlas" } }),
      activeGenerationId: () => null, // no live chunks → identity note packs zero sections
      table: {} as unknown as SearchTable,
      noteMeta: () => null, // projection missing for this note
    });
    const r = await retrieve({ text: "concept-atlas" }, deps);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.trust).toBe("unverified"); // fail closed, NOT "verified"
    expect(r.items[0]!.sensitivity).toBe("restricted"); // most restrictive, NOT "internal"
  });
});

// ---------------------------------------------------------------------------
// Query-embed failure surfaces as a typed error.
// ---------------------------------------------------------------------------

describe("query embed failure surfaces as a typed QueryEmbedError", () => {
  it("maps a retryable provider fault to embedding-retryable", async () => {
    const deps = makeDeps({
      activeGenerationIds: () => ["g1"],
      embed: async () => ({ ok: false, retryable: true, kind: "rate_limit", message: "slow down", retryAfterMs: 500 }),
    });
    const err = await retrieve({ text: "x" }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryEmbedError);
    expect((err as QueryEmbedError).code).toBe("embedding-retryable");
    expect((err as QueryEmbedError).retryAfterMs).toBe(500);
  });

  it("maps a permanent provider fault to embedding-failed", async () => {
    const deps = makeDeps({
      activeGenerationIds: () => ["g1"],
      embed: async () => ({ ok: false, retryable: false, kind: "authentication", message: "bad key" }),
    });
    const err = await retrieve({ text: "x" }, deps).catch((e: unknown) => e);
    expect((err as QueryEmbedError).code).toBe("embedding-failed");
  });
});

// ---------------------------------------------------------------------------
// 6. Context packing.
// ---------------------------------------------------------------------------

describe("packContext — dedup by note, section-aware, trust surfaced, budget-bounded", () => {
  function res(items: Array<{ noteId: string; trust: "verified" | "unverified"; sensitivity: string; sections: Array<{ sectionPath: string; text: string }> }>) {
    return {
      items: items.map((i) => ({
        noteId: i.noteId,
        sectionPath: i.sections[0]?.sectionPath ?? "",
        score: 1,
        contributions: [{ layer: "vector" as const, rank: 1, weightedContribution: 1 }],
        sensitivity: i.sensitivity,
        trust: i.trust,
        sections: i.sections,
      })),
      layersUsed: ["vector" as const],
      retrievalRunId: "rr",
      mode: "vector" as const,
      degraded: true,
    };
  }

  it("packs sections section-by-section, dedups by note, and surfaces the trust flag", () => {
    const r = res([
      { noteId: "n1", trust: "verified", sensitivity: "internal", sections: [{ sectionPath: "A", text: "alpha" }, { sectionPath: "B", text: "bravo" }] },
      { noteId: "n2", trust: "unverified", sensitivity: "confidential", sections: [{ sectionPath: "C", text: "charlie" }] },
    ]);
    const pack = packContext(r, { maxTokens: 1000 });
    expect(pack.notes.map((n) => n.noteId)).toEqual(["n1", "n2"]);
    expect(pack.notes[0]!.sections.map((s) => s.sectionPath)).toEqual(["A", "B"]);
    // Surfaced-but-unverified: n2 is INCLUDED but flagged.
    expect(pack.notes[1]!.trust).toBe("unverified");
    expect(pack.notes[1]!.sensitivity).toBe("confidential");
    expect(pack.truncated).toBe(false);
  });

  it("rejects a non-finite or negative token budget instead of packing unbounded (finding)", () => {
    // NaN/±Infinity would make `totalTokens + tokens > maxTokens` always false,
    // silently disabling the bound; a negative budget is nonsense. All must throw
    // a typed validation error, never pack.
    const r = res([{ noteId: "n1", trust: "verified", sensitivity: "internal", sections: [{ sectionPath: "A", text: "alpha" }] }]);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5]) {
      const err = (() => {
        try {
          packContext(r, { maxTokens: bad });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err, `maxTokens=${bad} must throw`).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("invalid-token-budget");
    }
    // The boundary value 0 is valid (packs nothing).
    expect(packContext(r, { maxTokens: 0 }).notes).toEqual([]);
  });

  it("truncates at the token budget without splitting a section", () => {
    const r = res([
      { noteId: "n1", trust: "verified", sensitivity: "internal", sections: [{ sectionPath: "A", text: "x".repeat(40) }] }, // ~10 tokens
      { noteId: "n2", trust: "verified", sensitivity: "internal", sections: [{ sectionPath: "B", text: "y".repeat(40) }] },
    ]);
    const pack = packContext(r, { maxTokens: 10 }); // room for exactly one section
    expect(pack.notes.map((n) => n.noteId)).toEqual(["n1"]);
    expect(pack.truncated).toBe(true);
    expect(pack.totalTokens).toBeLessThanOrEqual(10);
  });

  it("commits a note's fitted sections when a LATER section overflows; totals == sum of packed (finding)", () => {
    // First section fits, second overflows the same note. The fitted section must be
    // COMMITTED (note not dropped), and totalTokens must equal the packed content only.
    const r = res([
      {
        noteId: "n1",
        trust: "verified",
        sensitivity: "internal",
        sections: [
          { sectionPath: "A", text: "x".repeat(20) }, // ~5 tokens (fits)
          { sectionPath: "B", text: "y".repeat(400) }, // ~100 tokens (overflows)
        ],
      },
      { noteId: "n2", trust: "verified", sensitivity: "internal", sections: [{ sectionPath: "C", text: "z" }] },
    ]);
    const pack = packContext(r, { maxTokens: 10 }); // room for A only
    expect(pack.notes.map((n) => n.noteId)).toEqual(["n1"]); // n1 committed, not dropped
    expect(pack.notes[0]!.sections.map((s) => s.sectionPath)).toEqual(["A"]); // only the fitted section
    expect(pack.truncated).toBe(true);
    // The invariant the finding demands: totals equal the sum of actually-packed content.
    const packedSum = pack.notes.reduce((s, n) => s + n.sections.reduce((t, sec) => t + sec.tokens, 0), 0);
    expect(pack.totalTokens).toBe(packedSum);
    expect(pack.notes[0]!.tokens).toBe(pack.totalTokens);
  });

  it("dedups a note that appears twice in the items list", () => {
    const r = res([
      { noteId: "dup", trust: "verified", sensitivity: "internal", sections: [{ sectionPath: "A", text: "a" }] },
      { noteId: "dup", trust: "verified", sensitivity: "internal", sections: [{ sectionPath: "B", text: "b" }] },
    ]);
    const pack = packContext(r, { maxTokens: 1000 });
    expect(pack.notes).toHaveLength(1);
    expect(pack.notes[0]!.sections.map((s) => s.sectionPath)).toEqual(["A"]);
  });
});
