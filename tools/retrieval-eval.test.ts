/**
 * `retrieval-eval.test` — the always-on metric-math test for `runRetrievalEval`
 * (Task 3.6). Verifies recall@K + MRR against HAND-COMPUTED values with a stubbed
 * retriever (no embeddings, no index), and validates the labeled fixture set is
 * internally consistent. The LIVE end-to-end (real retriever over `source-heavy` under
 * embeddings) is the opt-in `apps/cli/test/retrieval-eval.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runRetrievalEval, type EvalQuerySet, type EvalLabelSet } from "./retrieval-eval.js";

/** A stubbed retriever from a fixed `text → ranked note ids` map. */
function stubRetriever(map: Record<string, string[]>): (text: string) => Promise<readonly string[]> {
  return (text) => Promise.resolve(map[text] ?? []);
}

describe("runRetrievalEval — metric math (Task 3.6)", () => {
  it("computes recall@K and MRR against hand-computed values", async () => {
    const result = await runRetrievalEval({
      queries: [
        { id: "q1", text: "a" }, // relevant A at rank 1 → RR 1, recall 1
        { id: "q2", text: "b" }, // relevant B at rank 2 → RR 1/2, recall 1
        { id: "q3", text: "c" }, // no relevant retrieved → RR 0, recall 0
      ],
      labels: { q1: ["A"], q2: ["B"], q3: ["C"] },
      retrieve: stubRetriever({ a: ["A", "B", "C"], b: ["X", "B", "Y"], c: ["X", "Y", "Z"] }),
    });

    expect(result.k).toBe(10);
    expect(result.perQuery.map((r) => r.reciprocalRank)).toEqual([1, 0.5, 0]);
    expect(result.perQuery.map((r) => r.recall)).toEqual([1, 1, 0]);
    expect(result.perQuery.map((r) => r.firstRelevantRank)).toEqual([1, 2, null]);
    // MRR = (1 + 0.5 + 0) / 3; recall@10 = (1 + 1 + 0) / 3.
    expect(result.mrr).toBeCloseTo(0.5, 10);
    expect(result.recallAt10).toBeCloseTo(2 / 3, 10);
  });

  it("recall is |expected ∩ topK| / |expected| for multi-relevant labels, and K truncates", async () => {
    const result = await runRetrievalEval({
      queries: [{ id: "q", text: "t" }],
      labels: { q: ["A", "B"] },
      // B sits at rank 4 but K=2 truncates to [A, X] → only A counts.
      retrieve: stubRetriever({ t: ["A", "X", "Y", "B"] }),
      k: 2,
    });
    expect(result.k).toBe(2);
    expect(result.perQuery[0]!.recall).toBe(0.5); // 1 of 2 relevant within top-2
    expect(result.perQuery[0]!.reciprocalRank).toBe(1); // A at rank 1
    expect(result.recallAt10).toBe(0.5);
  });

  it("a query with no labels contributes 0 to both metrics (never NaN)", async () => {
    const result = await runRetrievalEval({
      queries: [{ id: "q", text: "t" }],
      labels: {},
      retrieve: stubRetriever({ t: ["A"] }),
    });
    expect(result.perQuery[0]!.recall).toBe(0);
    expect(result.perQuery[0]!.reciprocalRank).toBe(0);
    expect(result.recallAt10).toBe(0);
    expect(result.mrr).toBe(0);
  });

  it("an empty query set yields 0/0 metrics, not NaN", async () => {
    const result = await runRetrievalEval({ queries: [], labels: {}, retrieve: stubRetriever({}) });
    expect(result.recallAt10).toBe(0);
    expect(result.mrr).toBe(0);
    expect(result.perQuery).toEqual([]);
  });

  it("the labeled fixture set is internally consistent", () => {
    const qset = JSON.parse(readFileSync(new URL("../fixtures/retrieval-eval/queries.json", import.meta.url), "utf8")) as EvalQuerySet;
    const lset = JSON.parse(readFileSync(new URL("../fixtures/retrieval-eval/labels.json", import.meta.url), "utf8")) as EvalLabelSet;

    expect(qset.version).toBe(lset.version); // versioned in lockstep
    expect(qset.queries.length).toBeGreaterThan(0);
    const ids = new Set(qset.queries.map((q) => q.id));
    expect(ids.size).toBe(qset.queries.length); // unique query ids

    // Every query has a non-empty label set, and every label key is a known query id.
    for (const q of qset.queries) {
      const expected = lset.labels[q.id];
      expect(expected, `query ${q.id} has labels`).toBeDefined();
      expect(expected!.length).toBeGreaterThan(0);
      expect(q.text.length).toBeGreaterThan(0);
    }
    for (const key of Object.keys(lset.labels)) expect(ids.has(key), `label key ${key} is a known query`).toBe(true);
  });
});
