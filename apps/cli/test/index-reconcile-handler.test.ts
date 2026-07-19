/**
 * `sync/reconcile-handler` (60-B Phase 3, Task 3.1/3.2) — the EXECUTE side of the
 * `index:reconcile` job kind: the scoped, O(delta) per-sync-cycle reindex that
 * re-embeds ONLY the notes named in the payload.
 *
 * Before this handler the production registry had no `index:reconcile` executor, so a
 * drain of an enqueued reconcile hit the runner's "no handler" path — classified
 * TRANSIENT, burning the whole attempt budget with backoff before failing exit 4. This
 * suite pins the handler + its registration + the completeness-gate coverage.
 *
 * Properties covered (mirrors the reverify/retention/remediation sibling handlers):
 *   1. **Laziness** — `buildIndexReconcileHandler` dereferences nothing at build time
 *      (the registry-completeness gate builds the whole registry with a stub `deps`).
 *   2. **Payload validation** — an empty/malformed payload is a PERMANENT `validation`
 *      failure, never a transient one that retries the budget away.
 *   3. **Scoped delegation** — the handler drives the reconcile with EXACTLY the payload
 *      note ids (the O(delta) contract).
 *   4. **Content-addressed result** — a scoped reindex is derived/disposable state, so
 *      the handler returns the content-addressed arm (NO `commit` closure ⇒ no protected
 *      -ref mutation; delete `lancedb.dir` to roll back).
 *   5. **Cooperative cancel** — a pre-aborted signal throws `AbortError` before any work.
 *   6. **Registration** — `index:reconcile` is in the production registry with no test-env
 *      gate, and is declared by `PRODUCTION_WORKFLOWS` so the completeness gate covers it.
 *   7. **The Phase-2 correction (critical)** — the notes provider the handler builds is a
 *      real `ParsedNote` provider that OMITS ids that no longer resolve at the ref, so
 *      `indexNotes` treats an absent id as removed. A bare fence would be un-re-embeddable.
 */
import { describe, expect, it } from "vitest";
import type { ParsedNote } from "@atlas/contracts";
import { classifyError, type JobHandlerContext, type JobHandlerResult } from "@atlas/jobs";
import {
  buildIndexReconcileHandler,
  scopedNotesProvider,
  INDEX_RECONCILE_WORKFLOW,
  type IndexReconcileSeams,
} from "../src/sync/reconcile-handler.js";
import type { JobHandlerDeps } from "../src/commands/job-handlers.js";
import { buildJobHandlers, PRODUCTION_WORKFLOWS } from "../src/commands/job-handlers.js";
import type { ReconcileReport } from "@atlas/lancedb-index";

/** A fake reconcile seam that records the note ids it was driven with. */
function recordingSeams(): { seams: IndexReconcileSeams; calls: string[][] } {
  const calls: string[][] = [];
  const report: ReconcileReport = { scanned: 0, reembedded: 0, unchanged: 0, removed: 0, results: [] };
  return {
    calls,
    seams: {
      reconcile: (_deps, noteIds) => {
        calls.push([...noteIds]);
        return Promise.resolve({ ...report, scanned: noteIds.length });
      },
    },
  };
}

function jctx(payload: unknown, signal: AbortSignal = new AbortController().signal): JobHandlerContext {
  return { jobId: "job-reconcile", workflow: INDEX_RECONCILE_WORKFLOW, attempt: 1, payload, signal, now: "2026-07-19T00:00:00.000Z" };
}

/** Classify what a handler invocation threw (permanent/transient/cancelled + code). */
async function classifyThrown(p: Promise<JobHandlerResult>): Promise<{ cls: string; code: string }> {
  try {
    await p;
    throw new Error("expected the handler to throw");
  } catch (e) {
    const c = classifyError(e);
    return { cls: c.cls, code: c.code };
  }
}

/** A minimal ParsedNote carrying just the identity the notes provider keys on. */
function note(id: string): ParsedNote {
  return {
    id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-19", updated: "2026-07-19", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: { children: [] } as unknown as ParsedNote["sections"], contentHash: "sha256:0", raw: `# ${id}`,
  };
}

