/**
 * `brain index eval` (search-index live-build plan, 2026-07-17) — the graduation
 * retrieval-eval gate as an operator command, per `retrieval-index-contract.md` §7 and
 * `cli-contract/index-eval.schema.json`.
 *
 * Scores the PRODUCTION retriever (the Task 4.11 `makeRetrieveSeam` — identity
 * short-circuits + FTS/vector RRF fusion over the live LanceDB index) against a labeled
 * query set (`EvalQuerySet`/`EvalLabelSet` JSON, the shapes `runRetrievalEval` defines),
 * and aggregates recall@K + MRR (acceptance-thresholds.md §retrieval: recall@10 ≥ 0.85,
 * MRR ≥ 0.7 gate graduation). Below-threshold emits the SAME success payload with
 * `pass:false` and exits 1 — mirroring `index verify`'s report-then-exit-1 shape.
 *
 * Tier-0 audited read: ONE terminal `run.readonly` audit event for the whole eval run
 * (per-query egress embeds are capability-bound to this run; receipts are not persisted
 * — the egress broker's own budget/audit applies). No ledger business row, no mutation.
 * ONE run id: the invocation ULID (`ctx.runId`) binds the egress embed capability AND
 * anchors the audit event, so logs, broker per-run records, and the run.readonly event
 * join on a single id (the query.ts pattern; handlers.ts documents RunContext.runId).
 */
import { readFileSync } from "node:fs";
import {
  runRetrievalEval,
  type EvalLabelSet,
  type EvalQuerySet,
  type RetrievalEvalResult,
} from "@atlas/lancedb-index";
import { ModelsClient } from "@atlas/models";
import { EgressClient } from "@atlas/broker";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { makeRetrieveSeam } from "../retrieval/wiring.js";
import { QueryEmbedError } from "../retrieval/layers.js";
import { runReadAudit } from "../audit/readonly.js";

export interface ParsedIndexEvalArgs {
  readonly queriesPath: string;
  readonly labelsPath: string;
  readonly k: number;
  readonly minRecall: number;
  readonly minMrr: number;
}

/** Parse `index eval`'s residual argv: `--queries <p> --labels <p> [--k <n>] [--min-recall <x>] [--min-mrr <x>]`. */
export function parseIndexEvalArgs(argv: string[]): ParsedIndexEvalArgs {
  let queriesPath: string | undefined;
  let labelsPath: string | undefined;
  let k = 10;
  let minRecall = 0.85; // acceptance-thresholds.md §retrieval (contract-pinned defaults)
  let minMrr = 0.7;
  const take = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw CliError.usage(`\`${flag}\` requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--queries") queriesPath = take(++i, "--queries");
    else if (a.startsWith("--queries=")) queriesPath = a.slice("--queries=".length);
    else if (a === "--labels") labelsPath = take(++i, "--labels");
    else if (a.startsWith("--labels=")) labelsPath = a.slice("--labels=".length);
    else if (a === "--k") k = parseIntBounded(take(++i, "--k"), "--k", 1, 100);
    else if (a.startsWith("--k=")) k = parseIntBounded(a.slice("--k=".length), "--k", 1, 100);
    else if (a === "--min-recall") minRecall = parseUnit(take(++i, "--min-recall"), "--min-recall");
    else if (a.startsWith("--min-recall=")) minRecall = parseUnit(a.slice("--min-recall=".length), "--min-recall");
    else if (a === "--min-mrr") minMrr = parseUnit(take(++i, "--min-mrr"), "--min-mrr");
    else if (a.startsWith("--min-mrr=")) minMrr = parseUnit(a.slice("--min-mrr=".length), "--min-mrr");
    else throw CliError.usage(`unknown flag/argument for \`index eval\`: ${a}`);
  }
  if (queriesPath === undefined) throw CliError.usage("`index eval` requires `--queries <path>`");
  if (labelsPath === undefined) throw CliError.usage("`index eval` requires `--labels <path>`");
  if (queriesPath.length === 0) throw CliError.usage("`--queries` requires a non-empty path");
  if (labelsPath.length === 0) throw CliError.usage("`--labels` requires a non-empty path");
  return { queriesPath, labelsPath, k, minRecall, minMrr };
}

function parseIntBounded(v: string, flag: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw CliError.usage(`${flag} must be an integer in ${min}..${max} (got ${v})`);
  return n;
}

function parseUnit(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw CliError.usage(`${flag} must be a number in [0,1] (got ${v})`);
  return n;
}

const evalSetInvalid = (message: string): CliError =>
  new CliError({
    code: "eval-set-invalid",
    message,
    hint: "The eval set is {version:1, queries:[{id,text}]} + {version:1, labels:{<queryId>:[noteId,...]}} — see the vault's 00_System/retrieval-eval/README.md.",
    exitCode: EXIT.VALIDATION,
  });

