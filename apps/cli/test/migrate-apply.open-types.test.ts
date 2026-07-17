/**
 * `migrate-apply` open type system (Task 3, #151) — the SHAPE-defect totality proven ON DISK:
 * a reader-fatal filename-slug collision is resolved by a deterministic file RENAME (the renamed
 * file exists at `newPath`, the old path is gone), unresolved/ambiguous wikilinks are FLATTENED
 * (their `[[…]]` no longer appears in the emitted body), and the migrated copy passes the strict
 * reader with NO `broken-link`/`ambiguous-link`/`identity-collision`. Rename is byte-exact
 * reversible (rollback restores the original path) and resume-safe (re-plan from the reconstructed
 * originals reproduces the same plan and skips every applied note).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { AtlasConfig } from "@atlas/contracts";
import { planBootstrapMigration, type MigrationInputFile } from "../src/graduation/migrate-plan.js";
import { applyBootstrapMigration, rollbackBootstrapMigration, readOriginalInputs } from "../src/graduation/migrate-apply.js";
import { readVault } from "../src/vault/reader.js";

const TS = "2026-07-17T00:00:00Z";
const OPTS = { migrationRunId: "01J9ZAPPLYOPEN000000000000", bootstrapTimestamp: TS };

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "atlas-apply-open-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(files: { path: string; raw: string }[]): string {
  const copy = join(root, "copy");
  for (const f of files) {
    const full = join(copy, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.raw, "utf8");
  }
  return copy;
}
function readTree(copy: string): MigrationInputFile[] {
  return readOriginalInputs(copy); // no checkpoint yet ⇒ walks the raw tree
}
const cfgFor = (dir: string): AtlasConfig => ({ vault: { path: dir } } as unknown as AtlasConfig);

describe("bootstrap-migration apply — slug-collision rename + link flattening (Task 3)", () => {
  it("a filename-slug collision is renamed on disk: newPath exists, old path is gone, reader is clean", async () => {
    const copy = seed([
      { path: "10_Work/Repos/meridian.md", raw: "---\nid: repo-meridian\ntype: repo\ntitle: Meridian Repo\n---\n# Meridian Repo\n" },
      { path: "10_Work/Projects/meridian.md", raw: "---\nid: project-meridian\ntype: project\ntitle: Meridian Project\n---\n# Meridian Project\n" },
    ]);
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    expect(plan.renames.length).toBe(1);
    const renamed = plan.notes.find((n) => n.newPath);
    expect(renamed, "one note is renamed").toBeTruthy();

    applyBootstrapMigration(copy, plan, OPTS);

    // the renamed file exists at newPath; the old path is gone
    expect(existsSync(join(copy, renamed!.newPath!))).toBe(true);
    expect(existsSync(join(copy, renamed!.path))).toBe(false);
    // no two files share a filename slug anymore → reader-safe
    const finalPaths = plan.notes.map((n) => n.newPath ?? n.path);
    const slugs = finalPaths.map((p) => p.slice(p.lastIndexOf("/") + 1));
    expect(new Set(slugs).size).toBe(slugs.length);

    const snap = await readVault(cfgFor(copy));
    expect(snap.errors.filter((e) => e.kind === "identity-collision")).toEqual([]);
    expect(snap.errors.filter((e) => e.kind === "broken-link" || e.kind === "ambiguous-link")).toEqual([]);
  });

  it("unresolved + ambiguous wikilinks are flattened on disk: no flattened [[…]] survives, reader is clean", async () => {
    const copy = seed([
      // two notes share the slug/title 'dup' ⇒ [[dup]] is ambiguous; [[Nope]] resolves to nothing.
      { path: "a/one.md", raw: "---\nid: note-one\ntype: note\ntitle: One\n---\nSee [[Nope|the missing]] and [[dup]] here.\n" },
      { path: "b/dup.md", raw: "---\nid: note-dupb\ntype: note\ntitle: dup\n---\n# dup B\n" },
      { path: "c/dup.md", raw: "---\nid: note-dupc\ntype: note\ntitle: dup\n---\n# dup C\n" },
    ]);
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    const one = plan.notes.find((n) => n.path === "a/one.md")!;
    expect(one.linkRewrites.map((r) => r.resolution).sort()).toEqual(["flattened-ambiguous", "flattened-unresolved"]);

    applyBootstrapMigration(copy, plan, OPTS);

    // every FLATTENED link's original [[…]] is gone from the emitted body
    const body = readFileSync(join(copy, "a/one.md"), "utf8");
    for (const r of one.linkRewrites) {
      if (r.resolution.startsWith("flattened")) expect(body.includes(r.from), `${r.from} flattened away`).toBe(false);
    }
    expect(body).toContain("the missing"); // display text kept as prose
    expect(body).toContain("dup");

    const snap = await readVault(cfgFor(copy));
    expect(snap.errors.filter((e) => e.kind === "broken-link" || e.kind === "ambiguous-link")).toEqual([]);
  });

  it("a resolvable wikilink STAYS a canonical [[id|display]] wikilink (only flattened links lose their link)", async () => {
    const copy = seed([
      { path: "a/note.md", raw: "---\nid: note-a\ntype: note\ntitle: A\n---\nLink to [[Target Note|here]].\n" },
      { path: "b/target.md", raw: "---\nid: note-target\ntype: note\ntitle: Target Note\n---\n# Target\n" },
    ]);
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    applyBootstrapMigration(copy, plan, OPTS);
    const body = readFileSync(join(copy, "a/note.md"), "utf8");
    expect(body).toContain("[[note-target|here]]");
    const snap = await readVault(cfgFor(copy));
    expect(snap.errors.filter((e) => e.kind === "broken-link" || e.kind === "ambiguous-link")).toEqual([]);
  });

  it("a slug-collision rename is byte-exact reversible: rollback restores the original path, removes the renamed file", () => {
    const inputs = [
      { path: "10_Work/Repos/meridian.md", raw: "---\nid: repo-meridian\ntype: repo\ntitle: Meridian Repo\n---\n# Meridian Repo\n" },
      { path: "10_Work/Projects/meridian.md", raw: "---\nid: project-meridian\ntype: project\ntitle: Meridian Project\n---\n# Meridian Project\n" },
    ];
    const copy = seed(inputs);
    const originalBytes = new Map(inputs.map((f) => [f.path, f.raw]));
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    const renamed = plan.notes.find((n) => n.newPath)!;
    applyBootstrapMigration(copy, plan, OPTS);
    expect(existsSync(join(copy, renamed.newPath!))).toBe(true);

    const rb = rollbackBootstrapMigration(copy);
    expect(rb.rollbackConflicts).toBeNull();
    // the renamed file is gone; the original path is restored byte-for-byte
    expect(existsSync(join(copy, renamed.newPath!))).toBe(false);
    expect(existsSync(join(copy, renamed.path))).toBe(true);
    expect(readFileSync(join(copy, renamed.path), "utf8")).toBe(originalBytes.get(renamed.path));
  });

  it("resume after a rename re-plans from reconstructed originals and skips every applied note", () => {
    const copy = seed([
      { path: "10_Work/Repos/meridian.md", raw: "---\nid: repo-meridian\ntype: repo\ntitle: Meridian Repo\n---\n# Meridian Repo\n" },
      { path: "10_Work/Projects/meridian.md", raw: "---\nid: project-meridian\ntype: project\ntitle: Meridian Project\n---\n# Meridian Project\n" },
    ]);
    applyBootstrapMigration(copy, planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS }), OPTS);
    // second run re-plans from the RECONSTRUCTED originals (pre-images at their ORIGINAL paths)
    const reconstructed = readOriginalInputs(copy);
    expect(reconstructed.map((f) => f.path).sort()).toEqual(["10_Work/Projects/meridian.md", "10_Work/Repos/meridian.md"]);
    const res2 = applyBootstrapMigration(copy, planBootstrapMigration(reconstructed, { bootstrapTimestamp: TS }), OPTS);
    expect(res2.applied).toEqual([]);
    expect(res2.skipped.sort()).toEqual(["10_Work/Projects/meridian.md", "10_Work/Repos/meridian.md"]);
  });
});
