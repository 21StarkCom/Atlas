/**
 * `pagination.contract.test` — the Task 2.9 pagination CONTRACT (the load-bearing
 * part). Proves, across the four paginated read commands (`source list`,
 * `note related`, `note history`; `git status` retired v2, #333):
 *
 *  1. DETERMINISTIC ordering with a UNIQUE tie-breaker — rows sharing the primary
 *     sort key are ordered by the unique secondary key, so offset pagination is
 *     stable (no row swaps a page boundary because of a tie).
 *  2. OUT-OF-RANGE offset/limit ⇒ exit 5 (`--limit` ∉ [1,500], `--offset` < 0, and
 *     a positive `--offset` at/beyond `total`).
 *  3. STABLE JSON schemas — every `--json` success validates against the committed
 *     `docs/specs/cli-contract/*.schema.json`.
 *  4. CONCURRENT-INSERT anomaly BOUND — under an insert between page reads, a full
 *     walk duplicates/omits at most as many rows as were inserted (best-effort
 *     under concurrency, plan §2.5).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../src/main.js";
import { openStore, rebuildProjections, SourceRepo, type Store } from "@atlas/sqlite-store";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { traverseRelated } from "../src/commands/note.js";
import {
  parseLimit,
  parseOffset,
  assertOffsetInRange,
  buildPagination,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../src/commands/pagination.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  errorsText: (e?: unknown) => string;
};

function validateSchema(name: string, value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${name} failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, env, { cwd, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** 64-hex content hash from a small ordinal (deterministic, unique). */
const hash = (n: number): string => n.toString(16).padStart(64, "0");
const iso = (n: number): string => `2026-07-13T10:00:${String(n % 60).padStart(2, "0")}.000Z`;
// A valid ULID (26 Crockford chars, first ≤ 7) that sorts by n via its numeric suffix.
const ulid = (n: number): string => `01J9Z8Q${"0".repeat(17)}${String(n).padStart(2, "0")}`;
/** The deterministic `source` id `seedSource(n)` writes (matches its `src-NN`). */
const sid = (n: number): string => `src-${String(n).padStart(2, "0")}`;

/** Seed a v2 `source` registry row (id `src-NN`, unique locator, given addedAt). */
function seedSource(store: Store, n: number, addedAt: string): void {
  new SourceRepo(store.db).insert({
    id: `src-${String(n).padStart(2, "0")}`,
    kind: "file",
    locator: `sources/${n}.txt`,
    title: `source ${n}`,
    addedAt,
  });
}

/** Seed an open agent run. */
function seedOpenRun(store: Store, n: number, updatedAt: string): void {
  store.ledger.upsertAgentRun({ run_id: ulid(n), operation: "ingest", status: "planned", tier: ((n % 3) + 1), target_note_id: null, started_at: updatedAt, updated_at: updatedAt });
}

