/**
 * `models-production-dependency` — the PRODUCTION-package import smoke test the wing
 * reviewer required (round-3 finding on terminal-audit-detail.ts:19 + package.json).
 *
 * `src/workflows/terminal-audit-detail.ts` imports `@atlas/models` at RUNTIME (the
 * SSOT `ModelCallAuditRecordSchema`), so a production-only install (`pnpm install
 * --prod`, which omits devDependencies) MUST still resolve `@atlas/models` — otherwise
 * loading the CLI throws `ERR_MODULE_NOT_FOUND`. This test fails CLOSED if the package
 * ever drifts back into `devDependencies`, AND proves the runtime module that imports it
 * actually loads + validates.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTerminalAuditDetail } from "../src/workflows/terminal-audit-detail.js";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("@atlas/models is a PRODUCTION dependency (round-3 finding)", () => {
  it("is declared in dependencies, not devDependencies", () => {
    // A runtime import of `@atlas/models` (terminal-audit-detail.ts) requires it in
    // `dependencies` — a `--prod` install strips devDependencies and would break the CLI.
    expect(pkg.dependencies?.["@atlas/models"]).toBe("workspace:*");
    expect(pkg.devDependencies?.["@atlas/models"]).toBeUndefined();
  });

  it("the runtime module that imports @atlas/models loads and enforces the allowlist", () => {
    // Loading this module resolves `@atlas/models` at import time (the SSOT schema).
    // A missing production dependency would throw before this line — reaching it proves
    // the import resolved; the allowlist behavior proves the shared schema is live.
    expect(parseTerminalAuditDetail({})).toEqual({});
    expect(() => parseTerminalAuditDetail({ prompt: "raw model payload" })).toThrow(/terminal audit detail rejected/);
  });
});