describe("index:reconcile handler", () => {
  it("builds lazily — dereferences nothing at build time (registry-completeness stub)", () => {
    expect(() => buildIndexReconcileHandler({} as JobHandlerDeps)).not.toThrow();
    expect(typeof buildIndexReconcileHandler({} as JobHandlerDeps)).toBe("function");
  });

  it("drives the reconcile with exactly the payload note ids and returns the content-addressed arm", async () => {
    const { seams, calls } = recordingSeams();
    const handler = buildIndexReconcileHandler({} as JobHandlerDeps, seams);
    const res = await handler(jctx({ noteIds: ["n1", "n2"] }));
    expect(calls).toEqual([["n1", "n2"]]);
    // Content-addressed: the discriminant is the ABSENCE of a `commit` closure — no
    // mutable SQLite side effect, no protected-ref mutation (reindex is derived state).
    expect((res as { commit?: unknown }).commit).toBeUndefined();
  });

  it("rejects an empty or malformed payload as a PERMANENT validation failure", async () => {
    const { seams } = recordingSeams();
    const handler = buildIndexReconcileHandler({} as JobHandlerDeps, seams);
    expect(await classifyThrown(handler(jctx({ noteIds: [] })))).toMatchObject({ cls: "permanent", code: "validation" });
    expect(await classifyThrown(handler(jctx({})))).toMatchObject({ cls: "permanent", code: "validation" });
    expect(await classifyThrown(handler(jctx({ noteIds: [""] })))).toMatchObject({ cls: "permanent", code: "validation" });
    expect(await classifyThrown(handler(jctx("nope")))).toMatchObject({ cls: "permanent", code: "validation" });
  });

  it("does not run the reconcile for a malformed payload (fails before any work)", async () => {
    const { seams, calls } = recordingSeams();
    const handler = buildIndexReconcileHandler({} as JobHandlerDeps, seams);
    await classifyThrown(handler(jctx({})));
    expect(calls).toEqual([]);
  });

  it("observes a pre-aborted cancel signal before any work (cancelled, not run)", async () => {
    const { seams, calls } = recordingSeams();
    const handler = buildIndexReconcileHandler({} as JobHandlerDeps, seams);
    const ac = new AbortController();
    ac.abort();
    expect(await classifyThrown(handler(jctx({ noteIds: ["n1"] }, ac.signal)))).toMatchObject({ cls: "cancelled", code: "cancelled" });
    expect(calls).toEqual([]);
  });
});

describe("index:reconcile registration + completeness", () => {
  it("declares index:reconcile in PRODUCTION_WORKFLOWS", () => {
    expect((PRODUCTION_WORKFLOWS as readonly string[]).includes(INDEX_RECONCILE_WORKFLOW)).toBe(true);
  });

  it("registers an index:reconcile handler in the production registry (no test-env gate)", () => {
    delete process.env.ATLAS_TEST_JOB_HANDLER;
    const handlers = buildJobHandlers({} as JobHandlerDeps);
    expect(typeof handlers[INDEX_RECONCILE_WORKFLOW]).toBe("function");
  });
});

describe("scopedNotesProvider — the Phase-2 correction (absent id ⇒ removed)", () => {
  it("yields ParsedNotes only for ids that resolve at the ref, omitting the rest", () => {
    const surviving = new Map<string, ParsedNote>([["n1", note("n1")], ["n3", note("n3")]]);
    const resolve = (id: string): ParsedNote | null => surviving.get(id) ?? null;
    const provider = scopedNotesProvider(resolve, ["n1", "n2", "n3"]);
    const notes = provider();
    // n2 does not resolve ⇒ ABSENT from the provider ⇒ indexNotes drops its chunks
    // (removed). n1/n3 survive as real ParsedNotes (bodies present ⇒ re-embeddable).
    expect(notes.map((n) => n.id).sort()).toEqual(["n1", "n3"]);
    expect(notes.every((n) => typeof n.raw === "string")).toBe(true);
  });

  it("returns an empty provider when nothing resolves", () => {
    const provider = scopedNotesProvider(() => null, ["n1", "n2"]);
    expect(provider()).toEqual([]);
  });
});
