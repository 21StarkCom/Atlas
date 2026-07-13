/**
 * contract-lint — the vitest gate for the retained CLI-contract harness.
 *
 * Asserts registry <-> fixture <-> schema-presence consistency and generator
 * determinism. Part of the Phase-0 bootstrap; never reverted.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ProviderErrorSchema } from "@atlas/contracts";
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
    // Some Phase-1 schema files now exist (#14); pick a row whose schema file is
    // still absent (a later-phase command) so flipping it to implemented must fail.
    const idx = registry.commands.findIndex((c) => !existsSync(join(root, c.schemaRef)));
    expect(idx).toBeGreaterThanOrEqual(0);
    const mutated: Registry = {
      version: registry.version,
      commands: registry.commands.map((c, i) => (i === idx ? { ...c, implemented: true } : c)),
    };
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

  it("every Phase-2 row is still implemented:false at this contract-only gate", () => {
    for (const r of phase2) {
      expect(r.implemented, `${r.name} implemented`).toBe(false);
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

describe("generator determinism", () => {
  it("renderOverview is a pure function of the registry", () => {
    expect(renderOverview(registry)).toEqual(renderOverview(loadRegistry(root)));
  });

  it("the committed derived overview matches the generator output (--check would be clean)", () => {
    const onDisk = readFileSync(join(root, "docs/specs/cli-contract/commands-overview.md"), "utf8");
    expect(onDisk).toEqual(renderOverview(registry));
  });
});
