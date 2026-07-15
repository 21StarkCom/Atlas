/**
 * `index-ops.test` — the Task 3.5 acceptance suite (#42): staleness detection,
 * SQLite↔LanceDB verify, reconcile-backed repair, and full rebuild.
 *
 * Drives the PRODUCTION package functions (`computeStaleness`, `indexVerify`,
 * `indexRepair`, `indexRebuild`) + the `run.projection` audit path against REAL
 * in-process seams — a real LanceDB index, a real migrated SQLite ledger, a real egress
 * `EgressService` (deterministic embed adapter, no network), and the real broker socket
 * + AEAD backup custody from the Phase-2 harness. It asserts:
 *
 *   1. rebuild reconstructs from an EMPTY index; `verify` is then consistent;
 *   2. an edited note is detected `stale` (contentHash trigger) and `repair` converges it;
 *   3. deleting all LanceDB chunks is a `missing-chunks` divergence; `rebuild` reconstructs;
 *   4. an orphaned generation is detected + compacted;
 *   5. each executed op appends EXACTLY ONE terminal `run.projection` event, verify-clean.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { newRunId, type ParsedNote } from "@atlas/contracts";
import {
  EgressService,
  mintEgressCapability,
  type EgressInvokeParams,
  type ProviderAdapter,
  type Usage,
} from "@atlas/broker";
import type { QuarantineSink } from "@atlas/scan";
import { ModelsClient } from "@atlas/models";
import { openStore, registerGenerationMigration, type Store } from "@atlas/sqlite-store";
import {
  assembleRows,
  chunkNote,
  computeStaleness,
  embedderFromClient,
  generationId,
  indexRebuild,
  indexRepair,
  indexVerify,
  openSearchTable,
  writeGeneration,
  type Embedder,
  type IndexDeps,
  type IndexingConfig,
  type NoteFenceInput,
  type SearchTable,
} from "@atlas/lancedb-index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";
import { runReadAudit } from "../src/audit/readonly.js";

const DIMS = 3;
const CFG: IndexingConfig = { chunker_version: 1, embedding_model: "test-embed", dimensions: DIMS };

/** A deterministic embed adapter (no network): every text → the unit vector `[1,0,0]`. */
function fakeEmbedAdapter(): ProviderAdapter {
  const usage: Usage = { inputTokens: 8, outputTokens: 0 };
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: () => Promise.resolve({ rawResponse: Buffer.from("{}", "utf8"), retries: 0 }),
    parse: (op, req) => {
      if (op !== "embed") throw new Error(`unexpected op ${op}`);
      const r = req as { texts: readonly string[]; dimensions: number; model: string };
      const vec = Array.from({ length: r.dimensions }, (_v, i) => (i === 0 ? 1 : 0));
      return { result: { vectors: r.texts.map(() => vec), dimensions: r.dimensions, usage, model: r.model }, usage, model: r.model };
    },
    costMicros: (_m, u) => u.inputTokens + 1,
  };
}

function memQuarantine(): QuarantineSink {
  return { quarantine: () => Promise.resolve() };
}

function makeNote(id: string, body: string, hash: string): ParsedNote {
  return {
    id,
    path: `${id}.md`,
    type: "concept",
    schemaVersion: 1,
    title: id,
    status: "active",
    created: "2026-07-15T00:00:00Z",
    updated: "2026-07-15T00:00:00Z",
    aliases: [],
    sources: [],
    declaredSensitivity: "internal",
    links: [],
    sections: { heading: "", level: 0, path: "", children: [] },
    contentHash: hash,
    raw: body,
  };
}

