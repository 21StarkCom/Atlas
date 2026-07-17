/**
 * `index-eval.cli.test` — parse/validation/output/threshold behavior of `brain index
 * eval` (this plan). The heavy wiring (store/LanceDB/egress) is exercised by the live
 * drive + the opt-in `retrieval-eval.test.ts`; here the pure pieces are driven directly:
 * flag parsing, eval-set loading/validation, and the output/exit shaping over a stub
 * retriever via the re-homed `runRetrievalEval`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRetrievalEval } from "@atlas/lancedb-index";
import { CliError } from "../src/errors/envelope.js";
import { parseIndexEvalArgs, loadEvalSet, evalOutput } from "../src/commands/index-eval.js";

function writeSet(queries: unknown, labels: unknown): { queriesPath: string; labelsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "index-eval-"));
  const queriesPath = join(dir, "queries.json");
  const labelsPath = join(dir, "labels.json");
  writeFileSync(queriesPath, JSON.stringify(queries));
  writeFileSync(labelsPath, JSON.stringify(labels));
  return { queriesPath, labelsPath };
}

const GOOD_QUERIES = { version: 1, queries: [{ id: "q1", text: "who runs the cloud team" }] };
const GOOD_LABELS = { version: 1, labels: { q1: ["team-cloud"] } };

describe("parseIndexEvalArgs", () => {
  it("parses required paths + defaults (k=10, thresholds 0.85/0.7)", () => {
    const p = parseIndexEvalArgs(["--queries", "/q.json", "--labels", "/l.json"]);
    expect(p).toEqual({ queriesPath: "/q.json", labelsPath: "/l.json", k: 10, minRecall: 0.85, minMrr: 0.7 });
  });

  it("accepts --k / --min-recall / --min-mrr in both --flag v and --flag=v forms", () => {
    const p = parseIndexEvalArgs(["--queries=/q.json", "--labels=/l.json", "--k=5", "--min-recall", "0.9", "--min-mrr=0.5"]);
    expect(p).toEqual({ queriesPath: "/q.json", labelsPath: "/l.json", k: 5, minRecall: 0.9, minMrr: 0.5 });
  });

  it("rejects a missing --queries/--labels, out-of-bounds --k, and non-[0,1] thresholds as usage", () => {
    expect(() => parseIndexEvalArgs([])).toThrowError(CliError);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--k", "0"])).toThrowError(/--k/);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--k", "101"])).toThrowError(/--k/);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--min-recall", "1.5"])).toThrowError(/--min-recall/);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--unknown"])).toThrowError(/unknown/);
  });
});

describe("loadEvalSet", () => {
  it("loads a valid set and cross-checks label ids against the projection", () => {
    const { queriesPath, labelsPath } = writeSet(GOOD_QUERIES, GOOD_LABELS);
    const set = loadEvalSet(queriesPath, labelsPath, (id) => id === "team-cloud");
    expect(set.queries).toHaveLength(1);
    expect(set.labels["q1"]).toEqual(["team-cloud"]);
  });

  it("rejects malformed JSON, a bad version, a query without labels, and an unknown labeled note id", () => {
    const anyId = (): boolean => true;
    const { queriesPath, labelsPath } = writeSet(GOOD_QUERIES, GOOD_LABELS);
    expect(() => loadEvalSet("/nonexistent.json", labelsPath, anyId)).toThrowError(/eval-set-invalid|cannot read/);
    const badVersion = writeSet({ version: 2, queries: [] }, GOOD_LABELS);
    expect(() => loadEvalSet(badVersion.queriesPath, badVersion.labelsPath, anyId)).toThrowError(/version/);
    const unlabeled = writeSet({ version: 1, queries: [{ id: "q-un", text: "t" }] }, { version: 1, labels: {} });
    expect(() => loadEvalSet(unlabeled.queriesPath, unlabeled.labelsPath, anyId)).toThrowError(/q-un/);
    const ghost = writeSet(GOOD_QUERIES, GOOD_LABELS);
    expect(() => loadEvalSet(ghost.queriesPath, ghost.labelsPath, () => false)).toThrowError(/team-cloud/);
  });
});

describe("evalOutput", () => {
  it("shapes the schema payload and passes/fails against the thresholds", async () => {
    const result = await runRetrievalEval({
      queries: [
        { id: "q1", text: "a" },
        { id: "q2", text: "b" },
      ],
      labels: { q1: ["n1"], q2: ["n2"] },
      k: 10,
      retrieve: (text) => Promise.resolve(text === "a" ? ["n1"] : ["x", "n2"]),
    });
    const out = evalOutput(result, { minRecall: 0.85, minMrr: 0.7 }, 0);
    expect(out.command).toBe("index eval");
    expect(out.metrics).toEqual({ recallAt10: 1, mrr: 0.75 });
    expect(out.pass).toBe(true);
    expect(out.queries).toBe(2);
    expect(out.perQuery[0]).toEqual({ queryId: "q1", expected: ["n1"], retrieved: ["n1"], firstRelevantRank: 1, reciprocalRank: 1, recall: 1 });
    expect("degradedQueries" in out).toBe(false);

    const failing = evalOutput(result, { minRecall: 0.85, minMrr: 0.8 }, 2);
    expect(failing.pass).toBe(false);
    expect(failing.degradedQueries).toBe(2);
  });
});
