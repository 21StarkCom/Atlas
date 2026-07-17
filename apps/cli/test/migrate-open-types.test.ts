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

describe("graduation migrate — identity, slug collisions, links", () => {
  it("two notes with the SAME explicit id both migrate, disambiguated by numeric suffix", () => {
    const plan = planBootstrapMigration([
      note("a/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup A"),
      note("b/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup B"),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    expect(plan.notes.map((n) => n.newId).sort()).toEqual(["repo-dup", "repo-dup-2"]);
  });
  it("a suffix never collides with an existing explicit id (reserve-all-first)", () => {
    const plan = planBootstrapMigration([
      note("a/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup A"),
      note("b/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup B"),
      note("c/two.md", "id: repo-dup-2\ntype: repo\ntitle: Two"),
    ], { bootstrapTimestamp: TS });
    expect(plan.notes.map((n) => n.newId).sort()).toEqual(["repo-dup", "repo-dup-2", "repo-dup-3"]);
  });
  it("filename-SLUG collision (reader-fatal) triggers a deterministic file rename", () => {
    const plan = planBootstrapMigration([
      note("10_Work/Repos/meridian.md", "id: repo-meridian\ntype: repo\ntitle: Meridian Repo"),
      note("10_Work/Projects/meridian.md", "id: project-meridian\ntype: project\ntitle: Meridian Project"),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    // exactly one keeps the bare slug; the other is renamed deterministically (sorted-path loser)
    const renamed = plan.notes.map((n) => n.newPath ?? n.path).sort();
    expect(new Set(renamed).size).toBe(2);              // distinct basenames now
    const slugs = renamed.map((p) => p.slice(p.lastIndexOf("/") + 1));
    expect(new Set(slugs).size).toBe(2);                // no shared slug → reader-safe
  });
  it("an unresolved wikilink is FLATTENED to display text (no [[…]] survives)", () => {
    const plan = planBootstrapMigration([
      note("x/a.md", "id: note-a\ntype: note\ntitle: A", "See [[Nonexistent Target|the target]] here.\n"),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    expect(plan.notes[0]!.linkRewrites[0]).toMatchObject({ resolution: "flattened-unresolved", to: "the target" });
  });
  it("an ambiguous-title note still migrates (no ambiguous-alias quarantine)", () => {
    const plan = planBootstrapMigration([note("x/weird.md", "type: memory\ntitle: '***'", "# ***\n")], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    expect(plan.notes).toHaveLength(1);
  });
  it("an alias↔alias identity collision surfaces on plan.aliasDrops (the deterministic loser's alias)", () => {
    const plan = planBootstrapMigration([
      note("a/one.md", 'id: note-one\ntype: note\ntitle: One\naliases: ["Foo Bar"]'),
      note("b/two.md", 'id: note-two\ntype: note\ntitle: Two\naliases: ["foo, bar"]'),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    // both aliases normalize (Unicode fold + punctuation→space) to the same identity key "foo bar";
    // the sorted-path-first owner (a/one.md) wins, so b/two.md is the deterministic loser.
    expect(plan.aliasDrops["b/two.md"]).toEqual(["foo, bar"]);
    expect(plan.aliasDrops["a/one.md"]).toBeUndefined();
  });
});
