import { describe, it, expect } from "vitest";
import type { ChangePlan, ChangePlanOperation } from "@atlas/contracts";
import { validatePlan, type ValidationContext, type ValidationVault } from "../src/validation/index.js";

const H = "a".repeat(64);
const REND = `sha256:${H}:text/markdown:1:1`;

/** An all-resolving vault; override individual resolvers per test. */
function vault(over: Partial<ValidationVault> = {}): ValidationVault {
  return {
    hasNoteId: () => true,
    identityOwners: () => [],
    hasSourceRef: () => true,
    hasClaimKey: () => true,
    hasEvidenceLineage: () => true,
    hasEvidenceId: () => true,
    attachWouldDuplicate: () => false,
    ...over,
  };
}

function ctx(over: Partial<ValidationContext> = {}, vaultOver: Partial<ValidationVault> = {}): ValidationContext {
  return {
    targetType: "concept",
    vault: vault(vaultOver),
    supportingEvidenceStates: () => [],
    config: { requireSourcesForSynthesis: true },
    ...over,
  };
}

function plan(operation: ChangePlanOperation, over: Partial<ChangePlan> = {}): ChangePlan {
  return {
    target: "note-x",
    rationale: "test",
    sourceIds: ["src-1"],
    retrievedEvidence: [],
    confidence: 0.9,
    proposedRisk: "tier-2",
    reversibility: "reversible",
    schemaVersion: 1,
    operation,
    ...over,
  } as ChangePlan;
}

const updateSection = (over: Record<string, unknown> = {}): ChangePlanOperation =>
  ({ op: "UpdateSection", opVersion: 1, selector: { path: "Overview", expectedContentHash: `sha256:${H}` }, newContent: "# Body\n\ngood text\n", ...over }) as ChangePlanOperation;

const codes = (r: ReturnType<typeof validatePlan>): string[] => r.findings.map((f) => f.code);

describe("validation: reserved operations (fail-closed)", () => {
  it("rejects a CreateTask plan with reserved-operation", () => {
    const r = validatePlan(plan({ op: "CreateTask", opVersion: 1 } as ChangePlanOperation), ctx());
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("reserved-operation");
  });

  it("permits a non-reserved op", () => {
    expect(validatePlan(plan(updateSection()), ctx()).ok).toBe(true);
  });
});

describe("validation: per-op schema re-validation", () => {
  it("flags a schema-invalid op (empty selector path)", () => {
    const r = validatePlan(plan(updateSection({ selector: { path: "", expectedContentHash: `sha256:${H}` } })), ctx());
    expect(codes(r)).toContain("schema-invalid");
    expect(r.ok).toBe(false);
  });

  it("passes a schema-valid op", () => {
    expect(codes(validatePlan(plan(updateSection()), ctx()))).not.toContain("schema-invalid");
  });
});

describe("validation: path policy", () => {
  const createNote = (noteType: string): ChangePlanOperation =>
    ({ op: "CreateNote", opVersion: 1, noteType, title: "T", expectedAbsent: true, body: "# T\n\nhi\n" }) as ChangePlanOperation;

  it("rejects a whitespace-only noteType", () => {
    const r = validatePlan(plan(createNote("  "), { target: "brand-new" }), ctx({ targetType: "concept" }, { hasNoteId: () => false }));
    expect(codes(r)).toContain("path-policy-violation");
  });

  it("passes a valid noteType", () => {
    const r = validatePlan(plan(createNote("concept"), { target: "brand-new" }), ctx({ targetType: "concept" }, { hasNoteId: () => false }));
    expect(codes(r)).not.toContain("path-policy-violation");
  });
});

describe("validation: identity-namespace collisions", () => {
  const createNote = (): ChangePlanOperation =>
    ({ op: "CreateNote", opVersion: 1, noteType: "concept", title: "T", expectedAbsent: true, body: "# T\n\nhi\n" }) as ChangePlanOperation;

  it("rejects a new note id that collides with an existing identity", () => {
    const r = validatePlan(plan(createNote(), { target: "dup" }), ctx({}, { hasNoteId: () => false, identityOwners: () => ["existing-note"] }));
    expect(codes(r)).toContain("identity-collision");
  });

  it("passes a fresh note id", () => {
    const r = validatePlan(plan(createNote(), { target: "fresh" }), ctx({}, { hasNoteId: () => false }));
    expect(codes(r)).not.toContain("identity-collision");
  });

  it("rejects an alias colliding with another note", () => {
    const addAlias = { op: "AddAlias", opVersion: 1, alias: "Taken" } as ChangePlanOperation;
    const r = validatePlan(plan(addAlias), ctx({}, { identityOwners: () => ["other-note"] }));
    expect(codes(r)).toContain("identity-collision");
  });

  it("rejects an alias whose advisory normalizedKey disagrees with the canonical fold", () => {
    const addAlias = { op: "AddAlias", opVersion: 1, alias: "Foo", normalizedKey: "wrong" } as ChangePlanOperation;
    const r = validatePlan(plan(addAlias), ctx());
    expect(codes(r)).toContain("normalized-key-mismatch");
  });
});

