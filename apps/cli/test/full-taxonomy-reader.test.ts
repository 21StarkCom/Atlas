/**
 * `full-taxonomy-reader` (Task 5.4) — the reader-compatibility gate that makes "total ingestion"
 * REAL. It applies the full-taxonomy bootstrap-migration plan into a temp copy via
 * `applyBootstrapMigration`, then runs the strict `readVault()` over the RESULT and asserts ZERO
 * errors — no broken-link, ambiguous-link, identity-collision, duplicate-id, or schema errors.
 *
 * It specifically exercises the collision-clearing mutations on disk:
 *   • the meridian same-slug pair — the rename cleared the identity collision;
 *   • the flattened unresolved link — no `[[…]]` survives to become a broken link;
 *   • the STRICT alias↔alias collision — the dropped alias (Task 4 consumes `plan.aliasDrops`);
 *   • the LOOSE alias↔alias collision — a loose note's colliding alias is ALSO dropped (the drop is
 *     applied in the loose emit branch too, else the strict reader would emit identity-collision).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, cpSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AtlasConfig } from "../src/config/schema.js";
import { planBootstrapMigration, type MigrationInputFile } from "../src/graduation/migrate-plan.js";
import { applyBootstrapMigration } from "../src/graduation/migrate-apply.js";
import { readVault } from "../src/vault/reader.js";
import { splitFrontmatter } from "../src/markdown/parse.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "docs/specs/fixtures/bootstrap-migration");
const TS = "2026-07-12T00:00:00Z";
const OPTS = { migrationRunId: "01J9ZTREADER0000000000000A", bootstrapTimestamp: TS };
const cfgFor = (dir: string): AtlasConfig => ({ vault: { path: dir } } as unknown as AtlasConfig);

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

let root: string;
let copy: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-ft-reader-"));
  copy = join(root, "copy");
  cpSync(join(FIXTURES, "full-taxonomy", "input"), copy, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("full-taxonomy reader-compat gate (Task 5.4, #151)", () => {
  it("the applied full-taxonomy copy passes readVault() with ZERO errors of every kind", async () => {
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    // Guard the fixture is doing its job: 21 notes, one rename, two alias drops (one STRICT pair, one
    // LOOSE pair), one flattened link.
    expect(plan.notes.length).toBe(21);
    expect(plan.renames).toEqual([{ from: "Projects/Meridian.md", to: "Projects/Meridian-project.md" }]);
    expect(plan.aliasDrops).toEqual({ "alias-y.md": ["Shared Alias"], "loose-alias-b.md": ["open, q"] });

    applyBootstrapMigration(copy, plan, OPTS);

    const snap = await readVault(cfgFor(copy));

    // The proof: not just the named collision kinds — ZERO errors of ANY kind.
    expect(snap.errors, `unexpected reader errors: ${JSON.stringify(snap.errors)}`).toEqual([]);
    for (const kind of ["broken-link", "ambiguous-link", "identity-collision", "duplicate-id"]) {
      expect(snap.errors.filter((e) => e.kind === kind), kind).toEqual([]);
    }
    expect(snap.notes.length).toBe(21); // every note parsed (no schema/read errors dropped one)
  });

  it("the meridian same-slug pair is on disk under distinct slugs (the rename cleared the collision)", async () => {
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    applyBootstrapMigration(copy, plan, OPTS);

    expect(existsSync(join(copy, "People/Meridian.md"))).toBe(true); // winner kept its path
    expect(existsSync(join(copy, "Projects/Meridian.md"))).toBe(false); // loser moved
    expect(existsSync(join(copy, "Projects/Meridian-project.md"))).toBe(true); // …to its renamed path

    const snap = await readVault(cfgFor(copy));
    expect(snap.errors.filter((e) => e.kind === "identity-collision")).toEqual([]);
  });

  it("the unresolved link is flattened on disk (no `[[` survives) and the resolved link stays a canonical wikilink", async () => {
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    applyBootstrapMigration(copy, plan, OPTS);

    const research = readFileSync(join(copy, "research-note.md"), "utf8");
    expect(research).not.toContain("[["); // flattened away
    expect(research).toContain("Nonexistent Thing"); // kept as prose

    const journal = readFileSync(join(copy, "personal-journal.md"), "utf8");
    expect(journal).toContain("[[person-ada|Ada]]"); // resolvable link stays canonical

    const snap = await readVault(cfgFor(copy));
    expect(snap.errors.filter((e) => e.kind === "broken-link" || e.kind === "ambiguous-link")).toEqual([]);
  });

  it("the alias↔alias collision is cleared on disk: the sorted-later note dropped the shared alias", async () => {
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    applyBootstrapMigration(copy, plan, OPTS);

    const fmOf = (p: string): Record<string, unknown> => {
      const { frontmatter } = splitFrontmatter(readFileSync(join(copy, p), "utf8"));
      return parseYaml(frontmatter!) as Record<string, unknown>;
    };
    expect(fmOf("alias-x.md").aliases).toEqual(["Shared Alias"]); // winner keeps it
    expect(fmOf("alias-y.md").aliases).toEqual([]); // loser dropped it on disk

    const snap = await readVault(cfgFor(copy));
    expect(snap.errors.filter((e) => e.kind === "identity-collision")).toEqual([]);
  });

  it("the LOOSE alias↔alias collision is cleared on disk: the loose loser dropped its colliding alias", async () => {
    const plan = planBootstrapMigration(readTree(copy), { bootstrapTimestamp: TS });
    applyBootstrapMigration(copy, plan, OPTS);

    const fmOf = (p: string): Record<string, unknown> => {
      const { frontmatter } = splitFrontmatter(readFileSync(join(copy, p), "utf8"));
      return parseYaml(frontmatter!) as Record<string, unknown>;
    };
    // "Open Q" and "open, q" fold to the same identity key; loose-alias-a (sorted first) wins and
    // keeps its alias VERBATIM, loose-alias-b drops the colliding alias — proving the loose emit
    // branch applies aliasDrops (the whole point of this fix).
    expect(fmOf("loose-alias-a.md").aliases).toEqual(["Open Q"]); // loose winner keeps it verbatim
    expect(fmOf("loose-alias-b.md").aliases).toEqual([]); // loose loser dropped it on disk

    const snap = await readVault(cfgFor(copy));
    expect(snap.errors.filter((e) => e.kind === "identity-collision")).toEqual([]);
  });
});

/**
 * The serializer must QUOTE ambiguous managed scalars: a numeric-looking `type: "42"` (guards
 * fixture's `MalformedType.md`, from input `type: 42`) has to serialize QUOTED so YAML re-parses it
 * as a STRING — an unquoted `type: 42` re-parses as a NUMBER and the strict reader's `type: z.string()`
 * rejects it (`invalid-frontmatter`). This gate FAILS if the serializer ever emits scalars raw.
 */
