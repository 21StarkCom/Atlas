/**
 * `synthesis/model-output` — the production model-output ORCHESTRATION BOUNDARY.
 *
 * Every model-derived operation (a synthesis `ChangePlan` produced from model
 * output) that would mutate the vault MUST pass through {@link submitModelDerivedOperation}
 * FIRST. It consults the SSOT operation gate (`policies/operation-gate`) fail-closed
 * BEFORE any executor runs, so in Phase 2 a synthesis/trust/reserved operation is
 * refused ({@link OperationForbiddenError}) and NOTHING downstream — no persisted
 * `ChangePlan`, no canonical mutation, no broker `advanceProtectedRef` — ever runs.
 *
 * ## Why this lives under `src/` (not a test helper)
 * The Phase-2 restriction — "the vault cannot be mutated via model output" — is a
 * PRODUCTION invariant. If the gate were only consulted by a test-only helper, real
 * model output could reach the vault while the E2E stayed green. This module is the
 * one seam a Phase-4 synthesis executor will call (Phase 4 supplies the real
 * `execute`); the Phase-2 exit test drives THIS boundary.
 *
 * ## No bypass in the shipped surface (round-2 wing finding 1)
 * The production entry point {@link submitModelDerivedOperation} enforces the SSOT gate
 * at phase 2 FIXED inside the boundary — there is NO caller-supplied `gate`/`phase`
 * parameter, and this module exports NO symbol, hook, or "internals" object a caller
 * could use to substitute a no-op gate or a later phase. Consequently NO shipped API
 * (named export OR symbol-keyed) can reach synthesis in Phase 2. The release-blocking
 * exit test proves the all-sinks invariant has teeth by injecting a SYNTHETIC bypass —
 * but it does so through a GENUINELY TEST-ONLY seam that lives under `test/`
 * (`phase2-support.ts` → `submitThroughSyntheticGate`), never here in `src/`. An
 * export-surface regression test pins this module's exports to the allowlist below.
 *
 * The executor is injected (not hard-coded) because Phase 2 ships NO synthesis
 * executor at all — the gate is expected to reject before an executor is ever needed.
 */
import type { ChangePlan } from "@atlas/contracts";
import { assertOperationAllowed } from "../policies/operation-gate.js";

export { OperationForbiddenError, assertOperationAllowed } from "../policies/operation-gate.js";

/**
 * The synthesis executor a submission runs — reached ONLY past the gate.
 */
export type SynthesisExecutor = (plan: ChangePlan) => void | Promise<void>;

/**
 * How a model-derived operation is submitted through the orchestration boundary.
 *
 * The production surface carries ONLY the executor — there is NO `gate` or `phase`
 * parameter a caller could use to reach synthesis in Phase 2 (round-2 wing finding 1).
 * The phase-2 restriction is enforced internally against the SSOT, fail-closed.
 */
export interface ModelOutputSubmission {
  /**
   * The synthesis executor, reached ONLY past the gate. Phase 4 supplies the real
   * one (persist the `ChangePlan`, apply, integrate via the broker's authorized
   * canonical-advance path). In Phase 2 the internal gate rejects first, so this is
   * never invoked.
   */
  readonly execute: SynthesisExecutor;
}

/**
 * Submit a model-derived operation through the production orchestration boundary.
 * Consults the SSOT operation gate FAIL-CLOSED at phase 2 for the parsed
 * `ChangePlan`'s operation; ONLY if the gate permits it does `execute` run. In
 * Phase 2 the gate throws {@link OperationForbiddenError} for every synthesis/trust/
 * reserved op, so `execute` is never reached — no `ChangePlan` is persisted and
 * canonical is never mutated. Enforcement is FIXED here — the SSOT gate at phase 2 —
 * and there is NO parameter a caller can pass to weaken it (round-2 wing finding 1).
 */
export async function submitModelDerivedOperation(
  plan: ChangePlan,
  submission: ModelOutputSubmission,
): Promise<void> {
  // Fail-closed SSOT restriction — throws for reserved/unknown ops.
  assertOperationAllowed(plan.operation);
  // ── PAST THE GATE — reachable ONLY when the SSOT gate permitted the operation. ──
  await submission.execute(plan);
}
