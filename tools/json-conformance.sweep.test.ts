/**
 * `json-conformance.sweep` (SP-1 Phase 6, §13.8) — every read-class command's
 * `--json` output validates against its `schemaRef`. The inventory is derived AT
 * RUNTIME from the schemas (`x-atlas-contract.executionClass` ∈ read /
 * audited-read / pure), never hardcoded; each command drives the REAL `brain`
 * binary through an invocation adapter whose `arrange` returns concrete argv
 * with fixture-derived ids/paths (nothing guessed). `watch` is the sole
 * streaming command — bounded by `--once`, its single `watch.hello` line
 * validated against the union.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { findRepoRoot, loadRegistry } from "./cli-contract.js";
import { makeSweepHarness, type SweepHarness } from "./support/sweep-harness.js";

const Ajv2020 = ((_Ajv2020 as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown };
  errorsText: (errors?: unknown) => string;
};

const root = findRepoRoot();
const BIN = join(root, "apps", "cli", "dist", "bin.js");
const SWEEP_CLASSES = new Set(["read", "audited-read", "pure"]);

interface Arranged {
  argv: string[];
  /** Exit codes accepted as the command's SUCCESS surface (default [0]). */
  okCodes?: number[];
  /** Validate only the FIRST stdout line (streaming/one-line commands). */
  firstLineOnly?: boolean;
  /** Skip with reason (arrangement impossible in this environment). */
  skip?: string;
}

type Adapter = (h: SweepHarness) => Arranged | Promise<Arranged>;

/** The per-command invocation adapter map (plan Phase 6 Task 1). */
const ADAPTERS: Record<string, Adapter> = {
  status: () => ({ argv: ["status", "--json"] }),
  // Post-#326 EXIT.ACTION_REQUIRED (6) is retired; doctor's action-required
  // status (e.g. unprovisioned host) now surfaces as exit 2.
  doctor: () => ({ argv: ["doctor", "--json"], okCodes: [0, 2] }),
  validate: () => ({ argv: ["validate", "--json"], okCodes: [0, 1] }),
  "db status": () => ({ argv: ["db", "status", "--json"] }),
  "db verify": () => ({ argv: ["db", "verify", "--json"], okCodes: [0, 1] }),
  "jobs list": () => ({ argv: ["jobs", "list", "--json"] }),
  "source list": () => ({ argv: ["source", "list", "--json"] }),
  "evidence review": () => ({ argv: ["evidence", "review", "--json"] }),
  "git status": () => ({ argv: ["git", "status", "--json"] }),
  "git verify": () => ({ argv: ["git", "verify", "--json"], okCodes: [0, 1] }),
  "index status": () => ({ argv: ["index", "status", "--json"] }),
  "index verify": () => ({ argv: ["index", "verify", "--json"], okCodes: [0, 1] }),
  inspect: () => ({ argv: ["inspect", "--json"] }),
  "git review": (h) => ({ argv: ["git", "review", h.seeded.reviewRunId, "--json"] }),
  "source show": (h) => ({ argv: ["source", "show", h.seeded.sourceId, "--json"] }),
  "note show": (h) => ({ argv: ["note", "show", h.seeded.noteId, "--json"] }),
  "note history": (h) => ({ argv: ["note", "history", h.seeded.noteId, "--json"] }),
  "note related": (h) => ({ argv: ["note", "related", h.seeded.noteId, "--json"] }),
  query: (h) => ({ argv: ["query", h.seeded.noteId, "--json"] }),
  "index eval": (h) => ({
    argv: ["index", "eval", "--queries", h.seeded.queriesPath, "--labels", h.seeded.labelsPath, "--json"],
    okCodes: [0, 1], // a below-threshold gate still emits the conformant report
  }),
  "graduation scan": (h) => ({
    argv: ["graduation", "scan", "--source", h.seeded.gradSource, "--copy", h.seeded.gradCopy, "--json"],
  }),
  "graduation audit": () => ({ argv: ["graduation", "audit", "--json"] }),
  "sync status": () => ({ argv: ["sync", "status", "--json"] }),
  watch: () => ({ argv: ["watch", "--json", "--once"], firstLineOnly: true }),
};

const registry = loadRegistry(root);
// `quarantine inspect` is un-arrangeable post-#326: the secret scan is retired
// (nothing ever quarantines), so no arrangement can seed an item. The command
// itself leaves the registry in the #333 survivor-set shrink; excluded here
// explicitly rather than skipped silently.
const RETIRED_ARRANGEMENTS = new Set(["quarantine inspect"]);
const inventory = registry.commands.filter((r) => {
  if (!r.implemented) return false; // an unimplemented row cannot be invoked; the adapter obligation starts when the flag flips
  if (RETIRED_ARRANGEMENTS.has(r.name)) return false;
  const schema = JSON.parse(readFileSync(join(root, r.schemaRef), "utf8"));
  return SWEEP_CLASSES.has(schema["x-atlas-contract"]?.executionClass);
});

describe.skipIf(!existsSync(BIN))("--json read-surface conformance sweep (§13.8)", () => {
  let h: SweepHarness;
  beforeAll(async () => {
    h = await makeSweepHarness();
  }, 240_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("the runtime-derived inventory covers every read-class command and every one has an adapter", () => {
    // 24 post-#326: `source trust show` left the registry with the trust
    // semantics, and `quarantine inspect` is excluded (RETIRED_ARRANGEMENTS).
    expect(inventory.length).toBeGreaterThanOrEqual(24);
    for (const r of inventory) {
      expect(ADAPTERS[r.name], `no invocation adapter for \`${r.name}\``).toBeDefined();
    }
    // No orphan adapters either — the map tracks the registry, not a stale list.
    for (const name of Object.keys(ADAPTERS)) {
      expect(inventory.some((r) => r.name === name), `adapter \`${name}\` has no read-class registry row`).toBe(true);
    }
  });

  for (const rowName of Object.keys(ADAPTERS)) {
    it(`\`${rowName}\` --json validates against its schemaRef`, async () => {
      const row = registry.commands.find((r) => r.name === rowName)!;
      const schema = JSON.parse(readFileSync(join(root, row.schemaRef), "utf8"));
      const arranged = await ADAPTERS[rowName]!(h);
      if (arranged.skip !== undefined) {
        throw new Error(`arrangement failed for \`${rowName}\`: ${arranged.skip}`);
      }
      const r = await h.run(arranged.argv);
      const okCodes = arranged.okCodes ?? [0];
      expect(okCodes, `\`${rowName}\` exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`).toContain(r.status);
      const lines = r.stdout.trim().split("\n").filter((l) => l !== "");
      expect(lines.length, `\`${rowName}\` emitted no stdout`).toBeGreaterThan(0);
      const payload = JSON.parse(arranged.firstLineOnly ? lines[0]! : lines[lines.length - 1]!);
      const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
      expect(
        validate(payload),
        `\`${rowName}\` nonconformant: ${JSON.stringify(validate.errors)}\npayload: ${JSON.stringify(payload).slice(0, 2000)}`,
      ).toBe(true);
    }, 120_000);
  }
});
