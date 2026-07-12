/**
 * contract-lint — the vitest gate for the retained CLI-contract harness.
 *
 * Asserts registry <-> fixture <-> schema-presence consistency and generator
 * determinism. Part of the Phase-0 bootstrap; never reverted.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  checkAuthzContractCompleteness,
  checkFixtureConsistency,
  checkImplementedSchemas,
  checkStateTableCompleteness,
  checkTableInventory,
  DATA_DICTIONARY_PATH,
  extractJsonBlocks,
  findRepoRoot,
  loadAuthzContract,
  loadDataDictionaryTables,
  loadFixtureNames,
  loadRegistry,
  loadStateTable,
  normativeStateSet,
  parseAuthzContract,
  parseDataDictionaryTables,
  parseFixture,
  parseStateTable,
  privilegedCommandSet,
  renderOverview,
  SECURITY_BROKER_CONTRACT_PATH,
  sqlite27Tables,
  validateRegistry,
  type AuthzContract,
  type Registry,
} from "./cli-contract.ts";

const root = findRepoRoot();
const registry = loadRegistry(root);
const fixtureNames = loadFixtureNames(root);
const stateTable = loadStateTable(root);
const dictionaryTables = loadDataDictionaryTables(root);
const authzContract = loadAuthzContract(root);

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

describe("sqlite data-dictionary table inventory (against plan §2.7)", () => {
  it("the dictionary defines exactly the §2.7 table set — no missing, extra, or duplicate table", () => {
    expect(checkTableInventory(dictionaryTables)).toEqual([]);
  });

  it("every §2.7 table has a CREATE TABLE in the dictionary and vice versa", () => {
    expect([...new Set(dictionaryTables)].sort()).toEqual(sqlite27Tables());
  });
});

describe("table-inventory gate (the load-bearing guarantee)", () => {
  it("dropping a §2.7 table from the dictionary fails the inventory check", () => {
    const dropped = sqlite27Tables()[0]!;
    const mutated = dictionaryTables.filter((t) => t !== dropped);
    const errors = checkTableInventory(mutated);
    expect(errors.some((e) => e.includes(dropped) && e.includes("missing a CREATE TABLE"))).toBe(true);
  });

  it("a CREATE TABLE with no owning §2.7 migration fails the inventory check", () => {
    const mutated = [...dictionaryTables, "totally_new_table"];
    const errors = checkTableInventory(mutated);
    expect(errors.some((e) => e.includes("totally_new_table") && e.includes("no owning migration"))).toBe(true);
  });

  it("defining the same table twice fails the inventory check", () => {
    const mutated = [...dictionaryTables, dictionaryTables[0]!];
    const errors = checkTableInventory(mutated);
    expect(errors.some((e) => e.includes(dictionaryTables[0]!) && e.includes("more than once"))).toBe(true);
  });
});

describe("security/broker contract authzContract", () => {
  it("the fenced `json authzContract` block parses to an object with ops + catalog", () => {
    expect(authzContract.version).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(authzContract.privilegedOps)).toBe(true);
    expect(authzContract.privilegedOps.length).toBeGreaterThan(0);
    expect(Array.isArray(authzContract.errorCatalog)).toBe(true);
    expect(authzContract.errorCatalog.length).toBeGreaterThan(0);
  });

  it("covers exactly the registry-privileged set, every op fully mapped, every driftCode cataloged", () => {
    expect(checkAuthzContractCompleteness(authzContract, registry)).toEqual([]);
  });

  it("every commands.json privileged command has a non-variant authz op", () => {
    const nonVariant = new Set(
      authzContract.privilegedOps.filter((o) => o.variant !== true).map((o) => o.command),
    );
    for (const cmd of privilegedCommandSet(registry)) {
      expect(nonVariant.has(cmd), `missing authz mapping for privileged command "${cmd}"`).toBe(true);
    }
  });

  it("every op names a mechanism and non-empty challenge/verification/drift arrays", () => {
    for (const op of authzContract.privilegedOps) {
      expect(op.mechanism, `op "${op.op}" mechanism`).toBeTruthy();
      expect(op.challengeFields.length, `op "${op.op}" challengeFields`).toBeGreaterThan(0);
      expect(op.verificationSteps.length, `op "${op.op}" verificationSteps`).toBeGreaterThan(0);
      expect(op.driftCodes.length, `op "${op.op}" driftCodes`).toBeGreaterThan(0);
    }
  });
});

describe("authzContract completeness gate (the load-bearing guarantee)", () => {
  it("dropping the authz op for a privileged command fails the completeness check", () => {
    const dropped = privilegedCommandSet(registry)[0]!;
    const mutated: AuthzContract = {
      ...authzContract,
      privilegedOps: authzContract.privilegedOps.filter((o) => o.command !== dropped),
    };
    const errors = checkAuthzContractCompleteness(mutated, registry);
    expect(errors.some((e) => e.includes(dropped) && e.includes("no authz mapping"))).toBe(true);
  });

  it("authorizing a non-privileged command (without variant:true) fails the check", () => {
    const shared = registry.commands.find((c) => c.privilege === "shared")!.name;
    const mutated: AuthzContract = {
      ...authzContract,
      privilegedOps: [
        ...authzContract.privilegedOps,
        {
          op: shared,
          command: shared,
          mechanism: "broker-signature",
          challengeFields: ["op"],
          verificationSteps: ["x"],
          driftCodes: ["authz.ok"],
        },
      ],
    };
    const errors = checkAuthzContractCompleteness(mutated, registry);
    expect(errors.some((e) => e.includes(shared) && e.includes("not classified privileged"))).toBe(true);
  });

  it("a driftCode outside the errorCatalog fails the check", () => {
    const mutated: AuthzContract = {
      ...authzContract,
      privilegedOps: authzContract.privilegedOps.map((o, i) =>
        i === 0 ? { ...o, driftCodes: [...o.driftCodes, "authz.not_a_real_code"] } : o,
      ),
    };
    const errors = checkAuthzContractCompleteness(mutated, registry);
    expect(errors.some((e) => e.includes("authz.not_a_real_code") && e.includes("not in the errorCatalog"))).toBe(true);
  });

  it("an op missing its verificationSteps fails the check", () => {
    const mutated: AuthzContract = {
      ...authzContract,
      privilegedOps: authzContract.privilegedOps.map((o, i) =>
        i === 0 ? { ...o, verificationSteps: [] } : o,
      ),
    };
    const errors = checkAuthzContractCompleteness(mutated, registry);
    expect(errors.some((e) => e.includes("verificationSteps") && e.includes("non-empty array"))).toBe(true);
  });

  it("an errorCatalog exitCode outside the §2.5 set fails the check", () => {
    const mutated: AuthzContract = {
      ...authzContract,
      errorCatalog: authzContract.errorCatalog.map((e, i) => (i === 0 ? { ...e, exitCode: 7 } : e)),
    };
    const errors = checkAuthzContractCompleteness(mutated, registry);
    expect(errors.some((e) => e.includes("exitCode") && e.includes("0..6"))).toBe(true);
  });

  it("a malformed / absent authzContract block throws on parse", () => {
    expect(() => parseAuthzContract("# no fenced block here")).toThrow(/authzContract/);
    expect(() => parseAuthzContract("```json authzContract\n{ not json }\n```")).toThrow();
  });
});

describe("security/broker contract JSON examples are well-formed", () => {
  const raw = readFileSync(join(root, SECURITY_BROKER_CONTRACT_PATH), "utf8");

  it("every fenced ```json block parses (structural precondition for the Task 1.1 Zod mirrors)", () => {
    const blocks = extractJsonBlocks(raw);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(() => JSON.parse(block), block.slice(0, 60)).not.toThrow();
    }
  });

  it("contains no NUL (or other C0 control) bytes — stays a text file, byte-stable to sign over", () => {
    expect(raw.includes("\x00")).toBe(false);
    // Only tab / newline are permitted C0 controls in the Markdown source; a raw
    // separator byte embedded in the opaque-ID formula would break text-safety
    // and canonicalization (it must be written as an explicit \x00 escape).
    // eslint-disable-next-line no-control-regex
    const badControl = /[\x01-\x08\x0B\x0C\x0E-\x1F]/.exec(raw);
    expect(badControl, badControl ? `control char U+${badControl[0].codePointAt(0)!.toString(16)}` : "")
      .toBeNull();
  });
});

describe("data-dictionary parser", () => {
  it("extracts CREATE TABLE names and ignores CREATE INDEX / REFERENCES", () => {
    const sql = [
      "```sql",
      "CREATE TABLE notes ( note_id TEXT PRIMARY KEY );",
      "CREATE TABLE IF NOT EXISTS jobs ( job_id TEXT PRIMARY KEY );",
      "CREATE UNIQUE INDEX idx_x ON notes(note_id);",
      "CREATE INDEX idx_y ON jobs(state, next_run_at);",
      "-- FOREIGN KEY (x) REFERENCES source_renditions(y)",
      "```",
    ].join("\n");
    expect(parseDataDictionaryTables(sql)).toEqual(["notes", "jobs"]);
  });

  it("ignores CREATE TABLE mentioned in prose outside a sql fence", () => {
    const md = [
      "Each migration copies its `CREATE TABLE ghost_prose` verbatim from here.",
      "> Prose can name CREATE TABLE another_ghost without declaring it.",
      "",
      "```text",
      "CREATE TABLE fenced_but_not_sql ( x TEXT );",
      "```",
      "",
      "```sql",
      "CREATE TABLE real_table ( id TEXT PRIMARY KEY ) STRICT;",
      "```",
    ].join("\n");
    // Only the CREATE TABLE inside a ```sql fence counts.
    expect(parseDataDictionaryTables(md)).toEqual(["real_table"]);
  });

  it("ignores commented-out CREATE TABLE (line and block comments) inside a sql fence", () => {
    const md = [
      "```sql",
      "-- CREATE TABLE line_commented_ghost ( x TEXT );",
      "/* CREATE TABLE block_commented_ghost ( x TEXT ); */",
      "CREATE TABLE real_table ( id TEXT PRIMARY KEY ) STRICT;  -- CREATE TABLE trailing_ghost",
      "/*",
      "  CREATE TABLE multiline_block_ghost ( x TEXT );",
      "*/",
      "```",
    ].join("\n");
    expect(parseDataDictionaryTables(md)).toEqual(["real_table"]);
  });
});

