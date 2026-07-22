/**
 * `operation-gate.test` — the Phase-2 operation allowlist (provider-interface §6;
 * fixes R1-F3). Capture/projection allowed, synthesis fail-closed in Phase 2,
 * reserved task ops rejected in EVERY phase; Phase 4 permits synthesis (tier
 * gating layers on top of this same owner).
 */
import { describe, it, expect } from "vitest";
import type { ChangePlanOperation } from "@atlas/contracts";
import {
  assertOperationAllowed,
  classifyOperation,
  OperationForbiddenError,
} from "../src/policies/operation-gate.js";

/** Minimal well-typed op payloads (only `op` matters to the gate). */
const createNote = { op: "CreateNote" } as unknown as ChangePlanOperation;
const createTask = { op: "CreateTask" } as unknown as ChangePlanOperation;
const updateSection = { op: "UpdateSection" } as unknown as ChangePlanOperation;

describe("classifyOperation", () => {
  it("classifies the retired trust ops as unknown ⇒ synthesis (fail-closed; v2 has no trust ops)", () => {
    expect(classifyOperation("PromoteTrust")).toBe("synthesis");
    expect(classifyOperation("RevokeTrust")).toBe("synthesis");
  });
  it("classifies knowledge mutations as synthesis", () => {
    expect(classifyOperation("CreateNote")).toBe("synthesis");
    expect(classifyOperation("AttachEvidence")).toBe("synthesis");
  });
  it("classifies task ops as reserved (from the contracts SSOT)", () => {
    expect(classifyOperation("CreateTask")).toBe("reserved");
    expect(classifyOperation("UpdateTaskState")).toBe("reserved");
  });
  it("fails closed to synthesis for an unknown op", () => {
    expect(classifyOperation("SomethingNew")).toBe("synthesis");
  });
});

describe("assertOperationAllowed — Phase 2", () => {
  it("rejects a synthesis op FAIL-CLOSED", () => {
    const err = catchErr(() => assertOperationAllowed(createNote, 2));
    expect(err).toBeInstanceOf(OperationForbiddenError);
    expect(err).toMatchObject({ code: "operation-forbidden", opClass: "synthesis", exitCode: 1 });
  });
  it("rejects a reserved op ALWAYS", () => {
    const err = catchErr(() => assertOperationAllowed(createTask, 2));
    expect(err).toMatchObject({ code: "reserved-operation", opClass: "reserved" });
  });
});

describe("assertOperationAllowed — Phase 4", () => {
  it("permits a synthesis op (tier gating layers on top elsewhere)", () => {
    expect(() => assertOperationAllowed(createNote, 4)).not.toThrow();
    expect(() => assertOperationAllowed(updateSection, 4)).not.toThrow();
  });
  it("still rejects a reserved op", () => {
    expect(() => assertOperationAllowed(createTask, 4)).toThrow(OperationForbiddenError);
  });
});

function catchErr(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}