beforeEach(() => {
  root = mkdtempSync(join("/tmp", "atlas-pg-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(join(cwd, "vault"), { recursive: true });
  const config = [
    "vault:", `  path: ${join(cwd, "vault")}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1" };
  dbPath = join(cwd, ".atlas", "atlas.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pagination helper (unit)", () => {
  it("limit default 50 / max 500; out-of-range limit ⇒ usage", () => {
    expect(DEFAULT_LIMIT).toBe(50);
    expect(MAX_LIMIT).toBe(500);
    expect(parseLimit("c", "1")).toBe(1);
    expect(parseLimit("c", "500")).toBe(500);
    for (const bad of ["0", "501", "-1", "1.5", "x"]) {
      expect(() => parseLimit("c", bad), bad).toThrow();
    }
  });

  it("offset ≥ 0; negatives/non-integers ⇒ usage", () => {
    expect(parseOffset("c", "0")).toBe(0);
    for (const bad of ["-1", "1.5", "x"]) expect(() => parseOffset("c", bad), bad).toThrow();
  });

  it("offset rejects lexically-malformed values Number() would silently coerce", () => {
    // `Number("")` is 0, `Number("1e2")` is 100, `Number("0x10")` is 16, and
    // whitespace is ignored — all must be usage errors, not silent acceptances.
    for (const bad of ["", " ", "1e2", "1E2", "0x10", "0b10", "0o10", " 5", "5 ", "+", "Infinity", "NaN", "1_000"]) {
      expect(() => parseOffset("c", bad), JSON.stringify(bad)).toThrow();
    }
    // limit shares the same strict lexical parser.
    for (const bad of ["", "1e2", "0x10", " 5"]) expect(() => parseLimit("c", bad), JSON.stringify(bad)).toThrow();
    // well-formed decimals still parse (incl. an explicit +).
    expect(parseOffset("c", "42")).toBe(42);
    expect(parseOffset("c", "+7")).toBe(7);
  });

  it("assertOffsetInRange: offset 0 always valid; positive offset ≥ total ⇒ usage", () => {
    expect(() => assertOffsetInRange("c", 0, 0)).not.toThrow();
    expect(() => assertOffsetInRange("c", 0, 10)).not.toThrow();
    expect(() => assertOffsetInRange("c", 9, 10)).not.toThrow();
    expect(() => assertOffsetInRange("c", 10, 10)).toThrow();
    expect(() => assertOffsetInRange("c", 1, 0)).toThrow();
  });

  it("hasMore is derived from ACTUAL rows, not offset+limit", () => {
    expect(buildPagination({ limit: 50, offset: 0 }, 1, 1).hasMore).toBe(false);
    expect(buildPagination({ limit: 2, offset: 0 }, 5, 2).hasMore).toBe(true);
    expect(buildPagination({ limit: 50, offset: 4 }, 5, 1).hasMore).toBe(false);
  });
});

describe("jobs list routes through the shared pagination contract (SP-1 Phase 6 fix-forward)", () => {
  it("the handler source consumes parseLimit/parseOffset/assertOffsetInRange — no bare Number() pagination", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dirname, "..", "src", "commands", "jobs.ts"), "utf8");
    expect(src).toMatch(/parseLimit\("jobs list"/);
    expect(src).toMatch(/parseOffset\("jobs list"/);
    expect(src).toMatch(/assertOffsetInRange\("jobs list"/);
    // The old divergence: a bare Number() on the pagination values.
    expect(src).not.toMatch(/limit = Number\(/);
    expect(src).not.toMatch(/offset = Number\(/);
  });
});

describe("deterministic ordering + unique tie-breaker", () => {
  it("source list: ties on addedAt broken by id (ascending), stable across offset", async () => {
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: dbPath });
    try {
      const repo = new SourceRepo(store.db);
      // All share the SAME addedAt → the v2 tie-breaker (id ASC) decides order.
      for (const n of [5, 1, 3, 2, 4]) seedSource(store, n, iso(0));
      expect(repo.count()).toBe(5);
      const ids = repo.list({ limit: 50, offset: 0 }).map((r) => r.id);
      expect(ids).toEqual([...ids].sort()); // id ascending (the total-order tie-breaker)
      // Page boundary is stable: page1 ++ page2 ++ page3 === full order, no dup/skip.
      const p1 = repo.list({ limit: 2, offset: 0 }).map((r) => r.id);
      const p2 = repo.list({ limit: 2, offset: 2 }).map((r) => r.id);
      const p3 = repo.list({ limit: 2, offset: 4 }).map((r) => r.id);
      expect([...p1, ...p2, ...p3]).toEqual(ids);
    } finally {
      store.close();
    }
  });


  it("note related: ordered by (distance asc, noteId asc), each noteId once", async () => {
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: dbPath });
    try {
      const mkNote = (id: string) => store.projections.insertNote({ note_id: id, slug: id, title: id, type: "concept", schema_version: 1, status: "active", file_path: `${id}.md`, content_hash: `sha256:${hash(1)}`, created: iso(0), updated: iso(0) });
      ["seed", "a", "b", "c", "d"].forEach(mkNote);
      // seed → a (link), seed → b (relationship), a → c, and d → seed (backlink).
      store.projections.insertLink({ source_note_id: "seed", target_note_id: "a", predicate: "references", ordinal: 0 });
      store.projections.insertLink({ source_note_id: "seed", target_note_id: "b", predicate: "depends-on", ordinal: 1 });
      store.projections.insertLink({ source_note_id: "a", target_note_id: "c", predicate: "references", ordinal: 0 });
      store.projections.insertLink({ source_note_id: "d", target_note_id: "seed", predicate: "references", ordinal: 0 });
      const related = traverseRelated(store.db, "seed", 2);
      // distance-1: a(link), b(relationship), d(backlink); distance-2: c.
      expect(related.map((r) => [r.noteId, r.distance])).toEqual([
        ["a", 1], ["b", 1], ["d", 1], ["c", 2],
      ]);
      const byId = new Set(related.map((r) => r.noteId));
      expect(byId.size).toBe(related.length); // each noteId at most once
      expect(related.find((r) => r.noteId === "b")?.predicate).toBe("depends-on");
      expect(related.find((r) => r.noteId === "d")?.via).toBe("backlink");
    } finally {
      store.close();
    }
  });

  it("pre-0013 frontier: the synthetic DEFAULT_LINK_PREDICATE is via=link; typed predicates stay relationships", async () => {
    // Regression (round-3 finding): `note related` must stay readable against a
    // valid PRE-0013 database, where plain links carry the synthetic
    // "references" predicate (the v1 schema had predicate NOT NULL — NULL could
    // not occur). Classifying on nullability alone would emit those plain links
    // as via="relationship". Post-0013, migrated "references" rows are
    // deliberately typed edges — covered by the v2 test below.
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: dbPath });
    try {
      // Simulate the pre-0013 frontier honestly: un-record 0013 and restore the
      // v1 note_links shape (3-col PK, predicate NOT NULL).
      store.db.exec(`
        DELETE FROM db_schema_migrations WHERE id = '0013_links_v2';
        DROP TABLE note_links;
        CREATE TABLE note_links (
          source_note_id TEXT NOT NULL,
          target_note_id TEXT NOT NULL,
          predicate TEXT NOT NULL,
          PRIMARY KEY (source_note_id, target_note_id, predicate)
        );
        INSERT INTO note_links VALUES ('vseed', 'vplain', 'references');
        INSERT INTO note_links VALUES ('vseed', 'vtyped', 'supports');
      `);

      const related = traverseRelated(store.db, "vseed", 1);
      const plain = related.find((r) => r.noteId === "vplain");
      expect(plain?.via).toBe("link");
      expect(plain?.predicate).toBeUndefined();
      const typed = related.find((r) => r.noteId === "vtyped");
      expect(typed?.via).toBe("relationship");
      expect(typed?.predicate).toBe("supports");
    } finally {
      store.close();
    }
  });

  it("rebuild → note related: a plain [[wikilink]] (predicate NULL) is via=link, never a null-predicate relationship", async () => {
    // Regression (0013 v2 shape): `rebuildProjections` stores a parsed
    // `[[wikilink]]` with predicate NULL. `traverseRelated` MUST classify a NULL
    // predicate as a PLAIN link (via "link", no `predicate`) — not via
    // "relationship" with `predicate: null`, which violates the note-related JSON
    // schema (predicate is a string, only present when via=relationship).
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: dbPath });
    try {
      const mkNote = (id: string, links: ParsedNote["links"]): ParsedNote => ({
        id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
        created: iso(0), updated: iso(0), aliases: [], sources: [], declaredSensitivity: "internal",
        links, relationships: [], sections: { heading: "", level: 0, path: "", children: [] },
        contentHash: `sha256:${hash(1)}`, raw: `# ${id}\n`,
      });
      // `pseed` plainly wiki-links `ptarget` (with a display alias) — no predicate.
      const snapshot: VaultSnapshot = {
        notes: [
          mkNote("pseed", [{ target: "ptarget", alias: "The Target", raw: "[[ptarget|The Target]]" }]),
          mkNote("ptarget", []),
        ],
        errors: [],
      };
      rebuildProjections(store.db, snapshot);

      // The persisted link carries a NULL predicate (the v2 plain-link shape).
      const row = store.db
        .prepare(`SELECT predicate, alias FROM note_links WHERE source_note_id = 'pseed' AND target_note_id = 'ptarget'`)
        .get() as { predicate: string | null; alias: string | null };
      expect(row.predicate).toBeNull();
      expect(row.alias).toBe("The Target");

      const related = traverseRelated(store.db, "pseed", 1);
      const edge = related.find((r) => r.noteId === "ptarget");
      expect(edge?.via).toBe("link");
      expect(edge?.predicate).toBeUndefined();

      // The full `note related` --json envelope validates against the committed schema
      // (a `predicate: null` on a via="link" entry would fail `predicate: string`).
      const r = await cli(["note", "related", "pseed", "--json"]);
      expect(r.code, r.out).toBe(0);
      const out = JSON.parse(r.out);
      validateSchema("note-related", out);
      expect(out.related.find((e: { noteId: string }) => e.noteId === "ptarget")).toEqual({
        noteId: "ptarget", via: "link", distance: 1,
      });
    } finally {
      store.close();
    }
  });
});

