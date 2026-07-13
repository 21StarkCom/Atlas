/**
 * `broker.no-ledger-dep.test` — the acyclic ledger→broker seam (§2.8).
 *
 * The broker is the sole protected-ref mutator and must NEVER import
 * `@atlas/sqlite-store`; the dependency direction is strictly ledger → broker.
 * Two complementary guards:
 *   1. package.json declares no sqlite-store dependency;
 *   2. no source file under src/ or bin/ imports `@atlas/sqlite-store` (a
 *      transitive-free static import-graph check over this package's own code).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("broker never depends on @atlas/sqlite-store", () => {
  it("package.json declares no sqlite-store dependency", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    expect(Object.keys(deps)).not.toContain("@atlas/sqlite-store");
  });

  it("no source file imports @atlas/sqlite-store", () => {
    const files = [...walk(join(pkgRoot, "src")), ...walk(join(pkgRoot, "bin"))];
    expect(files.length).toBeGreaterThan(0);
    // Only real import/require of the package counts — mentions in prose/comments
    // (documenting the acyclic seam) are fine and expected.
    const importRe = /(?:from|import|require)\s*\(?\s*["']@atlas\/sqlite-store["']/;
    const offenders = files.filter((f) => importRe.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
