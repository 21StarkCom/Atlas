/**
 * `query.audit-readonly.test` — the Task 3.4 acceptance suite (#41).
 *
 * Drives the PRODUCTION `executeQuery` core + the audited-read finalize path
 * (`recordReadonlyRun` → `finalizeLedgerWrite`) against REAL in-process seams — a
 * real LanceDB index, a real migrated SQLite ledger, a real egress `EgressService`
 * (a deterministic embed+generate adapter, no network / no live Gemini), and the real
 * broker socket + AEAD backup custody from the Phase-2 harness. It asserts:
 *
 *   1. one executed query ⇒ EXACTLY ONE terminal `run.readonly` event + COMPLETE
 *      correlated ledger rows (`agent_runs` × 1, `retrieval_runs` × 1,
 *      `retrieval_results` × N, `model_calls` per transmission), all under one runId;
 *   2. NO canonical/worktree mutation (canonical ref, working tree, worktree dir);
 *   3. `--no-answer` STILL records the embed `model_calls` row (every provider call
 *      accounted) while writing no generation row;
 *   4. the resulting ledger passes `db verify` (the `run.readonly`-as-terminal shape).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { newRunId, type ParsedNote } from "@atlas/contracts";
import {
  BrokerClient,
  EgressService,
  mintEgressCapability,
  type EgressInvokeParams,
  type ProviderAdapter,
  type Usage,
} from "@atlas/broker";
import type { QuarantineSink } from "@atlas/scan";
import { ModelsClient, type ModelCallReceipt } from "@atlas/models";
import { openStore, registerGenerationMigration, type Store } from "@atlas/sqlite-store";
import {
  assembleRows,
  chunkNote,
  embedderFromClient,
  generationId,
  indexingConfigKey,
  openSearchTable,
  writeGeneration,
  type IndexingConfig,
  type SearchTable,
} from "@atlas/lancedb-index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";
import { executeQuery, parseQueryArgs, recordFailedTransmissions, type QueryExecDeps } from "../src/commands/query.js";
import { recordReadonlyRun, runReadAudit } from "../src/audit/readonly.js";
import type { IdentityResolver, NoteMeta, RetrievalDeps } from "../src/retrieval/layers.js";

const DIMS = 3;
const CFG: IndexingConfig = { chunker_version: 1, embedding_model: "test-embed", dimensions: DIMS };
const GEN_MODEL = "test-gen";
const NOW = (): string => "2026-07-14T00:00:00.000Z";

/** A deterministic embed+generate adapter (no network): embed returns a fixed unit
 * vector `[1,0,0]` (so vector search resolves the note indexed at `[1,0,0]`), and
 * generateText returns an answer that cites `[[alpha]]`. Every model is priced. */
function fakeEmbedGenAdapter(answer: string): ProviderAdapter {
  const usage: Usage = { inputTokens: 8, outputTokens: 4 };
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: () => Promise.resolve({ rawResponse: Buffer.from("{}", "utf8"), retries: 0 }),
    parse: (op, req, _raw) => {
      if (op === "embed") {
        const r = req as { texts: readonly string[]; dimensions: number; model: string };
        const vec = Array.from({ length: r.dimensions }, (_v, i) => (i === 0 ? 1 : 0));
        return { result: { vectors: r.texts.map(() => vec), dimensions: r.dimensions, usage, model: r.model }, usage, model: r.model };
      }
      const g = req as { model: string };
      return { result: { text: answer, usage, model: g.model }, usage, model: g.model };
    },
    costMicros: (_m, u) => u.inputTokens + (u.outputTokens ?? 0) + 1,
  };
}

function memQuarantine(): QuarantineSink {
  return { quarantine: () => Promise.resolve() };
}

/** Build a ModelsClient over an in-process EgressService, collecting every receipt. */
function modelsOver(egress: EgressService): { models: ModelsClient; receipts: ModelCallReceipt[] } {
  const receipts: ModelCallReceipt[] = [];
  const models = new ModelsClient(
    (params: EgressInvokeParams, signal?: AbortSignal) =>
      egress.invoke(params, signal).then((out) => {
        if (out.ok) return { ok: true as const, result: out.result, receipt: out.receipt };
        if (out.providerError) return { ok: false as const, providerError: out.error, receipt: out.receipt };
        return { ok: false as const, refusal: out.refusal, ...(out.receipt !== undefined ? { receipt: out.receipt } : {}) };
      }),
    (r: ModelCallReceipt) => {
      receipts.push(r);
    },
  );
  return { models, receipts };
}

