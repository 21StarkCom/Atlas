/**
 * bin launcher — the installed `brain` command routes through runCli and
 * propagates the mapped process-exit code (Task 1.8 acceptance: reachable
 * entrypoint). Exercises the COMPILED `dist/bin.js` (built by `pnpm -r build`
 * before `pnpm -r test`); skips if the build output is absent.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

  it("maps a registry-known but handler-less command to not-implemented → 5 (--json)", () => {
    // Every real command now has a handler, so the not-implemented BRANCH is exercised against a
    // SYNTHETIC registry: a `phantom` command present in commands.json with no wired handler,
    // loaded via the `ATLAS_ROOT` override (the real binary, end-to-end through the mapped exit).
    const cwd = mkdtempSync(join(tmpdir(), "atlas-bin-"));
    const contractDir = join(cwd, "docs", "specs", "cli-contract");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(
      join(contractDir, "commands.json"),
      JSON.stringify({ version: 1, commands: [{ name: "phantom", schemaRef: "docs/specs/cli-contract/phantom.schema.json", phase: 1, idempotency: "none", privilege: "shared", implemented: false }] }),
      "utf8",
    );
    writeFileSync(join(cwd, "brain.config.yaml"), EXAMPLE, "utf8");
    try {
      const r = spawnSync(process.execPath, [BIN, "phantom", "--json"], { cwd, encoding: "utf8", env: { ...process.env, ATLAS_ROOT: cwd, NO_COLOR: "1" } });
      expect(r.status, r.stdout + r.stderr).toBe(5);
      expect(JSON.parse(r.stdout).code).toBe("not-implemented");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
