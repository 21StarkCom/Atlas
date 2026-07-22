/**
 * `brain query <text>` (Task 3.4 / #41) — the Tier-0 grounded-answer command.
 *
 * Pipeline (retrieval-index-contract §5, plan §Phase-3 Task 3.4):
 *
 *   retrieve  →  packed context  →  generateText grounded answer citing note ids
 *
 * Retrieval resolves the query through the layer precedence (exact id → slug →
 * unique alias → fts/vector RRF fusion, over the SQLite-active generation only),
 * packs a section-aware, token-bounded context, and — unless `--no-answer` — sends
 * it to the egress broker's `generateText` for a grounded answer that cites the
 * backing note ids. The response is a discriminated union on `mode`: `answered`
 * (default) or `retrieval-only` (`--no-answer`).
 *
 * ## Audit + accounting (the load-bearing acceptance — `query.audit-readonly.test`)
 * An executed query is an AUDITED READ. It records its correlated ledger rows —
 * `retrieval_runs` (one), `retrieval_results` (one per fused note), and `model_calls`
 * (one per egress transmission) — and emits EXACTLY ONE terminal `run.readonly`
 * event. Every row + the event land through a SINGLE {@link finalizeLedgerWrite}
 * (via 1.9's {@link runReadAudit}/`recordReadonlyRun`, extended to carry the business
 * `ledgerWrite`): the §2.8 sequence (intent txn → broker audit append → atomic ledger
 * commit → backup/watermark) is the ONLY write path — this command never writes a
 * ledger table directly. A post-run backup applies because the run wrote rows.
 *
 * ## Every provider call is accounted (carry-forward #4)
 * `model_calls` records EVERY egress transmission, not just the answer generation:
 * the statistical retrieval path calls `models.embed` for the query vector, and every
 * transmission emits a receipt → one `model_calls` row. So a `--no-answer` statistical
 * query still records the embed `model_calls` row (it merely skips the generation
 * call). An answered statistical query records both (embed + generation); an identity
 * short-circuit embeds nothing (it never spends a query-vector call). The JSON
 * `modelCalls` field counts the GENERATION calls only (contract; present iff answered),
 * while the ledger table accounts every transmission.
 *
 * ## No canonical/worktree/projection mutation (review hint)
 * The command opens the ledger read-write to append its audit + business rows, but it
 * NEVER touches canonical git, a worktree, or the notes/index projection. The single
 * `run.readonly` event installs no canonical ref move (the broker refuses the
 * canonical-installing kinds for this path), and the ledger write is confined to the
 * read-class tables above — asserted byte-for-byte across every sink by the test.
 *
 * ## A ledger-writing read is a STRICT audit (round-2 finding F1)
 * Unlike a pure diagnostic read (`inspect`/`status`, whose `run.readonly` is best-effort
 * and backup-coalesced), `query` WRITES business rows, so its terminal audit is STRICT +
 * NON-COALESCING with a MANDATORY covering backup: a failed finalize or a failed covering
 * backup FAILS the command (never an exit-0 answer without the `run.readonly` + correlated
 * rows, and never a coalesced skip of the contractually-required post-run backup).
 *
 * ## Every transmission is accounted, even on failure (round-2 finding F3)
 * `@atlas/models` emits a receipt for EVERY transmission — success, refusal, OR provider
 * error — before the call returns/throws. So a refused/errored embed or generation still
 * produced a receipt; the command preserves those failure receipts through the terminal
 * audit path (one `model_calls` row each) BEFORE surfacing the mapped error, so no
 * transmission is silently discarded.
 *
 * ## Sensitivity-bound export (D19, round-2 finding F4)
 * The generation exports the PACKED PAYLOAD, so its declared sensitivity is the
 * EFFECTIVE sensitivity of that payload — the most-restrictive class across the query
 * text and every packed note — and the generation capability is minted with a matching
 * `allowedSensitivity` ceiling. A confidential/restricted note therefore can never be
 * exported under a falsely-lower `internal` label.
 *
 * ## The read-run's `agent_runs` parent (a `model_calls` FK requirement)
 * `model_calls.run_id` and `retrieval_runs.run_id` carry enforced FKs into
 * `agent_runs` (`0001_core`, `PRAGMA foreign_keys = ON`). A query that transmits to
 * the model therefore needs an `agent_runs` parent, so the run records ONE `agent_runs`
 * row (operation `retrieve`, terminal status `finalized`) keyed on the invocation
 * `runId` — the SAME id bound into every capability/receipt and anchoring the
 * `run.readonly` event, so the whole run correlates under one id. A `finalized` read
 * run is excluded from `brain status` open-runs and — because `db verify`'s
 * cardinality invariant recognizes `run.readonly` as a terminal (plan §2.5 audit SSOT)
 * — verifies clean without a workflow install event.
 */
