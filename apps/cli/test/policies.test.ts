import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ChangePlan, ChangePlanOperation, RiskTier } from "@atlas/contracts";
import {
  mutationPolicyFor,
  mutationPolicyValueFor,
  MUTATION_POLICY,
  POLICY_TARGET_TYPES,
  type PolicyValue,
} from "../src/policies/mutation-policy.js";
import { effectiveRisk, riskConfigFrom, type PolicyContext } from "../src/policies/risk.js";
import { effectiveSensitivity, mostRestrictive, type SensitivityDeps } from "../src/policies/sensitivity.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Parse the machine-readable `mutationPolicy` block from the workflow-risk-contract spec. */
function specMutationPolicy(): {
  targetTypes: string[];
  ops: { op: string; policy: Record<string, string> }[];
} {
  const raw = readFileSync(join(REPO_ROOT, "docs/specs/workflow-risk-contract.md"), "utf8");
  const block = /```json\s+mutationPolicy\s*\n([\s\S]*?)\n```/.exec(raw);
  if (!block) throw new Error("no mutationPolicy block in workflow-risk-contract.md");
  return JSON.parse(block[1]!);
}

const CONFIG = riskConfigFrom({
  tier2_min_confidence: 0.8,
  tier2_max_changed_lines: 50,
  tier2_max_sections: 3,
});

/** A ChangePlan carrying `op` and `confidence`; `proposedRisk` is set to a decoy on purpose. */
function plan(op: ChangePlanOperation["op"], confidence: number, proposedRisk: RiskTier = "tier-1"): ChangePlan {
  const operation = { op, opVersion: 1 } as unknown as ChangePlanOperation;
  return {
    target: "note-x",
    rationale: "test",
    sourceIds: [],
    retrievedEvidence: [],
    confidence,
    proposedRisk,
    reversibility: "reversible",
    schemaVersion: 1,
    operation,
  } as ChangePlan;
}

/** A context that would earn Tier-2 unless a single field is overridden to escalate. */
function autoCtx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    targetType: "concept",
    changedLines: 10,
    sections: 1,
    singleNote: true,
    destructive: false,
    inputsTrusted: true,
    evidenceValid: true,
    validationConfidence: 0.95,
    config: CONFIG,
    ...over,
  };
}

describe("mutationPolicyFor: table matches the contract for every op × type", () => {
  const spec = specMutationPolicy();

  it("is byte-equal to the spec's machine-readable mutationPolicy block (anti-drift)", () => {
    expect(JSON.parse(JSON.stringify(MUTATION_POLICY.ops))).toEqual(spec.ops);
    expect(MUTATION_POLICY.targetTypes).toEqual(spec.targetTypes);
  });

  it("every op × target-type cell resolves to the contract's policy value", () => {
    const byOp = new Map(spec.ops.map((o) => [o.op, o.policy]));
    for (const type of POLICY_TARGET_TYPES) {
      const row = mutationPolicyFor(type);
      for (const { op } of spec.ops) {
        expect(row[op as keyof typeof row]).toBe(byOp.get(op)![type]);
      }
    }
  });

  it("sources are immutable for every content/proposal op (source mutation ⇒ policy violation)", () => {
    const row = mutationPolicyFor("source");
    for (const { op } of spec.ops) {
      const expected = op === "PromoteTrust" || op === "RevokeTrust" ? "review" : op.startsWith("CreateTask") || op === "UpdateTaskState" ? "reserved" : "immutable";
      expect(row[op as keyof typeof row]).toBe(expected as PolicyValue);
    }
  });

  it("falls back to fail-closed review (never auto) for an unknown note type", () => {
    expect(mutationPolicyValueFor("UpdateSection", "gizmo")).toBe("review");
    expect(mutationPolicyValueFor("CreateTask", "gizmo")).toBe("reserved");
  });
});

