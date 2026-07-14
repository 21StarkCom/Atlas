/**
 * Egress-broker refusal taxonomy (D19). Stable codes with the plan §2.5 exit-code
 * mapping, mirroring the {@link BrokerRefusal} discipline of the integration
 * broker: every refusal a `@atlas/models` client sees is one of these — a typed
 * refusal, never a bare throw across the egress IPC seam.
 *
 * These are DISTINCT from the provider-error taxonomy (`@atlas/contracts`
 * `ProviderError`): a `ProviderError` is a fault of the remote provider call
 * (rate limit, timeout, auth) surfaced to the caller for retry classification; an
 * `EgressRefusal` is the broker itself REFUSING to transmit — a capability/budget
 * violation, a secret detected in the exact serialized payload, or a sensitivity
 * over-export. A refusal still produces a receipt so the CLI writes a `model_calls`
 * row for the refused transmission (D6/D18).
 */

import type { ExitCode } from "../errors.js";

/**
 * The egress refusal catalog. `secret_detected` reuses the secret-scan exit code
 * (3) so the CLI boundary maps an in-broker scan block to the same process exit a
 * pre-persistence scan block produces. The capability/budget/sensitivity codes are
 * `6` (action-required — the run's minted bounds must change) except a structurally
 * invalid capability, which is `1` (validation).
 */
export const EGRESS_ERROR_CATALOG = {
  /** The capability failed structural validation or its MAC did not verify. */
  "egress.capability_invalid": 1,
  /** The capability expired (past `expiresAt`). */
  "egress.capability_expired": 6,
  /** The request's operation/model did not match the capability's binding. */
  "egress.capability_mismatch": 6,
  /** Cumulative per-run outbound bytes would exceed the capability's `maxBytes`. */
  "egress.byte_budget_exceeded": 6,
  /** Cumulative per-run token usage would exceed the capability's `maxTokens`. */
  "egress.token_budget_exceeded": 6,
  /** Cumulative per-run cost would exceed the capability's `costCeiling`. */
  "egress.cost_budget_exceeded": 6,
  /** The payload's effectiveSensitivity exceeds the run's `allowedSensitivity`. */
  "egress.sensitivity_exceeded": 6,
  /** A secret was detected in the exact serialized request/response payload. */
  "egress.secret_detected": 3,
  /** A malformed/unroutable IPC frame. */
  "egress.bad_request": 5,
  /** Any uncaught internal fault (never leaks a stack across the seam). */
  "egress.internal": 4,
} as const satisfies Record<string, ExitCode>;

export type EgressCode = keyof typeof EGRESS_ERROR_CATALOG;

/** Resolve the exit code for an egress refusal code (defaults to internal `4`). */
export function egressExitCodeFor(code: string): ExitCode {
  return (EGRESS_ERROR_CATALOG as Record<string, ExitCode>)[code] ?? 4;
}

/**
 * A typed egress-broker refusal. Carries a stable {@link EgressCode}, its exit
 * code, and an optional structured `detail` (allowlisted metadata only — never a
 * secret nor a raw payload). Serializable across the IPC seam and rebuilt on the
 * client so callers see the same code/exitCode locally and remotely.
 */
export class EgressRefusal extends Error {
  readonly code: EgressCode;
  readonly exitCode: ExitCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: EgressCode, message?: string, detail: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = "EgressRefusal";
    this.code = code;
    this.exitCode = egressExitCodeFor(code);
    this.detail = detail;
  }

  /** Wire form for the IPC response envelope. */
  toWire(): { code: EgressCode; exitCode: ExitCode; message: string; detail: Record<string, unknown> } {
    return { code: this.code, exitCode: this.exitCode, message: this.message, detail: { ...this.detail } };
  }
}
