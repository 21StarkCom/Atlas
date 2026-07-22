/**
 * `sync/reconcile-handler` — the EXECUTE side of the `index:reconcile` job kind (60-B
 * Phase 3). The scoped, O(delta) per-sync-cycle reindex: the sync cycle (Phase 4)
 * enqueues ONE `index:reconcile` job carrying the note ids it just absorbed, and this
 * handler re-embeds exactly those notes via the shared fenced {@link indexNotes}
 * pipeline — leaving the rest of the corpus untouched (no full-corpus embed spend).
 *
 * ## Why this is the first REAL production job kind
 * Until #216 the production registry was empty; until THIS handler even the populated
 * registry covered only retention/remediation/reverify. `index:reconcile` is what a
 * `brain sync` cycle enqueues, so without it the sync feature would enqueue a reindex
 * that hit the runner's "no handler" path (classified TRANSIENT ⇒ whole attempt budget
 * burned with backoff ⇒ exit 4). This handler closes that.
 *
 * ## Content-addressed, never a protected-ref mutation
 * A scoped reindex is DERIVED, DISPOSABLE state — the LanceDB projection + the SQLite
 * activation fence, both re-derivable from Markdown (`db rebuild` / `index rebuild`).
 * The handler therefore returns the CONTENT-ADDRESSED arm of `JobHandlerResult` (no
 * `commit` closure): it mutates no protected ref, appends no ledger business row, and
 * rolls back by deleting `lancedb.dir` wholesale. This mirrors `index repair`/`rebuild`,
 * which are projection-class ops, not canonical-git mutations.
 *
 * ## The Phase-2 correction (load-bearing)
 * `indexNotes(deps, noteIds)` re-embeds from `deps.notes` — a **`ParsedNote` provider**,
 * not fences. It needs the note BODY to chunk + embed, and it detects a removal by a
 * requested id being ABSENT from `deps.notes()`. So the handler wires `deps.notes` to a
 * real resolver ({@link resolveAtRef} at the canonical ref over the configured note
 * globs): a surviving id yields its parsed note (re-embedded); an id that no longer
 * resolves is omitted ⇒ `indexNotes` drops its chunks (removed). Passing bare fences
 * here would be un-re-embeddable — the mistake the plan sketch made.
 *
 * ## Laziness
 * `buildIndexReconcileHandler(deps)` closes over `deps` but dereferences NOTHING at build
 * time — the registry-completeness gate builds the whole production registry with a stub
 * `deps`. Every store/egress/git access happens inside the returned closure, when a job
 * actually executes; the heavy reconcile is behind an injectable {@link IndexReconcileSeams}
 * so the handler's validation + result-shaping logic is unit-testable without egress.
 */
import * as lancedb from "@lancedb/lancedb";
import { z } from "zod";
import type { ParsedNote } from "@atlas/contracts";
import { ensureFtsIndex, indexNotes, openSearchTable, type IndexDeps, type ReconcileReport } from "@atlas/lancedb-index";
import { openRepo } from "@atlas/git";
import type { JobHandler, JobHandlerContext, JobHandlerResult } from "@atlas/jobs";
import type { JobHandlerDeps } from "../commands/job-handlers.js";
import { buildEmbedder, indexingConfig } from "../commands/index-ops.js";
import { resolvePath } from "../commands/backup-config.js";
import { resolveAtRef } from "./resolve-at-ref.js";
import { CANONICAL_BRANCH } from "../workflows/direct-integrator.js";

/** Enqueue-side SSOT workflow name for the scoped per-cycle reindex (60-B). Bound to the
 * production registry + the completeness gate; the sync cycle enqueues under this name. */
export const INDEX_RECONCILE_WORKFLOW = "index:reconcile";

/** The durable payload of an `index:reconcile` job — validated fail-closed (payload is
 * `unknown`). A non-empty id list is required: the sync layer only enqueues a reconcile
 * for a non-empty change set, so an empty/absent list is a caller error, not a no-op. */
const PayloadSchema = z.object({ noteIds: z.array(z.string().min(1)).min(1) }).strict();

/**
 * The one heavy operation the handler delegates: re-embed exactly `noteIds`, resolving
 * their surviving bodies at the canonical ref. Injected so the handler's payload
 * validation + result shaping is unit-testable without a live egress broker / LanceDB.
 */
export interface IndexReconcileSeams {
  reconcile(deps: JobHandlerDeps, noteIds: string[]): Promise<ReconcileReport>;
}