describe("out-of-range bounds ⇒ exit 5 (via the CLI)", () => {
  beforeEach(async () => {
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: dbPath });
    try {
      for (const n of [1, 2, 3] as const) seedSource(store, n, iso(n));
    } finally {
      store.close();
    }
  });

  it("--limit 0 / 501 and --offset -1 are usage errors", async () => {
    for (const args of [["--limit", "0"], ["--limit", "501"], ["--offset", "-1"]]) {
      const r = await cli(["source", "list", ...args, "--json"]);
      expect(r.code, JSON.stringify(args)).toBe(5);
      expect(JSON.parse(r.out).code).toBe("usage");
    }
  });

  it("--offset at/beyond total is a usage error (out-of-range)", async () => {
    const r = await cli(["source", "list", "--offset", "3", "--json"]); // total=3 → offsets 0..2
    expect(r.code).toBe(5);
    expect(JSON.parse(r.out).code).toBe("usage");
  });

  it("lexically-malformed --offset (empty / exponential / hex) ⇒ exit 5, not silent 0", async () => {
    for (const flag of ["--offset=", "--offset=1e2", "--offset=0x10", "--offset= "]) {
      const r = await cli(["source", "list", flag, "--json"]);
      expect(r.code, `${flag}: ${r.out}`).toBe(5);
      expect(JSON.parse(r.out).code).toBe("usage");
    }
  });
});