describe("guards fixture reader-compat: ambiguous managed scalars stay strings (#151)", () => {
  let gRoot: string;
  let gCopy: string;
  beforeEach(() => {
    gRoot = mkdtempSync(join(tmpdir(), "atlas-guards-reader-"));
    gCopy = join(gRoot, "copy");
    cpSync(join(FIXTURES, "guards", "input"), gCopy, { recursive: true });
  });
  afterEach(() => rmSync(gRoot, { recursive: true, force: true }));

  it("the applied guards copy passes readVault() with ZERO errors — numeric `type: 42` survives as a string", async () => {
    const plan = planBootstrapMigration(readTree(gCopy), { bootstrapTimestamp: TS });
    applyBootstrapMigration(gCopy, plan, OPTS);

    // Proof the fix is what's under test: the numeric-looking type serialized QUOTED on disk, so a
    // re-parse yields the STRING "42" (an unquoted `type: 42` would be a number → reader rejects).
    const malformed = readFileSync(join(gCopy, "MalformedType.md"), "utf8");
    expect(malformed).toContain('type: "42"');
    const { frontmatter } = splitFrontmatter(malformed);
    const fm = parseYaml(frontmatter!) as Record<string, unknown>;
    expect(fm.type).toBe("42"); // STRING, not number 42

    const snap = await readVault(cfgFor(gCopy));
    expect(snap.errors, `unexpected reader errors: ${JSON.stringify(snap.errors)}`).toEqual([]);
    expect(snap.notes.length).toBe(4); // every guard note parsed (none dropped on an invalid-frontmatter)
  });
});
