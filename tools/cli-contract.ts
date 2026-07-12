/**
 * Retained CLI-contract harness — shared library.
 *
 * Single source of truth for loading + validating the command registry
 * (`docs/specs/cli-contract/commands.json`) against the prose CLI-surface
 * fixture (`cli-surface.fixture.txt`) and for rendering the derived overview.
 *
 * Consumed by both `gen-cli-contract.ts` (the generator CLI) and
 * `contract-lint.test.ts` (the vitest gate) so the two never diverge.
 *
 * This module is part of the Phase-0 bootstrap and is NEVER reverted.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PHASES = [0, 1, 2, 3, 4, 5] as const;
export type Phase = (typeof PHASES)[number];

export const IDEMPOTENCY = ["key-accepting", "intrinsic", "none"] as const;
export type Idempotency = (typeof IDEMPOTENCY)[number];

export const PRIVILEGE = ["shared", "privileged"] as const;
export type Privilege = (typeof PRIVILEGE)[number];

export interface CommandRow {
  name: string;
  schemaRef: string;
  phase: Phase;
  idempotency: Idempotency;
  privilege: Privilege;
  implemented: boolean;
}

export interface Registry {
  version: number;
  commands: CommandRow[];
}

/**
 * The normative workflow state set, verbatim from the plan's §2.5 Global
 * Constraints. This is the single source of truth the recovery-state-machine
 * contract's `stateTable` is checked for completeness against — it must not be
 * silently widened (that would mask a missing state in the contract).
 *
 *   planned → patched → worktree-applied → agent-committed → [review-pending] →
 *   integrated → reindexed → finalized;
 *   terminals rejected, rolled-back, failed, cancelled
 *   (recorded failed@<checkpoint> / cancelled@<checkpoint>).
 */
export const RECOVERY_CHECKPOINTS = [
  "planned",
  "patched",
  "worktree-applied",
  "agent-committed",
  "review-pending",
  "integrated",
  "reindexed",
] as const;
export type RecoveryCheckpoint = (typeof RECOVERY_CHECKPOINTS)[number];

/** Terminal state classes (§2.5). `failed`/`cancelled` are also recorded suffixed. */
export const RECOVERY_TERMINALS = ["finalized", "rejected", "rolled-back", "failed", "cancelled"] as const;
export type RecoveryTerminal = (typeof RECOVERY_TERMINALS)[number];

/**
 * The checkpoints from which a run can terminate as failed/cancelled. Per the
 * contract, once `integrated` the mutation is durable and recovery is
 * forward-only (or an explicit `rolled-back`) — so no `failed@`/`cancelled@`
 * forms exist for `integrated`/`reindexed`.
 */
export const FAILABLE_CHECKPOINTS = [
  "planned",
  "patched",
  "worktree-applied",
  "agent-committed",
  "review-pending",
] as const;
export type FailableCheckpoint = (typeof FAILABLE_CHECKPOINTS)[number];

/**
 * The full §2.5 state set the `stateTable` must cover: every progression
 * checkpoint, every terminal class, and every `failed@`/`cancelled@` suffixed
 * terminal for the failable checkpoints.
 */
export function normativeStateSet(): string[] {
  const states = new Set<string>([...RECOVERY_CHECKPOINTS, ...RECOVERY_TERMINALS]);
  for (const cp of FAILABLE_CHECKPOINTS) {
    states.add(`failed@${cp}`);
    states.add(`cancelled@${cp}`);
  }
  return [...states].sort();
}

/** The two legal `kind` classifications for a `stateTable` row. */
export const STATE_KINDS = ["checkpoint", "terminal"] as const;
export type StateKind = (typeof STATE_KINDS)[number];

