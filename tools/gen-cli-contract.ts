/**
 * gen-cli-contract.ts — retained CLI-contract generator (Phase-0 bootstrap; never reverted).
 *
 * Modes:
 *   --check   Validate registry <-> fixture <-> schema-presence consistency AND
 *             assert every derived file is up to date. Exits non-zero on any
 *             drift. Deterministic: clean immediately after --write. (Used by CI + lint.)
 *   --write   Regenerate the derived files from the registry.
 *
 * Derived files: docs/specs/cli-contract/commands-overview.md
 *
 * Usage: node tools/gen-cli-contract.ts [--check | --write]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findRepoRoot,
  lintAll,
  loadFixtureNames,
  loadRegistry,
  OVERVIEW_PATH,
  renderOverview,
} from "./cli-contract.ts";

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function main(argv: string[]): number {
  const wantCheck = argv.includes("--check");
  const wantWrite = argv.includes("--write");

  if (wantCheck === wantWrite) {
    process.stderr.write("usage: gen-cli-contract.ts (--check | --write)\n");
    return 5;
  }

  const root = findRepoRoot();
  const reg = loadRegistry(root);
  const fixtureNames = loadFixtureNames(root);

  const errors = lintAll(root, reg, fixtureNames);
  if (errors.length > 0) {
    process.stderr.write("CLI-contract consistency errors:\n");
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return 1;
  }

  const overviewPath = join(root, OVERVIEW_PATH);
  const expected = renderOverview(reg);

  if (wantWrite) {
    writeFileSync(overviewPath, expected, "utf8");
    process.stdout.write(`wrote ${OVERVIEW_PATH}\n`);
    return 0;
  }

  // --check: derived files must already match.
  const actual = readIfExists(overviewPath);
  if (actual !== expected) {
    process.stderr.write(
      `derived file drift: ${OVERVIEW_PATH} is out of date — run \`node tools/gen-cli-contract.ts --write\`\n`,
    );
    return 1;
  }

  process.stdout.write("CLI-contract check: clean\n");
  return 0;
}

process.exit(main(process.argv.slice(2)));
