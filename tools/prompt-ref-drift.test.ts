import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROMPT_REGISTRY, PROMPT_REFS } from "@atlas/models";
import { findRepoRoot } from "./cli-contract.js";

/**
 * #210 — prompt-ref drift gate. The CLI once sent the hand-typed ref
 * "synthesis-plan" that no registry entry backed, so every synthesis command
 * (enrich/reconcile/maintain/git refresh) died at the FIRST live provider call
 * with `unknown prompt reference` while the in-process suites (which stub the
 * plan generator) stayed green. This test binds the two sides at CI time:
 * every ref the CLI can send must resolve in the PRODUCTION registry, and call
 * sites must go through the PROMPT_REFS SSOT, never a string literal.
 *
 * Post the Phase-2 in-process cutover the production prompt registry is the
 * in-process `@atlas/models` one the runtime adapter resolves against — NOT the
 * (now vestigial, Phase-3-deleted) `@atlas/broker` copy. Targeting the broker copy
 * would let the gate pass while the runtime registry rejects a CLI prompt.
 */

const root = findRepoRoot();

/** Every production .ts file under apps/cli/src (test/ is excluded by location). */
function cliSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(p);
    }
  };
  walk(join(root, "apps/cli/src"));
  return out;
}

describe("prompt-ref drift (#210)", () => {
  it("every PROMPT_REFS value resolves in the egress registry and follows the naming rule", () => {
    for (const [name, ref] of Object.entries(PROMPT_REFS)) {
      // provider-interface.md: `prompts/<name>@<n>`, never inline.
      expect(ref, `PROMPT_REFS.${name}`).toMatch(/^prompts\/[a-z0-9-]+@[1-9][0-9]*$/);
      const resolved = DEFAULT_PROMPT_REGISTRY.resolve(ref);
      expect(resolved, `PROMPT_REFS.${name} (${ref}) must be registered`).toBeDefined();
      expect(resolved!.content.length, `${ref} content must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("no CLI call site sends a string-literal prompt ref — refs come through the SSOT", () => {
    const literalCallSite = /prompt:\s*\{\s*ref:\s*["'`]/;
    for (const file of cliSourceFiles()) {
      const src = readFileSync(file, "utf8");
      expect(literalCallSite.test(src), `${file} sends a literal prompt ref — import PROMPT_REFS instead`).toBe(false);
    }
  });

  it("every string literal inside a ref EXPRESSION resolves — including the `?? \"fallback\"` form #210 took", () => {
    // #210's exact shape was `prompt: { ref: deps.promptRef ?? "synthesis-plan" }` —
    // a literal buried in an expression, invisible to the direct-literal check above.
    // Extract every ref/promptRef expression and require each embedded string
    // literal to resolve in the egress registry.
    const refExpr = /(?:prompt:\s*\{\s*ref:|promptRef(?:\s*:\s*|\s*\?\?\s*))([^,}\n]*)/g;
    const stringLiteral = /["'`]([^"'`]+)["'`]/g;
    for (const file of cliSourceFiles()) {
      const src = readFileSync(file, "utf8");
      for (const expr of src.matchAll(refExpr)) {
        for (const lit of expr[1]!.matchAll(stringLiteral)) {
          expect(
            DEFAULT_PROMPT_REGISTRY.resolve(lit[1]!),
            `${file}: ref expression embeds unregistered literal "${lit[1]}"`,
          ).toBeDefined();
        }
      }
    }
  });

  it("no synthesis command passes the per-RUN egress ceiling as the per-CALL plan maxTokens (#210 layer 2)", () => {
    // `maxTokens: EGRESS.maxTokens` inside a makeModelPlanGenerator deps block made
    // the egress projection (input + maxTokens) exceed the ceiling by construction —
    // every synthesis command structurally refused. The per-call cap must be the
    // PLAN_GENERATION_MAX_TOKENS constant (or another sub-ceiling value), never the
    // run ceiling itself.
    // Tempered: the capability limits inside `mintCapability` legitimately carry
    // EGRESS.maxTokens (the per-run ceiling the capability enforces) — only the
    // DEPS-level maxTokens (everything before `mintCapability`) is the per-call cap.
    const planDepsWithCeiling = /makeModelPlanGenerator\(\s*\{(?:(?!mintCapability)[\s\S]){0,400}?maxTokens:\s*EGRESS\./;
    for (const file of cliSourceFiles()) {
      const src = readFileSync(file, "utf8");
      expect(
        planDepsWithCeiling.test(src),
        `${file} passes the per-run egress ceiling (EGRESS.maxTokens) as the plan-generation per-call cap`,
      ).toBe(false);
    }
  });

  it("every prompts/…@n literal anywhere in apps/cli/src resolves in the registry", () => {
    const refLiteral = /["'`](prompts\/[a-z0-9-]+@[0-9]+)["'`]/g;
    for (const file of cliSourceFiles()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(refLiteral)) {
        expect(
          DEFAULT_PROMPT_REGISTRY.resolve(m[1]!),
          `${file} references ${m[1]} which the egress registry does not resolve`,
        ).toBeDefined();
      }
    }
  });

  it("regression pin: the bare ref that caused #210 appears nowhere in apps/cli/src", () => {
    for (const file of cliSourceFiles()) {
      const src = readFileSync(file, "utf8");
      expect(src.includes('"synthesis-plan"'), `${file} contains the unregistered bare ref "synthesis-plan"`).toBe(false);
    }
  });

  // The runtime provider path resolves prompts against @atlas/models (above). The
  // @atlas/broker copy is now a vestigial compatibility shim (Phase-3-deleted) and
  // cannot import @atlas/models without pulling @atlas/sqlite-store into the
  // ledger-free broker (invariant #2). So this gate mechanically DERIVES the broker
  // copy from the models SSOT: any divergence in refs or content fails CI, which
  // keeps the two byte-identical until the broker copy is deleted — a stale broker
  // copy can never silently mask a runtime rejection.
});