import * as lancedb from "@lancedb/lancedb";
import { newRunId } from "@atlas/contracts";
import {
  embedderFromClient,
  indexingConfigKey,
  openSearchTable,
  type IndexingConfig,
  type SearchTable,
} from "@atlas/lancedb-index";
import {
  ModelsClient,
  createInProcessInvoker,
  buildModelCallStatement,
  ProviderCallError,
  EgressRefusal,
  PROMPT_REFS,
  type GenerateTextResult,
  type ModelCallReceipt,
} from "@atlas/models";
import { BrokerClient } from "@atlas/broker";
import {
  assertBackupHealthy,
  BackupUnhealthyError,
  finalizeLedgerWrite,
  type LedgerStatement,
  type Store,
} from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { resolvePath, backupConfig } from "./backup-config.js";
import { agentRunUpsert } from "../workflows/checkpoints.js";
import { runReadAudit } from "../audit/readonly.js";
import {
  retrieve,
  AmbiguousNoteError,
  QueryEmbedError,
  type IdentityResolver,
  type NoteMeta,
  type RetrievalDeps,
  type RetrievalResult,
  type RetrievalResultRecord,
  type RetrievalRunRecord,
} from "../retrieval/layers.js";
import { packContext } from "../retrieval/pack.js";

// ---------------------------------------------------------------------------
// Tuning constants (owned here; no config field exists for the pack/generation
// budgets — plan §Phase-3 leaves them command-local). A whole packed context is
// bounded to keep the grounded-answer prompt within the model's window; the
// generation cap bounds the answer length.
// ---------------------------------------------------------------------------

/** Token budget for the packed context handed to the grounded-answer step. */
const PACK_TOKEN_BUDGET = 6000;
/** `maxTokens` for the grounded-answer generation (required positive int).
 * Gemini 3.5 spends its THINKING tokens inside `maxOutputTokens` (live-measured
 * ~1000-1100 thought tokens per grounded answer), so the cap must fit thinking +
 * answer. 1024 truncated every answer at MAX_TOKENS (#211); 4096 verified live:
 * finishReason STOP with a complete cited answer. */
const GENERATION_MAX_TOKENS = 4096;
/** The versioned egress prompt for grounded synthesis (broker PROMPT_REFS SSOT). */
const ANSWER_PROMPT_REF = PROMPT_REFS.synthesize;


// ---------------------------------------------------------------------------
// Args.
// ---------------------------------------------------------------------------

/** The parsed `query` invocation (flags per `query.schema.json` `x-atlas-contract`). */
export interface ParsedQueryArgs {
  readonly text: string;
  readonly k: number | undefined;
  readonly type: string | undefined;
  /** `answered` (default) vs `retrieval-only` (`--no-answer`). */
  readonly answer: boolean;
}

/** Parse `query`'s residual argv: `<text>` + `--k <n>` / `--type <t>` / `--no-answer`. */
export function parseQueryArgs(argv: string[]): ParsedQueryArgs {
  let text: string | undefined;
  let k: number | undefined;
  let type: string | undefined;
  let answer = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-answer") answer = false;
    else if (a === "--k") {
      const v = argv[++i];
      if (v === undefined) throw CliError.usage("`--k` requires a value");
      k = parseK(v);
    } else if (a.startsWith("--k=")) k = parseK(a.slice("--k=".length));
    else if (a === "--type") {
      type = argv[++i];
      if (type === undefined) throw CliError.usage("`--type` requires a value");
    } else if (a.startsWith("--type=")) type = a.slice("--type=".length);
    else if (a.startsWith("-")) throw CliError.usage(`unknown flag for \`query\`: ${a}`);
    else if (text === undefined) text = a;
    // Additional bare words are appended to the query text (a multi-word query
    // passed without quotes still forms one natural-language question).
    else text = `${text} ${a}`;
  }
  if (text === undefined || text.length === 0) throw CliError.usage("`query` requires a <text> argument");
  return { text, k, type, answer };
}