describe("validation: dangling references", () => {
  it("flags a target note that does not exist", () => {
    const r = validatePlan(plan(updateSection()), ctx({}, { hasNoteId: () => false }));
    expect(codes(r)).toContain("dangling-note");
  });

  it("flags an unresolved claim provenance ref", () => {
    const claim = { op: "CreateClaim", opVersion: 1, claimKey: "c/1", claimText: "x", provenance: [REND] } as ChangePlanOperation;
    const r = validatePlan(plan(claim), ctx({}, { hasSourceRef: () => false }));
    expect(codes(r)).toContain("dangling-source");
  });

  it("flags evidence attached to an unknown claim", () => {
    const attach = { op: "AttachEvidence", opVersion: 1, claimKey: "c/unknown", renditionId: REND, locator: "char:0-1", quoteHash: `sha256:${H}` } as ChangePlanOperation;
    const r = validatePlan(plan(attach), ctx({}, { hasClaimKey: () => false }));
    expect(codes(r)).toContain("dangling-claim");
  });

  it("flags a verification update naming an unknown lineage", () => {
    const upd = { op: "UpdateEvidenceVerification", opVersion: 1, claimKey: "c/1", lineageId: `sha256:${H}`, supersedesEvidenceId: `sha256:${H}`, expectedSupersededRenditionId: REND, toVerification: "valid", replacementRenditionId: `sha256:${H}:text/markdown:1:2`, locator: "char:0-1", quoteHash: `sha256:${H}` } as ChangePlanOperation;
    const r = validatePlan(plan(upd), ctx({}, { hasEvidenceLineage: () => false }));
    expect(codes(r)).toContain("dangling-evidence");
  });

  it("passes when every reference resolves", () => {
    const claim = { op: "CreateClaim", opVersion: 1, claimKey: "c/1", claimText: "x", provenance: [REND] } as ChangePlanOperation;
    expect(codes(validatePlan(plan(claim), ctx()))).not.toContain("dangling-source");
  });
});

describe("validation: duplicate evidence (gate)", () => {
  const attach = { op: "AttachEvidence", opVersion: 1, claimKey: "c/1", renditionId: REND, locator: "char:0-1", quoteHash: `sha256:${H}` } as ChangePlanOperation;

  it("flags an idempotent-duplicate attach as a Tier-2 gate", () => {
    const r = validatePlan(plan(attach), ctx({}, { attachWouldDuplicate: () => true }));
    expect(codes(r)).toContain("duplicate-evidence");
    expect(r.ok).toBe(true);
    expect(r.gates.tier2Eligible).toBe(false);
  });

  it("passes a fresh attach", () => {
    expect(codes(validatePlan(plan(attach), ctx()))).not.toContain("duplicate-evidence");
  });
});

describe("validation: provenance requirement", () => {
  it("requires sources for content synthesis when configured", () => {
    const r = validatePlan(plan(updateSection(), { sourceIds: [], retrievedEvidence: [] }), ctx());
    expect(codes(r)).toContain("missing-provenance");
  });

  it("passes when sources are present", () => {
    expect(codes(validatePlan(plan(updateSection(), { sourceIds: ["s"] }), ctx()))).not.toContain("missing-provenance");
  });

  it("does not require sources when the config disables it", () => {
    const r = validatePlan(plan(updateSection(), { sourceIds: [] }), ctx({ config: { requireSourcesForSynthesis: false } }));
    expect(codes(r)).not.toContain("missing-provenance");
  });
});

describe("validation: evidence-verification gating (gate)", () => {
  it("clears Tier-2 when supporting evidence is non-valid", () => {
    const r = validatePlan(plan(updateSection()), ctx({ supportingEvidenceStates: () => ["valid", "stale"] }));
    expect(codes(r)).toContain("evidence-not-valid");
    expect(r.ok).toBe(true);
    expect(r.gates.tier2Eligible).toBe(false);
  });

  it("keeps Tier-2 eligible when all evidence is valid", () => {
    const r = validatePlan(plan(updateSection()), ctx({ supportingEvidenceStates: () => ["valid", "valid"] }));
    expect(r.gates.tier2Eligible).toBe(true);
  });
});

describe("validation: markdown accessibility", () => {
  const body = (b: string): ChangePlanOperation =>
    ({ op: "CreateNote", opVersion: 1, noteType: "concept", title: "T", expectedAbsent: true, body: b }) as ChangePlanOperation;
  const run = (b: string) => validatePlan(plan(body(b), { target: "new" }), ctx({}, { hasNoteId: () => false }));

  it("flags multiple top-level headings", () => {
    expect(codes(run("# A\n\ntext\n\n# B\n\ntext\n"))).toContain("accessibility:multiple-top-level-headings");
  });

  it("flags a skipped heading level", () => {
    expect(codes(run("# A\n\n### C\n\ntext\n"))).toContain("accessibility:skipped-heading-level");
  });

  it("flags an image without alt text", () => {
    expect(codes(run("# A\n\n![](img.png)\n"))).toContain("accessibility:missing-alt-text");
  });

  it("flags a non-descriptive link label", () => {
    expect(codes(run("# A\n\n[click here](http://x)\n"))).toContain("accessibility:non-descriptive-link");
  });

  it("passes an accessible body", () => {
    const r = run("# A\n\nA paragraph with a [descriptive label](http://x) and an ![a cat](cat.png).\n\n## Detail\n\n- one\n- two\n");
    expect(r.findings.filter((f) => f.code.startsWith("accessibility:"))).toEqual([]);
  });
});

describe("validation: a fully-clean auto plan", () => {
  it("is ok and Tier-2 eligible with zero findings", () => {
    const r = validatePlan(plan(updateSection()), ctx());
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.gates.tier2Eligible).toBe(true);
  });
});