describe("effectiveRisk: deterministic tier from op × type × scope × config", () => {
  it("earns Tier-2 for an auto op within every bound", () => {
    expect(effectiveRisk(plan("UpdateSection", 0.95), autoCtx())).toBe("tier-2");
  });

  it("append-only + append op is auto-eligible (Tier-2 within bounds)", () => {
    expect(effectiveRisk(plan("AppendSection", 0.95), autoCtx({ targetType: "decision" }))).toBe("tier-2");
  });

  it("a review cell is always Tier-3 even within all bounds", () => {
    expect(effectiveRisk(plan("ProposeMerge", 0.99), autoCtx())).toBe("tier-3");
  });

  it("an immutable cell can never grant Tier-2", () => {
    expect(effectiveRisk(plan("UpdateSection", 0.99), autoCtx({ targetType: "source" }))).toBe("tier-3");
  });

  it.each<[string, Partial<PolicyContext>]>([
    ["over changed-lines", { changedLines: 51 }],
    ["over sections", { sections: 4 }],
    ["spans multiple notes", { singleNote: false }],
    ["destructive", { destructive: true }],
    ["untrusted input", { inputsTrusted: false }],
    ["non-valid evidence", { evidenceValid: false }],
    ["low validation confidence", { validationConfidence: 0.5 }],
    ["missing validation confidence", { validationConfidence: undefined }],
    ["malformed validation confidence", { validationConfidence: Number.NaN }],
  ])("escalates to Tier-3 on %s (each trigger independently)", (_label, over) => {
    expect(effectiveRisk(plan("UpdateSection", 0.95), autoCtx(over))).toBe("tier-3");
  });

  it("low MODEL confidence alone forces Tier-3 (two-input min-reduction)", () => {
    expect(effectiveRisk(plan("UpdateSection", 0.5), autoCtx())).toBe("tier-3");
  });

  it("ignores proposedRisk entirely: a tier-3 decoy still yields Tier-2 when inputs qualify", () => {
    expect(effectiveRisk(plan("UpdateSection", 0.95, "tier-3"), autoCtx())).toBe("tier-2");
  });

  it("ignores proposedRisk entirely: a tier-1 decoy still yields Tier-3 when a bound fails", () => {
    expect(effectiveRisk(plan("UpdateSection", 0.95, "tier-1"), autoCtx({ changedLines: 200 }))).toBe("tier-3");
  });
});

describe("effectiveSensitivity: computed-on-read, most-restrictive over the chain", () => {
  const deps = (declared: SensitivityDeps["declaredFor"], inputs: SensitivityDeps["inputSensitivities"]): SensitivityDeps => ({
    declaredFor: declared,
    inputSensitivities: inputs,
    defaultSensitivity: "internal",
  });

  it("takes the max over declared + source→claim→note input chain", () => {
    const d = deps(
      () => "public",
      () => ["internal", "restricted", "public"],
    );
    expect(effectiveSensitivity("n", d)).toBe("restricted");
  });

  it("returns the declared label when there are no inputs", () => {
    expect(effectiveSensitivity("n", deps(() => "confidential", () => []))).toBe("confidential");
  });

  it("falls back to the config default for unlabeled content", () => {
    expect(effectiveSensitivity("n", deps(() => undefined, () => []))).toBe("internal");
  });

  it("mostRestrictive follows public < internal < confidential < restricted", () => {
    expect(mostRestrictive("public", "internal")).toBe("internal");
    expect(mostRestrictive("confidential", "restricted")).toBe("restricted");
    expect(mostRestrictive("restricted", "public")).toBe("restricted");
  });
});

describe("proposedRisk grep-guard: no module reads it for control flow", () => {
  it("the string `proposedRisk` appears in no apps/cli/src source file", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (full.endsWith(".ts") && readFileSync(full, "utf8").includes("proposedRisk")) {
          offenders.push(full);
        }
      }
    };
    walk(join(REPO_ROOT, "apps/cli/src"));
    expect(offenders).toEqual([]);
  });
});