/** Parse + range-check `--k` (the deeper 1..100 bound is re-enforced in `retrieve`). */
function parseK(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw CliError.usage(`--k must be an integer (got ${v})`);
  return n;
}

// ---------------------------------------------------------------------------
// The JSON success output (`query.schema.json`).
// ---------------------------------------------------------------------------

interface QueryItemOutput {
  readonly noteId: string;
  readonly sectionPath: string;
  readonly score: number;
  readonly contributions: RetrievalResult["items"][number]["contributions"];
  /** Present iff answered: whether the answer cites this note. */
  readonly citation?: boolean;
}

interface QueryOutput {
  readonly command: "query";
  readonly mode: "answered" | "retrieval-only";
  readonly query: string;
  readonly answer?: string;
  /** Present iff answered AND the provider cut the answer (finishReason != STOP). */
  readonly truncated?: true;
  readonly modelCalls?: number;
  readonly items: QueryItemOutput[];
  readonly layersUsed: RetrievalResult["layersUsed"];
  readonly retrievalRunId: string;
  readonly degraded: boolean;
}

// ---------------------------------------------------------------------------
// The testable orchestration core (deps injected; no ctx, no sockets).
// ---------------------------------------------------------------------------

/** Everything {@link executeQuery} needs, injected so the acceptance suite drives it
 * against real in-process seams (real LanceDB + SQLite + egress + broker) with no
 * live provider. */
export interface QueryExecDeps {
  /** The single correlating run id (the invocation ULID) shared by the audit event,
   * `agent_runs`, `retrieval_runs`, and every `model_calls` receipt. */
  readonly runId: string;
  readonly args: ParsedQueryArgs;
  /** The retrieval seams (recorder + runId are supplied HERE, not by the caller). */
  readonly retrieval: Omit<RetrievalDeps, "recorder" | "runId">;
  /** The grounded-answer generation call (a `models.generateText` closure). Invoked
   * ONLY in answered mode. */
  readonly generate: (input: string) => Promise<GenerateTextResult>;
  /** Read the receipts collected so far across every transmission (embed +
   * generation) — the `model_calls` source. */
  readonly getReceipts: () => readonly ModelCallReceipt[];
  /** Token budget for context packing. */
  readonly packBudget: number;
  readonly now: () => string;
}

/** The outcome of {@link executeQuery}: the JSON output + the correlated ledger
 * rows to finalize (NOT yet written — the caller funnels them through the single
 * `finalizeLedgerWrite`/`run.readonly` audit path). */
export interface QueryExecResult {
  readonly output: QueryOutput;
  readonly ledgerWrite: LedgerStatement[];
}

/**
 * Run the retrieve → pack → (generate) pipeline and PRODUCE the correlated ledger
 * rows — WITHOUT writing them. The caller records them + the single `run.readonly`
 * event atomically via {@link runReadAudit}. Pure of audit/socket wiring so the
 * acceptance suite can drive it directly.
 */