describe("command-level pagination bounds (all four commands, via the CLI)", () => {
  // Each entry: how to invoke the command with the given pagination flags + a
  // `total` that a positive out-of-range offset must exceed to trigger exit 5.
  const seed = (): void => {
    const store = openStore({ path: dbPath });
    try {
      for (const n of [1, 2, 3] as const) seedSource(store, n, iso(n)); // source list total=3
      // note related: a seed note linking to 3 others (related total=3).
      const mk = (id: string) => store.projections.insertNote({ note_id: id, slug: id, title: id, type: "concept", schema_version: 1, status: "active", file_path: `${id}.md`, content_hash: `sha256:${hash(1)}`, created: iso(0), updated: iso(0) });
      ["rseed", "r1", "r2", "r3"].forEach(mk);
      ["r1", "r2", "r3"].forEach((t, i) => store.projections.insertLink({ source_note_id: "rseed", target_note_id: t, predicate: "references", ordinal: i }));
      // note history: a note with 3 runs targeting it (history total=3). v2 (#338):
      // note history projects one entry per `agent_runs` row (audit ledger retired).
      mk("hseed");
      for (const n of [1, 2, 3]) store.ledger.upsertAgentRun({ run_id: ulid(n), operation: "ingest", status: "integrated", tier: 1, target_note_id: "hseed", started_at: iso(0), updated_at: iso(0), finished_at: iso(0) });
    } finally {
      store.close();
    }
  };
  const COMMANDS: { name: string; argv: (flags: string[]) => string[] }[] = [
    { name: "source list", argv: (f) => ["source", "list", ...f, "--json"] },
    { name: "note related", argv: (f) => ["note", "related", "rseed", ...f, "--json"] },
    { name: "note history", argv: (f) => ["note", "history", "hseed", ...f, "--json"] },
  ];

  beforeEach(async () => {
    await cli(["db", "migrate", "--json"]);
    seed();
  });

  for (const c of COMMANDS) {
    it(`${c.name}: --limit 0/501 and --offset -1 ⇒ exit 5 usage`, async () => {
      for (const flags of [["--limit", "0"], ["--limit", "501"], ["--offset", "-1"]]) {
        const r = await cli(c.argv(flags));
        expect(r.code, `${c.name} ${JSON.stringify(flags)}: ${r.out}`).toBe(5);
        expect(JSON.parse(r.out).code).toBe("usage");
      }
    });
    it(`${c.name}: --offset at/beyond total (3) ⇒ exit 5 usage`, async () => {
      const r = await cli(c.argv(["--offset", "3"]));
      expect(r.code, `${c.name}: ${r.out}`).toBe(5);
      expect(JSON.parse(r.out).code).toBe("usage");
    });
    it(`${c.name}: in-range page reports total=3 + hasMore`, async () => {
      const r = await cli(c.argv(["--limit", "2", "--offset", "0"]));
      expect(r.code, r.out).toBe(0);
      const p = JSON.parse(r.out).pagination;
      expect(p).toMatchObject({ limit: 2, offset: 0, total: 3, hasMore: true });
    });
  }
});

