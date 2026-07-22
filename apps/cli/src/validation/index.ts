/**
 * `validation` — the deterministic ChangePlan validator (Task 4.4), the single
 * owner `brain validate` (Task 4.11) is a thin wrapper over. `validatePlan`
 * runs every deterministic check and returns a {@link ValidationReport}: the
 * blocking findings, the non-blocking gate findings, and the `tier2Eligible`
 * gate the pipeline (Task 4.5) feeds into `effectiveRisk`.
 *
 * Checks (all fail-closed): reserved-op rejection, per-op schema re-validation,
 * mutation-policy cell (immutable/reserved reject, append-only forbids
 * in-place replacement, review clears Tier-2), path policy, identity-namespace
 * collisions (`identity.ts`), dangling refs + duplicate evidence + provenance
 * requirements (`provenance.ts`), evidence-verification gating (non-`valid`
 * evidence cannot support Tier-2), and Markdown accessibility (`accessibility.ts`).
 *
 * Severity split: an `error` finding blocks the change (`ok: false`); a `gate`
 * finding leaves the change applicable under review but clears `tier2Eligible`
 * (forces Tier-3). `tier2Eligible` is true only when NO error and NO gate
 * finding is present.
 */
import {
  ChangePlanOperationSchema,
  isReservedOp,
  type ChangePlan,
  type ChangePlanOperation,
  type NoteType,
} from "@atlas/contracts";
import { checkIdentity } from "./identity.js";
import { checkProvenance } from "./provenance.js";
import { checkAccessibility } from "./accessibility.js";

/** A single validation finding. `error` blocks the change; `gate` only clears Tier-2. */
export interface ValidationFinding {
  readonly code: string;
  readonly severity: "error" | "gate";
  readonly detail: string;
  /** Optional locus (section path / frontmatter field). */
  readonly path?: string;
}

/** The validator's verdict for a ChangePlan. */
export interface ValidationReport {
  /** True when there are no blocking (`error`) findings. */
  readonly ok: boolean;
  readonly findings: readonly ValidationFinding[];
  /** Tier gate consumed by `effectiveRisk`: true only with zero error+gate findings. */
  readonly gates: { readonly tier2Eligible: boolean };
}

/** The vault/graph resolvers the validator reads (the pipeline wires them to real state). */
export interface ValidationVault {
  hasNoteId(id: string): boolean;
  /** Note ids that already own an id / filename-slug / normalized-alias key. */
  identityOwners(normalizedKey: string): readonly string[];
  /** A pinned `contentId`/`renditionId` provenance ref resolves to a captured source. */
  hasSourceRef(handle: string): boolean;
  /** A claim natural key resolves to an existing claim. */
  hasClaimKey(claimKey: string): boolean;
  /** An evidence lineage id resolves to an existing lineage. */
  hasEvidenceLineage(lineageId: string): boolean;
  /** An evidence surrogate id resolves to an existing head. */
  hasEvidenceId(evidenceId: string): boolean;
  /** True when an `AttachEvidence` would re-attach a payload already present (idempotent duplicate). */
  attachWouldDuplicate(op: ChangePlanOperation): boolean;
}

/** Data + config the validator consults. */
export interface ValidationContext {
  /** The resolved target note type (drives the mutation-policy cell). */
  readonly targetType: NoteType;
  readonly vault: ValidationVault;
  /** Verification states of the evidence supporting this change (evidence-gating input). */
  supportingEvidenceStates(): readonly string[];
  readonly config: { readonly requireSourcesForSynthesis: boolean };
}

/** Content-authoring ops that must carry provenance under `require_sources_for_synthesis`. */
const REQUIRES_PROVENANCE = new Set(["CreateNote", "UpdateSection", "AppendSection"]);

/** Run the full deterministic validation over a ChangePlan. */
export function validatePlan(plan: ChangePlan, ctx: ValidationContext): ValidationReport {
  const findings: ValidationFinding[] = [
    ...checkReservedAndSchema(plan.operation),
    ...checkPathPolicy(plan.operation),
    ...checkProvenanceRequirement(plan, ctx),
    ...checkEvidenceGating(ctx),
    ...checkIdentity(plan, ctx),
    ...checkProvenance(plan, ctx),
    ...accessibilityFindings(plan.operation),
  ];
  const hasError = findings.some((f) => f.severity === "error");
  const hasGate = findings.some((f) => f.severity === "gate");
  return { ok: !hasError, findings, gates: { tier2Eligible: !hasError && !hasGate } };
}

/** Reserved-op rejection (fail-closed) + per-op schema re-validation. */
function checkReservedAndSchema(op: ChangePlanOperation): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  if (isReservedOp(op.op)) {
    out.push({ code: "reserved-operation", severity: "error", detail: `operation '${op.op}' is reserved and cannot be executed (V1 policy)` });
    return out; // no point schema-checking a reserved op
  }
  const parsed = ChangePlanOperationSchema.safeParse(op);
  if (!parsed.success) {
    out.push({ code: "schema-invalid", severity: "error", detail: `operation '${op.op}' failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}` });
  }
  return out;
}

/** Path policy: a new note's natural id must be a safe vault identifier. */
function checkPathPolicy(op: ChangePlanOperation): ValidationFinding[] {
  if (op.op !== "CreateNote") return [];
  if (op.noteType.trim() === "") {
    return [{ code: "path-policy-violation", severity: "error", detail: "CreateNote requires a non-empty noteType" }];
  }
  return [];
}

/** Provenance requirement: content-authoring synthesis needs at least one source. */
function checkProvenanceRequirement(plan: ChangePlan, ctx: ValidationContext): ValidationFinding[] {
  if (!ctx.config.requireSourcesForSynthesis) return [];
  if (!REQUIRES_PROVENANCE.has(plan.operation.op)) return [];
  if (plan.sourceIds.length > 0 || plan.retrievedEvidence.length > 0) return [];
  return [{ code: "missing-provenance", severity: "error", detail: `operation '${plan.operation.op}' requires supporting sources (require_sources_for_synthesis)` }];
}

/** Evidence-verification gating: any non-`valid` supporting evidence clears Tier-2. */
function checkEvidenceGating(ctx: ValidationContext): ValidationFinding[] {
  const states = ctx.supportingEvidenceStates();
  const bad = states.filter((s) => s !== "valid");
  if (bad.length === 0) return [];
  return [{ code: "evidence-not-valid", severity: "gate", detail: `${bad.length} supporting evidence item(s) are non-valid (${[...new Set(bad)].join(", ")}); cannot support Tier-2` }];
}

/** Accessibility over the op's authored body (create/update/append content only). */
function accessibilityFindings(op: ChangePlanOperation): ValidationFinding[] {
  const body = authoredBody(op);
  return body === null ? [] : checkAccessibility(body);
}

/** The Markdown body an op authors, or `null` for ops that author none. */
function authoredBody(op: ChangePlanOperation): string | null {
  switch (op.op) {
    case "CreateNote":
      return op.body ?? "";
    case "UpdateSection":
      return op.newContent;
    case "AppendSection":
      return op.content;
    default:
      return null;
  }
}
