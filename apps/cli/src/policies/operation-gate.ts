/**
 * `policies.operationGate` — the ONE surviving gate semantic after the v2
 * trust/scan-gate demolition (Phase-3, ADR-0003). The retired security
 * architecture layered risk-tier gating, phase allowlists, and synthesis
 * fail-closed refusal on top of this owner; all of that is gone. What remains is
 * the minimal, deterministic membership check every model-derived operation runs
 * before it can mutate the vault:
 *
 *   - **reserved** — the forward-compatible task ops (`CreateTask`,
 *     `UpdateTaskState`) are refused ALWAYS (`reserved-operation`, exit 1).
 *   - **unknown** — an op name outside the contract's `ChangePlanOpName` set is
 *     refused FAIL-CLOSED (`operation-forbidden`, exit 1), so a newly-added or
 *     malformed op is rejected until it is deliberately admitted here.
 *   - everything else (the synthesis ops) is permitted — there is no tier gate.
 *
 * `assertOperationAllowed` throws a typed {@link OperationForbiddenError} (exit 1)
 * — it never returns a boolean a caller could forget to check.
 */
import { isReservedOp, type ChangePlanOperation, type ChangePlanOpName } from "@atlas/contracts";

/** The known non-reserved (synthesis) operation names admitted by the gate. */
const KNOWN_SYNTHESIS_OPS: ReadonlySet<string> = new Set<ChangePlanOpName>([
  "CreateNote",
  "UpdateSection",
  "AppendSection",
  "SetFrontmatterField",
  "AddAlias",
  "SetLink",
  "CreateRelationship",
  "ProposeMerge",
  "ProposeRename",
  "ProposeArchive",
]);

/** A typed refusal — the operation is reserved or unknown, so it cannot execute. */
export class OperationForbiddenError extends Error {
  /** Plan §2.5 exit code for a validation-class refusal. */
  readonly exitCode = 1 as const;
  readonly op: string;
  /** Stable code: `reserved-operation` for the reserved ops, else `operation-forbidden`. */
  readonly code: "reserved-operation" | "operation-forbidden";

  constructor(op: string, code: "reserved-operation" | "operation-forbidden") {
    super(
      code === "reserved-operation"
        ? `operation "${op}" is reserved and cannot be executed (V1 policy)`
        : `operation "${op}" is not a recognized ChangePlan operation`,
    );
    this.name = "OperationForbiddenError";
    this.op = op;
    this.code = code;
  }
}

/**
 * Assert an operation may execute, throwing {@link OperationForbiddenError}
 * otherwise. The reserved task ops are refused always; an unknown op name is
 * refused fail-closed; every recognized synthesis op is permitted (no tier gate).
 */
export function assertOperationAllowed(op: ChangePlanOperation): void {
  if (isReservedOp(op.op)) throw new OperationForbiddenError(op.op, "reserved-operation");
  if (!KNOWN_SYNTHESIS_OPS.has(op.op)) throw new OperationForbiddenError(op.op, "operation-forbidden");
}
