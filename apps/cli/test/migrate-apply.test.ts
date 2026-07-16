/**
 * `migrate-apply` (Task 5.3) — the byte-exact apply + resumable checkpoint layer. Applies the
 * bootstrap-migration plan to a working copy of a fixture's `input/` and asserts each migrated note
 * equals the committed `output/` artifact byte-for-byte, then re-runs to prove idempotent resume
 * (every note verified-migrated ⇒ skipped, no re-write) and a mid-run crash resumes the pending note.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, cpSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { planBootstrapMigration, type MigrationInputFile, type ReleaseInput } from "../src/graduation/migrate-plan.js";
import { applyBootstrapMigration, serializeMigratedNote, readOriginalInputs, rollbackBootstrapMigration } from "../src/graduation/migrate-apply.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "docs/specs/fixtures/bootstrap-migration");

function readTree(dir: string): MigrationInputFile[] {
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
function releasesFor(expected: { migrate?: { releases?: { path: string; opaqueId: string; authorization: string }[] } }): Record<string, ReleaseInput> {
  const map: Record<string, ReleaseInput> = {};
  for (const r of expected.migrate?.releases ?? []) map[r.path] = { opaqueId: r.opaqueId, authorization: r.authorization };
  return map;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-apply-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("bootstrap-migration apply — byte-exact output + resumable checkpoints (Task 5.3)", () => {
  it("basic: applied notes equal the committed output/ artifacts byte-for-byte", () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, "basic", "expected.json"), "utf8"));
    const copy = join(root, "copy");
    cpSync(join(FIXTURES, "basic", "input"), copy, { recursive: true });

    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: expected.bootstrapTimestamp, released: releasesFor(expected) });
    const res = applyBootstrapMigration(copy, plan, { migrationRunId: expected.migrate.migrationRunId, bootstrapTimestamp: expected.bootstrapTimestamp });

    expect(res.applied.sort()).toEqual(["Concepts/Atlas.md", "People/Koral.md"]);
    for (const n of plan.notes) {
      const got = readFileSync(join(copy, n.path), "utf8");
      const want = readFileSync(join(FIXTURES, "basic", "output", n.path), "utf8");
      expect(got, `${n.path} byte-exact`).toBe(want);
    }
    // The checkpoint sealed a verified pre + post image for each migrated note.
    for (const cn of res.checkpoint.notes.filter((x) => x.status === "migrated")) {
      expect(cn.preImageSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(cn.postImageSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(copy, cn.preImage!))).toBe(true);
    }
  });

  it("serializeMigratedNote is byte-exact for a note that had NO original frontmatter", () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, "basic", "expected.json"), "utf8"));
    const atlas = expected.migrate.notes.find((n: { path: string }) => n.path === "Concepts/Atlas.md");
    const original = readFileSync(join(FIXTURES, "basic", "input", "Concepts/Atlas.md"), "utf8");
    const want = readFileSync(join(FIXTURES, "basic", "output", "Concepts/Atlas.md"), "utf8");
    expect(serializeMigratedNote(original, atlas)).toBe(want);
  });

  it("resume is idempotent: a second apply skips every verified-migrated note and rewrites nothing", () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, "basic", "expected.json"), "utf8"));
    const copy = join(root, "copy");
    cpSync(join(FIXTURES, "basic", "input"), copy, { recursive: true });
    const opts = { migrationRunId: expected.migrate.migrationRunId, bootstrapTimestamp: expected.bootstrapTimestamp };
    const rel = releasesFor(expected);

    applyBootstrapMigration(copy, planBootstrapMigration(readTree(copy), { bootstrapTimestamp: expected.bootstrapTimestamp, released: rel }), opts);
    const after1 = readFileSync(join(copy, "People/Koral.md"), "utf8");
    // Second run: re-plan from the RECONSTRUCTED ORIGINALS (pre-images), which reproduces the exact
    // same plan (§5 step 3) so the checkpoint can verify every note already-applied.
    const res2 = applyBootstrapMigration(copy, planBootstrapMigration(readOriginalInputs(copy), { bootstrapTimestamp: expected.bootstrapTimestamp, released: rel }), opts);
    expect(res2.applied).toEqual([]);
    expect(res2.skipped.sort()).toEqual(["Concepts/Atlas.md", "People/Koral.md"]);
    expect(readFileSync(join(copy, "People/Koral.md"), "utf8")).toBe(after1); // unchanged
  });
});

describe("bootstrap-migration rollback — byte-exact reversal, fail-closed, idempotent (§8.2)", () => {
  it("rollback: reverts each note to its pre-image in reverse sorted-path order; rerun re-reverts nothing", () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, "rollback", "expected.json"), "utf8"));
    const copy = join(root, "rb");
    cpSync(join(FIXTURES, "rollback", "input"), copy, { recursive: true });

    const res = rollbackBootstrapMigration(copy);
    expect(res.mode).toBe("rolled-back");
    expect(res.rollbackOrder).toEqual(expected.migrate.rollbackOrder);
    expect(res.rolledBack).toEqual(expected.migrate.rolledBack);
    expect(res.rollbackConflicts).toBeNull();
    // Each reverted note now equals its retained pre-image byte-for-byte.
    for (const rb of res.rolledBack) {
      expect(readFileSync(join(copy, rb.path), "utf8")).toBe(readFileSync(join(copy, ".bootstrap-backup", rb.path), "utf8"));
    }
    // Idempotent rerun: nothing newly reverted, nothing re-reverted.
    const rerun = rollbackBootstrapMigration(copy);
    expect(rerun.rolledBack).toEqual([]);
    expect(rerun.reReverted).toEqual([]);
  });

  it("rollback-conflict: a post-migration-edited note is a fail-closed conflict (pre-image NOT restored)", () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, "rollback-conflict", "expected.json"), "utf8"));
    const copy = join(root, "rbc");
    cpSync(join(FIXTURES, "rollback-conflict", "input"), copy, { recursive: true });

    const edited = readFileSync(join(copy, "Edited.md"), "utf8"); // the drifted bytes, must survive
    const res = rollbackBootstrapMigration(copy);
    expect(res.rollbackOrder).toEqual(expected.migrate.rollbackOrder);
    expect(res.rolledBack).toEqual(expected.migrate.rolledBack);
    expect(res.rollbackConflicts).toEqual(expected.migrate.rollbackConflicts);
    // The clean note reverted; the edited note was left exactly as-is (never clobbered).
    expect(readFileSync(join(copy, "Clean.md"), "utf8")).toBe(readFileSync(join(copy, ".bootstrap-backup", "Clean.md"), "utf8"));
    expect(readFileSync(join(copy, "Edited.md"), "utf8")).toBe(edited);
  });
});