/**
 * Build the `deps.notes` provider for a scoped reconcile: map each requested id through
 * the ref resolver and keep only the ones that resolve. An id that no longer resolves is
 * OMITTED, which is exactly how {@link indexNotes} learns it was removed (its chunks get
 * dropped). Pure + synchronous over an already-built resolver, so it is directly testable.
 */
export function scopedNotesProvider(
  resolve: (noteId: string) => ParsedNote | null,
  noteIds: readonly string[],
): () => ParsedNote[] {
  return () => {
    const notes: ParsedNote[] = [];
    for (const id of noteIds) {
      const n = resolve(id);
      if (n !== null) notes.push(n);
    }
    return notes;
  };
}

/**
 * The production reconcile: assemble the reconcile {@link IndexDeps} the same way
 * `index repair`/`rebuild` do (config / LanceDB table / SQLite activation authority /
 * egress-minted embedder / maintenance lock) but with a note-SCOPED `deps.notes`
 * resolved at the canonical ref, then run {@link indexNotes} over exactly the payload ids.
 */
async function runScopedReconcile(deps: JobHandlerDeps, noteIds: string[]): Promise<ReconcileReport> {
  const { ctx, store } = deps;
  const cfg = indexingConfig(ctx);
  const dir = resolvePath(ctx, ctx.config.config.lancedb.dir);
  const conn = await lancedb.connect(dir);
  const table = await openSearchTable(conn, cfg);

  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  const canonicalRef = CANONICAL_BRANCH;
  const resolve = resolveAtRef(repo, canonicalRef, ctx.config.config.vault.note_globs);

  const { embed, close } = await buildEmbedder(ctx, cfg, ctx.runId);
  try {
    const indexDeps: IndexDeps = {
      config: cfg,
      table,
      store: store.generation,
      embed,
      lockLocation: dir,
      notes: scopedNotesProvider(resolve, noteIds),
    };
    const report = await indexNotes(indexDeps, noteIds);
    // Re-derive the `text` FTS inverted index over the freshly written rows, exactly as
    // `index rebuild`/`repair` do at the end of their convergence. This is REQUIRED, not
    // cosmetic: a missing/stale analyzer index does NOT throw — LanceDB silently
    // brute-force-scans with the default no-stem/no-stop-word tokenizer, so the FTS layer
    // keeps PARTICIPATING at degraded quality and floods top-K with common-term matches
    // (issue #156 — the bug that dragged the default hybrid to 0.878/0.673 on the
    // 2026-07-17 drive). Without this, every note a sync cycle absorbs would be served
    // from a stale inverted index. `ensureFtsIndex` is idempotent (`replace: true`) and
    // no-ops on a zero-row table.
    await ensureFtsIndex(table);
    return report;
  } finally {
    close();
  }
}

/** The production seams (assemble IndexDeps + run indexNotes over the egress broker). */
export const defaultIndexReconcileSeams: IndexReconcileSeams = {
  reconcile: (deps, noteIds) => runScopedReconcile(deps, noteIds),
};

/**
 * Build the `index:reconcile` job handler. `deps`/`seams` are captured but NOT
 * dereferenced until a job executes (build-time laziness — the completeness gate builds
 * this with a stub `deps`). `seams` defaults to {@link defaultIndexReconcileSeams}; tests
 * inject a fake to exercise validation + result shaping without a broker/index.
 */
export function buildIndexReconcileHandler(
  deps: JobHandlerDeps,
  seams: IndexReconcileSeams = defaultIndexReconcileSeams,
): JobHandler {
  return async (ctx: JobHandlerContext): Promise<JobHandlerResult> => {
    // 1. Validate the payload (it arrives as `unknown`). A bad payload is a PERMANENT
    //    `validation` failure — a mis-enqueued job must not retry until its budget is gone.
    const parsed = PayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw { kind: "validation", message: `index:reconcile payload invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }

    // Cooperative cancel BEFORE any work (jobs-contract §1).
    if (ctx.signal.aborted) throw { name: "AbortError", message: "index:reconcile cancelled before execution" };

    await seams.reconcile(deps, parsed.data.noteIds);

    // Content-addressed: the reindex is derived/disposable state (delete `lancedb.dir` to
    // roll back), so NO `commit` closure ⇒ no mutable SQLite side effect, no protected-ref
    // mutation. `sideEffectId` stays absent (recorded NULL) — content-addressing, not a
    // per-attempt id, is the crash-safety mechanism (the pipeline is idempotent per note).
    return {};
  };
}
