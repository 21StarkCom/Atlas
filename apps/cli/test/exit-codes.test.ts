/**
 * `exit-codes` (v2 #335) — the process-exit contract is {0,1,2,4,5}, plus 7 for
 * the `jobs run` batch aggregate ALONE. Secret-scan (3) and action-required (6)
 * are retired with the scan/review architecture (ADR-0003). This gate proves it
 * three ways: the envelope EXIT constant set, the per-command schema exitCodes,
 * and a source scan that no handler emits 3/6.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../src/errors/envelope.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const CLI_SRC = join(import.meta.dirname, "..", "src");
const SCHEMA_DIR = join(REPO_ROOT, "docs/specs/cli-contract");

describe("v2 process-exit contract (#335)", () => {
  it("the envelope EXIT set is exactly {0,1,2,4,5} — no secret-scan (3), no action-required (6)", () => {
    expect(new Set(Object.values(EXIT))).toEqual(new Set([0, 1, 2, 4, 5]));
    expect(Object.values(EXIT)).not.toContain(3);
    expect(Object.values(EXIT)).not.toContain(6);
  });

  it("no command schema declares exit 3 or 6; exit 7 appears only in jobs run", () => {
    for (const f of readdirSync(SCHEMA_DIR)) {
      if (!f.endsWith(".schema.json") || f === "error-envelope.schema.json") continue;
      const s = JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
      const c = s["x-atlas-contract"];
      if (!c) continue;
      const exits = new Set<number>([
        ...((c.exitCodes as number[]) ?? []),
        ...((c.errorCodes as { exit: number }[]) ?? []).map((e) => e.exit),
      ]);
      expect(exits.has(3), `${f} declares exit 3`).toBe(false);
      expect(exits.has(6), `${f} declares exit 6`).toBe(false);
      if (exits.has(7)) expect(c.command, `${f} declares exit 7`).toBe("jobs run");
    }
  });

  it("no handler source emits a retired exit code (EXIT.SECRET_SCAN / EXIT.ACTION_REQUIRED / literal 3|6)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (entry.endsWith(".ts")) {
          const code = readFileSync(p, "utf8")
            .split("\n")
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join("\n");
          for (const needle of ["EXIT.SECRET_SCAN", "EXIT.ACTION_REQUIRED", "process.exit(3", "process.exit(6"]) {
            if (code.includes(needle)) offenders.push(`${p}: ${needle}`);
          }
        }
      }
    };
    walk(CLI_SRC);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