function makeNote(id: string, body: string, hash: string): ParsedNote {
  return {
    id,
    path: `${id}.md`,
    type: "concept",
    schemaVersion: 1,
    title: id,
    status: "active",
    created: "2026-07-14T00:00:00Z",
    updated: "2026-07-14T00:00:00Z",
    aliases: [],
    sources: [],
    declaredSensitivity: "internal",
    links: [],
    sections: { heading: "", level: 0, path: "", children: [] },
    contentHash: hash,
    raw: body,
  };
}

describe("query.audit-readonly — audited Tier-0 read (Task 3.4)", () => {
  let h: Phase2Harness;
  let store: Store;
  let dir: string;
  let conn: lancedb.Connection;
  let table: SearchTable;

  beforeEach(async () => {
    h = await makePhase2Harness();
    // Open the ledger + apply the Phase-3 generation migration (0008) on top of the
    // harness's workflow-migrated DB, then index one note so the vector layer resolves.
    store = openStore({ path: h.dbPath });
    registerGenerationMigration(store);
    store.migrate();

    dir = await mkdtemp(join(tmpdir(), "atlas-query-"));
    conn = await lancedb.connect(dir);
    table = await openSearchTable(conn, CFG);

    store.db
      .prepare(
        `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
         VALUES ('alpha','alpha','Alpha','concept',1,'active','alpha.md','h-alpha','2026-07-14T00:00:00Z','2026-07-14T00:00:00Z')`,
      )
      .run();
    store.db
      .prepare(`INSERT INTO note_identity_keys (normalized_key, note_id, kind, normalizer_version) VALUES ('alpha','alpha','slug',1)`)
      .run();
    const note = makeNote("alpha", "Alpha content about meridian.", "h-alpha");
    const chunks = chunkNote(note, CFG);
    const gen = generationId(note, CFG);
    const rows = assembleRows(chunks, chunks.map(() => [1, 0, 0]), CFG, gen);
    await writeGeneration(table, rows);
    store.generation.adoptConfig(indexingConfigKey(CFG));
    expect(store.activateGeneration("alpha", gen, "h-alpha", indexingConfigKey(CFG))).toBe(true);
  });

  afterEach(async () => {
    store.close();
    await h.cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const resolver: IdentityResolver = {
    resolveExactId: () => null,
    resolveSlug: () => [],
    resolveAlias: () => [],
  };
  const noteMeta = (): NoteMeta => ({ type: "concept", sensitivity: "internal", trust: "verified" });

  function retrievalDeps(models: ModelsClient, runId: string): Omit<RetrievalDeps, "recorder" | "runId"> {
    const embedCap = mintEgressCapability(
      { runId },
      { operation: "embed", model: CFG.embedding_model, maxBytes: 1_000_000, maxTokens: 100_000, costCeiling: 1_000_000, allowedSensitivity: "internal" },
      { secret: h.capabilitySecret },
    );
    return {
      config: { rrf: { k: 60, weights: { fts: 1, vector: 1 } }, fts: { enabled: false } },
      resolver,
      table,
      activeGenerationIds: () => store.generation.activeGenerationIds(),
      activeGenerationId: (id) => store.generation.activeGenerationId(id),
      embed: embedderFromClient(models, embedCap, CFG),
      noteMeta,
      indexGeneration: store.generation.configRevisionFor(indexingConfigKey(CFG)),
      newRetrievalId: () => `rr-${runId}`,
      now: NOW,
    };
  }

  function generateWith(models: ModelsClient, runId: string): QueryExecDeps["generate"] {
    // Mirror production (F4): the capability's `allowedSensitivity` ceiling AND the
    // transmission's declared sensitivity are both bound to the effective sensitivity
    // handed in by `executeQuery`.
    return (input, declaredSensitivity) => {
      const cap = mintEgressCapability(
        { runId },
        { operation: "generateText", model: GEN_MODEL, maxBytes: 1_000_000, maxTokens: 100_000, costCeiling: 1_000_000, allowedSensitivity: declaredSensitivity },
        { secret: h.capabilitySecret },
      );
      return models.generateText({ model: GEN_MODEL, prompt: { ref: "prompts/synthesize@1" }, input, maxTokens: 256 }, cap, { declaredSensitivity });
    };
  }

  function ledgerCounts(runId: string): Record<string, number> {
    const q = (sql: string): number => (store.db.prepare(sql).get(runId) as { n: number }).n;
    return {
      agentRuns: q(`SELECT COUNT(*) AS n FROM agent_runs WHERE run_id = ?`),
      retrievalRuns: q(`SELECT COUNT(*) AS n FROM retrieval_runs WHERE run_id = ?`),
      retrievalResults: (store.db.prepare(`SELECT COUNT(*) AS n FROM retrieval_results r JOIN retrieval_runs rr ON rr.retrieval_id = r.retrieval_id WHERE rr.run_id = ?`).get(runId) as { n: number }).n,
      modelCalls: q(`SELECT COUNT(*) AS n FROM model_calls WHERE run_id = ?`),
      readonlyEvents: q(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND event_type = 'run.readonly'`),
    };
  }

  it("an answered query records exactly one run.readonly + complete correlated rows; no canonical/worktree mutation", async () => {
    const canonicalBefore = h.git(["rev-parse", "refs/heads/main"]);
    const { models, receipts } = modelsOver(new EgressService({ adapter: fakeEmbedGenAdapter("Meridian is discussed in [[alpha]]."), quarantine: memQuarantine(), capabilitySecret: h.capabilitySecret }));
    const runId = newRunId();

    const exec = await executeQuery({
      runId,
      args: parseQueryArgs(["meridian"]),
      retrieval: retrievalDeps(models, runId),
      generate: generateWith(models, runId),
      getReceipts: () => receipts,
      packBudget: 6000,
      baseSensitivity: "internal",
      now: NOW,
    });

    // Output shape (answered).
    expect(exec.output.mode).toBe("answered");
    expect(exec.output.answer).toContain("[[alpha]]");
    expect(exec.output.modelCalls).toBe(1); // generation-step count
    expect(exec.output.items.map((i) => i.noteId)).toContain("alpha");
    expect(exec.output.items.find((i) => i.noteId === "alpha")!.citation).toBe(true);
    // Two provider transmissions: the query embed + the answer generation.
    expect(receipts).toHaveLength(2);
    expect(receipts.filter((r) => r.operation === "embed")).toHaveLength(1);
    expect(receipts.filter((r) => r.operation === "generateText")).toHaveLength(1);

    // Finalize the correlated rows as ONE run.readonly.
    const broker = await BrokerClient.connect(h.socketPath);
    let res;
    try {
      res = await recordReadonlyRun("run.readonly", "query", store, broker, { backup: h.backup, runId, ledgerWrite: exec.ledgerWrite, now: NOW });
    } finally {
      broker.close();
    }
    expect(res.recorded).toBe(true);

    const counts = ledgerCounts(runId);
    expect(counts).toEqual({ agentRuns: 1, retrievalRuns: 1, retrievalResults: 1, modelCalls: 2, readonlyEvents: 1 });
    // model_calls operations: one embed, one synthesize (the grounded answer).
    const ops = (store.db.prepare(`SELECT operation FROM model_calls WHERE run_id = ? ORDER BY operation`).all(runId) as { operation: string }[]).map((r) => r.operation);
    expect(ops).toEqual(["embed", "synthesize"]);
    // The ledger still verifies (run.readonly recognized as the read-run terminal).
    expect(store.verify().ok).toBe(true);

    // NO canonical/worktree mutation.
    expect(h.git(["rev-parse", "refs/heads/main"])).toBe(canonicalBefore);
    expect(h.git(["status", "--porcelain"])).toBe("");
    expect(readdirSync(h.worktreesPath)).toHaveLength(0);
  });

  it("--no-answer STILL records the embed model_call (every provider call accounted), and no generation row", async () => {
    const { models, receipts } = modelsOver(new EgressService({ adapter: fakeEmbedGenAdapter("unused"), quarantine: memQuarantine(), capabilitySecret: h.capabilitySecret }));
    const runId = newRunId();

    const exec = await executeQuery({
      runId,
      args: parseQueryArgs(["meridian", "--no-answer"]),
      retrieval: retrievalDeps(models, runId),
      generate: generateWith(models, runId),
      getReceipts: () => receipts,
      packBudget: 6000,
      baseSensitivity: "internal",
      now: NOW,
    });

    expect(exec.output.mode).toBe("retrieval-only");
    expect(exec.output.answer).toBeUndefined();
    expect(exec.output.modelCalls).toBeUndefined();
    // The embed transmission happened (statistical retrieval), the generation did NOT.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.operation).toBe("embed");

    const broker = await BrokerClient.connect(h.socketPath);
    try {
      await recordReadonlyRun("run.readonly", "query", store, broker, { backup: h.backup, runId, ledgerWrite: exec.ledgerWrite, now: NOW });
    } finally {
      broker.close();
    }
    const counts = ledgerCounts(runId);
    // Exactly one model_calls row — the embed — even though generation was skipped.
    expect(counts).toEqual({ agentRuns: 1, retrievalRuns: 1, retrievalResults: 1, modelCalls: 1, readonlyEvents: 1 });
    expect((store.db.prepare(`SELECT operation FROM model_calls WHERE run_id = ?`).get(runId) as { operation: string }).operation).toBe("embed");
    expect(store.verify().ok).toBe(true);
  });

  it("F1: a ledger-WRITING read is STRICT — an unreachable broker FAILS the command, never a silent best-effort skip", async () => {
    // A ctx whose AUDIT broker socket does not exist (everything else — backup custody,
    // lent store — valid), so the run fails at broker-connect.
    const badCtx = h.runContext();
    (badCtx as unknown as { config: { config: { broker: { socket_path: string } } } }).config.config.broker.socket_path =
      join(dir, "no-such-broker.sock");

    // Ledger-WRITING read (non-empty ledgerWrite) ⇒ STRICT ⇒ THROWS (never exit-0
    // without the durable audit + rows).
    await expect(
      runReadAudit(badCtx, "run.readonly", "query", store, {
        runId: newRunId(),
        ledgerWrite: [{ sql: "SELECT 1", params: [] }],
        strictBackup: true,
      }),
    ).rejects.toThrow(/broker/i);

    // Contrast: a PURE diagnostic read (empty ledgerWrite) DEGRADES on the same fault —
    // its summary is never gated on the audit.
    const pure = await runReadAudit(badCtx, "run.readonly", "inspect", store, { runId: newRunId() });
    expect(pure.recorded).toBe(false);
    expect(pure.degraded).toBe("broker-unreachable");
  });

  it("F3: a transmission that happened before a failure is STILL accounted — model_calls under a run.failed terminal, verify-clean", async () => {
    const { models, receipts } = modelsOver(
      new EgressService({ adapter: fakeEmbedGenAdapter("unused"), quarantine: memQuarantine(), capabilitySecret: h.capabilitySecret }),
    );
    const runId = newRunId();
    const embedCap = mintEgressCapability(
      { runId },
      { operation: "embed", model: CFG.embedding_model, maxBytes: 1_000_000, maxTokens: 100_000, costCeiling: 1_000_000, allowedSensitivity: "internal" },
      { secret: h.capabilitySecret },
    );
    // Two real transmissions reach the broker (each emits a receipt) before the failure.
    await models.embed({ texts: ["meridian"], dimensions: DIMS, model: CFG.embedding_model }, embedCap);
    await models.embed({ texts: ["again"], dimensions: DIMS, model: CFG.embedding_model }, embedCap);
    expect(receipts).toHaveLength(2);

    await recordFailedTransmissions(h.runContext(), store, runId, receipts, "provider exploded", NOW);

    // Both transmissions accounted: 2 model_calls rows under ONE run.failed terminal.
    const modelCalls = (store.db.prepare(`SELECT COUNT(*) AS n FROM model_calls WHERE run_id = ?`).get(runId) as { n: number }).n;
    expect(modelCalls).toBe(2);
    const ar = store.db.prepare(`SELECT status, failed_checkpoint FROM agent_runs WHERE run_id = ?`).get(runId) as {
      status: string;
      failed_checkpoint: string | null;
    };
    expect(ar.status).toBe("failed");
    expect(ar.failed_checkpoint).not.toBeNull(); // CHECK: failed ⇒ failed_checkpoint NOT NULL
    const failedEvents = (store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND event_type = 'run.failed'`).get(runId) as { n: number }).n;
    expect(failedEvents).toBe(1);
    expect(store.verify().ok).toBe(true);
  });

  it("F3: nothing transmitted ⇒ no run.failed terminal is written (a resolution error before any embed)", async () => {
    const runId = newRunId();
    await recordFailedTransmissions(h.runContext(), store, runId, [], "ambiguity refused pre-embed", NOW);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE run_id = ?`).get(runId) as { n: number }).n).toBe(0);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ?`).get(runId) as { n: number }).n).toBe(0);
  });

  it("parseQueryArgs parses text, --k, --type, and --no-answer", () => {
    expect(parseQueryArgs(["hello world"])).toEqual({ text: "hello world", k: undefined, type: undefined, answer: true });
    expect(parseQueryArgs(["q", "--k", "5", "--type", "source", "--no-answer"])).toEqual({ text: "q", k: 5, type: "source", answer: false });
    expect(() => parseQueryArgs([])).toThrow();
    expect(() => parseQueryArgs(["q", "--nope"])).toThrow();
  });
});