describe("note history: seq-DESC ordering is stable across page boundaries", () => {
  beforeEach(async () => {
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "hist", slug: "hist", title: "H", type: "concept", schema_version: 1, status: "active", file_path: "hist.md", content_hash: `sha256:${hash(1)}`, created: iso(0), updated: iso(0) });
      // v2 (#338): 5 runs target the note; created_at DELIBERATELY constant so ordering
      // rests on the unique monotonic seq (agent_runs.rowid) tie-breaker.
      for (const n of [1, 2, 3, 4, 5]) store.ledger.upsertAgentRun({ run_id: ulid(n), operation: "ingest", status: "integrated", tier: 1, target_note_id: "hist", started_at: iso(0), updated_at: iso(0), finished_at: iso(0) });
    } finally {
      store.close();
    }
  });

  it("full page is seq DESC; page1++page2++page3 === full order (no dup/skip)", async () => {
    const seqs = async (flags: string[]): Promise<number[]> => {
      const r = await cli(["note", "history", "hist", ...flags, "--json"]);
      expect(r.code, r.out).toBe(0);
      return JSON.parse(r.out).events.map((e: { seq: number }) => e.seq);
    };
    const full = await seqs(["--limit", "50"]);
    expect(full.length).toBe(5);
    // Strictly descending by the unique seq — its own tie-breaker, so pagination is stable.
    expect([...full].sort((a, b) => b - a)).toEqual(full);
    expect(new Set(full).size).toBe(5);
    const p1 = await seqs(["--limit", "2", "--offset", "0"]);
    const p2 = await seqs(["--limit", "2", "--offset", "2"]);
    const p3 = await seqs(["--limit", "2", "--offset", "4"]);
    expect([...p1, ...p2, ...p3]).toEqual(full);
    expect(p3.length).toBe(1); // short final page
  });
});