/**
 * The `kind` a §2.5 state MUST carry in the `stateTable`. Only the progression
 * checkpoints (`RECOVERY_CHECKPOINTS`) are `checkpoint`s; every terminal class,
 * every `failed@`/`cancelled@` suffixed terminal, and `finalized` are
 * `terminal`s. Because Task 4.11 generates a failpoint per row, a row whose
 * `kind` is missing or misclassified would emit an invalid failpoint — so the
 * lint pins the classification, it is not free-form.
 */
export function expectedStateKind(state: string): StateKind | undefined {
  if ((RECOVERY_CHECKPOINTS as readonly string[]).includes(state)) return "checkpoint";
  if ((RECOVERY_TERMINALS as readonly string[]).includes(state)) return "terminal";
  if (/^(failed|cancelled)@/.test(state)) {
    const cp = state.slice(state.indexOf("@") + 1);
    return (FAILABLE_CHECKPOINTS as readonly string[]).includes(cp) ? "terminal" : undefined;
  }
  return undefined;
}

/** One row of the recovery `stateTable`; only the fields the lint enforces are typed. */
export interface StateTableEntry {
  state: string;
  kind: "checkpoint" | "terminal";
  recoveryAction: string;
  [key: string]: unknown;
}

export interface StateTable {
  version: number;
  states: StateTableEntry[];
  [key: string]: unknown;
}

/** Relative (repo-root-anchored) paths for the contract files. */
export const REGISTRY_PATH = "docs/specs/cli-contract/commands.json";
export const FIXTURE_PATH = "docs/specs/cli-contract/cli-surface.fixture.txt";
export const OVERVIEW_PATH = "docs/specs/cli-contract/commands-overview.md";
export const CLI_CONTRACT_DIR = "docs/specs/cli-contract";
export const RECOVERY_STATE_MACHINE_PATH = "docs/specs/recovery-state-machine.md";
export const DATA_DICTIONARY_PATH = "docs/specs/sqlite-data-dictionary.md";

/**
 * Migration ownership — transcribed verbatim from the plan's §2.7 (the single
 * authoritative migration-ownership table). Exactly one migration creates each
 * table; this constant is the SSOT the `sqlite-data-dictionary.md` table
 * inventory is linted against. It must not be silently widened or narrowed —
 * a table added to the dictionary without a §2.7 row (or vice versa) must fail
 * the lint, mirroring the registry↔fixture and stateTable completeness gates.
 *
 * Keys are the §2.7 migration ids (plus the runner-bootstrap pseudo-migration
 * that creates `db_schema_migrations` itself, not a numbered migration).
 */
export const MIGRATION_OWNERSHIP: Readonly<Record<string, readonly string[]>> = {
  "0001_core": [
    "notes",
    "note_identity_keys",
    "note_links",
    "vault_schema_migrations",
    "agent_runs",
    "model_calls",
    "retrieval_runs",
    "retrieval_results",
    "change_plans",
    "patches",
    "patch_operations",
    "validation_results",
    "git_operations",
    "audit_events",
    "audit_intents",
    "backup_watermark",
    "raw_payloads",
  ],
  "0002_jobs": ["jobs", "job_attempts"],
  "0003_provenance": ["content_blobs", "source_captures", "source_renditions", "note_sources"],
  "0004_claims": ["claims", "claim_evidence"],
  "(runner bootstrap)": ["db_schema_migrations"],
} as const;

/** The full, sorted set of tables §2.7 says the data dictionary MUST define. */
export function sqlite27Tables(): string[] {
  return [...new Set(Object.values(MIGRATION_OWNERSHIP).flat())].sort();
}

