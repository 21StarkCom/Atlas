/**
 * contract-lint — the vitest gate for the retained CLI-contract harness.
 *
 * Asserts registry <-> fixture <-> schema-presence consistency and generator
 * determinism. Part of the Phase-0 bootstrap; never reverted.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { ProviderErrorSchema, CHANGE_PLAN_OPS, SCHEMA_VERSION } from "@atlas/contracts";
import {
  checkAuthzContractCompleteness,
  checkFixtureConsistency,
  checkImplementedSchemas,
  checkStateTableCompleteness,
  checkTableInventory,
  DATA_DICTIONARY_PATH,
  EXIT_CODES,
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
    // Every real registry row now ships a schema file (the Phase-5 contracts gate,
    // Task 5.0, completed the set), so we synthesize a row whose schemaRef points at
    // an absent file to exercise the guarantee: implemented:true + missing schema ⇒ error.
    const missing = "docs/specs/cli-contract/does-not-exist.schema.json";
    expect(existsSync(join(root, missing))).toBe(false);
    const mutated: Registry = {
      version: registry.version,
      commands: registry.commands.map((c, i) =>
        i === 0 ? { ...c, schemaRef: missing, implemented: true } : c,
      ),
    };
    const errors = checkImplementedSchemas(root, mutated);
    expect(errors.some((e) => e.includes(missing))).toBe(true);
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

describe("Phase-2 cli-contract schema presence (Task 2.0)", () => {
  const phase2 = registry.commands.filter((c) => c.phase === 2);

  it("has Phase-2 rows", () => {
    expect(phase2.length).toBeGreaterThan(0);
  });

  it("every Phase-2 row has an existing schema file (independent of implementation status)", () => {
    // This is a contract-only gate: the schemas ship now, the handlers land in
    // later Phase-2 tasks. Schema presence is asserted directly, NOT via the
    // implemented flag (which stays false until the handler exists).
    for (const r of phase2) {
      expect(existsSync(join(root, r.schemaRef)), `${r.name} schema ${r.schemaRef}`).toBe(true);
    }
  });

  // NB: schema presence is asserted independently of the `implemented` flag (above).
  // We deliberately do NOT require Phase-2 rows to stay implemented:false — delivering
  // tasks flip rows to implemented:true as handlers land (Task 2.7 delivered the four
  // `jobs *` commands), and the durable gate is schema presence, not a temporal
  // implementation-status assertion (which the first Phase-2 handler necessarily
  // breaks). Matches the Phase-3/Phase-4 gate policy below.
  it("the delivered `jobs *` commands are implemented:true with their schemas present", () => {
    const jobs = phase2.filter((r) => r.name.startsWith("jobs "));
    expect(jobs.map((r) => r.name).sort()).toEqual(["jobs cancel", "jobs list", "jobs retry", "jobs run"]);
    for (const r of jobs) {
      expect(r.implemented, `${r.name} implemented`).toBe(true);
      expect(existsSync(join(root, r.schemaRef)), `${r.name} schema ${r.schemaRef}`).toBe(true);
    }
  });

  it("the Phase-2 command set matches the plan Task 2.0 inventory", () => {
    expect(phase2.map((c) => c.name).sort()).toEqual(
      [
        "git cleanup",
        "git status",
        "ingest",
        "jobs cancel",
        "jobs list",
        "jobs retry",
        "jobs run",
        "note add",
        "note history",
        "note related",
        "note show",
        "source add",
        "source list",
        "source show",
        "source trust show",
      ].sort(),
    );
  });
});

describe("Phase-2 contract docs — fenced examples validate (Task 2.0)", () => {
  const docs = [
    "docs/specs/jobs-contract.md",
    "docs/specs/sandbox-contract.md",
    "docs/specs/normalization-contract.md",
    "docs/specs/provider-interface.md",
  ];

  for (const rel of docs) {
    describe(rel, () => {
      const raw = readFileSync(join(root, rel), "utf8");

      it("exists and is a text file with no C0 control bytes (byte-stable)", () => {
        expect(raw.length).toBeGreaterThan(0);
        // eslint-disable-next-line no-control-regex
        const bad = /[\x00-\x08\x0B\x0C\x0E-\x1F]/.exec(raw);
        expect(bad, bad ? `control U+${bad[0].codePointAt(0)!.toString(16)}` : "").toBeNull();
      });

      it("every fenced ```json block is well-formed JSON", () => {
        const blocks = extractJsonBlocks(raw);
        expect(blocks.length).toBeGreaterThan(0);
        for (const b of blocks) {
          expect(() => JSON.parse(b), b.slice(0, 60)).not.toThrow();
        }
      });
    });
  }

  it("jobs-contract state machine covers the 5 DDL job states + 3 terminals", () => {
    const raw = readFileSync(join(root, "docs/specs/jobs-contract.md"), "utf8");
    const block = /```json\s+jobsStateMachine\s*\n([\s\S]*?)\n```/.exec(raw);
    expect(block, "jobsStateMachine block").not.toBeNull();
    const sm = JSON.parse(block![1]!);
    // Exactly the authoritative jobs.state CHECK set — no separate `claimed` state.
    expect(sm.states.sort()).toEqual(
      ["cancelled", "failed", "pending", "running", "succeeded"].sort(),
    );
    expect(sm.terminals.sort()).toEqual(["cancelled", "failed", "succeeded"].sort());
    // every transition names states from the declared set
    const states = new Set<string>(sm.states);
    for (const t of sm.transitions) {
      expect(states.has(t.from), `from ${t.from}`).toBe(true);
      expect(states.has(t.to), `to ${t.to}`).toBe(true);
    }
    // dead-runner recovery MUST be able to move a running job back to pending.
    const hasRecovery = sm.transitions.some(
      (t: { from: string; to: string }) => t.from === "running" && t.to === "pending",
    );
    expect(hasRecovery, "running -> pending (dead-runner-recovery)").toBe(true);
  });

  it("jobs-list schema state enum matches the DDL 5-state set (R3-F5: no stale `claimed`)", () => {
    const raw = readFileSync(join(root, "docs/specs/jobs-contract.md"), "utf8");
    const sm = JSON.parse(/```json\s+jobsStateMachine\s*\n([\s\S]*?)\n```/.exec(raw)![1]!);
    const ddlStates: string[] = [...sm.states].sort();
    // The public `jobs list` state enum + its --state flag constraint must be
    // EXACTLY the authoritative DDL state set — no `claimed`, no drift.
    const schema = JSON.parse(
      readFileSync(join(root, "docs/specs/cli-contract/jobs-list.schema.json"), "utf8"),
    );
    const enumStates: string[] = [...schema.properties.jobs.items.properties.state.enum].sort();
    expect(enumStates).toEqual(ddlStates);
    expect(enumStates).not.toContain("claimed");
    const stateFlag = schema["x-atlas-contract"].flags.find((f: { name: string }) =>
      f.name.startsWith("--state"),
    );
    expect(stateFlag.constraint).not.toContain("claimed");
    for (const s of ddlStates) expect(stateFlag.constraint).toContain(s);
  });

  it("sandbox-contract declares required guarantees with a darwin + linux primitive each", () => {
    const raw = readFileSync(join(root, "docs/specs/sandbox-contract.md"), "utf8");
    const block = /```json\s+sandboxContract\s*\n([\s\S]*?)\n```/.exec(raw);
    expect(block, "sandboxContract block").not.toBeNull();
    const sc = JSON.parse(block![1]!);
    expect(Array.isArray(sc.guarantees) && sc.guarantees.length).toBeGreaterThan(0);
    for (const g of sc.guarantees) {
      expect(typeof g.guarantee).toBe("string");
      expect(typeof g.darwin, `${g.guarantee} darwin`).toBe("string");
      expect(typeof g.linux, `${g.guarantee} linux`).toBe("string");
    }
    // the scan-before-persist guarantee (D15) is present and required
    const sbp = sc.guarantees.find((g: { guarantee: string }) => g.guarantee === "scan-before-persist");
    expect(sbp?.required).toBe(true);
  });

  it("normalization-contract gives every format a canonical media token + accepted encodings", () => {
    const raw = readFileSync(join(root, "docs/specs/normalization-contract.md"), "utf8");
    const block = /```json\s+normalizationContract\s*\n([\s\S]*?)\n```/.exec(raw);
    expect(block, "normalizationContract block").not.toBeNull();
    const nc = JSON.parse(block![1]!);
    const tokens = new Set<string>();
    for (const f of nc.formats) {
      expect(f.canonicalMediaType, `${f.format} token`).toBeTruthy();
      expect(tokens.has(f.canonicalMediaType), `duplicate token ${f.canonicalMediaType}`).toBe(false);
      tokens.add(f.canonicalMediaType);
      expect(Array.isArray(f.mimeSignatures) && f.mimeSignatures.length).toBeGreaterThan(0);
      expect(Array.isArray(f.encodings) && f.encodings.length).toBeGreaterThan(0);
    }
    // the required rejection codes are all declared
    for (const code of ["unsupported-encoding", "encrypted-source", "no-extractable-text"]) {
      expect(nc.rejectionCodes.includes(code), `rejection ${code}`).toBe(true);
    }
  });

  it("provider-interface ProviderError examples validate against the @atlas/contracts schema", () => {
    const raw = readFileSync(join(root, "docs/specs/provider-interface.md"), "utf8");
    const block = /```json\s+providerErrors\s*\n([\s\S]*?)\n```/.exec(raw);
    expect(block, "providerErrors block").not.toBeNull();
    const errors = JSON.parse(block![1]!) as unknown[];
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(() => ProviderErrorSchema.parse(e), JSON.stringify(e)).not.toThrow();
    }
  });
});

describe("Phase-3 cli-contract schema presence (Task 3.0)", () => {
  const phase3 = registry.commands.filter((c) => c.phase === 3);

  it("has Phase-3 rows", () => {
    expect(phase3.length).toBeGreaterThan(0);
  });

  it("every Phase-3 row has an existing schema file (independent of implementation status)", () => {
    // Contract-only gate: the schemas ship now (Task 3.0), the handlers land in
    // later Phase-3 tasks. Schema presence is asserted directly, NOT via the
    // implemented flag (which stays false until the handler exists).
    for (const r of phase3) {
      expect(existsSync(join(root, r.schemaRef)), `${r.name} schema ${r.schemaRef}`).toBe(true);
    }
  });

  // NB: schema presence is asserted independently of the `implemented` flag (above).
  // We deliberately do NOT require Phase-3 rows to stay implemented:false — Tasks 3.4/3.5
  // flip rows to implemented:true as handlers land, and the contract-only gate must not
  // block that (Task 3.0 acceptance: "Registry rows flip to implemented as tasks land").

  it("the Phase-3 command set matches the plan Task 3.0 inventory", () => {
    expect(phase3.map((c) => c.name).sort()).toEqual(
      ["index rebuild", "index repair", "index status", "index verify", "query"].sort(),
    );
  });
});

describe("Phase-3 retrieval/index contract (Task 3.0)", () => {
  const rel = "docs/specs/retrieval-index-contract.md";
  const raw = readFileSync(join(root, rel), "utf8");

  it("exists and is a text file with no C0 control bytes (byte-stable)", () => {
    expect(raw.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-control-regex
    const bad = /[\x00-\x08\x0B\x0C\x0E-\x1F]/.exec(raw);
    expect(bad, bad ? `control U+${bad[0].codePointAt(0)!.toString(16)}` : "").toBeNull();
  });

  it("every fenced ```json block is well-formed JSON", () => {
    const blocks = extractJsonBlocks(raw);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(() => JSON.parse(b), b.slice(0, 60)).not.toThrow();
    }
  });

  const rc = JSON.parse(/```json\s+retrievalContract\s*\n([\s\S]*?)\n```/.exec(raw)![1]!);

  it("the fenced `json retrievalContract` block parses to a versioned object", () => {
    expect(rc.version).toBeGreaterThanOrEqual(1);
  });

  it("chunker consumes D4 (chunker_version=1) with heading hierarchy + title + aliases in chunk text", () => {
    expect(rc.chunker.version).toBe(1); // D4
    expect(rc.chunker.unit).toBe("semantic-section");
    expect(rc.chunker.headingHierarchy).toBe(true);
    expect(rc.chunker.includeTitle).toBe(true);
    expect(rc.chunker.includeAliases).toBe(true);
  });

  it("generation identity is exactly the five-component tuple", () => {
    expect([...rc.generationIdentity].sort()).toEqual(
      ["chunkerVersion", "contentHash", "embeddingDimensions", "embeddingModel", "noteId"].sort(),
    );
  });

  it("reconciliation covers the full crash-safe pipeline (chunk→embed→write→verify-complete→activate→retire→mark)", () => {
    for (const step of ["chunk", "embed", "write", "verify-complete", "activate", "retire", "mark-indexed"]) {
      expect(rc.reconciliationSteps.includes(step), `step ${step}`).toBe(true);
    }
    // verify-complete must precede activate so a partial batched write can never be activated (§3)
    expect(rc.reconciliationSteps.indexOf("verify-complete")).toBeLessThan(
      rc.reconciliationSteps.indexOf("activate"),
    );
  });

  it("chunks carry deterministic ids so the complete expected set is verifiable before activation (§1/§3)", () => {
    expect(rc.chunker.deterministicChunkId).toBe(true);
    expect(rc.chunker.chunkIdComponents).toEqual(["generationId", "sectionPath", "ordinal"]);
    expect(rc.activation.verifyBeforeActivate).toBe(true);
  });

  it("activation uses the integer config-revision fence + composite join key columns with atomic CAS (§2)", () => {
    // active_generation carries the monotonic config-revision fence; active_generation_id is the
    // LanceDB join key AND the retrieval filter column — matching the authoritative sqlite-data-dictionary.
    expect(rc.activation.authority).toBe("sqlite");
    expect(rc.activation.fenceCounterColumn).toBe("active_generation");
    expect(rc.activation.fenceCounterType).toBe("integer");
    expect(rc.activation.generationJoinKeyColumn).toBe("active_generation_id");
    expect(rc.activation.retrievalFilterColumn).toBe("active_generation_id");
    // The generation/config fence (Task issue #39, carry-forward #1): content-hash
    // alone does not fence different-config/same-content workers, so the CAS also
    // fences on the config revision. Both guards move both columns in one txn.
    expect(rc.activation.casGuards).toEqual(["content_hash-unchanged", "config-revision-not-superseded"]);
    expect(rc.activation.configRevisionColumn).toBe("active_generation");
  });

  it("staleness triggers cover hash/chunker/model/dimensions drift (§4)", () => {
    expect([...rc.stalenessTriggers].sort()).toEqual(
      ["chunkerVersion", "contentHash", "embeddingDimensions", "embeddingModel"].sort(),
    );
  });

  it("layer precedence is exactly exact-id → slug → unique-alias → fts/vector fusion (contract-owned order)", () => {
    expect(rc.layerPrecedence).toEqual(["exact-id", "slug", "unique-alias", "fts-vector-fusion"]);
  });

  it("RRF weights + k are contract-owned, within declared bounds, and config-keyed (not hardcoded)", () => {
    expect(rc.rrf.k).toBeGreaterThanOrEqual(rc.rrf.kBounds[0]);
    expect(rc.rrf.k).toBeLessThanOrEqual(rc.rrf.kBounds[1]);
    for (const layer of ["fts", "vector"] as const) {
      const w = rc.rrf.weights[layer];
      expect(w, `weight ${layer}`).toBeGreaterThanOrEqual(rc.rrf.weightBounds[0]);
      expect(w, `weight ${layer}`).toBeLessThanOrEqual(rc.rrf.weightBounds[1]);
    }
    expect(rc.rrf.configKeyPrefix, "RRF values are consumed from config, not inlined").toBeTruthy();
  });

  it("records the LanceDB FTS-maturity fallback: hybrid degrades to vector + id/alias with RRF (§6)", () => {
    expect(rc.ftsFallback.droppedLayer).toBe("fts");
    expect(rc.ftsFallback.fusionRemains).toBe("rrf");
    for (const layer of ["vector", "exact-id", "unique-alias"]) {
      expect(rc.ftsFallback.degradesTo.includes(layer), `degradesTo ${layer}`).toBe(true);
    }
    // the fallback must NOT drop the vector layer (that is what it degrades onto)
    expect(rc.ftsFallback.degradesTo.includes("fts")).toBe(false);
  });
});

describe("Phase-3 schema discriminants + audit/error catalog (Task 3.0 revision R3)", () => {
  const schemaDir = "docs/specs/cli-contract";
  const load = (name: string) => JSON.parse(readFileSync(join(root, schemaDir, name), "utf8"));
  // Compile each success schema for instance validation. strictSchema:false so the
  // x-atlas-contract vendor block + draft-2020 unevaluatedProperties don't trip Ajv's
  // metaschema strictness; the discriminant conditionals are what we exercise.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const compile = (name: string) => ajv.compile(load(name));

  it("query: error catalog includes the fail-closed backup-unhealthy exit-2 outcome (both modes write ledger rows)", () => {
    const q = load("query.schema.json");
    const codes = q["x-atlas-contract"].errorCodes as { code: string; exit: number; retryable?: boolean }[];
    const bu = codes.find((c) => c.code === "backup-unhealthy");
    expect(bu, "backup-unhealthy error").toBeTruthy();
    expect(bu!.exit).toBe(2);
    expect(bu!.retryable).toBe(true);
    // both query modes finalize ledger writes, so the fail-closed watermark applies to each
    const se = (q["x-atlas-contract"].sideEffects as string[]).join(" ");
    expect(se).toMatch(/finalizeLedgerWrite/);
    expect(q["x-atlas-contract"].exitCodes).toContain(2);
  });

  it("query: items carry per-layer contributions[] (FTS+vector representable), no single-layer field", () => {
    const validate = compile("query.schema.json");
    const item = {
      command: "query",
      mode: "answered",
      query: "x",
      answer: "a",
      modelCalls: 1,
      items: [
        {
          noteId: "n1",
          score: 0.033,
          contributions: [
            { layer: "fts", rank: 2, weightedContribution: 0.0161 },
            { layer: "vector", rank: 1, weightedContribution: 0.0164 },
          ],
        },
      ],
      layersUsed: ["fts", "vector"],
      retrievalRunId: "rr-1",
    };
    expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
    // an item WITHOUT contributions[] is now invalid (single-layer provenance rejected)
    const noContrib = structuredClone(item);
    delete (noContrib.items[0] as Record<string, unknown>).contributions;
    expect(validate(noContrib)).toBe(false);
    // and the bundled examples all validate
    for (const ex of load("query.schema.json").examples) {
      expect(validate(ex), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  for (const name of ["index-status.schema.json", "index-verify.schema.json"]) {
    it(`${name}: declares the required terminal run.projection event and no longer prohibits a git-ref advance`, () => {
      const c = load(name)["x-atlas-contract"];
      expect(c.terminalAuditEvent).toBe("run.projection");
      expect((c.sideEffects as string[]).some((s) => s.includes("run.projection"))).toBe(true);
      expect((c.prohibitedEffects as string[]).some((s) => /git ref advanced/.test(s))).toBe(false);
    });
  }

  it("index verify: consistent MUST agree with divergences (all four combinations)", () => {
    const validate = compile("index-verify.schema.json");
    const mk = (consistent: boolean, divs: unknown[]) => ({
      command: "index verify",
      consistent,
      checked: 1,
      divergences: divs,
    });
    const oneDiv = [{ noteId: "n1", kind: "missing-chunks" }];
    // valid: true+empty, false+nonempty
    expect(validate(mk(true, [])), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(mk(false, oneDiv)), JSON.stringify(validate.errors)).toBe(true);
    // invalid: true+nonempty, false+empty
    expect(validate(mk(true, oneDiv))).toBe(false);
    expect(validate(mk(false, []))).toBe(false);
  });

  it("index repair: unresolved[].retryable MUST match its code (all combinations)", () => {
    const validate = compile("index-repair.schema.json");
    const mk = (code: string, retryable: boolean) => ({
      command: "index repair",
      outcome: "partial",
      repaired: [],
      unresolved: [{ noteId: "n1", code, retryable, message: "m" }],
    });
    // valid discriminant pairings
    expect(validate(mk("embedding-retryable", true)), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(mk("embedding-failed", false)), JSON.stringify(validate.errors)).toBe(true);
    // invalid: retryable flag contradicts the code
    expect(validate(mk("embedding-retryable", false))).toBe(false);
    expect(validate(mk("embedding-failed", true))).toBe(false);
    // outcome=partial still requires a non-empty unresolved[]
    expect(validate({ command: "index repair", outcome: "partial", repaired: [] })).toBe(false);
    // outcome=converged must NOT carry unresolved[]
    expect(
      validate({
        command: "index repair",
        outcome: "converged",
        repaired: [],
        unresolved: [{ noteId: "n1", code: "embedding-failed", retryable: false, message: "m" }],
      }),
    ).toBe(false);
    // the bundled examples all validate
    for (const ex of load("index-repair.schema.json").examples) {
      expect(validate(ex), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("retrieval contract: RRF weights/k + FTS fallback switch are config-owned (retrieval section)", () => {
    const rel = "docs/specs/retrieval-index-contract.md";
    const raw = readFileSync(join(root, rel), "utf8");
    const rc = JSON.parse(/```json\s+retrievalContract\s*\n([\s\S]*?)\n```/.exec(raw)![1]!);
    expect(rc.config.section).toBe("retrieval");
    expect(rc.config.keys["retrieval.rrf.k"]).toBeTruthy();
    expect(rc.config.keys["retrieval.fts.enabled"]).toBeTruthy();
    // the vector-only fallback requires a strictly-positive vector weight
    expect(rc.config.keys["retrieval.rrf.weights.vector"].boundsExclusiveMin).toBe(0);
    expect(rc.ftsFallback.switchKey).toBe("retrieval.fts.enabled");
    expect(rc.ftsFallback.vectorWeightMustBePositive).toBe(true);
    // activation carries the 4-arg Task 3.2 signature: the caller supplies the config
    // IDENTITY (configKey), and the STORE resolves + owns the fence epoch — never a
    // caller integer (round-3 findings 3 & 4). The correctness fence is content-hash
    // AND config-revision (both orders), and the epoch supports rollback.
    expect(rc.activation.callerSuppliesConfigIdentity).toBe(true);
    expect(rc.activation.callerSuppliesConfigRevision).toBe(false);
    expect(rc.activation.configRevisionOwner).toBe("sqlite-adoption-log");
    expect(rc.activation.supportsRollback).toBe(true);
    expect(rc.activation.correctnessFence).toBe("content_hash-unchanged AND config-revision-not-superseded");
    // candidate unit is the note, chunks fold to notes with per-layer provenance
    expect(rc.candidateUnit).toBe("note");
    expect(rc.chunkToNoteAggregation.tieBreaker).toBe("noteId");
  });
});

describe("Phase-4 cli-contract schema presence (Task 4.0)", () => {
  const phase4 = registry.commands.filter((c) => c.phase === 4);

  it("has Phase-4 rows", () => {
    expect(phase4.length).toBeGreaterThan(0);
  });

  it("every Phase-4 row has an existing schema file (independent of implementation status)", () => {
    // Contract-only gate (Task 4.0 acceptance): all Phase-4 registry rows have
    // schemas BEFORE any Phase-4 feature code merges. Presence is asserted
    // directly, NOT via the implemented flag (which stays false until a handler
    // lands in Tasks 4.3–4.11).
    for (const r of phase4) {
      expect(existsSync(join(root, r.schemaRef)), `${r.name} schema ${r.schemaRef}`).toBe(true);
    }
  });

  // NB: schema presence is asserted independently of the `implemented` flag (above).
  // We deliberately do NOT require Phase-4 rows to stay implemented:false — Tasks
  // 4.3–4.11 flip rows to implemented:true as handlers land, and the durable gate is
  // schema presence, not a temporal implementation-status assertion (which the first
  // Phase-4 handler would necessarily break). Matches the Phase-3 gate policy.

  it("the Phase-4 command set matches the plan Task 4.0 inventory", () => {
    expect(phase4.map((c) => c.name).sort()).toEqual(
      [
        "enrich",
        "evidence resolve",
        "evidence retry",
        "evidence review",
        "git approve",
        "git refresh",
        "git reject",
        "git review",
        "git rollback",
        "git verify",
        "maintain",
        "purge",
        "reconcile",
        "source trust promote",
        "source trust revoke",
        "validate",
      ].sort(),
    );
  });

  it("every Phase-4 schema is well-formed, compiles, and its x-atlas-contract matches the registry row", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const r of phase4) {
      const schema = JSON.parse(readFileSync(join(root, r.schemaRef), "utf8"));
      const c = schema["x-atlas-contract"];
      expect(c, `${r.name} x-atlas-contract`).toBeTruthy();
      // The command const, phase, privilege, and idempotency are the SSOT registry
      // row — the schema must not drift from commands.json.
      expect(schema.properties.command.const, `${r.name} command const`).toBe(r.name);
      expect(c.command, `${r.name} x-atlas command`).toBe(r.name);
      expect(c.phase, `${r.name} phase`).toBe(4);
      expect(c.privilege, `${r.name} privilege`).toBe(r.privilege);
      expect(c.idempotency, `${r.name} idempotency`).toBe(r.idempotency);
      // exit codes are a subset of the §2.5 set and always include usage(5)+internal(4)
      for (const code of c.exitCodes as number[]) {
        expect(EXIT_CODES.includes(code as (typeof EXIT_CODES)[number]), `${r.name} exit ${code}`).toBe(true);
      }
      expect(c.exitCodes).toContain(4);
      expect(c.exitCodes).toContain(5);
      expect(c.errorEnvelopeRef).toBe("docs/specs/cli-contract/error-envelope.schema.json");
      // the schema compiles and each bundled example validates against it
      const validate = ajv.compile(schema);
      for (const ex of schema.examples ?? []) {
        expect(validate(ex), `${r.name} example: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });

  it("every privileged Phase-4 command exposes the challenge/authorization flow and exit 6", () => {
    for (const r of phase4.filter((c) => c.privilege === "privileged")) {
      const c = JSON.parse(readFileSync(join(root, r.schemaRef), "utf8"))["x-atlas-contract"];
      const flagNames = (c.flags as { flag?: string; name?: string }[]).map((f) => f.flag ?? f.name);
      expect(flagNames.some((f) => f?.startsWith("--export-challenge")), `${r.name} --export-challenge`).toBe(true);
      expect(flagNames.some((f) => f?.startsWith("--authorization")), `${r.name} --authorization`).toBe(true);
      // action-required (exit 6) is reachable when no authorization is supplied
      expect(c.exitCodes, `${r.name} exit 6`).toContain(6);
      const codes = (c.errorCodes as { code: string; exit: number }[]);
      expect(codes.some((e) => e.exit === 6), `${r.name} has an exit-6 error code`).toBe(true);
    }
  });
});

describe("Phase-4 workflow-risk-contract (Task 4.0)", () => {
  const rel = "docs/specs/workflow-risk-contract.md";
  const raw = readFileSync(join(root, rel), "utf8");

  it("exists and is a text file with no C0 control bytes (byte-stable)", () => {
    expect(raw.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-control-regex
    const bad = /[\x00-\x08\x0B\x0C\x0E-\x1F]/.exec(raw);
    expect(bad, bad ? `control U+${bad[0].codePointAt(0)!.toString(16)}` : "").toBeNull();
  });

  it("defines the tier taxonomy (Tier-0..Tier-3), the mutation-policy table, and CAS/refresh semantics", () => {
    for (const tier of ["Tier-0", "Tier-1", "Tier-2", "Tier-3"]) {
      expect(raw.includes(tier), `mentions ${tier}`).toBe(true);
    }
    expect(raw).toMatch(/§mutation-policy/);
    expect(raw).toMatch(/§cas/);
    expect(raw).toMatch(/§refresh/);
    // sources immutable + decisions append-only are the load-bearing policy invariants
    expect(raw.toLowerCase()).toMatch(/sources are immutable/);
    expect(raw.toLowerCase()).toMatch(/decisions are append-only/);
    // it consumes, not restates, the numeric thresholds
    expect(raw).toMatch(/acceptance-thresholds\.md/);
  });

  const mutationPolicy = JSON.parse(
    /```json\s+mutationPolicy\s*\n([\s\S]*?)\n```/.exec(raw)![1]!,
  );

  it("the mutation-policy op set is EXACTLY CHANGE_PLAN_OPS (bijection, so 4.3 can generate every op×type)", () => {
    const declared = [...mutationPolicy.ops.map((o: { op: string }) => o.op)].sort();
    // no duplicate op rows
    expect(declared.length).toBe(new Set(declared).size);
    // equals the @atlas/contracts SSOT of op discriminants (15 active + 2 reserved)
    expect(declared).toEqual([...CHANGE_PLAN_OPS].sort());
    // and the invented ops the round-2 finding flagged are absent
    for (const bogus of ["AddFrontmatterField", "UpdateFrontmatterField", "AddLink", "RemoveLink"]) {
      expect(declared).not.toContain(bogus);
    }
  });

  it("every op maps every target type to a legal policy value", () => {
    const types = mutationPolicy.targetTypes as string[];
    const legal = new Set(mutationPolicy.policyValues as string[]);
    expect([...legal].sort()).toEqual(["append-only", "auto", "immutable", "reserved", "review"]);
    for (const row of mutationPolicy.ops as { op: string; policy: Record<string, string> }[]) {
      expect([...Object.keys(row.policy)].sort(), `${row.op} types`).toEqual([...types].sort());
      for (const ty of types) {
        expect(legal.has(row.policy[ty]!), `${row.op}.${ty}=${row.policy[ty]}`).toBe(true);
      }
    }
  });

  it("the load-bearing invariants hold: sources immutable (except trust), decisions never in-place-replace, reserved denied", () => {
    const byOp = new Map(
      (mutationPolicy.ops as { op: string; policy: Record<string, string> }[]).map((o) => [o.op, o.policy]),
    );
    // sources are immutable for every content op
    for (const op of ["CreateNote", "UpdateSection", "AppendSection", "SetFrontmatterField", "SetLink", "CreateClaim"]) {
      expect(byOp.get(op)!.source, `${op} on source`).toBe("immutable");
    }
    // trust ops are the sole source-touching ops (review), immutable elsewhere
    for (const op of ["PromoteTrust", "RevokeTrust"]) {
      expect(byOp.get(op)!.source, `${op} on source`).toBe("review");
      expect(byOp.get(op)!.concept, `${op} on concept`).toBe("immutable");
    }
    // reserved task ops are reserved for every target type
    for (const op of ["CreateTask", "UpdateTaskState"]) {
      for (const ty of mutationPolicy.targetTypes as string[]) {
        expect(byOp.get(op)![ty], `${op}.${ty}`).toBe("reserved");
      }
    }
    // decisions never accept a bare CreateNote as auto (review) and never in-place replace
    expect(byOp.get("CreateNote")!.decision).toBe("review");
    expect(byOp.get("UpdateSection")!.decision).toBe("append-only");
  });
});

describe("Phase-4 acceptance thresholds — literal comparison to the plan §2.5 constants (Task 4.0)", () => {
  // The §2.5 Tier-2 auto-commit constants, written as LITERALS here. This is the
  // anti-drift anchor: acceptance-thresholds.md §workflow AND the plan §2.5 line
  // must both equal these three values, so a change in any one file is caught.
  const SECTION_2_5_MIN_CONFIDENCE = 0.8;
  const SECTION_2_5_MAX_CHANGED_LINES = 50;
  const SECTION_2_5_MAX_SECTIONS = 3;

  const thresholdsRaw = readFileSync(join(root, "docs/specs/acceptance-thresholds.md"), "utf8");
  const planRaw = readFileSync(join(root, "docs/plans/atlas-v1-implementation-2026-07-12.md"), "utf8");

  it("acceptance-thresholds.md §workflow declares the machine-readable workflowThresholds block", () => {
    const block = /```json\s+workflowThresholds\s*\n([\s\S]*?)\n```/.exec(thresholdsRaw);
    expect(block, "workflowThresholds block").not.toBeNull();
    const t = JSON.parse(block![1]!);
    expect(t.tier2AutoCommit.minConfidence).toBe(SECTION_2_5_MIN_CONFIDENCE);
    expect(t.tier2AutoCommit.maxChangedLines).toBe(SECTION_2_5_MAX_CHANGED_LINES);
    expect(t.tier2AutoCommit.maxSections).toBe(SECTION_2_5_MAX_SECTIONS);
    expect(t.tier2AutoCommit.singleNote).toBe(true);
  });

  it("the §workflow prose states the thresholds verbatim (confidence ≥ 0.8, patch ≤ 50, ≤ 3 sections)", () => {
    expect(thresholdsRaw).toMatch(/confidence ≥ 0\.8/);
    expect(thresholdsRaw).toMatch(/patch ≤ 50 changed lines/);
    expect(thresholdsRaw).toMatch(/≤ 3 sections/);
  });

  it("the plan §2.5 line carries the SAME three constants (spec ⇄ plan cannot drift)", () => {
    // Extract from the plan's own §2.5 Tier-2 bullet, then assert equality to the
    // literals AND to the spec's machine-readable block.
    const line = /Tier-2 auto-commit thresholds:[\s\S]*?confidence ≥ ([\d.]+)[\s\S]*?patch ≤ (\d+) changed lines across ≤ (\d+) sections/.exec(
      planRaw,
    );
    expect(line, "plan §2.5 Tier-2 threshold line").not.toBeNull();
    const [planConfidence, planLines, planSections] = [
      Number(line![1]),
      Number(line![2]),
      Number(line![3]),
    ];
    expect(planConfidence).toBe(SECTION_2_5_MIN_CONFIDENCE);
    expect(planLines).toBe(SECTION_2_5_MAX_CHANGED_LINES);
    expect(planSections).toBe(SECTION_2_5_MAX_SECTIONS);

    // And the spec's block equals the plan's numbers — the actual drift guard.
    const t = JSON.parse(
      /```json\s+workflowThresholds\s*\n([\s\S]*?)\n```/.exec(thresholdsRaw)![1]!,
    ).tier2AutoCommit;
    expect(t.minConfidence).toBe(planConfidence);
    expect(t.maxChangedLines).toBe(planLines);
    expect(t.maxSections).toBe(planSections);
  });

  it("the configKeys are the ACTUAL policies keys and their config defaults EQUAL the §2.5 constants", () => {
    // The contract's declared config keys must be the real `policies` schema keys
    // (round-2 finding: nonexistent nested keys), and the config DEFAULTS must equal
    // the same three constants — so plan ⇄ spec ⇄ config can never drift.
    const t = JSON.parse(
      /```json\s+workflowThresholds\s*\n([\s\S]*?)\n```/.exec(thresholdsRaw)![1]!,
    );
    expect(t.configKeys).toEqual({
      minConfidence: "policies.tier2_min_confidence",
      maxChangedLines: "policies.tier2_max_changed_lines",
      maxSections: "policies.tier2_max_sections",
    });
    const configSrc = readFileSync(join(root, "apps/cli/src/config/schema.ts"), "utf8");
    const defaultOf = (key: string) => {
      const m = new RegExp(`${key}:[^\\n]*\\.default\\(([\\d.]+)\\)`).exec(configSrc);
      expect(m, `config default for ${key}`).not.toBeNull();
      return Number(m![1]);
    };
    expect(defaultOf("tier2_min_confidence")).toBe(SECTION_2_5_MIN_CONFIDENCE);
    expect(defaultOf("tier2_max_changed_lines")).toBe(SECTION_2_5_MAX_CHANGED_LINES);
    expect(defaultOf("tier2_max_sections")).toBe(SECTION_2_5_MAX_SECTIONS);
  });

  it("models TWO independently-typed confidence inputs, min-reduced, fail-closed", () => {
    const t = JSON.parse(
      /```json\s+workflowThresholds\s*\n([\s\S]*?)\n```/.exec(thresholdsRaw)![1]!,
    ).tier2AutoCommit;
    const ci = t.confidenceInputs;
    expect(ci, "confidenceInputs block").toBeTruthy();
    // both a model and a validation confidence, each gated at the same minConfidence
    expect(ci.model.min).toBe(SECTION_2_5_MIN_CONFIDENCE);
    expect(ci.validation.min).toBe(SECTION_2_5_MIN_CONFIDENCE);
    // reduced by minimum and fail-closed on missing/malformed/conflicting
    expect(ci.reduction).toBe("min");
    expect(ci.failClosed).toBe(true);
    expect([...ci.failClosedOn].sort()).toEqual(["conflicting", "malformed", "missing"]);
    // prose names both confidences
    expect(thresholdsRaw).toMatch(/modelConfidence/);
    expect(thresholdsRaw).toMatch(/validationConfidence/);
  });
});

describe("Phase-4 privileged schemas ⇄ broker authzContract (per-command exits, SSOT)", () => {
  const schemaDir = "docs/specs/cli-contract";
  const load = (name: string) => JSON.parse(readFileSync(join(root, schemaDir, name), "utf8"));
  const catalogExit = new Map(authzContract.errorCatalog.map((e) => [e.code, e.exitCode]));
  const opByName = new Map(authzContract.privilegedOps.map((o) => [o.op, o]));
  const privileged = registry.commands.filter((c) => c.phase === 4 && c.privilege === "privileged");

  it("has the five privileged Phase-4 commands", () => {
    // `git refresh` is SHARED (non-privileged) as of Task 4.11 — it only regenerates a
    // review-pending proposal's agent branch (no canonical/trust/erase mutation), so it
    // carries no OS-presence challenge/authorization flow.
    expect(privileged.map((c) => c.name).sort()).toEqual(
      ["git approve", "git rollback", "purge", "source trust promote", "source trust revoke"].sort(),
    );
  });

  for (const r of registry.commands.filter((c) => c.phase === 4 && c.privilege === "privileged")) {
    it(`${r.name}: authz.driftCodes match the §7.5 op verbatim, each surfaced with the broker's catalog exit`, () => {
      const c = load(r.name.replace(/ /g, "-") + ".schema.json")["x-atlas-contract"];
      const authz = c.authz as {
        op: string;
        mechanism: string;
        challengeFields: string[];
        driftCodes: string[];
        universalCodes: string[];
      };
      expect(authz, `${r.name} authz block`).toBeTruthy();
      // canonical op name with SPACES (not dotted) and present in the §7.5 SSOT
      expect(authz.op).toBe(r.name);
      expect(authz.op).not.toMatch(/\./);
      const ssot = opByName.get(authz.op);
      expect(ssot, `authzContract op ${authz.op}`).toBeTruthy();
      // challengeFields equal the broker contract's §7.5 challengeFields for this op (verbatim)
      expect(authz.challengeFields, `${r.name} authz.challengeFields`).toBeTruthy();
      expect([...authz.challengeFields].sort()).toEqual([...ssot!.challengeFields].sort());
      // driftCodes equal the broker contract's driftCodes for this op (verbatim, no drift)
      expect([...authz.driftCodes].sort()).toEqual([...ssot!.driftCodes].sort());
      // every driftCode is surfaced in the schema errorCodes with the STABLE catalog exit
      const errByCode = new Map(
        (c.errorCodes as { code: string; exit: number }[]).map((e) => [e.code, e.exit]),
      );
      for (const code of authz.driftCodes) {
        expect(errByCode.has(code), `${r.name} errorCodes missing ${code}`).toBe(true);
        expect(errByCode.get(code), `${r.name} ${code} exit`).toBe(catalogExit.get(code));
      }
      // the schema never flattens broker auth into a single authorization-invalid exit-2 code
      expect(errByCode.has("authorization-invalid"), `${r.name} still flattens to authorization-invalid`).toBe(false);
      // drift/expiry stay exit 6; signature/signer/replay/payload stay exit 1 (spot-check)
      expect(errByCode.get("authz.signature_invalid")).toBe(1);
      // PRIOR-ROUND REQUIREMENT: the complete applicable broker error catalog is surfaced,
      // not only the op-specific driftCodes. The two UNIVERSAL broker validation failures
      // (schema_invalid, canonicalization_unsupported) apply to every signed op and are
      // exit 1 per acceptance-thresholds.md / security-broker-contract.md §7.3.
      const UNIVERSAL = ["authz.canonicalization_unsupported", "authz.schema_invalid"];
      expect([...authz.universalCodes].sort(), `${r.name} authz.universalCodes`).toEqual(UNIVERSAL);
      for (const code of authz.universalCodes) {
        // each universal code is a real catalog member, mapped to its STABLE catalog exit (1)
        expect(catalogExit.has(code), `${code} in errorCatalog`).toBe(true);
        expect(catalogExit.get(code), `${code} catalog exit`).toBe(1);
        expect(errByCode.has(code), `${r.name} errorCodes missing universal ${code}`).toBe(true);
        expect(errByCode.get(code), `${r.name} ${code} exit`).toBe(catalogExit.get(code));
      }
      // driftCodes and universalCodes are disjoint (universal codes are NOT op-specific drift)
      for (const code of authz.universalCodes) {
        expect(authz.driftCodes.includes(code), `${r.name} ${code} must not be a driftCode`).toBe(false);
      }
    });
  }

  it("no privileged schema uses a dotted op name (git.approve / source.trust.promote) anywhere", () => {
    for (const r of privileged) {
      const raw = readFileSync(join(root, schemaDir, r.name.replace(/ /g, "-") + ".schema.json"), "utf8");
      expect(raw, `${r.name} dotted op`).not.toMatch(/op (git|source)\.[a-z.]+/);
    }
  });
});

describe("Phase-4 mandatory completion postconditions (const true, not optional)", () => {
  const load = (name: string) =>
    JSON.parse(readFileSync(join(root, "docs/specs/cli-contract", name), "utf8"));

  it("git approve.reindexed, git rollback.reconciled, purge.verified(on applied) are const true", () => {
    expect(load("git-approve.schema.json").properties.reindexed.const).toBe(true);
    expect(load("git-rollback.schema.json").properties.reconciled.const).toBe(true);
    // purge verified is const true under the mode=applied conditional
    const purge = load("purge.schema.json");
    const appliedBranch = purge.allOf.find(
      (a: { if: { properties: { mode: { const: string } } } }) => a.if.properties.mode.const === "applied",
    );
    expect(appliedBranch.then.properties.verified.const).toBe(true);
  });
});

describe("Phase-4 key-accepting commands expose --idempotency-key + request-hash scope", () => {
  const load = (name: string) =>
    JSON.parse(readFileSync(join(root, "docs/specs/cli-contract", name), "utf8"))["x-atlas-contract"];
  const keyAccepting = registry.commands.filter((c) => c.phase === 4 && c.idempotency === "key-accepting");

  for (const r of registry.commands.filter((c) => c.phase === 4 && c.idempotency === "key-accepting")) {
    it(`${r.name}: has --idempotency-key and a non-empty requestHashScope`, () => {
      const c = load(r.name.replace(/ /g, "-") + ".schema.json");
      const flagNames = (c.flags as { flag?: string; name?: string }[]).map((f) => f.flag ?? f.name);
      expect(flagNames.some((f) => f?.startsWith("--idempotency-key")), `${r.name} --idempotency-key`).toBe(true);
      expect(Array.isArray(c.requestHashScope) && c.requestHashScope.length, `${r.name} requestHashScope`).toBeGreaterThan(0);
      expect(c.requestHashScope).toContain("idempotencyKey");
    });
  }

  it("git refresh's request-hash scope is (runId, superseded commit, current canonical base)", () => {
    const c = load("git-refresh.schema.json");
    for (const field of ["runId", "superseded", "baseCommit"]) {
      expect(c.requestHashScope, `git refresh scope ${field}`).toContain(field);
    }
  });

  it("covers the nine registry-classified key-accepting Phase-4 commands", () => {
    expect(keyAccepting.map((c) => c.name).sort()).toEqual(
      [
        "enrich",
        "git approve",
        "git refresh",
        "git rollback",
        "maintain",
        "purge",
        "reconcile",
        "source trust promote",
        "source trust revoke",
      ].sort(),
    );
  });
});

describe("Phase-4 recovery-state-machine alignment (reject retains, rollback is a distinct run)", () => {
  const load = (name: string) =>
    JSON.parse(readFileSync(join(root, "docs/specs/cli-contract", name), "utf8"));

  it("git reject RETAINS the agent commit for audit (does not delete the branch)", () => {
    const s = load("git-reject.schema.json");
    expect(s.required).toContain("retainedCommit");
    expect(s.required).not.toContain("cleaned");
    // prose no longer claims it removes the agent branch
    const c = s["x-atlas-contract"];
    expect((c.sideEffects as string[]).some((x) => /removes.*agent branch/i.test(x))).toBe(false);
    expect((c.prohibitedEffects as string[]).some((x) => /never deletes the agent-branch commit/i.test(x))).toBe(true);
  });

  it("git rollback carries a distinct rollback-run identity + rollbackOf; original stays finalized", () => {
    const s = load("git-rollback.schema.json");
    expect(s.required).toEqual(expect.arrayContaining(["rollbackRunId", "rollbackOf"]));
    expect(s.description).toMatch(/stays `finalized`/);
  });
});

describe("Phase-4 confidence inputs are two independently-typed fields (no single `confidence`)", () => {
  const load = (name: string) =>
    JSON.parse(readFileSync(join(root, "docs/specs/cli-contract", name), "utf8"));
  const mutationSchemas = ["enrich.schema.json", "reconcile.schema.json", "maintain.schema.json"];

  for (const file of mutationSchemas) {
    it(`${file}: exposes modelConfidence + validationConfidence and no single confidence`, () => {
      const s = load(file);
      expect(s.properties.modelConfidence?.type).toBe("number");
      expect(s.properties.validationConfidence?.type).toBe("number");
      // the collapsed single-field `confidence` is gone
      expect(s.properties.confidence, `${file} still exposes a single confidence`).toBeUndefined();
      // a Tier-2 APPLIED result requires BOTH inputs (neither can be absent)
      const branch = (s.allOf as any[]).find(
        (a) => a.if?.properties?.mode?.const === "applied" && a.if?.properties?.risk?.const === "tier-2",
      );
      expect(branch, `${file} tier-2 applied conditional`).toBeTruthy();
      expect(branch.then.required).toEqual(expect.arrayContaining(["modelConfidence", "validationConfidence"]));
    });
  }

  it("validate.schema.json ValidationReport exposes BOTH typed confidences (not only tier2Eligible)", () => {
    const gates = load("validate.schema.json").properties.gates;
    expect(gates.required).toEqual(
      expect.arrayContaining(["tier2Eligible", "modelConfidence", "validationConfidence"]),
    );
    expect(gates.properties.modelConfidence.type).toBe("number");
    expect(gates.properties.validationConfidence.type).toBe("number");
  });
});

describe("Phase-4 discriminated outcomes (evidence resolve, purge)", () => {
  const load = (name: string) =>
    JSON.parse(readFileSync(join(root, "docs/specs/cli-contract", name), "utf8"));

  it("evidence resolve: integrated requires integratedCommit; pending/failed forbid it and pending exits 6", () => {
    const s = load("evidence-resolve.schema.json");
    expect(s.properties.outcome.enum.sort()).toEqual(["failed", "integrated", "review_pending"]);
    const branchFor = (outcome: string) =>
      (s.allOf as any[]).find((a) => a.if?.properties?.outcome?.const === outcome);
    // integrated ⇒ requires the canonical commit + full superseding head
    expect(branchFor("integrated").then.required).toEqual(
      expect.arrayContaining(["evidenceId", "integratedCommit"]),
    );
    // pending/failed ⇒ integratedCommit is forbidden (never auto-integrates)
    expect(branchFor("review_pending").then.properties.integratedCommit).toBe(false);
    expect(branchFor("failed").then.properties.integratedCommit).toBe(false);
    // exit 6 surfaced for the pending escalation
    const exits = s["x-atlas-contract"].exitCodes as number[];
    expect(exits).toContain(6);
    const reviewPending = (s["x-atlas-contract"].errorCodes as any[]).find((e) => e.code === "review-pending");
    expect(reviewPending?.exit).toBe(6);
  });

  it("purge: erasureClass discriminates ordinary (no ref rewrite) vs history-rewrite (oldHead+replacementHead)", () => {
    const s = load("purge.schema.json");
    expect(s.properties.erasureClass.enum.sort()).toEqual(["history-rewrite", "ordinary"]);
    const branchFor = (cls: string) =>
      (s.allOf as any[]).find((a) => a.if?.properties?.erasureClass?.const === cls);
    // ordinary ⇒ refReplaced false, challengeBinding must NOT carry oldHead/replacementHead
    expect(branchFor("ordinary").then.properties.refReplaced.const).toBe(false);
    expect(branchFor("ordinary").then.properties.challengeBinding.not).toBeTruthy();
    // history-rewrite ⇒ refReplaced true, challengeBinding requires oldHead + replacementHead
    expect(branchFor("history-rewrite").then.properties.refReplaced.const).toBe(true);
    expect(branchFor("history-rewrite").then.properties.challengeBinding.required).toEqual(
      expect.arrayContaining(["oldHead", "replacementHead"]),
    );
    // the base challengeBinding no longer unconditionally requires oldHead/replacementHead
    const cb = s.properties.challengeBinding;
    expect(cb.required).not.toContain("oldHead");
    expect(cb.required).not.toContain("replacementHead");
  });
});

describe("Phase-5 cli-contract schema presence (Task 5.0)", () => {
  const phase5 = registry.commands.filter((c) => c.phase === 5);

  it("has Phase-5 rows", () => {
    expect(phase5.length).toBeGreaterThan(0);
  });

  it("every Phase-5 row has an existing schema file (independent of implementation status)", () => {
    // Contract-only gate (Task 5.0 acceptance): all Phase-5 registry rows have
    // schemas BEFORE any Phase-5 feature code merges. Presence is asserted
    // directly, NOT via the implemented flag (which stays false until a handler
    // lands in Tasks 5.1–5.3). Matches the Phase-3/4 gate policy.
    for (const r of phase5) {
      expect(existsSync(join(root, r.schemaRef)), `${r.name} schema ${r.schemaRef}`).toBe(true);
    }
  });

  // NB: schema presence is asserted independently of the `implemented` flag (above).
  // We deliberately do NOT require Phase-5 rows to stay implemented:false — Task 3
  // flips `index eval` to implemented:true once its handler lands, and the durable
  // gate is schema presence, not a temporal implementation-status assertion (which
  // that handler would necessarily break). Matches the Phase-2/3/4 gate policy above.
  it("the delivered Task-5.0 graduation/quarantine commands are implemented:true with their schemas present", () => {
    const delivered = [
      "graduation audit",
      "graduation migrate",
      "graduation scan",
      "quarantine inspect",
      "quarantine resolve",
    ];
    const rows = phase5.filter((r) => delivered.includes(r.name));
    expect(rows.map((r) => r.name).sort()).toEqual([...delivered].sort());
    for (const r of rows) {
      expect(r.implemented, `${r.name} implemented`).toBe(true);
      expect(existsSync(join(root, r.schemaRef)), `${r.name} schema ${r.schemaRef}`).toBe(true);
    }
  });

  it("the Phase-5 command set matches the delivered inventory (Task 5.0 + index eval)", () => {
    expect(phase5.map((c) => c.name).sort()).toEqual(
      [
        "graduation audit",
        "graduation migrate",
        "graduation scan",
        "index eval",
        "quarantine inspect",
        "quarantine resolve",
      ].sort(),
    );
  });

  it("every Phase-5 schema is well-formed, compiles, and its x-atlas-contract matches the registry row", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const r of phase5) {
      const schema = JSON.parse(readFileSync(join(root, r.schemaRef), "utf8"));
      const c = schema["x-atlas-contract"];
      expect(c, `${r.name} x-atlas-contract`).toBeTruthy();
      // The command const, phase, privilege, and idempotency are the SSOT registry
      // row — the schema must not drift from commands.json.
      expect(schema.properties.command.const, `${r.name} command const`).toBe(r.name);
      expect(c.command, `${r.name} x-atlas command`).toBe(r.name);
      expect(c.phase, `${r.name} phase`).toBe(5);
      expect(c.privilege, `${r.name} privilege`).toBe(r.privilege);
      expect(c.idempotency, `${r.name} idempotency`).toBe(r.idempotency);
      // exit codes are a subset of the §2.5 set and always include usage(5)+internal(4)
      for (const code of c.exitCodes as number[]) {
        expect(EXIT_CODES.includes(code as (typeof EXIT_CODES)[number]), `${r.name} exit ${code}`).toBe(true);
      }
      expect(c.exitCodes).toContain(4);
      expect(c.exitCodes).toContain(5);
      expect(c.errorEnvelopeRef).toBe("docs/specs/cli-contract/error-envelope.schema.json");
      // the schema compiles and each bundled example validates against it
      const validate = ajv.compile(schema);
      for (const ex of schema.examples ?? []) {
        expect(validate(ex), `${r.name} example: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });

  it("every privileged Phase-5 command exposes the challenge/authorization flow and exit 6", () => {
    for (const r of phase5.filter((c) => c.privilege === "privileged")) {
      const c = JSON.parse(readFileSync(join(root, r.schemaRef), "utf8"))["x-atlas-contract"];
      const flagNames = (c.flags as { flag?: string; name?: string }[]).map((f) => f.flag ?? f.name);
      expect(flagNames.some((f) => f?.startsWith("--export-challenge")), `${r.name} --export-challenge`).toBe(true);
      expect(flagNames.some((f) => f?.startsWith("--authorization")), `${r.name} --authorization`).toBe(true);
      expect(c.exitCodes, `${r.name} exit 6`).toContain(6);
      const codes = c.errorCodes as { code: string; exit: number }[];
      expect(codes.some((e) => e.exit === 6), `${r.name} has an exit-6 error code`).toBe(true);
    }
  });
});

describe("Phase-5 privileged schemas ⇄ broker authzContract (per-command exits, SSOT)", () => {
  const schemaDir = "docs/specs/cli-contract";
  const load = (name: string) => JSON.parse(readFileSync(join(root, schemaDir, name), "utf8"));
  const catalogExit = new Map(authzContract.errorCatalog.map((e) => [e.code, e.exitCode]));
  const opByName = new Map(authzContract.privilegedOps.map((o) => [o.op, o]));
  const privileged = registry.commands.filter((c) => c.phase === 5 && c.privilege === "privileged");

  it("has the three privileged Phase-5 commands", () => {
    expect(privileged.map((c) => c.name).sort()).toEqual(
      ["graduation migrate", "quarantine inspect", "quarantine resolve"].sort(),
    );
  });

  for (const r of registry.commands.filter((c) => c.phase === 5 && c.privilege === "privileged")) {
    it(`${r.name}: authz.driftCodes match the §7.5 op verbatim, each surfaced with the broker's catalog exit`, () => {
      const c = load(r.name.replace(/ /g, "-") + ".schema.json")["x-atlas-contract"];
      const authz = c.authz as {
        op: string;
        mechanism: string;
        challengeFields: string[];
        driftCodes: string[];
        universalCodes?: string[];
      };
      expect(authz, `${r.name} authz block`).toBeTruthy();
      // canonical op name with SPACES (not dotted) and present in the §7.5 SSOT
      expect(authz.op).toBe(r.name);
      expect(authz.op).not.toMatch(/\./);
      const ssot = opByName.get(authz.op);
      expect(ssot, `authzContract op ${authz.op}`).toBeTruthy();
      // mechanism + challengeFields equal the broker contract's §7.5 for this op (verbatim)
      expect(authz.mechanism, `${r.name} authz.mechanism`).toBe(ssot!.mechanism);
      expect([...authz.challengeFields].sort()).toEqual([...ssot!.challengeFields].sort());
      // driftCodes equal the broker contract's driftCodes for this op (verbatim, no drift)
      expect([...authz.driftCodes].sort()).toEqual([...ssot!.driftCodes].sort());
      // every driftCode is surfaced in the schema errorCodes with the STABLE catalog exit
      const errByCode = new Map(
        (c.errorCodes as { code: string; exit: number }[]).map((e) => [e.code, e.exit]),
      );
      for (const code of authz.driftCodes) {
        expect(errByCode.has(code), `${r.name} errorCodes missing ${code}`).toBe(true);
        expect(errByCode.get(code), `${r.name} ${code} exit`).toBe(catalogExit.get(code));
      }
      // the schema never flattens broker auth into a single authorization-invalid exit-2 code
      expect(errByCode.has("authorization-invalid"), `${r.name} still flattens to authorization-invalid`).toBe(false);
      // any declared universalCodes are real catalog members surfaced with their stable exit (1)
      for (const code of authz.universalCodes ?? []) {
        expect(catalogExit.has(code), `${code} in errorCatalog`).toBe(true);
        expect(catalogExit.get(code), `${code} catalog exit`).toBe(1);
        expect(errByCode.get(code), `${r.name} ${code} exit`).toBe(catalogExit.get(code));
        expect(authz.driftCodes.includes(code), `${r.name} ${code} must not be a driftCode`).toBe(false);
      }
    });
  }
});

describe("Phase-5 acceptance thresholds — literal comparison to the plan §2.5 constants (Task 5.0)", () => {
  // The §2.5 retrieval-eval constants, written as LITERALS here. This is the
  // anti-drift anchor: acceptance-thresholds.md §retrieval AND the plan §2.5 line
  // must both equal these two values, so a change in either file is caught
  // (mirrors the §workflow anti-drift test #44 added).
  const SECTION_2_5_RECALL_AT_10 = 0.85;
  const SECTION_2_5_MRR = 0.7;

  const thresholdsRaw = readFileSync(join(root, "docs/specs/acceptance-thresholds.md"), "utf8");
  const planRaw = readFileSync(join(root, "docs/plans/atlas-v1-implementation-2026-07-12.md"), "utf8");

  it("acceptance-thresholds.md §retrieval declares the machine-readable retrievalThresholds block", () => {
    const block = /```json\s+retrievalThresholds\s*\n([\s\S]*?)\n```/.exec(thresholdsRaw);
    expect(block, "retrievalThresholds block").not.toBeNull();
    const t = JSON.parse(block![1]!);
    expect(t.eval.recallAt10.min).toBe(SECTION_2_5_RECALL_AT_10);
    expect(t.eval.recallAt10.at).toBe(10);
    expect(t.eval.mrr.min).toBe(SECTION_2_5_MRR);
    expect(t.eval.gates).toBe("graduation");
  });

  it("the §retrieval prose states the thresholds verbatim (recall@10 ≥ 0.85, MRR ≥ 0.7)", () => {
    expect(thresholdsRaw).toMatch(/recall@10 ≥ 0\.85/);
    expect(thresholdsRaw).toMatch(/MRR ≥ 0\.7/);
  });

  it("the plan §2.5 line carries the SAME two constants (spec ⇄ plan cannot drift)", () => {
    const line = /Retrieval eval:\s*\*\*recall@10 ≥ ([\d.]+),\s*MRR ≥ ([\d.]+)\*\*/.exec(planRaw);
    expect(line, "plan §2.5 retrieval-eval line").not.toBeNull();
    const [planRecall, planMrr] = [Number(line![1]), Number(line![2])];
    expect(planRecall).toBe(SECTION_2_5_RECALL_AT_10);
    expect(planMrr).toBe(SECTION_2_5_MRR);

    // And the spec's block equals the plan's numbers — the actual drift guard.
    const t = JSON.parse(
      /```json\s+retrievalThresholds\s*\n([\s\S]*?)\n```/.exec(thresholdsRaw)![1]!,
    ).eval;
    expect(t.recallAt10.min).toBe(planRecall);
    expect(t.mrr.min).toBe(planMrr);
  });

  it("§scale declares both vault profiles and the scaleThresholds block (dimensions from §2.5)", () => {
    const block = /```json\s+scaleThresholds\s*\n([\s\S]*?)\n```/.exec(thresholdsRaw);
    expect(block, "scaleThresholds block").not.toBeNull();
    const s = JSON.parse(block![1]!);
    expect(s.profiles.representative.notes).toBeGreaterThan(0);
    expect(s.profiles.maximum.notes).toBeGreaterThan(s.profiles.representative.notes);
    // the §2.5 threshold dimensions are all represented (latency/throughput/memory/disk/recovery)
    expect(Object.keys(s.operations).length).toBeGreaterThan(0);
    expect(s.resources.peakRssBytes).toBeTruthy();
    expect(s.resources.diskFootprintCorpusMultiple).toBeTruthy();
    expect(s.resources.crashRecoveryMs).toBeTruthy();
  });
});

