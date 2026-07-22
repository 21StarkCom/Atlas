/**
 * `operation-gate.reserved-only` — the v2 operation allowlist. After the Phase-3
 * demolition the gate has ONE job: refuse the reserved task ops and any op name
 * outside the ChangePlan synthesis set. There is no phase argument, no tier gate,
 * and no trust op (Promote/RevokeTrust are gone). Every recognized synthesis op is
 * permitted.
 */
import { describe, it, expect } from "vitest";
import type { ChangePlanOperation } from "@atlas/contracts";
import {
  assertOperationAllowed,
  OperationForbiddenError,
} from "../src/policies/operation-gate.js";

const op = (name: string): ChangePlanOperation =>
  ({ op: name } as unknown as ChangePlanOperation);

function catchErr(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("assertOperationAllowed — reserved task ops (a)", () => {
  it("refuses CreateTask with reserved-operation, exit 1", () => {
    const err = catchErr(() => assertOperationAllowed(op("CreateTask")));
    expect(err).toBeInstanceOf(OperationForbiddenError);
    expect(err).toMatchObject({ code: "reserved-operation", exitCode: 1 });
  });
  it("refuses UpdateTaskState with reserved-operation, exit 1", () => {
    const err = catchErr(() => assertOperationAllowed(op("UpdateTaskState")));
    expect(err).toBeInstanceOf(OperationForbiddenError);
    expect(err).toMatchObject({ code: "reserved-operation", exitCode: 1 });
  });
});

describe("assertOperationAllowed — unknown ops (b)", () => {
  it("refuses an unrecognized op with operation-forbidden, exit 1", () => {
    const err = catchErr(() => assertOperationAllowed(op("SomethingNew")));
    expect(err).toBeInstanceOf(OperationForbiddenError);
    expect(err).toMatchObject({ code: "operation-forbidden", exitCode: 1 });
  });
  it("has no PromoteTrust/RevokeTrust op (d) — both refused as unknown", () => {
    expect(catchErr(() => assertOperationAllowed(op("PromoteTrust")))).toMatchObject({
      code: "operation-forbidden",
    });
    expect(catchErr(() => assertOperationAllowed(op("RevokeTrust")))).toMatchObject({
      code: "operation-forbidden",
    });
  });
});

describe("assertOperationAllowed — synthesis ops permitted (c)", () => {
  const SYNTHESIS_OPS = [
    "CreateNote",
    "UpdateSection",
    "AppendSection",
    "SetFrontmatterField",
    "AddAlias",
    "SetLink",
    "CreateRelationship",
    "CreateClaim",
    "AttachEvidence",
    "UpdateEvidenceVerification",
    "ProposeMerge",
    "ProposeRename",
    "ProposeArchive",
  ];
  for (const name of SYNTHESIS_OPS) {
    it(`permits ${name} (no phase argument, no tier gate)`, () => {
      expect(() => assertOperationAllowed(op(name))).not.toThrow();
    });
  }
});
