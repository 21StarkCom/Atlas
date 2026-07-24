/**
 * Provider refusal taxonomy — the survivor half of the retired egress-broker
 * refusal set (D19). {@link EgressRefusal} is kept as a stable, typed refusal the
 * `@atlas/models` client can surface; in the in-process cutover the capability /
 * budget / scan refusals are gone, so this is emitted rarely — but the symbol
 * survives so callers (`apps/cli`) keep a single refusal type to map to an exit
 * code. Defined here so `@atlas/models` no longer imports `the retired egress broker`.
 */

/** The CLI exit-code range (plan §2.5 exit set, 0..6). */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The retained refusal catalog with its exit-code mapping. `secret_detected`
 * reuses the secret-scan exit code (3); the capability/budget/sensitivity codes are
 * `6` (action-required) except a structurally invalid capability, which is `1`.
 */
export const EGRESS_ERROR_CATALOG = {
  "egress.capability_invalid": 1,
  "egress.capability_expired": 6,
  "egress.capability_mismatch": 6,
  "egress.byte_budget_exceeded": 6,
  "egress.token_budget_exceeded": 6,
  "egress.cost_budget_exceeded": 6,
  "egress.sensitivity_exceeded": 6,
  "egress.secret_detected": 3,
  "egress.bad_request": 5,
  "egress.internal": 4,
} as const satisfies Record<string, ExitCode>;

export type EgressCode = keyof typeof EGRESS_ERROR_CATALOG;

/** Resolve the exit code for an egress refusal code (defaults to internal `4`). */
export function egressExitCodeFor(code: string): ExitCode {
  return (EGRESS_ERROR_CATALOG as Record<string, ExitCode>)[code] ?? 4;
}

/**
 * A typed provider refusal. Carries a stable {@link EgressCode}, its exit code, and
 * optional allowlisted `detail` (never a secret nor a raw payload).
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
}
