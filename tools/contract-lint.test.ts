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
  checkStateTableCompleteness,
  findRepoRoot,
  loadFixtureNames,
  loadRegistry,
  loadStateTable,
  normativeStateSet,
  parseFixture,
  parseStateTable,
  renderOverview,
  validateRegistry,
  type Registry,
} from "./cli-contract.ts";

const root = findRepoRoot();
const registry = loadRegistry(root);
const fixtureNames = loadFixtureNames(root);
const stateTable = loadStateTable(root);

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

describe("recovery-state-machine stateTable", () => {
  it("the fenced `json stateTable` block parses to an object with states", () => {
    expect(stateTable.version).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(stateTable.states)).toBe(true);
    expect(stateTable.states.length).toBeGreaterThan(0);
  });

  it("covers every state in the §2.5 normative set, and no state lacks a recovery action", () => {
    expect(checkStateTableCompleteness(stateTable)).toEqual([]);
  });

  it("every normative §2.5 state is present as a stateTable row", () => {
    const present = new Set(stateTable.states.map((s) => s.state));
    for (const state of normativeStateSet()) {
      expect(present.has(state), `missing state "${state}"`).toBe(true);
    }
  });

  it("covers both failed@ and cancelled@ checkpoint-suffixed terminals", () => {
    const present = new Set(stateTable.states.map((s) => s.state));
    for (const cp of ["planned", "patched", "worktree-applied", "agent-committed", "review-pending"]) {
      expect(present.has(`failed@${cp}`), `missing failed@${cp}`).toBe(true);
      expect(present.has(`cancelled@${cp}`), `missing cancelled@${cp}`).toBe(true);
    }
  });
});

describe("stateTable completeness gate (the load-bearing guarantee)", () => {
  it("dropping a §2.5 state from the table fails the completeness check", () => {
    const dropped = normativeStateSet()[0]!;
    const mutated = { ...stateTable, states: stateTable.states.filter((s) => s.state !== dropped) };
    const errors = checkStateTableCompleteness(mutated);
    expect(errors.some((e) => e.includes(dropped) && e.includes("missing"))).toBe(true);
  });

  it("a state with an empty recoveryAction fails the completeness check", () => {
    const mutated = {
      ...stateTable,
      states: stateTable.states.map((s, i) => (i === 0 ? { ...s, recoveryAction: "" } : s)),
    };
    const errors = checkStateTableCompleteness(mutated);
    expect(errors.some((e) => e.includes("lacks a recoveryAction"))).toBe(true);
  });

  it("a malformed / absent stateTable block throws on parse", () => {
    expect(() => parseStateTable("# no fenced block here")).toThrow(/stateTable/);
    expect(() => parseStateTable("```json stateTable\n{ not json }\n```")).toThrow();
  });

  it("an unknown/typo'd state (outside the §2.5 set) fails the completeness check", () => {
    const mutated = {
      ...stateTable,
      states: [
        ...stateTable.states,
        { state: "integratedd", kind: "checkpoint" as const, recoveryAction: "x" },
      ],
    };
    const errors = checkStateTableCompleteness(mutated);
    expect(errors.some((e) => e.includes("integratedd") && e.includes("§2.5 persisted-state set"))).toBe(true);
  });

  it("a row missing its kind fails the completeness check", () => {
    const mutated = {
      ...stateTable,
      states: stateTable.states.map((s, i) => {
        if (i !== 0) return s;
        const { kind: _drop, ...rest } = s;
        return rest as typeof s;
      }),
    };
    const errors = checkStateTableCompleteness(mutated);
    expect(errors.some((e) => e.includes("invalid kind"))).toBe(true);
  });

  it("a checkpoint misclassified as terminal (or vice versa) fails the completeness check", () => {
    const idx = stateTable.states.findIndex((s) => s.kind === "checkpoint");
    const mutated = {
      ...stateTable,
      states: stateTable.states.map((s, i) => (i === idx ? { ...s, kind: "terminal" as const } : s)),
    };
    const errors = checkStateTableCompleteness(mutated);
    expect(errors.some((e) => e.includes("must be") && e.includes("checkpoint"))).toBe(true);
  });

  it("a failed@ terminal misclassified as checkpoint fails the completeness check", () => {
    const idx = stateTable.states.findIndex((s) => s.state === "failed@planned");
    const mutated = {
      ...stateTable,
      states: stateTable.states.map((s, i) => (i === idx ? { ...s, kind: "checkpoint" as const } : s)),
    };
    const errors = checkStateTableCompleteness(mutated);
    expect(errors.some((e) => e.includes("failed@planned") && e.includes('must be "terminal"'))).toBe(true);
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
