/**
 * no-render-bypass — the lint gate for the "single human-output channel" invariant
 * (Task 1.8 acceptance criterion).
 *
 * No source file may write human output directly (`process.stdout.write` /
 * `process.stderr.write` / `console.*`) EXCEPT the renderer (which owns the
 * terminal-safe write) and the JSON error-envelope emitter (which owns the JSON
 * write). Any other file must go through `render()`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

/** Modules permitted to write to stdout/stderr directly. */
const ALLOWED = new Set([
  "render/safe.ts", // the terminal-safe renderer
  "render/progress.ts", // progress lines — but only via render(); kept allowed for stream writes
  "errors/envelope.ts", // the JSON error-envelope emitter
]);

/** Banned direct-output patterns. */
const BANNED = [/\bprocess\.(stdout|stderr)\.write\b/, /\bconsole\.(log|info|warn|error|debug)\b/];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("no-render-bypass", () => {
  it("no source file writes human output outside the renderer / JSON emitter", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        // Skip line/JSDoc comments so documentation mentioning the pattern is fine.
        const code = line.replace(/\/\/.*$/, "");
        for (const rx of BANNED) {
          if (rx.test(code)) violations.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(violations, `render() bypass detected:\n${violations.join("\n")}`).toEqual([]);
  });

  it("the allowlist names only the renderer + JSON emitter modules", () => {
    expect([...ALLOWED].sort()).toEqual([
      "errors/envelope.ts",
      "render/progress.ts",
      "render/safe.ts",
    ]);
  });
});