export async function executeQuery(deps: QueryExecDeps): Promise<QueryExecResult> {
  const { runId, args, now } = deps;

  // Capture the retrieval records the retriever produces (its recorder seam). The
  // retriever NEVER writes ledger tables (plan §2.8); we fold what it produced into
  // the single audited finalize below.
  let runRecord: RetrievalRunRecord | undefined;
  let resultRecords: readonly RetrievalResultRecord[] = [];
  const recorder: RetrievalDeps["recorder"] = {
    record(run, results) {
      runRecord = run;
      resultRecords = results;
    },
  };

  // Retrieve. `runId` correlates `retrieval_runs.run_id` with this run's `agent_runs`
  // + `model_calls`. The embed (statistical path) happens INSIDE here and emits its
  // receipt through the shared sink; identity / empty-index short-circuits embed nothing.
  const result = await retrieve(
    { text: args.text, ...(args.k !== undefined ? { k: args.k } : {}), filters: { ...(args.type !== undefined ? { type: args.type } : {}) } },
    { ...deps.retrieval, recorder, runId },
  );
  if (runRecord === undefined) {
    // `retrieve` always records exactly one run; a missing record is a programming error.
    throw CliError.internal("retrieval produced no run record");
  }

  // Pack the section-aware context.
  const pack = packContext(result, { maxTokens: deps.packBudget });

  // Grounded answer (answered mode only). A generation call happens even when no
  // context met the threshold — the model reports the absence — so answered mode
  // always records exactly one generation `model_calls` row (schema: modelCalls >= 1).
  let answer: string | undefined;
  let generationCalls = 0;
  let truncated = false;
  if (args.answer) {
    const gen = await deps.generate(buildAnswerInput(args.text, pack));
    answer = gen.text;
    generationCalls = 1;
    // A non-STOP finish means the provider cut the answer (MAX_TOKENS etc.) —
    // surface it instead of releasing a fragment as a complete answer (#211).
    truncated = gen.finishReason !== undefined && gen.finishReason !== "STOP";
  }

  // Citations: which retrieved notes the answer cites. A citation is an EXACT
  // `[[note-id]]` token (round-2 finding F5) — never a bare substring — so ordinary
  // prose or a longer id that merely CONTAINS a shorter one cannot falsely mark an
  // item cited. Only meaningful in answered mode.
  const cited =
    answer !== undefined ? citedNoteIds(answer, result.items.map((it) => it.noteId)) : new Set<string>();

  const items: QueryItemOutput[] = result.items.map((it) => ({
    noteId: it.noteId,
    sectionPath: it.sectionPath,
    score: it.score,
    contributions: it.contributions,
    ...(answer !== undefined ? { citation: cited.has(it.noteId) } : {}),
  }));

  const output: QueryOutput = {
    command: "query",
    mode: args.answer ? "answered" : "retrieval-only",
    query: args.text,
    ...(answer !== undefined ? { answer, modelCalls: generationCalls } : {}),
    ...(truncated ? { truncated: true as const } : {}),
    items,
    layersUsed: result.layersUsed,
    retrievalRunId: result.retrievalRunId,
    degraded: result.degraded,
  };

  // Build the correlated ledger rows. ORDER MATTERS under the enforced FKs: the
  // `agent_runs` parent MUST precede its `retrieval_runs` + `model_calls` children,
  // and `retrieval_runs` MUST precede `retrieval_results` (all applied in array order
  // inside the one finalize transaction).
  const ledgerWrite: LedgerStatement[] = [
    agentRunStatement(runId, now()),
    retrievalRunStatement(runRecord),
    ...resultRecords.map((r) => retrievalResultStatement(runRecord!.retrievalId, r)),
    // EVERY egress transmission (embed AND generation) → one `model_calls` row.
    ...deps.getReceipts().map((r) => buildModelCallStatement(r, { now, operation: operationFor(r) })),
  ];

  return { output, ledgerWrite };
}

/** The semantic `model_calls.operation` for a receipt: embeds are `embed`; a
 * grounded-answer `generateText` is `synthesize` (data-dictionary domain). */
function operationFor(receipt: ModelCallReceipt): string {
  return receipt.operation === "embed" ? "embed" : "synthesize";
}

/** Matches a single `[[note-id]]` citation token; the inner text is trimmed and
 * compared EXACTLY against the retrieved ids (round-2 finding F5). */
const CITATION_TOKEN = /\[\[\s*([^[\]]+?)\s*\]\]/g;

