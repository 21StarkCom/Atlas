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
import { runRetrievalEval, type RetrievalEvalResult } from "@atlas/lancedb-index";
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

/** Catch `fn`'s CliError and return it so tests can assert the CONTRACT axis (code + exitCode). */
function catchCliError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error("expected a CliError to be thrown");
}

/** Assert `fn` rejects with the contract's envelope: code `eval-set-invalid`, exit 1. */
function expectEvalSetInvalid(fn: () => unknown, msg: RegExp): void {
  const err = catchCliError(fn);
  // The CONTRACT axis (index-eval.schema.json errorCodes) — a code rename or an exit
  // remap must fail here, not just a message drift.
  expect(err).toMatchObject({ code: "eval-set-invalid", exitCode: 1 });
  expect(err.message).toMatch(msg);
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

  it("rejects empty/whitespace threshold values and a float --k (strict lexical form)", () => {
    // `--min-recall=` (e.g. an unset shell var in runbook automation) must be a usage
    // error, NOT a silently-accepted threshold 0 that disarms the graduation gate.
    const empty = catchCliError(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--min-recall="]));
    expect(empty).toMatchObject({ code: "usage", exitCode: 5 });
    expect(empty.message).toMatch(/--min-recall/);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--min-mrr", "   "])).toThrowError(/--min-mrr/);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--k", "2.5"])).toThrowError(/--k/);
  });
});

describe("loadEvalSet", () => {
  it("loads a valid set and cross-checks label ids against the projection", () => {
    const { queriesPath, labelsPath } = writeSet(GOOD_QUERIES, GOOD_LABELS);
    const set = loadEvalSet(queriesPath, labelsPath, (id) => id === "team-cloud");
    expect(set.queries).toHaveLength(1);
    expect(set.labels["q1"]).toEqual(["team-cloud"]);
  });

  it("rejects an unreadable file, malformed JSON, and a bad version as eval-set-invalid (exit 1)", () => {
    const anyId = (): boolean => true;
    const { labelsPath } = writeSet(GOOD_QUERIES, GOOD_LABELS);
    expectEvalSetInvalid(() => loadEvalSet("/nonexistent.json", labelsPath, anyId), /cannot read/);
    const mangled = join(mkdtempSync(join(tmpdir(), "index-eval-")), "queries.json");
    writeFileSync(mangled, "{nope"); // REAL malformed JSON — exercises the JSON.parse catch
    expectEvalSetInvalid(() => loadEvalSet(mangled, labelsPath, anyId), /not valid JSON/);
    const badVersion = writeSet({ version: 2, queries: [] }, GOOD_LABELS);
    expectEvalSetInvalid(() => loadEvalSet(badVersion.queriesPath, badVersion.labelsPath, anyId), /version/);
  });

  it("rejects null roots, labels:null, an empty queries array, and duplicate query ids as eval-set-invalid", () => {
    const anyId = (): boolean => true;
    // A JSON root of literal `null` is valid JSON — must be eval-set-invalid, not a TypeError.
    const nullQueries = writeSet(null, GOOD_LABELS);
    expectEvalSetInvalid(() => loadEvalSet(nullQueries.queriesPath, nullQueries.labelsPath, anyId), /expected \{version:1, queries/);
    const nullLabels = writeSet(GOOD_QUERIES, null);
    expectEvalSetInvalid(() => loadEvalSet(nullLabels.queriesPath, nullLabels.labelsPath, anyId), /expected \{version:1, labels/);
    const labelsNull = writeSet(GOOD_QUERIES, { version: 1, labels: null }); // typeof null === "object"
    expectEvalSetInvalid(() => loadEvalSet(labelsNull.queriesPath, labelsNull.labelsPath, anyId), /expected \{version:1, labels/);
    const empty = writeSet({ version: 1, queries: [] }, GOOD_LABELS);
    expectEvalSetInvalid(() => loadEvalSet(empty.queriesPath, empty.labelsPath, anyId), /empty eval set cannot gate/);
    const dup = writeSet(
      { version: 1, queries: [{ id: "q1", text: "a" }, { id: "q1", text: "b" }] },
      { version: 1, labels: { q1: ["team-cloud"] } },
    ); // a duplicate id would double-weight that query in the gate average
    expectEvalSetInvalid(() => loadEvalSet(dup.queriesPath, dup.labelsPath, anyId), /duplicate query id q1/);
  });

  it("rejects a query without labels and an unknown labeled note id as eval-set-invalid", () => {
    const anyId = (): boolean => true;
    const unlabeled = writeSet({ version: 1, queries: [{ id: "q-un", text: "t" }] }, { version: 1, labels: {} });
    expectEvalSetInvalid(() => loadEvalSet(unlabeled.queriesPath, unlabeled.labelsPath, anyId), /q-un/);
    const ghost = writeSet(GOOD_QUERIES, GOOD_LABELS);
    expectEvalSetInvalid(() => loadEvalSet(ghost.queriesPath, ghost.labelsPath, () => false), /team-cloud/);
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

  it("passes at exactly the default thresholds (the gate is >=, not >)", () => {
    const boundary: RetrievalEvalResult = { recallAt10: 0.85, mrr: 0.7, k: 10, perQuery: [] };
    expect(evalOutput(boundary, { minRecall: 0.85, minMrr: 0.7 }, 0).pass).toBe(true);
  });

  it("an empty result set fails closed at the default thresholds", async () => {
    const empty = await runRetrievalEval({ queries: [], labels: {}, k: 10, retrieve: () => Promise.resolve([]) });
    const out = evalOutput(empty, { minRecall: 0.85, minMrr: 0.7 }, 0);
    expect(out.pass).toBe(false);
    expect(out.queries).toBe(0);
    expect("degradedQueries" in out).toBe(false);
  });
});
