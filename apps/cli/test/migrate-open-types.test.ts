/**
 * `graduation/migrate-plan` open type system (Task 2, #151) — the graduation type gate becomes
 * total: any asserted `type` is accepted (open registry, resolveType-normalized) and any explicit
 * `schema_version` is coerced to SCHEMA_VERSION. Neither `unknown-type` nor `unsupported-schema-version`
 * is ever refused. Covers `planBootstrapMigration` directly (pure function, no wall-clock).
 */
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@atlas/contracts";
import { planBootstrapMigration, type MigrationInputFile } from "../src/graduation/migrate-plan.js";

const TS = "2026-07-17T00:00:00.000Z";
export function note(path: string, fm: string, body = "# Body\n"): MigrationInputFile {
  return { path, raw: `---\n${fm}\n---\n${body}` };
}

describe("graduation migrate — open type system (types)", () => {
  it("a vault 'repo' note migrates (no unknown-type refusal)", () => {
    const plan = planBootstrapMigration([note("10_Work/Repos/meridian.md", "id: repo-meridian\ntype: repo\ntitle: Meridian")], { bootstrapTimestamp: TS });
    expect(plan.refused).toEqual([]);
    expect(plan.notes.map((n) => n.newId)).toContain("repo-meridian");
    expect(plan.notes[0]!.type.value).toBe("repo");
  });
  it("a completely unknown type is kept as-is and migrates (open registry)", () => {
    const plan = planBootstrapMigration([note("x/podcast.md", "id: podcast-ep1\ntype: podcast\ntitle: Ep 1")], { bootstrapTimestamp: TS });
    expect(plan.refused).toEqual([]);
    expect(plan.notes[0]!.type.value).toBe("podcast");
  });
  it("a whitespace-padded type is normalized through resolveType (no raw whitespace emitted)", () => {
    const plan = planBootstrapMigration([note("x/w.md", "id: note-w\ntype: '  repo  '\ntitle: W")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.type.value).toBe("repo");
  });
  it("a whitespace-only type falls back to 'note'", () => {
    const plan = planBootstrapMigration([note("x/blank.md", "type: '   '\ntitle: Blank")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.type.value).toBe("note");
  });
  it("an unsupported schema_version is coerced to SCHEMA_VERSION, never refused", () => {
    const plan = planBootstrapMigration([note("a.md", "id: note-a\ntype: note\ntitle: A\nschema_version: 99")], { bootstrapTimestamp: TS });
    expect(plan.refused).toEqual([]);
    expect(plan.notes[0]!.initializedFrontmatter.schema_version).toBe(SCHEMA_VERSION);
  });
});