/**
 * Strip SQL comments from a fragment of DDL: block comments (`/* … *\/`) and
 * line comments (`-- … <eol>`). Applied before scanning for `CREATE TABLE` so a
 * commented-out declaration inside a `sql` fence cannot satisfy the inventory
 * gate. String-literal handling is intentionally omitted — the data dictionary
 * is authored DDL with no `--`/`/*` sequences inside string literals.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/**
 * Parse the table names actually defined by the data dictionary: every
 * `CREATE TABLE [IF NOT EXISTS] <name>` in a fenced ```` ```sql ```` code block,
 * after SQL comments are stripped. Prose (`CREATE TABLE` mentioned in text) and
 * commented-out DDL therefore CANNOT satisfy the inventory gate — only real,
 * executable `CREATE TABLE` statements inside a SQL fence count. `CREATE INDEX`
 * / `CREATE UNIQUE INDEX` are intentionally not matched. Parsing the real DDL —
 * not headings or prose — guarantees the inventory check gates the presence of
 * the actual `CREATE TABLE` each migration copies verbatim.
 */
export function parseDataDictionaryTables(markdown: string): string[] {
  const fence = /```sql\b[^\n]*\n([\s\S]*?)```/gi;
  const table = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  const names: string[] = [];
  let block: RegExpExecArray | null;
  while ((block = fence.exec(markdown)) !== null) {
    const sql = stripSqlComments(block[1]!);
    table.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = table.exec(sql)) !== null) names.push(m[1]!);
  }
  return names;
}

export function loadDataDictionaryTables(root: string): string[] {
  return parseDataDictionaryTables(readFileSync(join(root, DATA_DICTIONARY_PATH), "utf8"));
}

/**
 * Assert the data dictionary defines exactly the §2.7 table set — every §2.7
 * table has a `CREATE TABLE`, and no `CREATE TABLE` exists that §2.7 doesn't
 * own (and none is defined twice). Returns human-readable errors (empty = OK).
 */
export function checkTableInventory(dictionaryTables: string[]): string[] {
  const errors: string[] = [];
  const expected = new Set(sqlite27Tables());
  const present = new Set<string>();

  for (const name of dictionaryTables) {
    if (present.has(name)) {
      errors.push(`${DATA_DICTIONARY_PATH}: table "${name}" is defined more than once (duplicate CREATE TABLE)`);
    }
    present.add(name);
    if (!expected.has(name)) {
      errors.push(`${DATA_DICTIONARY_PATH}: table "${name}" has no owning migration in §2.7`);
    }
  }
  for (const name of expected) {
    if (!present.has(name)) {
      errors.push(`§2.7 table "${name}" is missing a CREATE TABLE in ${DATA_DICTIONARY_PATH}`);
    }
  }
  return errors;
}

/** Walk up from a starting directory until the repo root (pnpm-workspace.yaml) is found. */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("could not locate repo root (no pnpm-workspace.yaml found walking up)");
    }
    dir = parent;
  }
}

/** Derive the canonical schemaRef path for a command name (spaces -> hyphens). */
export function expectedSchemaRef(name: string): string {
  return `${CLI_CONTRACT_DIR}/${name.replace(/ /g, "-")}.schema.json`;
}

export function loadRegistry(root: string): Registry {
  const raw = readFileSync(join(root, REGISTRY_PATH), "utf8");
  const parsed = JSON.parse(raw) as Registry;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.commands)) {
    throw new Error(`${REGISTRY_PATH}: expected an object with a "commands" array`);
  }
  return parsed;
}

/**
 * Parse the prose fixture into command names.
 *
 * Contract: a command line is one that BEGINS with a backtick (after trimming
 * leading whitespace); its command name is the text inside that first pair of
 * backticks. Every other line — headings, comments (`#`), underlines, and
 * explanatory prose (which may itself contain backticked tokens) — is ignored.
 */
