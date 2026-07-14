/**
 * bin launcher — the installed `brain` command routes through runCli and
 * propagates the mapped process-exit code (Task 1.8 acceptance: reachable
 * entrypoint). Exercises the COMPILED `dist/bin.js` (built by `pnpm -r build`
 * before `pnpm -r test`); skips if the build output is absent.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const EXAMPLE = readFileSync(join(REPO_ROOT, "brain.config.example.yaml"), "utf8");

const run = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });

describe.skipIf(!existsSync(BIN))("brain bin launcher", () => {
  it("routes --help and exits 0", () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-bin-"));
    try {
      const r = run(["--help"], cwd);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("brain — Atlas CLI");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("propagates a mapped non-zero exit code (unknown command → 5)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-bin-"));
    try {
      const r = run(["frobnicate"], cwd);
      expect(r.status).toBe(5);
      expect(r.stderr).toContain("unknown command");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("routes a real registry command and maps not-implemented → 5 (--json)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "atlas-bin-"));
    writeFileSync(join(cwd, "brain.config.yaml"), EXAMPLE, "utf8");
    try {
      // `query` is a real registry command (Phase-3 retrieval) with no handler in
      // this build — the stable not-implemented example (`db migrate` is now the
      // implemented migration composition root, Task 2.7).
      const r = run(["query", "--json"], cwd);
      expect(r.status).toBe(5);
      expect(JSON.parse(r.stdout).code).toBe("not-implemented");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
