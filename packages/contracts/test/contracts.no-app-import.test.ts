/**
 * `contracts.no-app-import.test` (D14) — the load-bearing build-graph invariant.
 *
 * Runs REPO-WIDE: no workspace package (anything under `packages/*`) may import
 * from `apps/cli`. Shared DTOs live in `@atlas/contracts` precisely so the
 * package→app dependency edge never exists. A violation here would reintroduce
 * the build cycle D14 exists to kill.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".turbo"]);

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTs(join(dir, entry.name), out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// The forbidden edge: a workspace package importing the CLI app, by workspace
// package name (`@atlas/cli`) or by any path specifier reaching into apps/cli.
const APP_IMPORT_RE =
  /\b(?:import|export)\b[^;\n]*?from\s*["'](@atlas\/cli(?:\/[^"']*)?|[^"']*apps\/cli[^"']*)["']|import\s*\(\s*["'](@atlas\/cli(?:\/[^"']*)?|[^"']*apps\/cli[^"']*)["']\s*\)/;

describe("no workspace package imports apps/cli (D14)", () => {
  const packagesDir = join(root, "packages");

  it("has a packages/ directory to scan", () => {
    expect(existsSync(packagesDir) && statSync(packagesDir).isDirectory()).toBe(true);
  });

  const files = walkTs(packagesDir);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (APP_IMPORT_RE.test(text)) offenders.push(relative(root, file));
  }

  it("finds zero apps/cli imports across all workspace packages", () => {
    expect(offenders).toEqual([]);
  });
});
