/**
 * `enrich.e2e` (Task 4.11) — the CAPSTONE integration for the model-authored enrichment command's
 * READ path, assembled from the SAME production seams the `enrich` command wires:
 *
 *   - `makeRetrieveSeam` over a REAL LanceDB index + a REAL `EgressService` embedder (the vector
 *     layer resolves the seeded note; the internal embed capability is minted through the shared
 *     secret resolver, exactly as the command does — no explicit-secret shortcut);
 *   - `makeModelPlanGenerator` over the SAME egress service's `generateObject` (a deterministic
 *     adapter returns a schema-valid `ChangePlan`, validated by the ModelsClient registry);
 *   - `makeStoreValidationVault` over the real migrated projections.
 *
 * It drives `previewSynthesis("enrich", …)` end-to-end and asserts the retrieval-first plan flows
 * through generation → validation → patch → effective-risk against real infrastructure. (The apply
 * → Tier-2 broker canonical-install half is proven by `broker-integrator.e2e` + `synthesis-apply.e2e`.)
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { newRunId, type ChangePlan, type ParsedNote } from "@atlas/contracts";
import { ModelsClient, createInProcessInvoker, type ModelCallReceipt, type ProviderAdapter, type Usage } from "@atlas/models";
import { openStore, registerGenerationMigration, type Store } from "@atlas/sqlite-store";
import { assembleRows, chunkNote, generationId, indexingConfigKey, openSearchTable, writeGeneration, type IndexingConfig, type SearchTable } from "@atlas/lancedb-index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePhase2Harness, type Phase2Harness } from "./phase2-support.js";
import { makeRetrieveSeam } from "../../src/retrieval/wiring.js";
import { makeModelPlanGenerator } from "../../src/workflows/model-plan-generator.js";
import { makeStoreValidationVault } from "../../src/validation/store-vault.js";
import { previewSynthesis, type SynthesisPlanDeps } from "../../src/workflows/synthesis.js";
import { buildSectionTree } from "../../src/markdown/sections.js";
import { splitFrontmatter } from "../../src/markdown/parse.js";
import type { RunContext } from "../../src/handlers.js";

const DIMS = 3;
const CFG: IndexingConfig = { chunker_version: 1, embedding_model: "test-embed", dimensions: DIMS };
const GEN_MODEL = "test-gen";
const NOW = (): string => "2026-07-16T00:00:00.000Z";

/** The ChangePlan the fake `generateObject` returns — a clean, patchable AppendSection enrichment. */
const RETURNED_PLAN: ChangePlan = {
  target: "alpha", rationale: "enrich alpha with a log entry", sourceIds: [], retrievedEvidence: [],
  confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1,
  operation: { op: "AppendSection", opVersion: 1, content: "Enriched detail about meridian.", createIfAbsent: true, selector: { path: "Log" } },
} as ChangePlan;

/** Deterministic adapter: embed → unit vector `[1,0,0]`; generateObject → the ChangePlan. */
function fakeEmbedObjectAdapter(): ProviderAdapter {
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
      return { result: RETURNED_PLAN, usage, model: g.model };
    },
    costMicros: (_m, u) => u.inputTokens + (u.outputTokens ?? 0) + 1,
  };
}

function modelsOver(adapter: ProviderAdapter): { models: ModelsClient; receipts: ModelCallReceipt[] } {
  const receipts: ModelCallReceipt[] = [];
  const models = new ModelsClient(createInProcessInvoker({ adapter }), (r: ModelCallReceipt) => { receipts.push(r); });
  return { models, receipts };
}

function alphaNote(): ParsedNote {
  const raw = `---\nid: alpha\ntype: concept\nschema_version: 1\ntitle: Alpha\nstatus: active\ncreated: 2026-07-16\nupdated: 2026-07-16\n---\n# Alpha\n\nAlpha content about meridian.\n`;
  const { body } = splitFrontmatter(raw);
  return { id: "alpha", path: "alpha.md", type: "concept", schemaVersion: 1, title: "Alpha", status: "active", created: "2026-07-16", updated: "2026-07-16", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "h-alpha", raw };
}

