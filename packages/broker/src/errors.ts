/**
 * Broker refusal taxonomy — stable codes with the plan §2.5 exit-code mapping.
 *
 * The authorization drift codes (`authz.*`) mirror the security/broker contract
 * §7.3 catalog verbatim (that doc is the SSOT); the `broker.*` codes cover the
 * protected-ref / audit-append primitives this package owns. Every refusal a
 * client sees is one of these — a typed refusal, never a bare throw across the
 * IPC seam.
 */

/** Exit-code set (plan §2.5): 0 ok · 1 validation · 2 config/vault · 3 secret-scan · 4 internal · 5 user/usage · 6 action-required. */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The §7.3 authorization drift-rejection catalog (stable codes → exit codes). */
export const AUTHZ_ERROR_CATALOG = {
  "authz.ok": 0,
  "authz.canonical_moved": 6,
  "authz.target_mismatch": 6,
  "authz.revert_mismatch": 6,
  "authz.backup_hash_mismatch": 6,
  "authz.generation_mismatch": 6,
  "authz.migration_plan_mismatch": 6,
  "authz.trust_level_mismatch": 6,
  "authz.rpo_gap_unaccepted": 6,
  "authz.quarantine_item_unknown": 1,
  "authz.quarantine_key_denied": 2,
  "authz.nonce_unknown": 1,
  "authz.nonce_expired": 6,
  "authz.nonce_replayed": 1,
  "authz.signer_unknown": 1,
  "authz.signer_revoked": 1,
  "authz.signer_not_permitted": 1,
  "authz.signature_invalid": 1,
  "authz.payload_mismatch": 1,
  "authz.schema_invalid": 1,
  "authz.canonicalization_unsupported": 1,
  "authz.presence_unverified": 6,
} as const satisfies Record<string, ExitCode>;

export type AuthzCode = keyof typeof AUTHZ_ERROR_CATALOG;

/**
 * The `broker.*` codes for the protected-ref + audit-append primitives (not part
 * of the authorization drift catalog but the same typed-refusal discipline).
 */
export const BROKER_ERROR_CATALOG = {
  "broker.ref_not_protected": 5,
  "broker.cas_failed": 6,
  "broker.not_fast_forward": 6,
  "broker.unknown_commit": 1,
  "broker.audit_seq_nonmonotonic": 1,
  "broker.audit_prev_head_mismatch": 1,
  "broker.audit_idempotency_conflict": 1,
  "broker.audit_chain_invalid": 4,
  "broker.audit_signature_invalid": 1,
  "broker.audit_signer_unknown": 1,
  "broker.audit_signer_untrusted": 1,
  "broker.event_binding_mismatch": 1,
  "broker.capture_scope_violation": 1,
  "broker.anchor_truncation": 4,
  "broker.bad_request": 5,
  "broker.internal": 4,
} as const satisfies Record<string, ExitCode>;

export type BrokerCode = keyof typeof BROKER_ERROR_CATALOG;

/** Every refusal code the broker can return. */
export type RefusalCode = AuthzCode | BrokerCode;

const EXIT_BY_CODE: Record<string, ExitCode> = {
  ...AUTHZ_ERROR_CATALOG,
  ...BROKER_ERROR_CATALOG,
};

/** Resolve the exit code for any refusal code (defaults to internal `4`). */
export function exitCodeFor(code: string): ExitCode {
  return EXIT_BY_CODE[code] ?? 4;
}

/**
 * A typed broker refusal. Carries a stable {@link RefusalCode}, its exit code,
 * and an optional structured `detail` (e.g. `{ noop: true }` for idempotent
 * completed replays, per §7.3). Serializable across the IPC seam and rebuilt on
 * the client so callers see the same code/exitCode locally and remotely.
 */
export class BrokerRefusal extends Error {
  readonly code: RefusalCode;
  readonly exitCode: ExitCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: RefusalCode, message?: string, detail: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = "BrokerRefusal";
    this.code = code;
    this.exitCode = exitCodeFor(code);
    this.detail = detail;
  }

  /** Wire form for the IPC response envelope. */
  toWire(): { ok: false; code: RefusalCode; exitCode: ExitCode; message: string; detail: Record<string, unknown> } {
    return { ok: false, code: this.code, exitCode: this.exitCode, message: this.message, detail: { ...this.detail } };
  }
}
