/**
 * `retrieval/wiring` — the reusable retrieval-deps assembly (Task 4.11). Both `brain query`
 * (Task 3.4) and the synthesis commands (enrich/reconcile/maintain) need the SAME retrieval
 * pipeline wired to real state: the LanceDB search table, the projection-backed identity resolver +
 * note metadata, the config index-generation, and an egress-broker embedder. This module assembles
 * those into a `retrieve(query) → RetrievalResult` seam so the synthesis pipeline's retrieval-first
 * stage runs against the real index. Read-only.
 */
import * as lancedb from "@lancedb/lancedb";
import { openSearchTable, embedderFromClient, indexingConfigKey, type SearchTable, type IndexingConfig } from "@atlas/lancedb-index";
import { mintEgressCapability, ModelsClient, type EgressLimits } from "@atlas/models";
import { newRunId } from "@atlas/contracts";
import type { Store } from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";
import { resolvePath } from "../commands/backup-config.js";
import type { RunContext } from "../handlers.js";
import { retrieve, type IdentityResolver, type NoteMeta, type RetrievalDeps, type RetrievalResult } from "./layers.js";

const EGRESS_MAX_BYTES = 1_000_000;
const EGRESS_MAX_TOKENS = 200_000;
const EGRESS_COST_CEILING = 1_000_000;

/** The projection-backed identity resolver (id / slug / alias). */
export function storeResolver(store: Store): IdentityResolver {
  return {
    resolveExactId: (raw) => (store.db.prepare(`SELECT note_id FROM notes WHERE note_id = ?`).get(raw) as { note_id: string } | undefined)?.note_id ?? null,
    resolveSlug: (key) => (store.db.prepare(`SELECT note_id FROM note_identity_keys WHERE normalized_key = ? AND kind = 'slug'`).all(key) as { note_id: string }[]).map((r) => r.note_id),
    resolveAlias: (key) => (store.db.prepare(`SELECT note_id FROM note_identity_keys WHERE normalized_key = ? AND kind = 'alias'`).all(key) as { note_id: string }[]).map((r) => r.note_id),
  };
}

/** The projection-backed note metadata (type + a fail-closed default sensitivity/trust). */
export function storeNoteMeta(store: Store, defaultSensitivity: string): (noteId: string) => NoteMeta | null {
  const stmt = store.db.prepare(`SELECT type FROM notes WHERE note_id = ?`);
  return (noteId) => {
    const row = stmt.get(noteId) as { type: string } | undefined;
    return row === undefined ? null : { type: row.type, sensitivity: defaultSensitivity, trust: "verified" };
  };
}

/** The config epoch the retrieval ran against (the 0008 adoption log, else newest active generation). */
export function computeIndexGeneration(store: Store, cfg: IndexingConfig): number {
  const hasLog = store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'index_config_revisions'`).get() !== undefined;
  if (hasLog) return store.generation.configRevisionFor(indexingConfigKey(cfg));
  return (store.db.prepare(`SELECT COALESCE(MAX(active_generation), 0) AS g FROM notes`).get() as { g: number }).g;
}

/** Open the LanceDB search table, mapping an absent index to the contract `index-unavailable` (exit 2). */
export async function openTableForCtx(ctx: RunContext, cfg: IndexingConfig): Promise<SearchTable> {
  try {
    return await openSearchTable(await lancedb.connect(resolvePath(ctx, ctx.config.config.lancedb.dir)), cfg);
  } catch (e) {
    throw new CliError({ code: "index-unavailable", message: `the LanceDB index at ${ctx.config.config.lancedb.dir} is not available: ${e instanceof Error ? e.message : String(e)}`, hint: "Run `brain index rebuild` to (re)build the retrieval index.", exitCode: EXIT.CONFIG, cause: e });
  }
}

/** The seams a retrieve closure needs assembled. */
export interface RetrieveSeamDeps {
  readonly ctx: RunContext;
  readonly store: Store;
  readonly models: ModelsClient;
  readonly indexingCfg: IndexingConfig;
  readonly rrf: RetrievalDeps["config"]["rrf"];
  readonly fts: RetrievalDeps["config"]["fts"];
  readonly defaultSensitivity: string;
  /** The run id every retrieval + embed receipt attributes to. */
  readonly runId: string;
  readonly now: () => string;
}

/**
 * Build the production retrieve seam `(query) → RetrievalResult` for the synthesis pipeline. Opens
 * the LanceDB table, mints a run-bound embed capability, and wires the projection resolver/metadata
 * + generation set. Records nothing to the ledger itself (a no-op recorder) — the synthesis run's
 * own ledger write owns provenance; this only performs the read.
 */
export async function makeRetrieveSeam(deps: RetrieveSeamDeps): Promise<(query: { text: string; k?: number; filters?: { type?: string } }) => Promise<RetrievalResult>> {
  const table = await openTableForCtx(deps.ctx, deps.indexingCfg);
  const embedLimits: EgressLimits = { operation: "embed", model: deps.indexingCfg.embedding_model, maxBytes: EGRESS_MAX_BYTES, maxTokens: EGRESS_MAX_TOKENS, costCeiling: EGRESS_COST_CEILING, allowedSensitivity: "internal" };
  const embed = embedderFromClient(deps.models, mintEgressCapability({ runId: deps.runId }, embedLimits), deps.indexingCfg);
  const base: Omit<RetrievalDeps, "recorder" | "runId"> = {
    config: { rrf: deps.rrf, fts: deps.fts },
    resolver: storeResolver(deps.store),
    table,
    activeGenerationIds: () => deps.store.generation.activeGenerationIds(),
    activeGenerationId: (noteId) => deps.store.generation.activeGenerationId(noteId),
    embed,
    noteMeta: storeNoteMeta(deps.store, deps.defaultSensitivity),
    indexGeneration: computeIndexGeneration(deps.store, deps.indexingCfg),
    newRetrievalId: () => newRunId(),
    now: deps.now,
  };
  return (query) =>
    retrieve(
      { text: query.text, ...(query.k !== undefined ? { k: query.k } : {}), ...(query.filters ? { filters: query.filters } : {}) },
      { ...base, recorder: { record: () => {} }, runId: deps.runId },
    );
}