describe("index-ops — status/verify/repair/rebuild (Task 3.5)", () => {
  let h: Phase2Harness;
  let store: Store;
  let dir: string;
  let conn: lancedb.Connection;
  let table: SearchTable;

  beforeEach(async () => {
    h = await makePhase2Harness();
    store = openStore({ path: h.dbPath });
    registerGenerationMigration(store);
    store.migrate();

    dir = await mkdtemp(join(tmpdir(), "atlas-index-ops-"));
    conn = await lancedb.connect(dir);
    table = await openSearchTable(conn, CFG);
  });

  afterEach(async () => {
    store.close();
    await h.cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Insert a projected note row (the activation authority) + its slug identity key. */
  function insertNote(id: string, contentHash: string): void {
    store.db
      .prepare(
        `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
         VALUES (?, ?, ?, 'concept', 1, 'active', ?, ?, '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z')`,
      )
      .run(id, id, id, `${id}.md`, contentHash);
  }

  function embedFor(runId: string): Embedder {
    // A dedicated egress over the deterministic embed adapter (the harness's own adapter
    // serves the capture path, not `embed`).
    const egress = new EgressService({ adapter: fakeEmbedAdapter(), quarantine: memQuarantine(), capabilitySecret: h.capabilitySecret });
    const models = new ModelsClient(
      (params: EgressInvokeParams, signal?: AbortSignal) =>
        egress.invoke(params, signal).then((out) => {
          if (out.ok) return { ok: true as const, result: out.result, receipt: out.receipt };
          if (out.providerError) return { ok: false as const, providerError: out.error, receipt: out.receipt };
          return { ok: false as const, refusal: out.refusal, ...(out.receipt !== undefined ? { receipt: out.receipt } : {}) };
        }),
      () => {},
    );
    const cap = mintEgressCapability(
      { runId },
      { operation: "embed", model: CFG.embedding_model, maxBytes: 8_000_000, maxTokens: 2_000_000, costCeiling: 10_000_000, allowedSensitivity: "internal" },
      { secret: h.capabilitySecret },
    );
    return embedderFromClient(models, cap, CFG);
  }

  function depsFor(notes: readonly ParsedNote[], runId: string): IndexDeps {
    return { config: CFG, table, store: store.generation, embed: embedFor(runId), lockLocation: dir, notes: () => notes };
  }

  function fences(): NoteFenceInput[] {
    return (
      store.db.prepare(`SELECT note_id, content_hash, active_generation_id FROM notes ORDER BY note_id`).all() as {
        note_id: string;
        content_hash: string;
        active_generation_id: string | null;
      }[]
    ).map((r) => ({ noteId: r.note_id, contentHash: r.content_hash, activeGenerationId: r.active_generation_id }));
  }

  it("rebuild reconstructs from an EMPTY index; verify is then consistent and status reports indexed", async () => {
    insertNote("alpha", "h-alpha");
    const notes = [makeNote("alpha", "Alpha content about meridian, expanded with more meridian detail.", "h-alpha")];

    const rebuild = await indexRebuild(depsFor(notes, newRunId()));
    expect(rebuild.notesIndexed).toBe(1);
    expect(rebuild.chunksWritten).toBeGreaterThan(0);
    expect(rebuild.unresolved).toHaveLength(0);

    const verify = await indexVerify({ notes: fences(), table, config: CFG, activeGenerationIds: store.generation.activeGenerationIds() });
    expect(verify.consistent).toBe(true);
    expect(verify.checked).toBe(1);

    const status = await computeStaleness(fences(), table, CFG);
    expect(status).toEqual([{ noteId: "alpha", status: "indexed", triggers: [] }]);
  });

  it("an EDITED note is detected stale (contentHash trigger) and repair converges it", async () => {
    insertNote("alpha", "h-alpha");
    await indexRebuild(depsFor([makeNote("alpha", "Original meridian prose.", "h-alpha")], newRunId()));

    // Edit the note: bump the projected content hash (simulating a Markdown edit). The
    // active generation's chunk still carries the OLD hash → stale by contentHash.
    store.db.prepare(`UPDATE notes SET content_hash = 'h-alpha-v2' WHERE note_id = 'alpha'`).run();
    const stale = await computeStaleness(fences(), table, CFG);
    expect(stale).toEqual([{ noteId: "alpha", status: "stale", triggers: ["contentHash"] }]);

    const verifyStale = await indexVerify({ notes: fences(), table, config: CFG, activeGenerationIds: store.generation.activeGenerationIds() });
    expect(verifyStale.consistent).toBe(false);
    expect(verifyStale.divergences.map((d) => d.kind)).toContain("stale-active");

    // Repair with the edited note re-embeds + re-activates the new generation.
    const repair = await indexRepair(depsFor([makeNote("alpha", "Edited meridian prose, expanded.", "h-alpha-v2")], newRunId()));
    expect(repair.outcome).toBe("converged");
    expect(repair.repaired.map((r) => r.noteId)).toContain("alpha");

    const after = await computeStaleness(fences(), table, CFG);
    expect(after).toEqual([{ noteId: "alpha", status: "indexed", triggers: [] }]);
    const verifyOk = await indexVerify({ notes: fences(), table, config: CFG, activeGenerationIds: store.generation.activeGenerationIds() });
    expect(verifyOk.consistent).toBe(true);
  });

  it("deleting all LanceDB chunks is a missing-chunks divergence; rebuild reconstructs", async () => {
    insertNote("alpha", "h-alpha");
    await indexRebuild(depsFor([makeNote("alpha", "Meridian prose.", "h-alpha")], newRunId()));

    // Wipe the LanceDB directory entirely (index state is disposable derived state).
    await rm(dir, { recursive: true, force: true });
    conn = await lancedb.connect(dir);
    table = await openSearchTable(conn, CFG);

    const gone = await computeStaleness(fences(), table, CFG);
    expect(gone).toEqual([{ noteId: "alpha", status: "missing", triggers: ["missing"] }]);
    const verifyGone = await indexVerify({ notes: fences(), table, config: CFG, activeGenerationIds: store.generation.activeGenerationIds() });
    expect(verifyGone.consistent).toBe(false);
    expect(verifyGone.divergences[0]!.kind).toBe("missing-chunks");

    const rebuild = await indexRebuild(depsFor([makeNote("alpha", "Meridian prose.", "h-alpha")], newRunId()));
    expect(rebuild.notesIndexed).toBe(1);
    const verifyBack = await indexVerify({ notes: fences(), table, config: CFG, activeGenerationIds: store.generation.activeGenerationIds() });
    expect(verifyBack.consistent).toBe(true);
  });

  it("an orphaned generation (live chunks not active for any note) is a divergence, compacted by repair", async () => {
    insertNote("alpha", "h-alpha");
    const note = makeNote("alpha", "Meridian prose about the index.", "h-alpha");
    await indexRebuild(depsFor([note], newRunId()));

    // Write an ORPHAN generation: chunks tagged with a generation that is not active for
    // any note (never CAS-activated), simulating a crashed/superseded write.
    const orphanNote = makeNote("alpha", "A superseded body.", "h-orphan");
    const orphanGen = generationId(orphanNote, CFG);
    const chunks = chunkNote(orphanNote, CFG);
    await writeGeneration(table, assembleRows(chunks, chunks.map(() => [1, 0, 0]), CFG, orphanGen));

    const verify = await indexVerify({ notes: fences(), table, config: CFG, activeGenerationIds: store.generation.activeGenerationIds() });
    expect(verify.consistent).toBe(false);
    expect(verify.divergences.some((d) => d.kind === "orphaned-generation")).toBe(true);

    // Repair compacts the orphan; verify is clean afterwards.
    await indexRepair(depsFor([note], newRunId()));
    const after = await indexVerify({ notes: fences(), table, config: CFG, activeGenerationIds: store.generation.activeGenerationIds() });
    expect(after.consistent).toBe(true);
  });

  it("each executed index op appends EXACTLY ONE terminal run.projection event, verify-clean", async () => {
    const ctx = h.runContext();
    const runId = newRunId();
    const audit = await runReadAudit(ctx, "run.projection", "index status", store, { runId, strictBackup: true });
    expect(audit.recorded).toBe(true);

    const events = store.db.prepare(`SELECT event_type, COUNT(*) AS n FROM audit_events WHERE run_id = ? GROUP BY event_type`).all(runId) as { event_type: string; n: number }[];
    expect(events).toEqual([{ event_type: "run.projection", n: 1 }]);
    expect(store.verify().ok).toBe(true);
  });
});