export function parseFixture(text: string): string[] {
  const names: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("`")) continue;
    const match = /^`([^`]+)`/.exec(line);
    if (match) names.push(match[1]!.trim());
  }
  return names;
}

export function loadFixtureNames(root: string): string[] {
  return parseFixture(readFileSync(join(root, FIXTURE_PATH), "utf8"));
}

/**
 * Validate the internal shape of the registry rows (independent of the fixture).
 * Returns a list of human-readable error strings (empty = valid).
 */
export function validateRegistry(reg: Registry): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let prev: string | null = null;

  for (const [i, row] of reg.commands.entries()) {
    const where = `commands[${i}] (${row?.name ?? "?"})`;
    if (!row || typeof row.name !== "string" || row.name.trim() === "") {
      errors.push(`${where}: missing/empty "name"`);
      continue;
    }
    if (seen.has(row.name)) errors.push(`${where}: duplicate command name`);
    seen.add(row.name);

    if (prev !== null && row.name < prev) {
      errors.push(`${where}: rows must be sorted by name ("${row.name}" after "${prev}")`);
    }
    prev = row.name;

    if (!(PHASES as readonly number[]).includes(row.phase)) {
      errors.push(`${where}: invalid phase ${JSON.stringify(row.phase)} (expected 0..5)`);
    }
    if (!(IDEMPOTENCY as readonly string[]).includes(row.idempotency)) {
      errors.push(`${where}: invalid idempotency ${JSON.stringify(row.idempotency)}`);
    }
    if (!(PRIVILEGE as readonly string[]).includes(row.privilege)) {
      errors.push(`${where}: invalid privilege ${JSON.stringify(row.privilege)}`);
    }
    if (typeof row.implemented !== "boolean") {
      errors.push(`${where}: "implemented" must be a boolean`);
    }
    const expected = expectedSchemaRef(row.name);
    if (row.schemaRef !== expected) {
      errors.push(`${where}: schemaRef "${row.schemaRef}" != expected "${expected}"`);
    }
  }
  return errors;
}

/**
 * Assert the registry <-> fixture bijection: every fixture command has a
 * registry row and vice versa. Returns human-readable error strings.
 */
export function checkFixtureConsistency(reg: Registry, fixtureNames: string[]): string[] {
  const errors: string[] = [];
  const registryNames = new Set(reg.commands.map((c) => c.name));
  const fixtureSet = new Set<string>();

  for (const name of fixtureNames) {
    if (fixtureSet.has(name)) errors.push(`fixture: duplicate command line "${name}"`);
    fixtureSet.add(name);
    if (!registryNames.has(name)) {
      errors.push(`fixture command "${name}" has no registry row in ${REGISTRY_PATH}`);
    }
  }
  for (const name of registryNames) {
    if (!fixtureSet.has(name)) {
      errors.push(`registry command "${name}" is missing from ${FIXTURE_PATH}`);
    }
  }
  return errors;
}

/**
 * Assert that every row flagged `implemented: true` has an existing schemaRef
 * file on disk. Returns human-readable error strings.
 */
export function checkImplementedSchemas(root: string, reg: Registry): string[] {
  const errors: string[] = [];
  for (const row of reg.commands) {
    if (row.implemented && !existsSync(resolve(root, row.schemaRef))) {
      errors.push(`command "${row.name}" is implemented:true but schemaRef "${row.schemaRef}" does not exist`);
    }
  }
  return errors;
}

/** Full consistency pass used by both `--check` and the lint test. */
export function lintAll(root: string, reg: Registry, fixtureNames: string[]): string[] {
  return [
    ...validateRegistry(reg),
    ...checkFixtureConsistency(reg, fixtureNames),
    ...checkImplementedSchemas(root, reg),
    ...checkTableInventory(loadDataDictionaryTables(root)),
  ];
}

/**
 * Extract the single fenced `stateTable` JSON block from the
 * recovery-state-machine contract. The block's opening fence info string is
 * exactly ```` ```json stateTable ```` — the same marker the Task 4.11
 * failpoint generator scans for. Throws if the block is absent, duplicated, or
 * malformed JSON.
 */
export function extractStateTableJson(markdown: string): string {
  const fence = /```json\s+stateTable\s*\n([\s\S]*?)\n```/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) matches.push(m[1]!);
  if (matches.length === 0) {
    throw new Error(`no fenced \`\`\`json stateTable block found in ${RECOVERY_STATE_MACHINE_PATH}`);
  }
  if (matches.length > 1) {
    throw new Error(`expected exactly one \`\`\`json stateTable block, found ${matches.length}`);
  }
  return matches[0]!;
}

