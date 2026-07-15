/**
 * `graduation-scan` (Task 5.1 / #57) — the fail-closed full-vault scan gate: a clean copy
 * passes; a copy containing a secret is blocked with the offending file named. Runs on a
 * throwaway copy, read-only.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanVaultCopy } from "../src/graduation/scan.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-grad-scan-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), "AKIA" + "IOSFODNN7EXAMPLE\n", "utf8"); // .git is excluded
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("graduation scan gate (fail-closed)", () => {
  it("a clean vault copy passes (excludes .git)", () => {
    writeFileSync(join(dir, "notes", "a.md"), "---\nid: a\n---\n# A\nClean content.\n", "utf8");
    const result = scanVaultCopy(dir);
    expect(result.clean).toBe(true);
    expect(result.scannedFiles).toBe(1); // .git/config not scanned
    expect(result.hits).toHaveLength(0);
  });

  it("a copy containing a secret is BLOCKED, naming the offending file", () => {
    writeFileSync(join(dir, "notes", "a.md"), "clean\n", "utf8");
    writeFileSync(join(dir, "notes", "leak.md"), "aws key AKIA" + "IOSFODNN7EXAMPLE here\n", "utf8");
    const result = scanVaultCopy(dir);
    expect(result.clean).toBe(false);
    expect(result.hits.map((h) => h.file)).toContain(join("notes", "leak.md"));
    expect(result.hits[0]!.findings.length).toBeGreaterThan(0);
  });
});
