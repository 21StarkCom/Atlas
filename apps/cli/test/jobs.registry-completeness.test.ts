/**
 * Registry-completeness gate.
 *
 * Every workflow name that production code can `enqueue()` MUST have a handler
 * registered in the production registry. Without this gate the registry was
 * empty (`JOB_HANDLERS = {}`), so every enqueued job hit
 * `runner.ts`'s "no handler registered" path — which classifies `internal` as
 * TRANSIENT, meaning the job burned its whole attempt budget with backoff
 * before failing at exit 4. A permanent misconfiguration retried as if it were
 * a blip.
 *
 * Nothing caught it: every CLI `jobs run` test drains an EMPTY queue, and the
 * real-process tests all set `ATLAS_TEST_JOB_HANDLER=1` so they only ever
 * exercise the synthetic `test-cap` workflow.
 *
 * This test binds the enqueue side to the execute side. Adding a new
 * `enqueue()` call site with an unregistered workflow now fails here.
 */
import { describe, expect, it } from "vitest";
import { buildJobHandlers, PRODUCTION_WORKFLOWS } from "../src/commands/job-handlers.ts";
import type { JobHandlerDeps } from "../src/commands/job-handlers.ts";
import { RETENTION_WORKFLOWS } from "../src/retention/jobs.ts";
import { REMEDIATION_WORKFLOW } from "../src/trust/revoke.ts";
import { REVERIFY_WORKFLOW } from "../src/workflows/reverify.ts";

/**
 * Handlers resolve their dependencies lazily INSIDE the closure, so building the
 * registry never touches the store. That is what lets this gate run without a
 * vault, and it is a property worth preserving — hence the stub.
 */
const stubDeps = {} as JobHandlerDeps;

describe("job handler registry completeness", () => {
  it("declares every enqueueable production workflow", () => {
    // PRODUCTION_WORKFLOWS is the union the registry promises to cover. Assert it
    // against the enqueue-side constants so a new workflow cannot be added to one
    // side alone.
    const enqueueable = [...RETENTION_WORKFLOWS, REMEDIATION_WORKFLOW, REVERIFY_WORKFLOW];
    expect([...PRODUCTION_WORKFLOWS].sort()).toEqual([...enqueueable].sort());
  });

  it("registers a handler for every production workflow", () => {
    const handlers = buildJobHandlers(stubDeps);
    const missing = PRODUCTION_WORKFLOWS.filter((w) => typeof handlers[w] !== "function");
    expect(missing).toEqual([]);
  });

  it("registers no handler the production workflow list does not declare", () => {
    const handlers = buildJobHandlers(stubDeps);
    const undeclared = Object.keys(handlers).filter(
      (w) => !(PRODUCTION_WORKFLOWS as readonly string[]).includes(w),
    );
    expect(undeclared).toEqual([]);
  });

  it("builds the registry without touching the store", () => {
    // Guards the laziness property the stub above depends on: if a handler ever
    // resolves a store/config at BUILD time, this throws instead of returning.
    expect(() => buildJobHandlers(stubDeps)).not.toThrow();
  });
});