/** Parse the `stateTable` block into its typed shape. Throws on malformed JSON or shape. */
export function parseStateTable(markdown: string): StateTable {
  const parsed = JSON.parse(extractStateTableJson(markdown)) as StateTable;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.states)) {
    throw new Error(`${RECOVERY_STATE_MACHINE_PATH}: stateTable must be an object with a "states" array`);
  }
  return parsed;
}

/** Load + parse the recovery `stateTable` from disk. */
export function loadStateTable(root: string): StateTable {
  return parseStateTable(readFileSync(join(root, RECOVERY_STATE_MACHINE_PATH), "utf8"));
}

/**
 * Assert the recovery `stateTable` covers every state in the normative §2.5 set
 * and that no state lacks a recovery action. Returns human-readable errors
 * (empty = complete).
 */
export function checkStateTableCompleteness(table: StateTable): string[] {
  const errors: string[] = [];
  const present = new Set<string>();

  const expectedKind = new Map(normativeStateSet().map((s) => [s, expectedStateKind(s)!] as const));

  for (const [i, row] of table.states.entries()) {
    const where = `states[${i}] (${row?.state ?? "?"})`;
    if (!row || typeof row.state !== "string" || row.state.trim() === "") {
      errors.push(`${where}: missing/empty "state"`);
      continue;
    }
    if (present.has(row.state)) errors.push(`${where}: duplicate state "${row.state}"`);
    present.add(row.state);

    // Reject any row outside the §2.5 persisted-state set. Task 4.11 generates a
    // failpoint per row, so a typo'd or unsupported state would silently produce
    // an invalid failpoint — it must fail the lint, not pass through.
    const wantKind = expectedKind.get(row.state);
    if (wantKind === undefined) {
      errors.push(`${where}: state "${row.state}" is not in the §2.5 persisted-state set`);
    }

    // Validate the checkpoint/terminal classification. `kind` must be present,
    // one of STATE_KINDS, and match the state's normative classification.
    if (!(STATE_KINDS as readonly string[]).includes(row.kind)) {
      errors.push(`${where}: invalid kind ${JSON.stringify(row.kind)} (expected "checkpoint" or "terminal")`);
    } else if (wantKind !== undefined && row.kind !== wantKind) {
      errors.push(`${where}: state "${row.state}" is classified "${row.kind}" but must be "${wantKind}"`);
    }

    if (typeof row.recoveryAction !== "string" || row.recoveryAction.trim() === "") {
      errors.push(`state "${row.state}" lacks a recoveryAction`);
    }
  }

  for (const state of normativeStateSet()) {
    if (!present.has(state)) {
      errors.push(`§2.5 state "${state}" is missing from the stateTable`);
    }
  }
  return errors;
}

/** Deterministically render the derived Markdown overview from the registry. */
export function renderOverview(reg: Registry): string {
  const rows = [...reg.commands].sort((a, b) => (a.phase - b.phase) || a.name.localeCompare(b.name, "en"));
  const lines: string[] = [];
  lines.push("<!-- GENERATED FILE — do not edit by hand.");
  lines.push("     Regenerate with: node tools/gen-cli-contract.ts --write");
  lines.push(`     Source of truth: ${REGISTRY_PATH} -->`);
  lines.push("");
  lines.push("# Atlas — CLI command surface (generated overview)");
  lines.push("");
  lines.push(`Registry version: **${reg.version}** · Commands: **${reg.commands.length}**`);
  lines.push("");
  lines.push("| Phase | Command | Idempotency | Privilege | Implemented | Schema |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${r.phase} | \`${r.name}\` | ${r.idempotency} | ${r.privilege} | ${r.implemented ? "yes" : "no"} | \`${r.schemaRef}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
