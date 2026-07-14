/**
 * `policies.operationGate` — the Phase-2 operation allowlist (fixes R1-F3;
 * provider-interface §6). Phase 2 is the ingest loop: the ONLY artifact that may
 * commit is deterministic, model-free immutable source capture. No synthesis
 * `ChangePlan` may even be CREATED — so this gate refuses synthesis operations
 * FAIL-CLOSED, and refuses the reserved task operations ALWAYS.
 *
 * SINGLE SOURCE (plan Task 2.8): Phase 4 extends THIS owner with risk-tier gating;
 * the classification below is the SSOT both phases consult. `assertOperationAllowed`
 * throws a typed {@link OperationForbiddenError} (exit 1) — it never returns a
 * boolean a caller could forget to check.
 *
 * Classification of the 17 `ChangePlanOperation`s (contracts `CHANGE_PLAN_OPS`):
 *   - `capture`   — source-lifecycle maintenance over already-captured sources
 *     (deterministic, operator-authorized; NOT model synthesis). Allowed in Phase 2.
 *     Ordinary source *capture* is a deterministic non-`ChangePlan` path.
 *   - `trust`     — the trust-ledger ops (`PromoteTrust`/`RevokeTrust`). Their owning
 *     contract (`@atlas/contracts` ops/trust.ts) marks EXECUTION as a privileged,
 *     broker-authorized change at PHASE-4 time — so, like synthesis, they are
 *     FORBIDDEN in Phase 2 (fail-closed) and permitted (tier-gated) in Phase 4. They
 *     are NOT `capture`: classifying them as capture let Phase 2 execute a Phase-4-only
 *     privileged trust mutation (the finding).
 *   - `synthesis` — every model-derivable knowledge mutation. FORBIDDEN in Phase 2
 *     (fail-closed), permitted (tier-gated) in Phase 4.
 *   - `reserved`  — the forward-compatible task ops. FORBIDDEN in every phase.
 *
 * There is no `ChangePlanOperation` in the `projection` class — projection updates
 * are a deterministic DB rebuild (`run.projection`), not a `ChangePlan` — so the
 * "projection allowed" branch is represented by the deterministic non-ChangePlan
 * path and the `capture` allowance here.
 */
import {
  isReservedOp,
  type ChangePlanOperation,
  type ChangePlanOpName,
} from "@atlas/contracts";

/** The operation classes the gate branches on (single source for Phase 2 + 4). */
export type OperationClass = "capture" | "projection" | "synthesis" | "trust" | "reserved";

/** The phase whose allowlist is being enforced (2 = ingest; 4 = synthesis/integration). */
export type GatePhase = 2 | 4;

/**
 * The SSOT classification of every `ChangePlanOpName`. Reserved ops are derived
 * from the contracts `isReservedOp` SSOT (never re-enumerated); the rest are
 * classified here. A missing entry is treated as `synthesis` (fail-closed) so a
 * newly-added op is refused until it is deliberately classified.
 */
const OPERATION_CLASS: Readonly<Record<ChangePlanOpName, OperationClass>> = {
  // Trust-ledger ops — privileged, broker-authorized, EXECUTION PHASE-4-ONLY per
  // their owning contract (ops/trust.ts). Rejected in Phase 2 (fail-closed).
  PromoteTrust: "trust",
  RevokeTrust: "trust",
  // Model-derivable knowledge mutations — synthesis.
  CreateNote: "synthesis",
  UpdateSection: "synthesis",
  AppendSection: "synthesis",
  SetFrontmatterField: "synthesis",
  AddAlias: "synthesis",
  SetLink: "synthesis",
  CreateRelationship: "synthesis",
  CreateClaim: "synthesis",
  AttachEvidence: "synthesis",
  UpdateEvidenceVerification: "synthesis",
  ProposeMerge: "synthesis",
  ProposeRename: "synthesis",
  ProposeArchive: "synthesis",
  // Reserved forward-compatible task surface — always forbidden.
  CreateTask: "reserved",
  UpdateTaskState: "reserved",
};

/** Classify an operation name (fail-closed to `synthesis` for an unknown op). */
export function classifyOperation(op: string): OperationClass {
  if (isReservedOp(op)) return "reserved";
  return OPERATION_CLASS[op as ChangePlanOpName] ?? "synthesis";
}

/** A typed refusal — the operation is not permitted in the given phase. */
export class OperationForbiddenError extends Error {
  /** Plan §2.5 exit code for a validation-class refusal. */
  readonly exitCode = 1 as const;
  readonly op: string;
  readonly opClass: OperationClass;
  readonly phase: GatePhase;
  /** Stable code: `reserved-operation` for the reserved ops, else `operation-forbidden`. */
  readonly code: "reserved-operation" | "operation-forbidden";

  constructor(op: string, opClass: OperationClass, phase: GatePhase) {
    const code = opClass === "reserved" ? "reserved-operation" : "operation-forbidden";
    super(
      opClass === "reserved"
        ? `operation "${op}" is reserved and cannot be executed (V1 policy)`
        : `operation "${op}" (${opClass}) is not permitted in phase ${phase}`,
    );
    this.name = "OperationForbiddenError";
    this.op = op;
    this.opClass = opClass;
    this.phase = phase;
    this.code = code;
  }
}

/**
 * Assert an operation is permitted in `phase`, throwing {@link OperationForbiddenError}
 * otherwise. Phase 2: `capture`/`projection` allowed, `synthesis` AND `trust`
 * fail-closed, `reserved` always rejected. Phase 4: everything except `reserved`
 * allowed here (Phase-4 tier gating layers ON TOP of this same owner — it does not
 * relax the reserved rejection).
 */
export function assertOperationAllowed(op: ChangePlanOperation, phase: GatePhase): void {
  const opClass = classifyOperation(op.op);
  if (opClass === "reserved") throw new OperationForbiddenError(op.op, opClass, phase);
  if (phase === 2 && (opClass === "synthesis" || opClass === "trust")) {
    throw new OperationForbiddenError(op.op, opClass, phase);
  }
}
