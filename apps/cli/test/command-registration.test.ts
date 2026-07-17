/**
 * `command-registration.test` — every `implemented: true` row in the canonical
 * `commands.json` registry MUST have a handler registered by the command barrel
 * (the exact import path `main.ts` dispatches through). Guards the #145 failure
 * class: a typo'd `registerCommand` name or a dropped barrel import would merge
 * green with `implemented: true` and die at the live drive as `not-implemented`.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/commands/index.js"; // the registration barrel main.ts imports before dispatch
import { HANDLERS } from "../src/handlers.js";
import { loadRegistry } from "../src/router.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("command registration (implemented:true ⇒ handler registered)", () => {
  it("every implemented registry row has a HANDLERS entry", () => {
    const registry = loadRegistry(REPO_ROOT);
    const implemented = registry.commands.filter((c) => c.implemented).map((c) => c.name);
    expect(implemented.length).toBeGreaterThan(0); // the registry is never empty — a 0 here means it failed to load
    const missing = implemented.filter((name) => !HANDLERS.has(name));
    expect(missing).toEqual([]);
  });
});
