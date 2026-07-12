/**
 * contract-lint — the vitest gate for the retained CLI-contract harness.
 *
 * Asserts registry <-> fixture <-> schema-presence consistency and generator
 * determinism. Part of the Phase-0 bootstrap; never reverted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkFixtureConsistency,
  checkImplementedSchemas,
  findRepoRoot,
  loadFixtureNames,
  loadRegistry,
  parseFixture,
  renderOverview,
  validateRegistry,
  type Registry,
} from "./cli-contract.ts";

const root = findRepoRoot();
const registry = loadRegistry(root);
const fixtureNames = loadFixtureNames(root);

describe("registry integrity", () => {
  it("has rows and a version", () => {
    expect(registry.version).toBeGreaterThanOrEqual(1);
    expect(registry.commands.length).toBeGreaterThan(0);
  });

  it("every row is well-formed, sorted, unique, with the derived schemaRef", () => {
    expect(validateRegistry(registry)).toEqual([]);
  });
});

describe("registry <-> fixture bijection", () => {
  it("every fixture command has a registry row and vice versa", () => {
    expect(checkFixtureConsistency(registry, fixtureNames)).toEqual([]);
  });

  it("fixture and registry cover the same command set", () => {
    expect([...fixtureNames].sort()).toEqual(registry.commands.map((c) => c.name).sort());
  });
});

describe("schema presence for implemented commands", () => {
  it("every implemented:true row has an existing schemaRef file", () => {
    expect(checkImplementedSchemas(root, registry)).toEqual([]);
  });
});

describe("fixture-mutation test (the load-bearing guarantee)", () => {
  it("adding a command to the fixture WITHOUT a registry row fails the lint", () => {
    const mutated = [...fixtureNames, "totally-new-command"];
    const errors = checkFixtureConsistency(registry, mutated);
    expect(errors.some((e) => e.includes("totally-new-command") && e.includes("no registry row"))).toBe(true);
  });

  it("removing a command from the fixture (registry row orphaned) fails the lint", () => {
    const mutated = fixtureNames.filter((n) => n !== registry.commands[0]!.name);
    const errors = checkFixtureConsistency(registry, mutated);
    expect(errors.some((e) => e.includes(registry.commands[0]!.name) && e.includes("missing from"))).toBe(true);
  });

  it("a registry row whose schemaRef does not follow the naming rule fails validation", () => {
    const mutated: Registry = {
      version: registry.version,
      commands: registry.commands.map((c, i) =>
        i === 0 ? { ...c, schemaRef: "docs/specs/cli-contract/WRONG.schema.json" } : c,
      ),
    };
    expect(validateRegistry(mutated).some((e) => e.includes("!= expected"))).toBe(true);
  });

  it("an implemented:true row without its schema file fails the schema-presence check", () => {
    const mutated: Registry = {
      version: registry.version,
      commands: registry.commands.map((c, i) => (i === 0 ? { ...c, implemented: true } : c)),
    };
    // Phase 0 ships no schema files, so flipping any row to implemented must fail.
    expect(checkImplementedSchemas(root, mutated).length).toBeGreaterThan(0);
  });
});

describe("fixture parser", () => {
  it("ignores comments, blank lines, underlines, and prose after the backtick", () => {
    const text = [
      "# a heading",
      "===",
      "",
      "`foo bar` — some description with `nested` ticks",
      "just prose, no command",
      "`baz`",
    ].join("\n");
    expect(parseFixture(text)).toEqual(["foo bar", "baz"]);
  });
});

describe("generator determinism", () => {
  it("renderOverview is a pure function of the registry", () => {
    expect(renderOverview(registry)).toEqual(renderOverview(loadRegistry(root)));
  });

  it("the committed derived overview matches the generator output (--check would be clean)", () => {
    const onDisk = readFileSync(join(root, "docs/specs/cli-contract/commands-overview.md"), "utf8");
    expect(onDisk).toEqual(renderOverview(registry));
  });
});
