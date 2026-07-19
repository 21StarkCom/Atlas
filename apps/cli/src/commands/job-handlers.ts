/**
 * `commands/job-handlers` — the PRODUCTION workflow→executor registry.
 *
 * Until this module existed the registry in `jobs.ts` was literally `{}`: every
 * job production code enqueued hit the runner's "no handler registered" path,
 * which classifies `internal` as TRANSIENT — so a permanently mis-registered
 * job burned its whole attempt budget with backoff before failing at exit 4.
 *
 * Two properties this module must keep:
 *
 *  1. **Completeness.** Every workflow name production code can `enqueue()`
 *     appears in `PRODUCTION_WORKFLOWS` and gets a handler here. The enqueue
 *     side and the execute side are bound together by
 *     `test/jobs.registry-completeness.test.ts`; adding one without the other
 *     fails that gate.
 *  2. **Laziness.** Handlers resolve their dependencies INSIDE the closure, not
 *     at build time. `buildJobHandlers` is called once per `jobs run` before any
 *     job is claimed, so build-time work would run even on an empty queue — and
 *     the completeness gate builds the registry with a stub `deps` precisely
 *     because nothing is dereferenced until a job actually executes.
 *
 * The registry is ctx-parameterized rather than populated at import time: real
 * handlers need a `RunContext` and an open `Store`, and both are only in scope
 * inside `jobsRun`. The env-gated test handler (`jobs-test-handler.ts`) keeps its
 * separate import-time seam — it takes no deps and must never ship in this map.
 */
import type { JobHandler } from "@atlas/jobs";
import type { Store } from "@atlas/sqlite-store";
import type { RunContext } from "../handlers.js";
import { RETENTION_WORKFLOWS } from "../retention/jobs.js";
import { buildRetentionHandlers } from "../retention/handlers.js";
import { REMEDIATION_WORKFLOW } from "../trust/revoke.js";
import { buildRemediationHandler } from "../trust/remediation.js";
import { REVERIFY_WORKFLOW } from "../workflows/reverify.js";
import { buildReverifyHandler } from "../workflows/reverify-handler.js";
import { INDEX_RECONCILE_WORKFLOW, buildIndexReconcileHandler } from "../sync/reconcile-handler.js";

/** Everything a production job handler may need, resolved lazily per execution. */
export interface JobHandlerDeps {
  readonly ctx: RunContext;
  readonly store: Store;
}

/**
 * The workflows the production registry covers. Bound to the enqueue-side
 * constants by the completeness gate — this list is not free-form.
 */
export const PRODUCTION_WORKFLOWS = [
  ...RETENTION_WORKFLOWS,
  REMEDIATION_WORKFLOW,
  REVERIFY_WORKFLOW,
  INDEX_RECONCILE_WORKFLOW,
] as const;

export type ProductionWorkflow = (typeof PRODUCTION_WORKFLOWS)[number];

/**
 * Build the production workflow→executor map. Pure and side-effect free: it only
 * closes over `deps`, so it is safe to call before the queue is known to be
 * non-empty (and safe for the completeness gate to call with a stub).
 */
export function buildJobHandlers(deps: JobHandlerDeps): Record<string, JobHandler> {
  return {
    ...buildRetentionHandlers(deps),
    [REMEDIATION_WORKFLOW]: buildRemediationHandler(deps),
    [REVERIFY_WORKFLOW]: buildReverifyHandler(deps),
    [INDEX_RECONCILE_WORKFLOW]: buildIndexReconcileHandler(deps),
  };
}