describe("enrich.e2e — retrieval-first plan over a real index + egress (Task 4.11)", () => {
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

    dir = await mkdtemp(join(tmpdir(), "atlas-enrich-"));
    conn = await lancedb.connect(dir);
    table = await openSearchTable(conn, CFG);

    store.db.prepare(
      `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
       VALUES ('alpha','alpha','Alpha','concept',1,'active','alpha.md','h-alpha','2026-07-16T00:00:00Z','2026-07-16T00:00:00Z')`,
    ).run();
    store.db.prepare(`INSERT INTO note_identity_keys (normalized_key, note_id, kind, normalizer_version) VALUES ('alpha','alpha','slug',1)`).run();
    const note = alphaNote();
    const chunks = chunkNote(note, CFG);
    const gen = generationId(note, CFG);
    await writeGeneration(table, assembleRows(chunks, chunks.map(() => [1, 0, 0]), CFG, gen));
    store.generation.adoptConfig(indexingConfigKey(CFG));
    expect(store.activateGeneration("alpha", gen, "h-alpha", indexingConfigKey(CFG))).toBe(true);
  });

  afterEach(async () => {
    store.close();
    await h.cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A RunContext whose lancedb dir + indexing config point at the seeded index. */
  function ctxForIndex(): RunContext {
    const ctx = h.runContext();
    const cfg = (ctx as unknown as { config: { config: Record<string, unknown> } }).config.config;
    cfg.lancedb = { dir };
    cfg.indexing = { chunker_version: CFG.chunker_version, embedding_model: CFG.embedding_model, dimensions: CFG.dimensions };
    cfg.retrieval = { rrf: { k: 60, weights: { fts: 1, vector: 1 } }, fts: { enabled: false } };
    return ctx;
  }

  it("previewSynthesis('enrich') grounds on the real index, generates + validates a ChangePlan, and materializes a patch — no sinks touched", async () => {
    const canonicalBefore = h.git(["rev-parse", "refs/heads/main"]);
    const { models, receipts } = modelsOver(fakeEmbedObjectAdapter());
    const runId = newRunId();

    const retrieve = await makeRetrieveSeam({
      ctx: ctxForIndex(), store, models, indexingCfg: CFG,
      rrf: { k: 60, weights: { fts: 1, vector: 1 } }, fts: { enabled: false },
      defaultSensitivity: "internal", runId, now: NOW,
    });
    const generatePlan = makeModelPlanGenerator({
      models, model: GEN_MODEL, maxTokens: 4096,
    });
    const note = alphaNote();
    const deps: SynthesisPlanDeps = {
      retrieve, generatePlan,
      readNote: (id) => (id === "alpha" ? note : null),
      validationVault: makeStoreValidationVault(store.db),
      supportingEvidenceStates: () => [],
      inputsTrusted: () => true,
      evidenceValid: () => true,
      config: { packBudgetTokens: 6000, requireSourcesForSynthesis: false, risk: { minConfidence: 0.8, maxChangedLines: 50, maxSections: 3 } },
    };

    const preview = await previewSynthesis("enrich", { target: "alpha", instruction: "enrich note alpha" }, deps);

    // Retrieval-first: a real retrieval ran and grounded the plan.
    expect(preview.mode).toBe("preview");
    expect(typeof preview.plan.retrievalRunId).toBe("string");
    // The model's ChangePlan flowed through (validated against the ChangePlan registry schema).
    expect(preview.plan.changePlan.target).toBe("alpha");
    expect(preview.plan.changePlan.operation.op).toBe("AppendSection");
    // Validation ran and the clean, patchable op materialized a patch.
    expect(preview.plan.report.ok).toBe(true);
    expect(preview.plan.patch).not.toBeNull();
    expect(["tier-1", "tier-2", "tier-3"]).toContain(preview.plan.tier);
    // Two provider transmissions reached the real egress: the query embed + the generateObject.
    expect(receipts.filter((r) => r.operation === "embed")).toHaveLength(1);
    expect(receipts.filter((r) => r.operation === "generateObject")).toHaveLength(1);

    // A preview touches NO sink: canonical ref unchanged.
    expect(h.git(["rev-parse", "refs/heads/main"])).toBe(canonicalBefore);
  });
});