describe("data-dictionary is text-safe and executable DDL", () => {
  const rawDictionary = readFileSync(join(root, DATA_DICTIONARY_PATH), "utf8");

  it("contains no NUL (or other C0 control) bytes — stays a text file, safe to copy verbatim", () => {
    expect(rawDictionary.includes("\x00")).toBe(false);
    // Only tab / newline are permitted C0 controls in the Markdown source.
    // eslint-disable-next-line no-control-regex
    const badControl = /[\x01-\x08\x0B\x0C\x0E-\x1F]/.exec(rawDictionary);
    expect(badControl, badControl ? `control char U+${badControl[0].codePointAt(0)!.toString(16)}` : "")
      .toBeNull();
  });

  it("every fenced sql block executes against SQLite (STRICT DDL + invariant queries run clean)", () => {
    const fence = /```sql\b[^\n]*\n([\s\S]*?)```/gi;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = fence.exec(rawDictionary)) !== null) blocks.push(m[1]!);
    expect(blocks.length).toBeGreaterThan(0);

    const db = new DatabaseSync(":memory:");
    try {
      // Execute in document order: CREATE TABLE/INDEX blocks precede the §7
      // SELECT invariant queries; forward FK references are legal at CREATE time.
      for (const block of blocks) {
        expect(() => db.exec(block)).not.toThrow();
      }
    } finally {
      db.close();
    }
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