/**
 * The set of retrieved note ids the grounded `answer` cites, detected by EXACT
 * `[[note-id]]` tokens (round-2 finding F5). Parsing the bracketed token — rather than
 * `answer.includes(noteId)` — prevents a false positive from (a) ordinary prose that
 * happens to contain the id as a substring, or (b) a longer note id whose text
 * CONTAINS a shorter retrieved id. Only a token whose trimmed inner text equals a
 * retrieved id exactly counts.
 */
export function citedNoteIds(answer: string, noteIds: readonly string[]): Set<string> {
  const retrieved = new Set(noteIds);
  const cited = new Set<string>();
  for (const m of answer.matchAll(CITATION_TOKEN)) {
    const id = m[1]!;
    if (retrieved.has(id)) cited.add(id);
  }
  return cited;
}

/** Rank a sensitivity class most-restrictive-highest; an unrecognized label ranks as
 * the MOST restrictive (fail-closed — an unknown class is never treated as low). */
/** Assemble the grounded-answer generation input: the question + the packed notes,
 * each labeled by its citable note id + section path. The versioned synthesis prompt
 * supplies the task instructions; this is the source material. */
function buildAnswerInput(query: string, pack: ReturnType<typeof packContext>): string {
  const lines: string[] = [
    `Question: ${query}`,
    "",
    "Answer strictly from the CONTEXT below. Cite each supporting note by its id in double brackets, e.g. [[note-id]]. If the context is insufficient, say so.",
    "",
    "CONTEXT:",
  ];
  if (pack.notes.length === 0) {
    lines.push("(no notes matched the query)");
  } else {
    for (const note of pack.notes) {
      const flag = note.trust === "unverified" ? " (UNVERIFIED — do not treat as trusted)" : "";
      lines.push(`[[${note.noteId}]]${flag}`);
      for (const section of note.sections) {
        if (section.sectionPath.length > 0) lines.push(`  § ${section.sectionPath}`);
        lines.push(section.text);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Ledger-statement builders (business rows written ONLY via finalizeLedgerWrite).
// ---------------------------------------------------------------------------

/** The read-run's `agent_runs` parent (satisfies the `model_calls`/`retrieval_runs`
 * FK). Terminal `finalized` (excluded from `status` open-runs); idempotent so a
 * reconcile re-drive is a no-op. `failed_checkpoint` stays NULL (the STRICT CHECK
 * ties it to failed/cancelled only). */
function agentRunStatement(runId: string, now: string): LedgerStatement {
  return {
    sql: `INSERT INTO agent_runs (run_id, operation, status, checkpoint_seq, started_at, updated_at, finished_at)
          VALUES (?, 'retrieve', 'finalized', 0, ?, ?, ?)
          ON CONFLICT(run_id) DO NOTHING`,
    params: [runId, now, now, now],
  };
}

/** The `retrieval_runs` row (retained `0001_core`). `recall_at_10`/`mrr` stay NULL
 * (populated only by the eval harness). Idempotent on the `retrieval_id` PK. */
function retrievalRunStatement(run: RetrievalRunRecord): LedgerStatement {
  return {
    sql: `INSERT INTO retrieval_runs (retrieval_id, run_id, query_text, mode, index_generation, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(retrieval_id) DO NOTHING`,
    params: [run.retrievalId, run.runId, run.queryText, run.mode, run.indexGeneration, run.createdAt],
  };
}

/** A `retrieval_results` row (one per fused note; PK `(retrieval_id, rank)`). */
function retrievalResultStatement(retrievalId: string, r: RetrievalResultRecord): LedgerStatement {
  return {
    sql: `INSERT INTO retrieval_results (retrieval_id, rank, note_id, score, channel)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(retrieval_id, rank) DO NOTHING`,
    params: [retrievalId, r.rank, r.noteId, r.score, r.channel],
  };
}

/**
 * Account the transmissions that occurred before a failure (round-2 finding F3).
 * `@atlas/models` emits a receipt for EVERY transmission — success, refusal, OR provider
 * error — so a failed embed/generation still produced receipts. This records them as
 * `model_calls` rows (one per transmission) under a `run.failed` terminal keyed on the
 * SAME run id, so no transmission is silently discarded from the ledger. BEST-EFFORT on
 * the failure path: if the audit itself cannot land (broker/ledger outage), the ORIGINAL
 * model error is still surfaced by the caller (the egress broker's own WORM audit retains
 * the transmission) — this never masks the real failure. A no-op when nothing transmitted
 * (e.g. an identity short-circuit or an ambiguity refused before any embed).
 */
export async function recordFailedTransmissions(
  ctx: RunContext,
  store: Store,
  runId: string,
  receipts: readonly ModelCallReceipt[],
  reason: string,
  now: () => string,
): Promise<void> {
  if (receipts.length === 0) return;
  let broker: BrokerClient;
  try {
    broker = await BrokerClient.connect(ctx.config.config.broker.socket_path);
  } catch {
    return; // audit broker unreachable — surface the original error (WORM retains receipts)
  }
  try {
    const ts = now();
    await finalizeLedgerWrite(store, broker, {
      runId,
      event: {
        schemaVersion: 1,
        eventId: newRunId(),
        kind: "run.failed",
        occurredAt: ts,
        runId,
        subjects: [],
        canonicalCommit: "0".repeat(40),
        detail: { failedAt: "retrieve", reason },
      },
      ledgerWrite: [
        agentRunUpsert({
          runId,
          operation: "retrieve",
          status: "failed",
          failedCheckpoint: "retrieve",
          startedAt: ts,
          now: ts,
          finishedAt: ts,
        }),
        ...receipts.map((r) => buildModelCallStatement(r, { now, operation: operationFor(r) })),
      ],
      backup: backupConfig(ctx),
    });
  } catch {
    // Best-effort: the caller surfaces the original model error regardless.
  } finally {
    broker.close();
  }
}

// ---------------------------------------------------------------------------
// Production wiring — build the injected seams from a RunContext.
// ---------------------------------------------------------------------------

/** The `notes`+`note_identity_keys`-backed identity resolver (Task 1.4). Each
 * resolver returns the FULL candidate set at its layer so `retrieve` can refuse a
 * silent ambiguous pick (`normalized_key` is a PK, so slug/alias resolve to ≤1). */
function storeResolver(store: Store): IdentityResolver {
  return {
    resolveExactId: (raw) =>
      (store.db.prepare(`SELECT note_id FROM notes WHERE note_id = ?`).get(raw) as { note_id: string } | undefined)
        ?.note_id ?? null,
    resolveSlug: (key) =>
      (store.db.prepare(`SELECT note_id FROM note_identity_keys WHERE normalized_key = ? AND kind = 'slug'`).all(key) as {
        note_id: string;
      }[]).map((r) => r.note_id),
    resolveAlias: (key) =>
      (store.db.prepare(`SELECT note_id FROM note_identity_keys WHERE normalized_key = ? AND kind = 'alias'`).all(key) as {
        note_id: string;
      }[]).map((r) => r.note_id),
  };
}

/**
 * The `notes`-projection-backed metadata lookup. A present note surfaces its `type`
 * (drives the `--type` filter), the config's default sensitivity (a PASS-THROUGH —
 * `0001_core` projects no per-note sensitivity, so the labeled value is the config
 * default; sensitivity never filters), and `trust: "verified"`. Evidence-gated trust
 * (`unverified` when a note carries only non-`valid` evidence) is a Phase-4 claims
 * concern; in Phase 3 a projected note is surfaced verified. A MISSING projection
 * returns `null`, which `retrieve` maps to its conservative fail-closed default
 * (`unverified` + most-restrictive sensitivity) — never fail-open. */
function storeNoteMeta(store: Store, defaultSensitivity: string): (noteId: string) => NoteMeta | null {
  const stmt = store.db.prepare(`SELECT type FROM notes WHERE note_id = ?`);
  return (noteId) => {
    const row = stmt.get(noteId) as { type: string } | undefined;
    if (row === undefined) return null;
    return { type: row.type, sensitivity: defaultSensitivity, trust: "verified" };
  };
}

/** The config epoch the query ran against (`retrieval_runs.index_generation`). Reads
 * the config's live adoption epoch when the `0008` adoption log exists, else falls
 * back to the newest `notes.active_generation` (always present in `0001_core`). */
function computeIndexGeneration(store: Store, cfg: IndexingConfig): number {
  const hasLog =
    store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'index_config_revisions'`).get() !==
    undefined;
  if (hasLog) return store.generation.configRevisionFor(indexingConfigKey(cfg));
  const row = store.db.prepare(`SELECT COALESCE(MAX(active_generation), 0) AS g FROM notes`).get() as { g: number };
  return row.g;
}

/** Open the LanceDB search table, mapping an absent/unopenable index to the
 * contract's `index-unavailable` (exit 2). */
async function openTable(ctx: RunContext, cfg: IndexingConfig): Promise<SearchTable> {
  try {
    const conn = await lancedb.connect(resolvePath(ctx, ctx.config.config.lancedb.dir));
    return await openSearchTable(conn, cfg);
  } catch (e) {
    throw new CliError({
      code: "index-unavailable",
      message: `the LanceDB index at ${ctx.config.config.lancedb.dir} is not available: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Run `brain index rebuild` to (re)build the retrieval index.",
      exitCode: EXIT.CONFIG,
      cause: e,
    });
  }
}

/** Map a typed model-provider failure (embed OR generation) to the CLI envelope.
 * The plan §2.5 exit set caps at 6, so the contract's nominal exit 7 for
 * `embedding-retryable` is expressed as exit 4 (internal) carrying `retryable: true`
 * + `retryAfterMs` — the retryability a jobs runner consumes lives on the flag, not
 * a code the exit set does not define. */
function mapModelError(e: unknown): CliError | null {
  if (e instanceof QueryEmbedError) {
    return new CliError({
      code: e.code,
      message: e.message,
      exitCode: EXIT.INTERNAL,
      retryable: e.retryable,
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
      cause: e,
    });
  }
  if (e instanceof ProviderCallError) {
    const retryable = e.retryable === true;
    return new CliError({
      code: retryable ? "embedding-retryable" : "embedding-failed",
      message: e.message,
      exitCode: EXIT.INTERNAL,
      retryable,
      ...(typeof (e as { retryAfterMs?: number }).retryAfterMs === "number"
        ? { retryAfterMs: (e as { retryAfterMs?: number }).retryAfterMs }
        : {}),
      cause: e,
    });
  }
  if (e instanceof EgressRefusal) {
    return new CliError({
      code: "embedding-failed",
      message: `the egress broker refused the model call: ${e.message}`,
      exitCode: EXIT.INTERNAL,
      cause: e,
    });
  }
  return null;
}

async function query(ctx: RunContext): Promise<number> {
  const args = parseQueryArgs(ctx.argv);
  const runId = ctx.runId;
  const cfgAll = ctx.config.config;
  const indexingCfg: IndexingConfig = {
    chunker_version: cfgAll.indexing.chunker_version,
    embedding_model: cfgAll.indexing.embedding_model,
    dimensions: cfgAll.indexing.dimensions,
  };

  // Open the ledger read-write (asserts an already-migrated store; never applies DDL).
  const store = openMigratedStore(ctx);
  const now = (): string => new Date().toISOString();

  try {
    // FAIL-CLOSED gate (contract): a query WRITES ledger rows via finalizeLedgerWrite,
    // so a blocked backup watermark refuses BOTH modes UP FRONT — before spending any
    // model call — with `backup-unhealthy` (exit 2).
    try {
      assertBackupHealthy(store.db);
    } catch (e) {
      if (e instanceof BackupUnhealthyError) {
        throw new CliError({
          code: e.code,
          message: e.message,
          hint: "Run `db backup` (or `db backup --force-unblock` / `db restore`) to clear the block, then retry.",
          exitCode: EXIT.CONFIG,
          retryable: true,
          cause: e,
        });
      }
      throw e;
    }

    const table = await openTable(ctx, indexingCfg);

    // The in-process model boundary: one client, one receipt sink collecting EVERY
    // transmission (D6/D18 — one `model_calls` row per call). No egress daemon, no
    // capability mint; the credential resolves lazily on the first call.
    const receipts: ModelCallReceipt[] = [];
    const models = new ModelsClient(
      createInProcessInvoker({ env: ctx.env }),
      (r: ModelCallReceipt) => {
        receipts.push(r);
      },
    );

    {
      // Every transmission binds to this run id (no capability mint).
      const embed = embedderFromClient(models, { runId }, indexingCfg);

      const generate = (input: string): Promise<GenerateTextResult> =>
        models.generateText(
          { model: cfgAll.models.generation_model, prompt: { ref: ANSWER_PROMPT_REF }, input, maxTokens: GENERATION_MAX_TOKENS },
          { runId },
        );

      const retrievalDeps: Omit<RetrievalDeps, "recorder" | "runId"> = {
        config: { rrf: cfgAll.retrieval.rrf, fts: cfgAll.retrieval.fts },
        resolver: storeResolver(store),
        table,
        activeGenerationIds: () => store.generation.activeGenerationIds(),
        activeGenerationId: (noteId) => store.generation.activeGenerationId(noteId),
        embed,
        noteMeta: storeNoteMeta(store, cfgAll.policies.default_sensitivity),
        indexGeneration: computeIndexGeneration(store, indexingCfg),
        newRetrievalId: () => newRunId(),
        now,
      };

      let exec: QueryExecResult;
      try {
        exec = await executeQuery({
          runId,
          args,
          retrieval: retrievalDeps,
          generate,
          getReceipts: () => receipts,
          packBudget: PACK_TOKEN_BUDGET,
          now,
        });
      } catch (e) {
        // F3: account any transmissions that already happened (embed and/or generation)
        // as `model_calls` under a `run.failed` terminal BEFORE surfacing the error, so
        // no transmission is silently discarded. A no-op when nothing transmitted.
        await recordFailedTransmissions(ctx, store, runId, receipts, e instanceof Error ? e.message : String(e), now);
        if (e instanceof AmbiguousNoteError) throw e; // already a CliError (exit 1)
        const mapped = mapModelError(e);
        if (mapped !== null) throw mapped;
        throw e;
      }

      // Record the SINGLE terminal `run.readonly` + the correlated business rows via
      // 1.9's audited read path (→ finalizeLedgerWrite). STRICT (round-2 finding F1): a
      // ledger-WRITING read is not best-effort — `runReadAudit` treats a non-empty
      // `ledgerWrite` as strict, and `strictBackup` makes the mandatory covering backup
      // load-bearing, so a failed finalize or failed covering backup FAILS the command
      // rather than returning an exit-0 answer without the durable audit + rows.
      const audit = await runReadAudit(ctx, "run.readonly", "query", store, { runId, ledgerWrite: exec.ledgerWrite, strictBackup: true });
      ctx.log.info("query", {
        mode: exec.output.mode,
        items: exec.output.items.length,
        modelCalls: receipts.length,
        degraded: exec.output.degraded,
        audited: audit.recorded,
        runId,
      });

      if (ctx.output.mode === "json") {
        emitJson(exec.output);
      } else {
        renderHuman(ctx, exec.output);
      }
      return EXIT.OK;
    }
  } finally {
    store.close();
  }
}

/** The human-mode summary line (the single render path). Exported for the test suite. */
export function renderHuman(ctx: RunContext, out: QueryOutput): void {
  if (out.mode === "answered") {
    const truncationWarning = out.truncated
      ? `\n[warning] the answer was truncated by the provider (finish != STOP) — retry, or narrow the question`
      : "";
    ctx.render(
      `${out.answer ?? ""}${truncationWarning}\n\n— ${out.items.length} note(s) retrieved (${out.layersUsed.join(", ") || "none"}${out.degraded ? ", degraded" : ""}); run ${out.retrievalRunId}`,
    );
  } else {
    const top = out.items.slice(0, 5).map((i) => `${i.noteId} (${i.score.toFixed(4)})`).join(", ");
    ctx.render(
      `query "${out.query}" — ${out.items.length} note(s) [${out.layersUsed.join(", ") || "none"}]${out.degraded ? " degraded" : ""}${top ? `: ${top}` : ""}; run ${out.retrievalRunId}`,
    );
  }
}

registerCommand("query", query);

export { query };
