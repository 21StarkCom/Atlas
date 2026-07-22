/**
 * `sync.v2` (#329, Phase-3 task 5) — the v2 reconcile-based `sync` command + the ONE
 * reconciliation routine (`reconcile`) that `sync` and `status` both consume.
 *
 * v2 retires the absorb-cycle's HEAD cursor: the SQLite projection's per-note
 * `content_hash` IS the cursor. Every case here drives the REAL `brain sync` through
 * the router against a real vault working tree + migrated projection + a real LanceDB
 * index, with the deterministic in-process fake embedder (ATLAS_TEST_MODE +
 * ATLAS_FAKE_PROVIDER) — no daemon, no network, no provisioning.
 *
 * Observability (#329 round-2, wing finding 4): three real, load-bearing observables
 * back every claim below — the LanceDB row count (`totalChunkRows`), the SQLite
 * activation fence (`activeGen`), and a genuine embed counter (`ATLAS_EMBED_COUNT_FILE`,
 * the count of `embed()` calls a command made). Retrieval invisibility is asserted by
 * driving the REAL retrieval engine `brain query` runs (`executeQuery` with
 * `--no-answer`, the active-generation fence enforced end-to-end) — a full `brain query`
 * / `brain index rebuild` COMMAND additionally needs the broker socket daemon for its
 * `run.readonly`/`run.projection` audit, which this deliberately daemon-free harness
 * does not stand up; the retrieval fence + orphan sweep those commands wrap are the
 * correctness surface and are exercised directly against the same engines.
 *
 * Coverage (plan task-5 acceptance):
 *   - row c: dirty edit ⇒ 1st sync indexes (changedCount:1, one re-embed), 2nd ⇒ noop:true
 *     with ZERO index writes;
 *   - the four runtime states validate against `sync.schema.json` (head absent, exact
 *     counts + scannedCount, clean JSON on stdout);
 *   - the dropped-note cross-store purge (projection row + note_links + LanceDB vectors
 *     gone; `executeQuery` cannot return it) + the orphan-vector failpoint (a REAL sync
 *     interrupted right after the SQLite purge txn via `ATLAS_SYNC_FAILPOINT`: the note
 *     is unqueryable, an unchanged-tree sync stays noop with no index write, the real
 *     rebuild orphan sweep reclaims the stranded vector);
 *   - move/rename (movedCount:1, changedCount:0, ZERO re-embeds, ZERO index writes) and
 *     rename-plus-edit (changedCount:1, movedCount:0, file_path updated AND re-embedded
 *     EXACTLY once) against the shared routine;
 *   - `sync status.pending` counts EXACTLY equal the following `sync` counts for edits,
 *     additions, drops, and moves (the shared-routine guarantee).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import * as lancedb from "@lancedb/lancedb";
import { openStore, GenerationRepo } from "@atlas/sqlite-store";
import {
  embedderFromClient,
  indexRebuild,
  openSearchTable,
  indexingConfigKey,
  SEARCH_CHUNK_TABLE,
  type IndexingConfig,
} from "@atlas/lancedb-index";
import { readVault } from "../src/vault/reader.js";
import type { AtlasConfig } from "../src/config/schema.js";
import { ModelsClient, createInProcessInvoker } from "@atlas/models";
import { runCli } from "../src/main.js";
import { reconcile } from "../src/sync/diff.js";
import { newRunId, normalizeIdentityKey } from "@atlas/contracts";
import { executeQuery, parseQueryArgs } from "../src/commands/query.js";
import type { IdentityResolver, NoteMeta, RetrievalDeps } from "../src/retrieval/layers.js";

const INDEX_CFG: IndexingConfig = { chunker_version: 1, embedding_model: "gemini-embedding-001", dimensions: 768 };

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  errorsText: (e?: unknown) => string;
};
function validateSyncSchema(value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", "sync.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`sync failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
  // `head` is dropped in v2 — assert it never leaks back.
  expect(Object.prototype.hasOwnProperty.call(value, "head")).toBe(false);
}

/** Validate a `sync status --json` envelope against the committed sync-status schema. */
function validateSyncStatusSchema(value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", "sync-status.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`sync status failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

let root: string;
let cwd: string;
let vaultDir: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;
let embedCountFile: string;
let lanceMutationFile: string;

async function cli(argv: string[], overrideEnv?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, overrideEnv ?? env, { cwd, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** Deterministic note file (valid frontmatter for the vault reader). */
function noteText(id: string, body: string): string {
  return `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\nstatus: active\ncreated: 2026-07-22\nupdated: 2026-07-22\n---\n# ${id}\n\n${body}\n`;
}
function writeNote(rel: string, id: string, body: string): void {
  const abs = join(vaultDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, noteText(id, body), "utf8");
}

