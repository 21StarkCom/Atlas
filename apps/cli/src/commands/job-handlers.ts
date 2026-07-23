/**
 * `commands/job-handlers` — the PRODUCTION workflow→executor registry.
 *
 * **v2 (task 4-4): the production registry is EMPTY.** `reverify` was the last
 * surviving production workflow; it was rendition-coupled (it re-anchored evidence
 * across `source_renditions` versions) and has no analog in the v2 flat, vault-
 * derived evidence model — `evidence retry` is now a synchronous frontmatter
 * mutation, not an enqueued job. The retention sweeps, trust remediation, and the
 * absorb-cycle `index:reconcile` had already died with their enqueuers (ADR-0003 /
 * #334). Nothing production code runs now enqueues a job, so `PRODUCTION_WORKFLOWS`
 * is empty and `jobs run` drains an empty production set (the durable queue
 * infrastructure is retained for the survivor `jobs run|list` commands + the
 * env-gated test handler, and for any future workflow).
 *
 * The two properties the completeness gate (`test/jobs.registry-completeness.test.ts`)
 * still enforces hold vacuously: every enqueueable workflow (none) has a handler,
 * and no handler exists without an enqueuer. `buildJobHandlers` stays ctx-parameterized
 * and side-effect-free so it is safe to call with a stub `deps`.
 */
import type { JobHandler } from "@atlas/jobs";
import type { Store } from "@atlas/sqlite-store";
import type { RunContext } from "../handlers.js";

/** Everything a production job handler may need, resolved lazily per execution. */
export interface JobHandlerDeps {
  readonly ctx: RunContext;
  readonly store: Store;
}

/**
 * The workflows the production registry covers. Bound to the enqueue-side
 * constants by the completeness gate — this list is not free-form. EMPTY in v2
 * (no production code enqueues a job — see the module header).
 */
export const PRODUCTION_WORKFLOWS = [] as const;

export type ProductionWorkflow = (typeof PRODUCTION_WORKFLOWS)[number];

/**
 * Build the production workflow→executor map. Pure and side-effect free: it only
 * closes over `deps`, so it is safe to call before the queue is known to be
 * non-empty (and safe for the completeness gate to call with a stub). Empty in v2.
 */
export function buildJobHandlers(_deps: JobHandlerDeps): Record<string, JobHandler> {
  return {};
}
