/**
 * `policies.mutationPolicyFor` — the per-type mutation-policy table (Task 4.3),
 * part of the same `policies` owner as `operation-gate.ts`. Every operation ×
 * target note type maps to one policy value that the pipeline (Task 4.5),
 * validation (Task 4.4), and `effectiveRisk` (`risk.ts`) consume:
 *
 *   - **auto** — permitted; tier then determined by `effectiveRisk`.
 *   - **review** — permitted but ALWAYS Tier-3 (never auto-commits).
 *   - **append-only** — permitted only as an append; in-place replacement rejects.
 *   - **immutable** — rejected (fail-closed policy violation).
 *   - **reserved** — schema-present, execution-denied in V1 (`reserved-operation`).
 *
 * The table below is the RUNTIME SSOT; `policies.mutation-policy.test` asserts it
 * is byte-equal to the machine-readable `mutationPolicy` block in
 * `docs/specs/workflow-risk-contract.md` §mutation-policy (which `contract-lint`
 * independently proves is a bijection with `@atlas/contracts` `CHANGE_PLAN_OPS`).
 * So the code, the spec, and the op union can never drift apart.
 */
import { isReservedOp, type ChangePlanOpName } from "@atlas/contracts";
import type { NoteType } from "@atlas/contracts";

/** The legal policy values (the `policyValues` axis of the contract table). */
export const POLICY_VALUES = ["auto", "review", "append-only", "immutable", "reserved"] as const;
export type PolicyValue = (typeof POLICY_VALUES)[number];

/** The canonical target note types the table is defined over (the contract `targetTypes`). */
export const POLICY_TARGET_TYPES = [
  "concept",
  "person",
  "project",
  "research",
  "decision",
  "source",
  "task",
] as const;
export type PolicyTargetType = (typeof POLICY_TARGET_TYPES)[number];

/** A note type's full policy row: the policy value for every operation. */
export type MutationPolicy = Readonly<Record<ChangePlanOpName, PolicyValue>>;

/**
 * The mutation-policy table, op-major, mirroring `workflow-risk-contract.md`
 * §mutation-policy's `mutationPolicy` JSON block VERBATIM (the anti-drift test
 * deep-equals this to the parsed spec block).
 */
export const MUTATION_POLICY = {
  version: 1,
  targetTypes: ["concept", "person", "project", "research", "decision", "source", "task"],
  policyValues: ["auto", "review", "append-only", "immutable", "reserved"],
  ops: [
    { op: "CreateNote", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "review", source: "immutable", task: "reserved" } },
    { op: "UpdateSection", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "append-only", source: "immutable", task: "reserved" } },
    { op: "AppendSection", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "append-only", source: "immutable", task: "reserved" } },
    { op: "SetFrontmatterField", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "append-only", source: "immutable", task: "reserved" } },
    { op: "AddAlias", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "auto", source: "immutable", task: "reserved" } },
    { op: "SetLink", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "append-only", source: "immutable", task: "reserved" } },
    { op: "CreateRelationship", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "append-only", source: "immutable", task: "reserved" } },
    { op: "CreateClaim", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "append-only", source: "immutable", task: "reserved" } },
    { op: "AttachEvidence", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "append-only", source: "immutable", task: "reserved" } },
    { op: "UpdateEvidenceVerification", policy: { concept: "auto", person: "auto", project: "auto", research: "auto", decision: "auto", source: "immutable", task: "reserved" } },
    { op: "ProposeMerge", policy: { concept: "review", person: "review", project: "review", research: "review", decision: "immutable", source: "immutable", task: "reserved" } },
    { op: "ProposeRename", policy: { concept: "review", person: "review", project: "review", research: "review", decision: "immutable", source: "immutable", task: "reserved" } },
    { op: "ProposeArchive", policy: { concept: "review", person: "review", project: "review", research: "review", decision: "immutable", source: "immutable", task: "reserved" } },
    { op: "PromoteTrust", policy: { concept: "immutable", person: "immutable", project: "immutable", research: "immutable", decision: "immutable", source: "review", task: "reserved" } },
    { op: "RevokeTrust", policy: { concept: "immutable", person: "immutable", project: "immutable", research: "immutable", decision: "immutable", source: "review", task: "reserved" } },
    { op: "CreateTask", policy: { concept: "reserved", person: "reserved", project: "reserved", research: "reserved", decision: "reserved", source: "reserved", task: "reserved" } },
    { op: "UpdateTaskState", policy: { concept: "reserved", person: "reserved", project: "reserved", research: "reserved", decision: "reserved", source: "reserved", task: "reserved" } },
  ],
} as const;

/** True when `type` is one of the canonical policy target types. */
export function isPolicyTargetType(type: NoteType): type is PolicyTargetType {
  return (POLICY_TARGET_TYPES as readonly string[]).includes(type);
}

/**
 * The fail-closed policy for a note type the table does not enumerate: reserved
 * ops stay `reserved`; every other op is `review` — permitted only under human
 * review (always Tier-3), never auto-committed. An unrecognized note type can
 * therefore never silently auto-commit, and is never hard-blocked either.
 */
function unknownTypePolicy(op: ChangePlanOpName): PolicyValue {
  return isReservedOp(op) ? "reserved" : "review";
}

/**
 * The policy row for a target note type: every op mapped to its policy value.
 * Known types read the contract table; an unknown type falls back to {@link
 * unknownTypePolicy} (fail-closed).
 */
export function mutationPolicyFor(type: NoteType): MutationPolicy {
  const known = isPolicyTargetType(type);
  const row = {} as Record<ChangePlanOpName, PolicyValue>;
  for (const { op, policy } of MUTATION_POLICY.ops) {
    const name = op as ChangePlanOpName;
    row[name] = known ? (policy[type] as PolicyValue) : unknownTypePolicy(name);
  }
  return row;
}

/** The policy value for a single operation × target type. */
export function mutationPolicyValueFor(op: ChangePlanOpName, type: NoteType): PolicyValue {
  return mutationPolicyFor(type)[op];
}