/** A note with explicit frontmatter aliases (for the identity-key + link fold tests). */
function writeNoteWithAliases(rel: string, id: string, aliases: readonly string[], body: string): void {
  const abs = join(vaultDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const aliasBlock = aliases.length === 0 ? "aliases: []" : `aliases:\n${aliases.map((a) => `  - ${a}`).join("\n")}`;
  const text = `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\nstatus: active\n${aliasBlock}\ncreated: 2026-07-22\nupdated: 2026-07-22\n---\n# ${id}\n\n${body}\n`;
  writeFileSync(abs, text, "utf8");
}

/** The normalized identity keys projected for a note (kind + key), ordered by key. */
function identityKeys(noteId: string): { normalized_key: string; kind: string }[] {
  const s = openStore({ path: dbPath });
  try {
    return s.db
      .prepare(`SELECT normalized_key, kind FROM note_identity_keys WHERE note_id = ? ORDER BY normalized_key`)
      .all(noteId) as { normalized_key: string; kind: string }[];
  } finally {
    s.close();
  }
}

/** The outgoing links projected for a note (target ids), sorted. */
function outgoingLinks(noteId: string): string[] {
  const s = openStore({ path: dbPath });
  try {
    return (
      s.db.prepare(`SELECT target_note_id FROM note_links WHERE source_note_id = ? ORDER BY target_note_id`).all(noteId) as {
        target_note_id: string;
      }[]
    ).map((r) => r.target_note_id);
  } finally {
    s.close();
  }
}

/** The embed-call count the LAST command recorded (0 when it embedded nothing). */
function embedCount(): number {
  if (!existsSync(embedCountFile)) return 0;
  return Number.parseInt(readFileSync(embedCountFile, "utf8").trim(), 10);
}
/** Reset the embed counter so the NEXT command's count is observed in isolation. */
function resetEmbedCount(): void {
  if (existsSync(embedCountFile)) unlinkSync(embedCountFile);
}

/**
 * The count of LanceDB MUTATING calls (`mergeInsert`/`delete`/`createIndex`) the LAST
 * command made (0 when absent). This is the observable finding 5 requires: it proves
 * ZERO index writes on a noop / pure move, which an unchanged row count cannot (a rewrite
 * or delete-then-reinsert preserves the count).
 */
function lanceMutations(): number {
  if (!existsSync(lanceMutationFile)) return 0;
  return Number.parseInt(readFileSync(lanceMutationFile, "utf8").trim(), 10);
}
function resetLanceMutations(): void {
  if (existsSync(lanceMutationFile)) unlinkSync(lanceMutationFile);
}

/** Run one sync, assert exit 0, parse + schema-validate the envelope. Resets the counters first. */
async function sync(flags: string[] = []): Promise<Record<string, unknown>> {
  resetEmbedCount();
  resetLanceMutations();
  const r = await cli(["sync", "--json", ...flags]);
  expect(r.code, r.out).toBe(0);
  const env0 = JSON.parse(r.out) as Record<string, unknown>;
  validateSyncSchema(env0);
  return env0;
}

/** Establish the baseline projection + index by absorbing every current note as `new`. */
async function baseline(): Promise<void> {
  const first = await sync();
  expect(first.noop).toBe(false);
  const second = await sync();
  expect(second.noop, `2nd sync must be a noop: ${JSON.stringify(second)}`).toBe(true);
}

function projectionRow(id: string): { note_id: string; file_path: string; content_hash: string; active_generation_id: string | null } | undefined {
  const s = openStore({ path: dbPath });
  try {
    return s.db.prepare(`SELECT note_id, file_path, content_hash, active_generation_id FROM notes WHERE note_id = ?`).get(id) as
      | { note_id: string; file_path: string; content_hash: string; active_generation_id: string | null }
      | undefined;
  } finally {
    s.close();
  }
}
/** The SQLite activation fence for a note (the generation retrieval serves), or null. */
function activeGen(id: string): string | null {
  return projectionRow(id)?.active_generation_id ?? null;
}

/** Count the LanceDB chunk rows stored for a note id (the vector-store side). */
async function chunkCount(noteId: string): Promise<number> {
  const conn = await lancedb.connect(join(cwd, ".atlas", "lancedb"));
  const table = await openSearchTable(conn, INDEX_CFG);
  const rows = await table.query().where(`noteId = '${noteId}'`).toArray();
  return rows.length;
}
/** Total LanceDB chunk rows across ALL notes — the observable "did sync write the index?". */
async function totalChunkRows(): Promise<number> {
  const conn = await lancedb.connect(join(cwd, ".atlas", "lancedb"));
  if (!(await conn.tableNames()).includes(SEARCH_CHUNK_TABLE)) return 0;
  const table = await openSearchTable(conn, INDEX_CFG);
  return table.countRows();
}

/**
 * Drive the REAL retrieval engine `brain query` runs — `executeQuery` with `--no-answer`,
 * over the real LanceDB table + the SQLite active-generation fence (§2) — and return the
 * note ids retrieval would serve. This is the exact fence a `brain query` enforces; the
 * only thing skipped is the command's broker-audit ceremony (impossible daemon-free).
 */
async function queryNoteIds(text: string): Promise<string[]> {
  const store = openStore({ path: dbPath });
  const conn = await lancedb.connect(join(cwd, ".atlas", "lancedb"));
  const table = await openSearchTable(conn, INDEX_CFG);
  const models = new ModelsClient(createInProcessInvoker({ env }), () => {});
  const runId = newRunId();
  const resolver: IdentityResolver = { resolveExactId: () => null, resolveSlug: () => [], resolveAlias: () => [] };
  const NOW = (): string => "2026-07-22T00:00:00.000Z";
  const noteMeta = (): NoteMeta => ({ type: "concept", sensitivity: "internal", trust: "verified" });
  try {
    const retrieval: Omit<RetrievalDeps, "recorder" | "runId"> = {
      config: { rrf: { k: 60, weights: { fts: 1, vector: 1 } }, fts: { enabled: false } },
      resolver,
      table,
      activeGenerationIds: () => store.generation.activeGenerationIds(),
      activeGenerationId: (id) => store.generation.activeGenerationId(id),
      embed: embedderFromClient(models, { runId }, INDEX_CFG),
      noteMeta,
      indexGeneration: store.generation.configRevisionFor(indexingConfigKey(INDEX_CFG)),
      newRetrievalId: () => `rr-${runId}`,
      now: NOW,
    };
    const exec = await executeQuery({
      runId,
      args: parseQueryArgs([text, "--no-answer"]),
      retrieval,
      generate: () => {
        throw new Error("--no-answer must never generate");
      },
      getReceipts: () => [],
      packBudget: 6000,
      now: NOW,
    });
    return exec.output.items.map((i) => i.noteId);
  } finally {
    store.close();
  }
}

/**
 * Reclaim orphans through the REAL `brain index rebuild` engine (finding 4) — the exact
 * `indexRebuild` reclamation the command wraps (drop table + re-embed every surviving vault
 * note; the deleted note is simply absent, so its chunks are gone). The full `brain index
 * rebuild` COMMAND additionally anchors a strict `run.projection` audit that needs the
 * broker daemon this harness omits, so we drive its reclamation engine directly — the same
 * seam `index-ops.test.ts` uses — never the low-level `compactOrphans` primitive.
 */
async function rebuildIndexEngine(): Promise<void> {
  const store = openStore({ path: dbPath });
  const conn = await lancedb.connect(join(cwd, ".atlas", "lancedb"));
  const dir = join(cwd, ".atlas", "lancedb");
  if ((await conn.tableNames()).includes(SEARCH_CHUNK_TABLE)) await conn.dropTable(SEARCH_CHUNK_TABLE);
  const table = await openSearchTable(conn, INDEX_CFG);
  const models = new ModelsClient(createInProcessInvoker({ env }), () => {});
  const cfg = { vault: { path: vaultDir, note_globs: ["**/*.md"] } } as unknown as AtlasConfig;
  try {
    const snapshot = await readVault(cfg);
    await indexRebuild({
      config: INDEX_CFG,
      table,
      store: new GenerationRepo(store.db),
      embed: embedderFromClient(models, { runId: newRunId() }, INDEX_CFG),
      lockLocation: dir,
      notes: () => snapshot.notes,
    });
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-syncv2-"));
  cwd = join(root, "work");
  vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
  dbPath = join(cwd, ".atlas", "atlas.db");
  embedCountFile = join(root, "embed-count.txt");
  lanceMutationFile = join(root, "lance-mutations.txt");
  const config = [
    "vault:", `  path: ${vaultDir}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  // ATLAS_TEST_MODE + ATLAS_FAKE_PROVIDER ⇒ the deterministic in-process embedder.
  // ATLAS_EMBED_COUNT_FILE ⇒ the observable embed counter (test-only, gated).
  env = {
    ...process.env,
    NO_COLOR: "1",
    ATLAS_TEST_MODE: "1",
    ATLAS_FAKE_PROVIDER: "1",
    ATLAS_EMBED_COUNT_FILE: embedCountFile,
    ATLAS_LANCE_MUTATION_COUNT_FILE: lanceMutationFile,
  };
  await cli(["db", "migrate", "--json"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reconcile — the shared routine (unit)", () => {
  it("classifies changed/new/dropped/moved disjointly, content-change wins over move", () => {
    const vault = [
      { noteId: "a", path: "a.md", contentHash: "h-a" }, // unchanged (same everywhere)
      { noteId: "b", path: "b2.md", contentHash: "h-b" }, // moved (same hash, new path)
      { noteId: "c", path: "c.md", contentHash: "h-c2" }, // changed (new hash, same path)
      { noteId: "d", path: "d2.md", contentHash: "h-d2" }, // rename+edit ⇒ changed, NOT moved
      { noteId: "e", path: "e.md", contentHash: "h-e" }, // new (absent from projection)
    ];
    const projection = [
      { noteId: "a", path: "a.md", contentHash: "h-a" },
      { noteId: "b", path: "b.md", contentHash: "h-b" },
      { noteId: "c", path: "c.md", contentHash: "h-c" },
      { noteId: "d", path: "d.md", contentHash: "h-d" },
      { noteId: "f", path: "f.md", contentHash: "h-f" }, // dropped (absent from vault)
    ];
    const r = reconcile(vault, projection);
    expect(r.new.map((n) => n.noteId)).toEqual(["e"]);
    expect(r.dropped.map((n) => n.noteId)).toEqual(["f"]);
    expect(r.moved.map((n) => n.noteId)).toEqual(["b"]);
    expect(r.moved[0]).toMatchObject({ fromPath: "b.md", toPath: "b2.md", contentHash: "h-b" });
    // c (edit in place) + d (rename+edit) both land in `changed`, never in `moved`.
    expect(r.changed.map((n) => n.noteId)).toEqual(["c", "d"]);
    expect(r.changed.find((n) => n.noteId === "d")!.path).toBe("d2.md"); // carries the new path
    // disjointness
    const changedIds = new Set(r.changed.map((n) => n.noteId));
    expect(r.moved.some((m) => changedIds.has(m.noteId))).toBe(false);
  });

  it("an identical tree is a full noop (every bucket empty)", () => {
    const rows = [{ noteId: "a", path: "a.md", contentHash: "h-a" }];
    const r = reconcile(rows, rows);
    expect([r.changed.length, r.new.length, r.dropped.length, r.moved.length]).toEqual([0, 0, 0, 0]);
  });
});

describe("brain sync (v2) — the four runtime states + schema", () => {
  it("new notes ⇒ newCount, then an unchanged tree ⇒ noop:true (ZERO index writes)", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    writeNote("b.md", "concept-b", "Beta about horizon.");
    const first = await sync();
    expect(first).toMatchObject({ command: "sync", scannedCount: 2, changedCount: 0, newCount: 2, droppedCount: 0, movedCount: 0, noop: false });
    expect(embedCount()).toBe(2); // exactly one embed per new note
    expect(lanceMutations()).toBeGreaterThan(0); // it DID write the index (mergeInsert + FTS createIndex)
    const rowsAfterFirst = await totalChunkRows();
    expect(rowsAfterFirst).toBeGreaterThan(0);

    const second = await sync();
    expect(second).toMatchObject({ scannedCount: 2, newCount: 0, changedCount: 0, droppedCount: 0, movedCount: 0, noop: true });
    // a noop performs NO index write: zero embeds, ZERO LanceDB mutation calls (finding 5 —
    // instrumented at the mergeInsert/delete/createIndex boundary), row count unchanged.
    expect(embedCount()).toBe(0);
    expect(lanceMutations()).toBe(0);
    expect(await totalChunkRows()).toBe(rowsAfterFirst);
  });

  it("row c: a dirty edit ⇒ 1st sync indexes (changedCount:1, one re-embed), the immediate 2nd ⇒ noop:true", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    writeNote("b.md", "concept-b", "Beta about horizon.");
    await baseline();
    const before = projectionRow("concept-a")!;

    writeNote("a.md", "concept-a", "Alpha REVISED — new prose about meridian and horizon.");
    const first = await sync();
    expect(first).toMatchObject({ scannedCount: 2, changedCount: 1, newCount: 0, droppedCount: 0, movedCount: 0, noop: false });
    expect(embedCount()).toBe(1); // exactly one re-embed for the one changed note
    // the projection content_hash (the cursor) AND the activation fence advanced for the edited note
    const after = projectionRow("concept-a")!;
    expect(after.content_hash).not.toBe(before.content_hash);
    expect(after.active_generation_id).not.toBe(before.active_generation_id);
    expect(after.active_generation_id).not.toBeNull(); // the new generation IS live (finding 1)

    const rowsAfterEdit = await totalChunkRows();
    const second = await sync();
    expect(second.noop).toBe(true);
    expect(second).toMatchObject({ changedCount: 0, newCount: 0 });
    expect(embedCount()).toBe(0);
    expect(await totalChunkRows()).toBe(rowsAfterEdit);
  });

  it("a NEW note is queryable after its first sync (activation against the new hash — finding 1)", async () => {
    writeNote("a.md", "concept-a", "Alpha about the meridian phenomenon.");
    await baseline();
    // the fence points at a live generation and retrieval serves the note
    expect(activeGen("concept-a")).not.toBeNull();
    expect(await queryNoteIds("meridian")).toContain("concept-a");
  });

  it("--dry-run classifies but writes no sink (the change is still pending on the next run)", async () => {
    writeNote("a.md", "concept-a", "Alpha.");
    await baseline();
    writeNote("a.md", "concept-a", "Alpha changed body.");
    const dry = await sync(["--dry-run"]);
    expect(dry).toMatchObject({ changedCount: 1, noop: false });
    expect(embedCount()).toBe(0); // --dry-run embeds nothing
    // nothing was written — the very next real sync still sees the change
    const real = await sync();
    expect(real).toMatchObject({ changedCount: 1, noop: false });
    expect(embedCount()).toBe(1);
  });
});

describe("brain sync (v2) — fail closed on a non-unique identity (finding 2)", () => {
  it("two files claiming one stable id ⇒ exit 2, NO projection or index mutation", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    await baseline();
    const rowsBefore = await totalChunkRows();
    const genBefore = activeGen("concept-a");

    // A second file re-uses concept-a's stable id ⇒ a duplicate-id / identity-collision.
    writeNote("dup.md", "concept-a", "A rogue duplicate of concept-a.");
    resetEmbedCount();
    const r = await cli(["sync", "--json"]);
    expect(r.code).toBe(2); // fail closed — reconciliation needs a unique id per note
    expect(r.out).toContain("not reconcilable");

    // Nothing mutated: no embed, the projection row + fence + LanceDB rows are untouched.
    expect(embedCount()).toBe(0);
    expect(activeGen("concept-a")).toBe(genBefore);
    expect(await totalChunkRows()).toBe(rowsBefore);
    expect(projectionRow("concept-a")!.file_path).toBe("a.md"); // the rogue file never landed
  });
});

describe("brain sync (v2) — FTS is a pre-cursor staging requirement (finding 2)", () => {
  it("an FTS failure leaves the content-hash cursor + fence PENDING; the retry reconciles", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    await baseline();
    const before = projectionRow("concept-a")!;

    // Edit the note, then sync with the FTS staging step armed to fail. FTS runs BEFORE
    // the cursor-advancing commit, so the throw leaves content_hash + the fence UNMOVED.
    writeNote("a.md", "concept-a", "Alpha REVISED — new prose about meridian and horizon.");
    resetEmbedCount();
    const crashed = await cli(["sync", "--json"], { ...env, ATLAS_SYNC_FAILPOINT: "before-fts" });
    expect(crashed.code).toBe(4); // internal — the injected FTS-stage crash, before commit

    // The projection content_hash (the cursor) and the activation fence did NOT advance.
    const afterCrash = projectionRow("concept-a")!;
    expect(afterCrash.content_hash).toBe(before.content_hash);
    expect(afterCrash.active_generation_id).toBe(before.active_generation_id);

    // The retry (no failpoint) re-detects the note as changed and reconciles it fully:
    // FTS completes, the cursor + fence advance, and the new content is queryable.
    const retry = await sync();
    expect(retry).toMatchObject({ changedCount: 1, newCount: 0, droppedCount: 0, movedCount: 0, noop: false });
    const afterRetry = projectionRow("concept-a")!;
    expect(afterRetry.content_hash).not.toBe(before.content_hash);
    expect(afterRetry.active_generation_id).not.toBe(before.active_generation_id);
    expect(await queryNoteIds("horizon")).toContain("concept-a");
  });
});

describe("brain sync (v2) — dropped-note cross-store purge", () => {
  it("a deleted file ⇒ droppedCount:1, projection row + note_links gone, retrieval cannot return it", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    writeNote("b.md", "concept-b", "Beta about the horizon phenomenon.");
    await baseline();
    // it IS retrievable before the drop
    expect(await queryNoteIds("horizon")).toContain("concept-b");
    // seed a note_link so the purge's link deletion is exercised
    const s = openStore({ path: dbPath });
    try {
      s.db.prepare(`INSERT INTO note_links (source_note_id, target_note_id, predicate) VALUES ('concept-a','concept-b','cites')`).run();
    } finally {
      s.close();
    }

    unlinkSync(join(vaultDir, "b.md"));
    const dropped = await sync();
    expect(dropped).toMatchObject({ scannedCount: 1, droppedCount: 1, changedCount: 0, newCount: 0, movedCount: 0, noop: false });

    // projection row + its links gone (invisibility-first purge)
    expect(projectionRow("concept-b")).toBeUndefined();
    const s2 = openStore({ path: dbPath });
    try {
      const links = s2.db.prepare(`SELECT COUNT(*) c FROM note_links WHERE source_note_id='concept-b' OR target_note_id='concept-b'`).get() as { c: number };
      expect(links.c).toBe(0);
    } finally {
      s2.close();
    }

    // LanceDB vectors dropped too — and retrieval (the real fence) cannot return it.
    expect(await chunkCount("concept-b")).toBe(0);
    expect(await chunkCount("concept-a")).toBeGreaterThan(0); // survivor untouched
    const served = await queryNoteIds("horizon");
    expect(served).not.toContain("concept-b");
    expect(served).toContain("concept-a"); // the survivor is still retrievable

    // an unchanged tree afterwards is a noop
    const again = await sync();
    expect(again.noop).toBe(true);
  });

  it("failpoint: a REAL sync interrupted after the SQLite purge txn strands a vector — unqueryable, noop-stable, swept by the real rebuild sweep", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    writeNote("b.md", "concept-b", "Beta about the horizon phenomenon.");
    await baseline();

    // Drive the REAL sync with the production failpoint armed: it deletes the file, so
    // reconcile classifies concept-b as dropped, commits the invisibility-first SQLite
    // purge txn, then crashes BEFORE the LanceDB vector delete — the exact §2.8 orphan
    // window. No hand-deleted rows: the interrupt is a production code path.
    unlinkSync(join(vaultDir, "b.md"));
    resetEmbedCount();
    const crashed = await cli(["sync", "--json"], { ...env, ATLAS_SYNC_FAILPOINT: "after-purge-txn" });
    expect(crashed.code).toBe(4); // internal — the injected crash

    // The SQLite purge committed (row gone); the LanceDB vector is STRANDED.
    expect(projectionRow("concept-b")).toBeUndefined();
    expect(await chunkCount("concept-b")).toBeGreaterThan(0);
    // Retrieval joins the SQLite-active generations, so with concept-b's row gone the
    // orphan is unreturnable even though its bytes physically remain.
    expect(await queryNoteIds("horizon")).not.toContain("concept-b");

    // The tree now matches the projection (b gone from both) ⇒ the next sync is a
    // structural noop and performs NO index write — the orphan sweep is NOT sync's job.
    const noop = await sync();
    expect(noop.noop).toBe(true);
    expect(noop).toMatchObject({ droppedCount: 0, scannedCount: 1 });
    expect(embedCount()).toBe(0);
    expect(await chunkCount("concept-b")).toBeGreaterThan(0); // sync did NOT sweep it

    // The orphan sweep is index rebuild's alone: driving the REAL `indexRebuild` engine
    // (finding 4) re-embeds every surviving vault note and drops the rest — concept-b is
    // gone from the vault, so its stranded chunk is reclaimed. Then retrieval (query
    // --no-answer, the real fence) still cannot return it, and the survivor is intact.
    await rebuildIndexEngine();
    expect(await chunkCount("concept-b")).toBe(0); // swept by the real rebuild engine
    expect(await chunkCount("concept-a")).toBeGreaterThan(0); // survivor re-indexed
    expect(await queryNoteIds("horizon")).not.toContain("concept-b");
    expect(await queryNoteIds("meridian")).toContain("concept-a");
  });
});

describe("brain sync (v2) — the v2 fold reconciles identity keys + links (finding 1)", () => {
  it("a NEW note receives its slug + alias identity keys (never left keyless)", async () => {
    writeNoteWithAliases("a.md", "concept-a", ["Alpha One", "First A"], "Alpha about meridian.");
    await baseline();
    const keys = identityKeys("concept-a");
    // slug key (from the path basename `a`) + one row per distinct alias — the exact set
    // rebuild would produce, so a new note is resolvable by slug AND alias immediately.
    expect(keys).toEqual(
      [
        { normalized_key: normalizeIdentityKey("a"), kind: "slug" },
        { normalized_key: normalizeIdentityKey("Alpha One"), kind: "alias" },
        { normalized_key: normalizeIdentityKey("First A"), kind: "alias" },
      ].sort((x, y) => (x.normalized_key < y.normalized_key ? -1 : x.normalized_key > y.normalized_key ? 1 : 0)),
    );
  });

  it("an alias + link edit refreshes note_identity_keys AND note_links (no stale rows)", async () => {
    writeNoteWithAliases("a.md", "concept-a", ["Old Alias"], "Alpha links to [[b]] about meridian.");
    writeNote("b.md", "concept-b", "Beta about horizon.");
    await baseline();
    // baseline projection: alias "Old Alias" + a link a→b
    expect(identityKeys("concept-a").some((k) => k.normalized_key === normalizeIdentityKey("Old Alias"))).toBe(true);
    expect(outgoingLinks("concept-a")).toEqual(["concept-b"]);

    // Edit: swap the alias and drop the link. The content hash changes ⇒ changed ⇒ folded.
    writeNoteWithAliases("a.md", "concept-a", ["New Alias"], "Alpha now stands alone about meridian.");
    const r = await sync();
    expect(r).toMatchObject({ changedCount: 1, noop: false });

    const keys = identityKeys("concept-a");
    expect(keys.some((k) => k.normalized_key === normalizeIdentityKey("New Alias"))).toBe(true);
    expect(keys.some((k) => k.normalized_key === normalizeIdentityKey("Old Alias"))).toBe(false); // stale alias GONE
    expect(outgoingLinks("concept-a")).toEqual([]); // stale link GONE
  });

  it("a filename-changing move updates the slug identity key (old slug key not retained)", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    await baseline();
    expect(identityKeys("concept-a")).toEqual([{ normalized_key: normalizeIdentityKey("a"), kind: "slug" }]);

    // Pure move to a new filename ⇒ the path-derived slug changes from `a` to `renamed`.
    renameSync(join(vaultDir, "a.md"), join(vaultDir, "renamed.md"));
    const moved = await sync();
    expect(moved).toMatchObject({ movedCount: 1, changedCount: 0, noop: false });

    expect(projectionRow("concept-a")!.file_path).toBe("renamed.md");
    // The slug identity key MOVED with the filename — the old `a` key is gone, not retained.
    expect(identityKeys("concept-a")).toEqual([{ normalized_key: normalizeIdentityKey("renamed"), kind: "slug" }]);
    // and it is resolvable under the new slug afterwards: an unchanged tree is a noop
    expect((await sync()).noop).toBe(true);
  });
});

describe("brain sync (v2) — moves vs rename-plus-edit", () => {
  it("a pure move ⇒ movedCount:1, changedCount:0, file_path updated in place (ZERO re-embed, ZERO index write)", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    await baseline();
    const before = projectionRow("concept-a")!;
    const rowsBefore = await totalChunkRows();

    // Relocate the file with IDENTICAL bytes (a pure move — same stable id, same hash).
    mkdirSync(join(vaultDir, "sub"), { recursive: true });
    renameSync(join(vaultDir, "a.md"), join(vaultDir, "sub", "a.md"));

    const moved = await sync();
    expect(moved).toMatchObject({ movedCount: 1, changedCount: 0, newCount: 0, droppedCount: 0, noop: false });
    expect(embedCount()).toBe(0); // a pure move NEVER re-embeds
    expect(lanceMutations()).toBe(0); // ZERO LanceDB mutation calls — the fold is SQLite-only (finding 5)
    expect(await totalChunkRows()).toBe(rowsBefore); // ZERO index write
    const after = projectionRow("concept-a")!;
    expect(after.file_path).toBe("sub/a.md"); // path updated in place
    expect(after.content_hash).toBe(before.content_hash); // identical content ⇒ no hash change
    expect(after.active_generation_id).toBe(before.active_generation_id); // same live generation

    const again = await sync();
    expect(again.noop).toBe(true);
  });

  it("rename-plus-edit ⇒ changedCount:1, movedCount:0, file_path updated AND re-embedded EXACTLY once", async () => {
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    await baseline();
    const before = projectionRow("concept-a")!;

    unlinkSync(join(vaultDir, "a.md"));
    writeNote("sub/a.md", "concept-a", "Alpha RENAMED and edited — new prose entirely.");
    const r = await sync();
    expect(r).toMatchObject({ changedCount: 1, movedCount: 0, newCount: 0, droppedCount: 0, noop: false });
    expect(embedCount()).toBe(1); // EXACTLY one re-embed
    const after = projectionRow("concept-a")!;
    expect(after.file_path).toBe("sub/a.md");
    expect(after.content_hash).not.toBe(before.content_hash); // re-embedded (content changed)
    expect(after.active_generation_id).not.toBe(before.active_generation_id); // the new generation is live
    expect(await queryNoteIds("meridian")).toContain("concept-a");

    const again = await sync();
    expect(again.noop).toBe(true);
  });
});

describe("brain sync (v2) — sync and the read surface share the ONE reconcile routine (finding 3)", () => {
  /**
   * `sync status.pending` and an acting `sync` both derive their counts from the ONE
   * `readReconcile` routine (see `sync.ts`: `runSyncV2` and `syncStatusHandler` both call
   * it). This drives the REAL `sync status --json` command, validates it against
   * `sync-status.schema.json`, and asserts `status.pending` EXACTLY equals the immediately
   * following acting `sync`'s counts — for additions, edits, drops, and moves. If the
   * status handler stopped consuming `readReconcile` (or mapped a pending field wrong),
   * this fails; the earlier `--dry-run`-vs-`sync` comparison could not catch that.
   */
  /** Seed the `sync_cursors` row + an empty upstream commit so `sync status` reads cleanly
   * (cursor == head ⇒ behindBy 0, divergence ok, blocked null — the git surface is inert;
   * `status.pending` is the v2 reconcile of the working tree, independent of git). */
  function seedCursorForStatus(): void {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: vaultDir });
    const oid = execFileSync("git", ["rev-parse", "HEAD"], { cwd: vaultDir, encoding: "utf8" }).trim();
    const s = openStore({ path: dbPath });
    try {
      s.db
        .prepare(
          `INSERT INTO sync_cursors (source_id, upstream_ref, last_absorbed_oid, last_synced_at, cycle_seq, pending_quarantine)
           VALUES ('main-vault', 'refs/heads/main', ?, '2026-07-22T00:00:00.000Z', 0, '[]')`,
        )
        .run(oid);
    } finally {
      s.close();
    }
  }

  /** The v2 `pending` set the REAL `sync status --json` command reports (schema-validated). */
  async function statusPending(): Promise<Record<string, unknown>> {
    const r = await cli(["sync", "status", "--json"]);
    expect(r.code, r.out).toBe(0);
    const envelope = JSON.parse(r.out) as Record<string, unknown>;
    validateSyncStatusSchema(envelope);
    return envelope.pending as Record<string, unknown>;
  }

  it("sync status.pending counts == the immediately following sync counts across add / edit / move / drop", async () => {
    seedCursorForStatus();

    async function readThenAct(): Promise<void> {
      const pending = await statusPending(); // the REAL sync status command, schema-validated
      const acted = await sync();
      const keys = ["scannedCount", "changedCount", "newCount", "droppedCount", "movedCount", "noop"] as const;
      for (const k of keys) expect(pending[k], `status.pending.${k} must equal the following sync.${k}`).toEqual(acted[k]);
      // and it really exercised the state (never a vacuous all-noop comparison)
      expect(pending).toMatchObject({ scannedCount: acted.scannedCount });
    }

    // addition
    writeNote("a.md", "concept-a", "Alpha about meridian.");
    writeNote("b.md", "concept-b", "Beta about horizon.");
    await readThenAct();

    // edit
    writeNote("a.md", "concept-a", "Alpha edited about meridian.");
    await readThenAct();

    // move
    mkdirSync(join(vaultDir, "sub"), { recursive: true });
    renameSync(join(vaultDir, "b.md"), join(vaultDir, "sub", "b.md"));
    await readThenAct();

    // drop
    unlinkSync(join(vaultDir, "a.md"));
    await readThenAct();
  });
});