/** Load + validate the labeled eval set; every label id must exist in the notes projection. */
export function loadEvalSet(
  queriesPath: string,
  labelsPath: string,
  noteExists: (noteId: string) => boolean,
): { queries: EvalQuerySet["queries"]; labels: EvalLabelSet["labels"] } {
  const read = (p: string): unknown => {
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (e) {
      throw evalSetInvalid(`cannot read eval-set file ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw evalSetInvalid(`eval-set file ${p} is not valid JSON`);
    }
  };
  const q = read(queriesPath) as Partial<EvalQuerySet>;
  const l = read(labelsPath) as Partial<EvalLabelSet>;
  if (q.version !== 1 || !Array.isArray(q.queries)) throw evalSetInvalid(`${queriesPath}: expected {version:1, queries:[...]}`);
  if (l.version !== 1 || l.labels === undefined || typeof l.labels !== "object") throw evalSetInvalid(`${labelsPath}: expected {version:1, labels:{...}}`);
  for (const query of q.queries) {
    if (typeof query?.id !== "string" || query.id.length === 0 || typeof query?.text !== "string" || query.text.length === 0)
      throw evalSetInvalid(`${queriesPath}: every query needs a non-empty id + text`);
    const ids = l.labels[query.id];
    if (!Array.isArray(ids) || ids.length === 0) throw evalSetInvalid(`query ${query.id} has no labels — every query must name ≥1 expected note id`);
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) throw evalSetInvalid(`query ${query.id} has a malformed label entry`);
      if (!noteExists(id)) throw evalSetInvalid(`query ${query.id} labels note id ${id}, which is not in the notes projection — a label that cannot be retrieved silently sinks recall`);
    }
  }
  return { queries: q.queries, labels: l.labels };
}

/** Shape the schema payload from the harness result + thresholds (pure — unit-tested). */
export function evalOutput(
  result: RetrievalEvalResult,
  thresholds: { minRecall: number; minMrr: number },
  degradedQueries: number,
): {
  command: "index eval";
  k: number;
  thresholds: { recallAt10: number; mrr: number };
  metrics: { recallAt10: number; mrr: number };
  pass: boolean;
  queries: number;
  degradedQueries?: number;
  perQuery: RetrievalEvalResult["perQuery"];
} {
  const pass = result.recallAt10 >= thresholds.minRecall && result.mrr >= thresholds.minMrr;
  return {
    command: "index eval",
    k: result.k,
    thresholds: { recallAt10: thresholds.minRecall, mrr: thresholds.minMrr },
    metrics: { recallAt10: result.recallAt10, mrr: result.mrr },
    pass,
    queries: result.perQuery.length,
    ...(degradedQueries > 0 ? { degradedQueries } : {}),
    perQuery: result.perQuery,
  };
}

async function indexEvalCmd(ctx: RunContext): Promise<number> {
  const p = parseIndexEvalArgs(ctx.argv);
  const cfg = ctx.config.config;
  const store = openMigratedStore(ctx);
  const noteExists = (noteId: string): boolean =>
    store.db.prepare(`SELECT 1 FROM notes WHERE note_id = ?`).get(noteId) !== undefined;

  let egress: EgressClient;
  try {
    egress = await EgressClient.connect(cfg.broker.egress_socket_path);
  } catch (e) {
    store.close();
    throw new CliError({
      code: "broker-unreachable",
      message: `the egress broker is unreachable at ${cfg.broker.egress_socket_path}`,
      hint: "Start the egress broker daemon (provisioning/bin/egress-launcher.sh) before `brain index eval`.",
      exitCode: EXIT.CONFIG,
      cause: e,
    });
  }
  const models = new ModelsClient((params, signal) => egress.invoke(params, signal), () => {});

  try {
    const { queries, labels } = loadEvalSet(p.queriesPath, p.labelsPath, noteExists);
    const runId = ctx.runId; // ONE id: egress capability + audit event + logs (query.ts pattern)
    const indexingCfg = {
      chunker_version: cfg.indexing.chunker_version,
      embedding_model: cfg.indexing.embedding_model,
      dimensions: cfg.indexing.dimensions,
    };
    const retrieveSeam = await makeRetrieveSeam({
      ctx,
      store,
      models,
      indexingCfg,
      rrf: cfg.retrieval.rrf,
      fts: cfg.retrieval.fts,
      defaultSensitivity: cfg.policies.default_sensitivity,
      runId,
      now: () => new Date().toISOString(),
    });

    let degradedQueries = 0;
    let result: RetrievalEvalResult;
    try {
      result = await runRetrievalEval({
        queries,
        labels,
        k: p.k,
        retrieve: async (text) => {
          const r = await retrieveSeam({ text, k: p.k });
          if (r.degraded) degradedQueries++;
          return r.items.map((i) => i.noteId);
        },
      });
    } catch (e) {
      // Typed embed failures surface as the contract's embedding-* codes (query.ts
      // convention): §2.5 caps exits at 6, so retryability rides the envelope flag.
      if (e instanceof QueryEmbedError) {
        throw new CliError({
          code: e.code,
          message: e.message,
          exitCode: EXIT.INTERNAL,
          retryable: e.retryable,
          ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
          cause: e,
        });
      }
      throw e;
    }

    const out = evalOutput(result, { minRecall: p.minRecall, minMrr: p.minMrr }, degradedQueries);
    const audit = await runReadAudit(ctx, "run.readonly", "index eval", store, { strictBackup: true, runId });
    ctx.log.info("index.eval", {
      queries: out.queries,
      recallAt10: out.metrics.recallAt10,
      mrr: out.metrics.mrr,
      pass: out.pass,
      degradedQueries,
      audited: audit.recorded,
      runId: audit.runId,
    });
    if (ctx.output.mode === "json") emitJson(out);
    else
      ctx.render(
        `index eval — ${out.pass ? "PASS" : "BELOW THRESHOLD"}: recall@${out.k}=${out.metrics.recallAt10.toFixed(3)} (≥${p.minRecall}) mrr=${out.metrics.mrr.toFixed(3)} (≥${p.minMrr}) over ${out.queries} queries${degradedQueries > 0 ? ` [${degradedQueries} degraded]` : ""}`,
      );
    return out.pass ? EXIT.OK : EXIT.VALIDATION;
  } finally {
    egress.close();
    store.close();
  }
}

registerCommand("index eval", indexEvalCmd);

export { indexEvalCmd };
