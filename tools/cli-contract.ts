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

/** Relative (repo-root-anchored) paths for the contract files. */
export const REGISTRY_PATH = "docs/specs/cli-contract/commands.json";
export const FIXTURE_PATH = "docs/specs/cli-contract/cli-surface.fixture.txt";
export const OVERVIEW_PATH = "docs/specs/cli-contract/commands-overview.md";
export const CLI_CONTRACT_DIR = "docs/specs/cli-contract";

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
  ];
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
