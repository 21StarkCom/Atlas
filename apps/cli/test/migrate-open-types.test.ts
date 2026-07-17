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

describe("graduation migrate — strict field-fill + normalized report", () => {
  it("a strict 'repo' note missing base fields gets schema-valid defaults; report lists them", () => {
    const plan = planBootstrapMigration([note("Repos/x.md", "id: repo-x\ntype: repo\ntitle: X")], { bootstrapTimestamp: TS });
    const fm = plan.notes[0]!.initializedFrontmatter;
    expect(fm.status).toBe("active");
    expect(fm.confidence).toBe("medium");
    expect(fm.classification).toBe("internal");
    expect(fm.aliases).toEqual([]);
    expect(fm.source).toEqual(["manual"]);            // structured list, NOT the path
    const rep = plan.normalized.find((n) => n.path === "Repos/x.md");
    expect(rep?.filled).toEqual(expect.arrayContaining(["status", "confidence", "classification", "source"]));
  });
  it("valid vault statuses (needs-review/stale/deprecated) are PRESERVED, not reset to active", () => {
    for (const st of ["needs-review", "stale", "deprecated"]) {
      const plan = planBootstrapMigration([note("Repos/s.md", `id: repo-s\ntype: repo\ntitle: S\nstatus: ${st}`)], { bootstrapTimestamp: TS });
      expect(plan.notes[0]!.initializedFrontmatter.status).toBe(st);
      expect(plan.normalized.find((n) => n.path === "Repos/s.md")?.coerced ?? []).not.toContain("status");
    }
  });
  it("a valid structured source list is preserved verbatim", () => {
    const plan = planBootstrapMigration([note("Repos/src.md", "id: repo-src\ntype: repo\ntitle: S\nsource:\n  - type: git\n    date: 2026-01-01")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.initializedFrontmatter.source).toEqual([{ type: "git", date: "2026-01-01" }]);
  });
  it("declaredSensitivity: public→public, personal/internal→internal (vault forbids confidential)", () => {
    const pub = planBootstrapMigration([note("a.md", "id: note-a\ntype: note\ntitle: A\nclassification: public")], { bootstrapTimestamp: TS });
    expect(pub.notes[0]!.initializedFrontmatter.declaredSensitivity).toBe("public");
    const per = planBootstrapMigration([note("b.md", "id: note-b\ntype: note\ntitle: B\nclassification: personal")], { bootstrapTimestamp: TS });
    expect(per.notes[0]!.initializedFrontmatter.declaredSensitivity).toBe("internal");
  });
  it("a loose 'research' note is NOT force-filled with strict base fields", () => {
    const plan = planBootstrapMigration([note("R/x.md", "id: research-x\ntype: research\ntitle: X")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.initializedFrontmatter.confidence).toBeUndefined();
  });
  it("normalized[] records EVERY change: missing/malformed schema_version, inferred type, replaced timestamp", () => {
    const p1 = planBootstrapMigration([note("x/n.md", "title: N")], { bootstrapTimestamp: TS });            // no type, no schema_version
    const r1 = p1.normalized.find((n) => n.path === "x/n.md")!;
    expect(r1.filled).toEqual(expect.arrayContaining(["schema_version"]));
    const p2 = planBootstrapMigration([note("x/b.md", 'type: note\ntitle: B\nschema_version: "99"')], { bootstrapTimestamp: TS });
    expect(p2.normalized.find((n) => n.path === "x/b.md")!.coerced).toEqual(expect.arrayContaining(["schema_version"]));
  });
  it("present-but-malformed strict fields are COERCED, not copied through", () => {
    const plan = planBootstrapMigration([note("Repos/m.md", "id: repo-m\ntype: repo\ntitle: M\naliases:\nstatus: bogus\nconfidence: '   '")], { bootstrapTimestamp: TS });
    const fm = plan.notes[0]!.initializedFrontmatter;
    expect(fm.aliases).toEqual([]);
    expect(fm.status).toBe("active");
    expect(fm.confidence).toBe("medium");
    expect(plan.normalized.find((n) => n.path === "Repos/m.md")!.coerced).toEqual(expect.arrayContaining(["aliases", "status", "confidence"]));
  });
});
