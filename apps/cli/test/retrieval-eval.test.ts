/**
 * `retrieval-eval.test` (LIVE) — the Task 3.6 end-to-end acceptance: the eval harness
 * (`@atlas/lancedb-index`'s `src/eval.ts`) run against the `source-heavy` fixture vault through the
 * REAL Task 3.3 retriever under LIVE embeddings, asserting the graduation thresholds
 * (acceptance-thresholds.md §retrieval: recall@10 ≥ 0.85, MRR ≥ 0.7).
 *
 * OPT-IN: this suite is skipped unless `ATLAS_LIVE_GEMINI=1` — live retrieval needs a
 * provisioned host (egress broker daemon + Gemini credentials) with an INDEXED vault.
 * Point it at that vault with `ATLAS_EVAL_VAULT=/abs/path/to/vault` (already migrated +
 * `brain index rebuild`-ed). CI runs the offline metric-math test
 * (`packages/lancedb-index/test/eval.test.ts`) instead; this is the nightly/graduation path.
 *
 * The retriever is wired through the shipped `brain query <text> --no-answer --json`
 * command — the real retrieve → fuse path — so the eval scores exactly what production
 * retrieval returns.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRetrievalEval, type EvalQuerySet, type EvalLabelSet } from "@atlas/lancedb-index";

const LIVE = process.env.ATLAS_LIVE_GEMINI === "1";
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO_ROOT, "apps", "cli", "dist", "bin.js");

function loadFixtures(): { queries: EvalQuerySet["queries"]; labels: EvalLabelSet["labels"] } {
  const qset = JSON.parse(readFileSync(join(REPO_ROOT, "fixtures/retrieval-eval/queries.json"), "utf8")) as EvalQuerySet;
  const lset = JSON.parse(readFileSync(join(REPO_ROOT, "fixtures/retrieval-eval/labels.json"), "utf8")) as EvalLabelSet;
  return { queries: qset.queries, labels: lset.labels };
}

/** The real retriever: run `brain query <text> --no-answer --json` and read the ranked
 * note ids from the JSON `items[]`. */
function cliRetriever(vault: string): (text: string) => Promise<readonly string[]> {
  return (text) => {
    const out = execFileSync("node", [BIN, "--vault", vault, "query", text, "--no-answer", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out) as { items: { noteId: string }[] };
    return Promise.resolve(parsed.items.map((i) => i.noteId));
  };
}

describe.skipIf(!LIVE)("retrieval eval (LIVE, opt-in via ATLAS_LIVE_GEMINI=1)", () => {
  it("meets the graduation thresholds on source-heavy (recall@10 ≥ 0.85, MRR ≥ 0.7)", async () => {
    const vault = process.env.ATLAS_EVAL_VAULT;
    if (vault === undefined) throw new Error("ATLAS_EVAL_VAULT must point at an indexed source-heavy vault for the live eval");
    const { queries, labels } = loadFixtures();

    const result = await runRetrievalEval({ queries, labels, retrieve: cliRetriever(vault) });

    // Surface the per-query breakdown for diagnosis when a threshold misses.
    for (const row of result.perQuery) {
      console.log(`  ${row.queryId}: rank=${row.firstRelevantRank ?? "miss"} recall=${row.recall.toFixed(3)} → ${row.retrieved.slice(0, 5).join(", ")}`);
    }
    console.log(`recall@10=${result.recallAt10.toFixed(3)} mrr=${result.mrr.toFixed(3)}`);

    expect(result.recallAt10).toBeGreaterThanOrEqual(0.85);
    expect(result.mrr).toBeGreaterThanOrEqual(0.7);
  });
});
