/**
 * `bootstrap-migration.fixtures` (Task 5.3) — runs the deterministic bootstrap-migration CORE over
 * the executable fixtures at `docs/specs/fixtures/bootstrap-migration/` and asserts the plan equals
 * each case's `expected.json` migrate block (idMap, per-note type/id/link/field outcomes, quarantine,
 * refusal, releases). Covers the pure-transformation cases; the checkpoint/rollback cases exercise
 * the command's per-note machinery (not this pure planner).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { planBootstrapMigration, slugify, type MigrationInputFile, type ReleaseInput } from "../src/graduation/migrate-plan.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "docs/specs/fixtures/bootstrap-migration");

function readInputTree(dir: string): MigrationInputFile[] {
  const out: MigrationInputFile[] = [];
  const walk = (cur: string): void => {
    for (const e of readdirSync(cur).sort()) {
      const full = join(cur, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".md")) out.push({ path: relative(dir, full), raw: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

/** The operator-authorized releases each fixture's expected output pins (from migrate.releases). */
function releasesFor(expected: { migrate?: { releases?: { path: string; opaqueId: string; authorization: string }[] } }): Record<string, ReleaseInput> {
  const map: Record<string, ReleaseInput> = {};
  for (const r of expected.migrate?.releases ?? []) map[r.path] = { opaqueId: r.opaqueId, authorization: r.authorization };
  return map;
}

// The pure-transformation cases (the checkpoint/rollback cases test the command, not the planner).
// `full-taxonomy` (#151) is the open-type-system census: every registered type + unknown type +
// no-frontmatter + strict-fill + dup-explicit-id + same-slug rename + link flatten/rewrite + alias drop.
const CASES = ["basic", "collision", "explicit-collision", "full-taxonomy", "guards"] as const;
const ranCases: string[] = [];

describe("bootstrap-migration deterministic core ⇄ fixtures (Task 5.3)", () => {
  for (const name of CASES) {
    it(`${name}: plan equals expected.json`, () => {
      const expected = JSON.parse(readFileSync(join(FIXTURES, name, "expected.json"), "utf8"));
      const files = readInputTree(join(FIXTURES, name, "input"));
      const plan = planBootstrapMigration(files, {
        bootstrapTimestamp: expected.bootstrapTimestamp,
        released: releasesFor(expected),
      });
      const m = expected.migrate;

      expect(plan.idMap).toEqual(m.idMap);
      expect(plan.notes).toEqual(m.notes);
      expect(plan.quarantined).toEqual(m.quarantined ?? []);
      expect(plan.refused).toEqual(m.refused ?? []);
      expect(plan.releases).toEqual(m.releases ?? []);
      expect(plan.renames).toEqual(m.renames ?? []);
      expect(plan.normalized).toEqual(m.normalized ?? []);
      ranCases.push(name);
    });
  }

  it("the full-taxonomy open-type census case actually ran", () => {
    expect(ranCases).toContain("full-taxonomy");
  });
});

describe("slugify (§2.1)", () => {
  it("NFKD-strips diacritics, lowercases, collapses non-alnum, trims", () => {
    expect(slugify("Kóral Bonfil")).toEqual({ slug: "koral-bonfil", ambiguous: false });
    expect(slugify("  Atlas — V1!! ")).toEqual({ slug: "atlas-v1", ambiguous: false });
    expect(slugify("café")).toEqual({ slug: "cafe", ambiguous: false });
  });
  it("a title with no alphanumerics ⇒ slug `note` + ambiguous (§2.1 step 5)", () => {
    expect(slugify("！！！")).toEqual({ slug: "note", ambiguous: true });
    expect(slugify("   ")).toEqual({ slug: "note", ambiguous: true });
  });
});