describe("stable JSON schemas (every paginated success validates)", () => {
  beforeEach(async () => {
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: dbPath });
    try {
      for (const n of [1, 2, 3] as const) seedSource(store, n, iso(n));
      seedOpenRun(store, 1, iso(1));
      // A note with run history (one integrated run).
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas", title: "Atlas", type: "concept", schema_version: 1, status: "active", file_path: "atlas.md", content_hash: `sha256:${hash(9)}`, created: iso(0), updated: iso(0) });
      store.ledger.upsertAgentRun({ run_id: ulid(9), operation: "ingest", status: "integrated", tier: 1, target_note_id: "concept-atlas", started_at: iso(0), updated_at: iso(0), finished_at: iso(0) });
    } finally {
      store.close();
    }
  });

  it("source list", async () => {
    const r = await cli(["source", "list", "--json"]);
    expect(r.code, r.out).toBe(0);
    validateSchema("source-list", JSON.parse(r.out));
  });
  it("note history", async () => {
    const r = await cli(["note", "history", "concept-atlas", "--json"]);
    expect(r.code, r.out).toBe(0);
    validateSchema("note-history", JSON.parse(r.out));
    const events = JSON.parse(r.out).events;
    // v2 (#338): seq is the run's monotonic agent_runs.rowid (its own tie-breaker),
    // not a hardcoded value — assert it is a non-negative integer per the schema.
    expect(Number.isInteger(events[0].seq) && events[0].seq >= 0).toBe(true);
    expect(events[0].kind).toBe("run.integrated");
  });
});

describe("concurrent-insert anomaly bound", () => {
  it("a full page-walk duplicates/omits at most as many rows as were inserted mid-walk", async () => {
    await cli(["db", "migrate", "--json"]);
    const store = openStore({ path: dbPath });
    try {
      const repo = new SourceRepo(store.db);
      // 6 sources with STRICTLY DESCENDING sort key by design (addedAt DESC → newest first).
      for (const n of [1, 2, 3, 4, 5, 6]) seedSource(store, n, iso(n));
      const limit = 2;
      const seen: string[] = [];
      // Page 1.
      seen.push(...repo.list({ limit, offset: 0 }).map((r) => r.id));
      // A concurrent insert AHEAD of the window (newest addedAt) shifts offsets down by 1.
      seedSource(store, 7, iso(59));
      // Continue the walk from where page 1 ended.
      for (let off = limit; ; off += limit) {
        const rows = repo.list({ limit, offset: off });
        const total = repo.count();
        if (off >= total) break;
        seen.push(...rows.map((r) => r.id));
        if (off + rows.length >= total) break;
      }
      // Count anomalies EXPLICITLY — both duplicates AND omissions (the documented
      // bound is over duplicated-OR-omitted rows, not duplicates alone). A duplicate
      // is a row the walk saw more than once; an omission is an ORIGINAL row (1..6)
      // the walk never saw. The newly-inserted row (7) is allowed to appear or not
      // and is excluded from the omission set. The bound: duplicates + omissions ≤
      // number of rows inserted mid-walk (1).
      const counts = new Map<string, number>();
      for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
      const duplicates = [...counts.values()].filter((c) => c > 1).reduce((a, c) => a + (c - 1), 0);
      const originals = [1, 2, 3, 4, 5, 6].map(sid);
      const omissions = originals.filter((id) => !seen.includes(id)).length;
      expect(duplicates + omissions).toBeLessThanOrEqual(1);
      // Every ORIGINAL row (1..6) is still reachable in a fresh full scan (ordering total).
      const full = repo.list({ limit: 50, offset: 0 }).map((r) => r.id);
      for (const n of [1, 2, 3, 4, 5, 6]) expect(full).toContain(sid(n));
    } finally {
      store.close();
    }
  });
});
