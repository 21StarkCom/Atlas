/**
 * `migrate-schema-conformance` (Task 4, #151) — proves the TS migration output and the
 * `graduation-migrate.schema.json` contract AGREE (fixes the "manually duplicated SSOT" finding):
 * an ACTUAL plan over a strict note, an unknown (open-registry) type, and a flattened wikilink is
 * wrapped into the exact preview + applied `--json` payload the command emits, and validated against
 * the schema with the SAME AJV 2020 validator the tools cli-contract lint uses. If the planner grows
 * a managed field the schema doesn't define (unevaluatedProperties:false), this fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { planBootstrapMigration, type MigrationInputFile } from "../src/graduation/migrate-plan.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  errorsText: (e?: unknown) => string;
};
function validator(): (v: unknown) => void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", "graduation-migrate.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  return (value: unknown): void => {
    if (!validate(value)) throw new Error(`graduation-migrate failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value, null, 2)}`);
  };
}

const TS = "2026-07-17T00:00:00.000Z";
function note(path: string, fm: string, body = "# Body\n"): MigrationInputFile {
  return { path, raw: `---\n${fm}\n---\n${body}` };
}

describe("graduation migrate — schema conformance (TS output ↔ JSON Schema SSOT)", () => {
  // A strict note (full base-field fill), an open-registry unknown type, and a note with a
  // flattened (unresolved) wikilink — the three shapes Task 4 must serialize into the payload.
  const files = [
    note("Repos/meridian.md", "type: repo\ntitle: Meridian"),
    note("x/podcast.md", "id: podcast-ep1\ntype: podcast\ntitle: Ep 1"),
    note("x/a.md", "id: note-a\ntype: note\ntitle: A", "See [[Nonexistent|the target]].\n"),
  ];
  const plan = planBootstrapMigration(files, { bootstrapTimestamp: TS });
  const check = validator();

  it("the strict/unknown/flattened shapes actually appear in the plan", () => {
    const repo = plan.notes.find((n) => n.path === "Repos/meridian.md")!;
    expect(repo.initializedFrontmatter.status).toBe("active");
    expect(repo.initializedFrontmatter.source).toEqual(["manual"]);
    expect(repo.initializedFrontmatter.declaredSensitivity).toBe("internal");
    expect(plan.notes.find((n) => n.path === "x/podcast.md")!.type.value).toBe("podcast");
    expect(plan.notes.find((n) => n.path === "x/a.md")!.linkRewrites[0]!.resolution).toBe("flattened-unresolved");
    expect(plan.normalized.length).toBeGreaterThan(0);
  });

  it("the PREVIEW --json payload validates against graduation-migrate.schema.json", () => {
    const out = { command: "graduation migrate", mode: "preview", migrationRunId: "01J9ZBOOTSTRAP0000000000000", idMap: plan.idMap, notes: plan.notes, quarantined: plan.quarantined, refused: plan.refused, normalized: plan.normalized, ...(plan.renames.length > 0 ? { renames: plan.renames } : {}) };
    check(out);
  });

  it("the APPLIED --json payload validates against graduation-migrate.schema.json", () => {
    const out = { command: "graduation migrate", mode: "applied", migrationRunId: "01J9ZBOOTSTRAP0000000000001", idMap: plan.idMap, notes: plan.notes, quarantined: plan.quarantined, refused: plan.refused, normalized: plan.normalized, ...(plan.renames.length > 0 ? { renames: plan.renames } : {}) };
    check(out);
  });
});