describe("Phase-5 bootstrap-migration executable fixtures (Task 5.0 — the contract for 5.3)", () => {
  const fixturesRel = "docs/specs/fixtures/bootstrap-migration";
  const manifest = JSON.parse(readFileSync(join(root, fixturesRel, "manifest.json"), "utf8"));

  // Slug + id derivation mirroring bootstrap-migration.md §2.1/§2 — the fixtures
  // must be derivable from these rules (so they cannot drift from the contract).
  const slug = (title: string): string =>
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "note";

  it("the manifest is versioned, sorted by id, and pins the supported schema_version", () => {
    expect(manifest.version).toBeGreaterThanOrEqual(1);
    expect(manifest.supportedSchemaVersion).toBe(1);
    const ids = (manifest.cases as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids.length).toBeGreaterThan(0);
  });

  for (const c of manifest.cases as { id: string; input: string; expected: string }[]) {
    describe(c.id, () => {
      it("input dir and expected.json exist and expected.json parses", () => {
        expect(existsSync(join(root, fixturesRel, c.input)), `${c.id} input`).toBe(true);
        expect(existsSync(join(root, fixturesRel, c.expected)), `${c.id} expected`).toBe(true);
        expect(() => JSON.parse(readFileSync(join(root, fixturesRel, c.expected), "utf8"))).not.toThrow();
      });
    });
  }

  const expectedOf = (id: string) => {
    const c = (manifest.cases as { id: string; expected: string }[]).find((x) => x.id === id)!;
    return JSON.parse(readFileSync(join(root, fixturesRel, c.expected), "utf8"));
  };

  it("basic: every migrated note's id is <type>-<slug(title)> and schema_version is initialized to 1", () => {
    const exp = expectedOf("basic");
    // Concepts/Atlas.md → concept-atlas ; People/Koral.md → person-koral (folder-inferred type + slug)
    expect(exp.migrate.idMap["Concepts/Atlas.md"]).toBe(`concept-${slug("Atlas")}`);
    expect(exp.migrate.idMap["People/Koral.md"]).toBe(`person-${slug("Koral")}`);
    for (const n of exp.migrate.notes) {
      expect(n.schemaVersion, `${n.path} schema_version`).toBe(1);
      expect(n.newId, `${n.path} id`).toBe(`${n.type.value}-${slug(n.newId.slice(n.type.value.length + 1))}`);
    }
    // the unresolved wikilink is FLATTENED to display text (Task 3, #151) — nothing survives as a link
    const atlas = exp.migrate.notes.find((n: { path: string }) => n.path === "Concepts/Atlas.md");
    const flattened = atlas.linkRewrites.find((l: { resolution: string }) => l.resolution === "flattened-unresolved");
    expect(flattened, "the unresolved link is flattened").toBeTruthy();
    expect(flattened.to.includes("[["), "flattened link left as plain display text").toBe(false);
    // the ORIGINAL vault's broken link is still inventoried by the audit (audit reads the pre-migration tree)
    expect(exp.audit.categories["incompatible-link"]).toContain("Concepts/Atlas.md");
  });

  it("collision: distinct derived-id clash → deterministic numeric suffix; duplicate EXPLICIT id → disambiguated (never quarantined)", () => {
    const exp = expectedOf("collision");
    const suffixed = exp.migrate.notes.find((n: { collision?: unknown }) => n.collision);
    expect(suffixed.collision.rule).toBe("numeric-suffix-by-sorted-path");
    expect(suffixed.collision.disambiguatedTo).toBe(`${suffixed.collision.derivedId}-2`);
    expect(suffixed.newId).toBe(suffixed.collision.disambiguatedTo);
    // duplicate EXPLICIT ids are numeric-suffix-disambiguated (Task 3, #151), never quarantined
    expect(exp.migrate.quarantined.filter((q: { category: string }) => q.category === "duplicate-identity")).toEqual([]);
    const explicitIds = exp.migrate.notes
      .filter((n: { oldId: string | null }) => n.oldId === "shared-x")
      .map((n: { newId: string }) => n.newId)
      .sort();
    expect(explicitIds).toEqual(["shared-x", "shared-x-2"]); // both migrate, distinct ids
    // the ORIGINAL vault's duplicate ids are still inventoried by the audit (audit reads the pre-migration tree)
    expect(exp.audit.categories["duplicate-identity"].sort()).toEqual(["ExplicitA.md", "ExplicitB.md"]);
  });

  it("guards (#151 open type gate): an unsupported schema_version is COERCED (never refused); an unknown/malformed type MIGRATES as-is; unknown frontmatter is preserved", () => {
    const exp = expectedOf("guards");
    // The type/schema-version refusal categories no longer occur — planBootstrapMigration is total.
    expect(exp.migrate.refused ?? []).toEqual([]);
    const byPath = new Map(exp.migrate.notes.map((n: { path: string }) => [n.path, n]));
    // FromFuture.md asserted schema_version: 99 — coerced to SCHEMA_VERSION, migrated (not refused).
    const future = byPath.get("FromFuture.md") as { schemaVersion: number; initializedFrontmatter: { schema_version: number } } | undefined;
    expect(future, "FromFuture.md migrates").toBeTruthy();
    expect(future!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(future!.initializedFrontmatter.schema_version).toBe(SCHEMA_VERSION);
    // Alien.md (`type: alien`) and MalformedType.md (`type: 42`) are open-registry types — kept as
    // asserted (resolver-normalized), never refused (bootstrap-migration.md §3, #151).
    const alien = byPath.get("Alien.md") as { type: { value: string } } | undefined;
    expect(alien, "Alien.md migrates").toBeTruthy();
    expect(alien!.type.value).toBe("alien");
    const malformed = byPath.get("MalformedType.md") as { type: { value: string } } | undefined;
    expect(malformed, "MalformedType.md migrates").toBeTruthy();
    expect(malformed!.type.value).toBe("42");
    // Open registry: neither is unknown-type in the audit inventory either (any non-empty type is known).
    expect(exp.audit.categories["unknown-type"]).toEqual([]);
    const preserved = exp.migrate.notes.find((n: { preservedFrontmatter?: string[] }) => n.preservedFrontmatter);
    expect(preserved.preservedFrontmatter).toEqual(expect.arrayContaining(["custom_field", "source_url", "tags"]));
  });

  it("graduation-migrate.schema.json's notes[].type.value is OPEN (#151): a fixture note with an unregistered type (e.g. `podcast`) validates", () => {
    const schema = JSON.parse(readFileSync(join(root, "docs/specs/cli-contract", "graduation-migrate.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const instance = {
      command: "graduation migrate",
      mode: "preview",
      migrationRunId: "01J9ZBOOTSTRAPPODCAST00000",
      notes: [
        {
          path: "x/Podcast.md",
          oldId: null,
          newId: "podcast-ep1",
          type: { value: "podcast", source: "frontmatter" },
          schemaVersion: 1,
          status: "migrated",
          linkRewrites: [],
        },
      ],
      quarantined: [],
      refused: [],
      idMap: { "x/Podcast.md": "podcast-ep1" },
    };
    const ok = validate(instance);
    expect(ok, ajv.errorsText(validate.errors)).toBe(true);
  });

  it("idempotent: a checkpoint resume skips migrated notes, re-applies nothing, and yields the same id map", () => {
    const exp = expectedOf("idempotent");
    expect(exp.resume.reapplied).toEqual([]);
    expect(exp.resume.skipped.length).toBeGreaterThan(0);
    for (const p of exp.resume.skipped) {
      expect(exp.resume.finalStatuses[p]).toBe("migrated");
      expect(exp.resume.idMap[p]).toBeTruthy();
    }
    const pre = new Map(exp.resume.preCheckpoint.map((n: { path: string; newId: string }) => [n.path, n.newId]));
    for (const [p, id] of Object.entries(exp.resume.idMap)) expect(pre.get(p)).toBe(id);
  });

  it("crash-window: resume skips the verified-migrated note and APPLIES the still-legacy pending note", () => {
    const exp = expectedOf("crash-window");
    // the pending note's on-disk bytes still equal its recorded preImage (mutation never applied)
    expect(exp.resume.rerunMode).toBe("applied");
    expect(exp.resume.skipped).toEqual(["Done.md"]);
    expect(exp.resume.applied).toEqual(["Pending.md"]); // never skipped just because the checkpoint names it
    expect(exp.resume.reapplied).toEqual([]);
    expect(exp.resume.verifiedPostImage["Done.md"]).toBe(true);
    expect(exp.resume.verifiedPreImage["Pending.md"]).toBe(true);
    expect(exp.resume.finalStatuses["Pending.md"]).toBe("migrated");
    // the recorded pre/post sha256 are present so the verification is real, not asserted
    const pending = exp.resume.preCheckpoint.find((n: { path: string }) => n.path === "Pending.md");
    expect(pending.preImageSha256).toMatch(/^[0-9a-f]{64}$/);
    const done = exp.resume.preCheckpoint.find((n: { path: string }) => n.path === "Done.md");
    expect(done.postImageSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("crash-window: the fixture bytes actually hash to the checkpoint's pre/post images (real verification)", () => {
    const dir = join(root, fixturesRel, "crash-window", "input");
    const cp = JSON.parse(readFileSync(join(dir, ".checkpoint.json"), "utf8"));
    const sha = (p: string) => createHash("sha256").update(readFileSync(join(dir, p))).digest("hex");
    const done = cp.notes.find((n: { path: string }) => n.path === "Done.md");
    const pending = cp.notes.find((n: { path: string }) => n.path === "Pending.md");
    // Done.md on disk is the MIGRATED bytes (matches postImage); Pending.md is still LEGACY (matches preImage)
    expect(sha("Done.md")).toBe(done.postImageSha256);
    expect(sha("Pending.md")).toBe(pending.preImageSha256);
  });

  it("explicit-collision: explicit ids are reserved before derivation; derived notes sorting before AND after the owner are both suffixed", () => {
    const exp = expectedOf("explicit-collision");
    expect(exp.reservedExplicitIds).toContain("note-report");
    // the explicit owner keeps the bare id; the two derived notes (one sorts before, one after) are suffixed
    expect(exp.migrate.idMap["MExplicit.md"]).toBe("note-report");
    expect(exp.migrate.idMap["AReport.md"]).toBe("note-report-2"); // sorts BEFORE the owner
    expect(exp.migrate.idMap["ZReport.md"]).toBe("note-report-3"); // sorts AFTER the owner
    // no note ends up sharing the explicit owner's id
    const ids = Object.values(exp.migrate.idMap);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of exp.migrate.notes) {
      if (n.collision) expect(n.collision.derivedId).toBe("note-report");
    }
  });

  it("rollback: byte-exact reversal via pre-images in reverse sorted-path order, idempotent re-rollback", () => {
    const exp = expectedOf("rollback");
    expect(exp.migrate.mode).toBe("rolled-back");
    expect(exp.migrate.rollbackOrder).toEqual(["Beta.md", "Alpha.md"]); // reverse sorted-path
    for (const r of exp.migrate.rolledBack) {
      expect(r.preImageRestored).toBe(true);
      expect(r.restoredToStatus).toBe("pending");
      expect(r.restoredToSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // a re-invoked rollback re-reverts nothing already reverted
    expect(exp.rerunRollback.reReverted).toEqual([]);
    expect(exp.rerunRollback.rolledBack).toEqual([]);
  });

  it("rollback: restore targets actually hash to the checkpoint pre-images (byte-exact reversal is real)", () => {
    const dir = join(root, fixturesRel, "rollback", "input");
    const cp = JSON.parse(readFileSync(join(dir, ".checkpoint.json"), "utf8"));
    const exp = expectedOf("rollback");
    const sha = (p: string) => createHash("sha256").update(readFileSync(join(dir, p))).digest("hex");
    for (const note of cp.notes as { path: string; preImage: string; preImageSha256: string }[]) {
      // the retained pre-image backup hashes to the recorded preImageSha256
      expect(sha(note.preImage), `${note.path} pre-image backup`).toBe(note.preImageSha256);
      // and the rolledBack record's restoredToSha256 equals that same pre-image hash
      const r = exp.migrate.rolledBack.find((x: { path: string }) => x.path === note.path);
      expect(r.restoredToSha256, `${note.path} restore target`).toBe(note.preImageSha256);
    }
  });

  it("basic: an unresolved-link note migrates by FLATTENING the link (no operator release needed — migration is total)", () => {
    const exp = expectedOf("basic");
    const atlas = exp.migrate.notes.find((n: { path: string }) => n.path === "Concepts/Atlas.md");
    // migration is total: the note migrates WITHOUT any release record — the link is flattened in place
    expect(atlas.released, "no release record — flattening is unconditional").toBeUndefined();
    const flattened = atlas.linkRewrites.find((l: { resolution: string }) => l.resolution === "flattened-unresolved");
    expect(flattened, "the unresolved link is flattened").toBeTruthy();
    expect(exp.migrate.releases ?? [], "no incompatible-link releases remain").toEqual([]);
  });

  it("idempotent + reader-required-field init: every migrated note initializes id/type/schema_version/title/created/updated", () => {
    for (const id of ["basic", "guards", "crash-window", "explicit-collision"]) {
      const exp = expectedOf(id);
      for (const n of exp.migrate.notes) {
        if (n.status !== "migrated") continue;
        const f = n.initializedFrontmatter;
        expect(f, `${id}:${n.path} initializedFrontmatter`).toBeTruthy();
        for (const k of ["id", "type", "schema_version", "title", "created", "updated"]) {
          expect(f[k], `${id}:${n.path} required ${k}`).toBeTruthy();
        }
        // deterministic timestamps: the no-history fallback is the pinned bootstrapTimestamp
        expect(f.created).toBe("2026-07-12T00:00:00Z");
        expect(f.updated).toBe("2026-07-12T00:00:00Z");
      }
    }
  });

  it("audit categories in every fixture are a subset of the bootstrap-migration.md §7 category set", () => {
    const CATEGORIES = new Set([
      "missing-id",
      "missing-type",
      "missing-schema-version",
      "ambiguous-alias",
      "duplicate-identity",
      "incompatible-link",
      "detected-credential",
      "unknown-type",
      "unsupported-schema-version",
    ]);
    for (const c of manifest.cases as { id: string }[]) {
      const exp = expectedOf(c.id);
      if (!exp.audit) continue;
      for (const key of Object.keys(exp.audit.categories)) {
        expect(CATEGORIES.has(key), `${c.id} category ${key}`).toBe(true);
      }
    }
  });
});

describe("Phase-5 graduation/quarantine schema contracts (wing findings R2 — named tests)", () => {
  const schemaDir = "docs/specs/cli-contract";
  const load = (name: string) => JSON.parse(readFileSync(join(root, schemaDir, name), "utf8"));
  const flagsOf = (schema: Record<string, unknown>) =>
    ((schema["x-atlas-contract"] as { flags?: { flag?: string; name?: string; required?: boolean }[] }).flags ?? []);
  const errorsOf = (schema: Record<string, unknown>) =>
    ((schema["x-atlas-contract"] as { errorCodes?: { code: string; exit: number; when: string }[] }).errorCodes ?? []);

  // Finding 6 — graduation scan: required --source/--copy path flags; live-source immutability.
  it("graduation scan requires --source AND --copy path flags (source-to-disposable-copy op)", () => {
    const flags = flagsOf(load("graduation-scan.schema.json"));
    const byFlag = new Map(flags.map((f) => [f.flag ?? f.name, f]));
    for (const name of ["--source <path>", "--copy <path>"]) {
      const f = byFlag.get(name);
      expect(f, `scan ${name} flag`).toBeTruthy();
      expect(f!.required, `scan ${name} required`).toBe(true);
    }
  });

  it("graduation scan usage-error covers a MISSING required --source/--copy, and the source is immutable", () => {
    const schema = load("graduation-scan.schema.json");
    const usage = errorsOf(schema).find((e) => e.code === "usage");
    expect(usage, "scan usage error").toBeTruthy();
    expect(usage!.when.toLowerCase()).toMatch(/missing required --source \/ --copy|missing required --source/);
    // live-source immutability is a hard prohibited effect (byte/tree-hash identical before/after)
    const prohibited = (schema["x-atlas-contract"] as { prohibitedEffects: string[] }).prohibitedEffects;
    expect(prohibited.some((p) => /never (scans or )?mutates the live main-vault/.test(p))).toBe(true);
    expect(prohibited.some((p) => /never writes to --source/.test(p))).toBe(true);
  });

  // Finding 7 — quarantine inspect: EVERY invocation is challenge-bound; reveal ADDITIONALLY binds reveal intent.
  it("quarantine inspect requires --authorization on EVERY invocation (metadata or --reveal)", () => {
    const schema = load("quarantine-inspect.schema.json");
    const authRequired = errorsOf(schema).find((e) => e.code === "authorization-required");
    expect(authRequired, "inspect authorization-required error").toBeTruthy();
    expect(authRequired!.exit).toBe(6);
    // the guard must cover ANY invocation — not only --reveal
    // R3-F1: exit 6 only when interactive presence is unavailable/declined (and no --authorization)
    // or a challenge is exported — NOT a blanket "every invocation requires --authorization".
    expect(authRequired!.when.toLowerCase()).toMatch(/interactive os-presence|unavailable or declined|export-challenge/);
    const prohibited = (schema["x-atlas-contract"] as { prohibitedEffects: string[] }).prohibitedEffects;
    expect(
      prohibited.some((p) => /never returns any output.*without a valid.*authorization/i.test(p)),
      "inspect blocks unauthenticated metadata",
    ).toBe(true);
    // --reveal additionally binds reveal intent (a metadata authorization does not authorize a reveal)
    const revealFlag = flagsOf(schema).find((f) => (f.flag ?? f.name) === "--reveal");
    expect(revealFlag, "inspect --reveal flag").toBeTruthy();
    expect(
      prohibited.some((p) => /never emits plaintext without a reveal-bound authorization/i.test(p)),
    ).toBe(true);
  });

  // Finding 8 — graduation migrate --rollback: apply-only authorization contract covers rollback too.
  it("graduation migrate --rollback is broker-authorized (unauthorized→6, stale→6, replay→1) and binds run+expected generation", () => {
    const schema = load("graduation-migrate.schema.json");
    const c = schema["x-atlas-contract"] as {
      requestHashScope: string[];
      flags: { flag?: string; description: string }[];
      errorCodes: { code: string; exit: number; when: string }[];
    };
    // R3-F2: rollback is the SAME broker op (graduation migrate) in the reverse direction —
    // it binds the broker-SSOT GraduateEffect fields (fromGeneration/toGeneration/migrationPlanDigest),
    // NOT the unsupported migrationRunId+expectedCurrentGeneration authorization fields. The request
    // hash keeps migrationRunId (checkpoint key) but no longer claims expectedCurrentGeneration.
    expect(c.requestHashScope).toEqual(
      expect.arrayContaining(["fromGeneration", "toGeneration", "migrationPlanDigest", "migrationRunId"]),
    );
    expect(c.requestHashScope).not.toContain("expectedCurrentGeneration");
    const rollback = c.flags.find((f) => (f.flag ?? "") === "--rollback");
    expect(rollback, "--rollback flag").toBeTruthy();
    expect(rollback!.description).toMatch(/broker-authorized/i);
    expect(rollback!.description).toMatch(/reverse direction/i);
    expect(rollback!.description).toMatch(/fromGeneration/);
    expect(rollback!.description).toMatch(/migrationPlanDigest/);
    // R3-F5: a conflicting post-migration edit fails closed (never clobbered)
    expect(rollback!.description).toMatch(/fails closed/i);
    const byCode = new Map(c.errorCodes.map((e) => [e.code, e]));
    // R3-F1: unauthorized rollback → exit 6 only when interactive presence is unavailable/declined
    expect(byCode.get("authorization-required")!.exit).toBe(6);
    expect(byCode.get("authorization-required")!.when).toMatch(/--rollback/);
    expect(byCode.get("authorization-required")!.when).toMatch(/interactive OS-presence|unavailable or declined|export-challenge/i);
    // stale-state rollback → generation_mismatch (6); replayed authorization → nonce_replayed (1)
    expect(byCode.get("authz.generation_mismatch")!.exit).toBe(6);
    expect(byCode.get("authz.generation_mismatch")!.when).toMatch(/stale rollback|current \(migrated\) generation|fromGeneration/);
    expect(byCode.get("authz.nonce_replayed")!.exit).toBe(1);
  });

  // Finding 9 — reconcile the authoritative category set: audit exposes ALL EIGHT §7 categories,
  // and quarantine inspect's enum omits the refused/informational ones (only the 4 inspectable).
  it("the graduation-audit categories reconcile 1:1 with bootstrap-migration.md §7 (all eight)", () => {
    const EIGHT = [
      "missing-id",
      "missing-type",
      "missing-schema-version",
      "ambiguous-alias",
      "duplicate-identity",
      "incompatible-link",
      "detected-credential",
      "unknown-type",
      "unsupported-schema-version",
    ];
    const auditCats = (load("graduation-audit.schema.json").properties.categories.required as string[]).sort();
    expect(auditCats).toEqual([...EIGHT].sort());
    // the doc §7 table enumerates the SAME eight rows
    const doc = readFileSync(join(root, "docs/specs/bootstrap-migration.md"), "utf8");
    for (const cat of EIGHT) expect(doc, `§7 mentions ${cat}`).toMatch(new RegExp(`\\\`${cat}\\\``));
  });

  it("quarantine inspect's category enum omits refused/informational categories (only the four inspectable)", () => {
    const inspectEnum = (load("quarantine-inspect.schema.json").properties.category.enum as string[]).sort();
    expect(inspectEnum).toEqual(
      ["ambiguous-alias", "detected-credential", "duplicate-identity", "incompatible-link"].sort(),
    );
    // the refusal category is explicitly NOT inspectable
    expect(inspectEnum).not.toContain("unsupported-schema-version");
  });
});

describe("Phase-6 console enablement (SP-1 contracts gate)", () => {
  const phase6 = registry.commands.filter((c) => c.phase === 6);

  it("the Phase-6 command set is exactly `watch` (shared, none-idempotent), landed with the harness widening", () => {
    expect(phase6.map((c) => c.name)).toEqual(["watch"]);
    const r = phase6[0]!;
    expect(r.privilege).toBe("shared");
    expect(r.idempotency).toBe("none");
    expect(existsSync(join(root, r.schemaRef)), `watch schema ${r.schemaRef}`).toBe(true);
  });

  // NB: no implemented:false assertion — the Phase-5 flip lands in a later SP-1
  // step; the durable gate is schema presence + row binding (Phase-3/4/5 policy).
  it("watch.schema.json is a compilable 8-member event-line union whose x-atlas-contract matches the registry row", () => {
    const r = phase6[0]!;
    const schema = JSON.parse(readFileSync(join(root, r.schemaRef), "utf8"));
    const c = schema["x-atlas-contract"];
    expect(c, "watch x-atlas-contract").toBeTruthy();
    expect(c.command).toBe(r.name);
    expect(c.phase).toBe(6);
    expect(c.privilege).toBe(r.privilege);
    expect(c.idempotency).toBe(r.idempotency);
    // read-only-ness rides executionClass (the registry has no "readonly" privilege);
    // plain read, NOT audited-read (spec §5.1 — watch emits no run.readonly)
    expect(c.executionClass).toBe("read");
    // strict exit subset for a long-lived stream (§10.1): no 1/3/6/7 paths exist
    expect(c.exitCodes).toEqual([0, 2, 4, 5]);
    for (const code of c.exitCodes as number[]) {
      expect(EXIT_CODES.includes(code as (typeof EXIT_CODES)[number]), `watch exit ${code}`).toBe(true);
    }
    expect(c.errorEnvelopeRef).toBe("docs/specs/cli-contract/error-envelope.schema.json");
    // read-only enforcement is pinned in prohibitedEffects (§5.2)
    const pe = (c.prohibitedEffects as string[]).join(" ");
    for (const needle of [/readonly:true/, /no Atlas lock/i, /no git/i, /no network egress/i]) {
      expect(pe, `prohibitedEffects pin ${needle}`).toMatch(needle);
    }
    expect(c.locks).toEqual([]);
    expect(c.sideEffects).toEqual([]);
    // a line-union schema, not a command-output object: 8 members, one per event type
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect(schema.oneOf).toHaveLength(8);
    // the schema compiles and each bundled example validates against it
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    for (const ex of schema.examples ?? []) {
      expect(validate(ex), `watch example: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    // one example per event type, covering the whole taxonomy (§6)
    const EVENTS = ["watch.hello", "watch.heartbeat", "watch.error", "job", "model_call", "audit", "backup", "daemon"];
    const seen = new Set((schema.examples as { event: string }[]).map((e) => e.event));
    expect([...seen].sort()).toEqual([...EVENTS].sort());
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
