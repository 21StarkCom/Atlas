/**
 * mutation-order.routing.test.ts (#325) — the routing conformance source gate.
 *
 * Proves, by SOURCE audit over `apps/cli/src`, that:
 *  1. NO source file calls the retired Phase-2 integration factories
 *     (`makeBrokerIntegrator` / `brokerSignedIntegration` / `makeInProcessBrokerClient`);
 *  2. the common mutation-order wrapper exists and exposes `runMutation`;
 *  3. `note add` routes its mutation through that wrapper (`runMutation`);
 *  4. every surviving synthesis mutation entry point (enrich / maintain / reconcile
 *     / evidence resolve) routes its apply through `applySynthesis`, which installs
 *     canonical via the common `runMutation` + direct `commitPaths` order — never a
 *     Phase-2 broker-CAS factory.
 *
 * The forbidden-factory scan mirrors `tools/verify-325.sh` gate 3 (comment-only
 * lines excluded), so this test and the acceptance harness cannot diverge.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const FORBIDDEN = ["makeBrokerIntegrator", "brokerSignedIntegration", "makeInProcessBrokerClient"] as const;

/** Every `.ts` file under `apps/cli/src`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** A file's non-comment lines (drops `//` / `*` / `/*` leading lines — the harness rule). */
function codeLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

describe("mutation-order routing conformance (#325)", () => {
  it("no source file calls a retired Phase-2 integration factory", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const code = codeLines(file).join("\n");
      for (const name of FORBIDDEN) {
        if (code.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the common mutation-order wrapper exposes runMutation + commitPaths + the HEAD/dirty gates", () => {
    const wrapper = read("workflows/mutation-order.ts");
    expect(wrapper).toContain("export async function runMutation");
    expect(wrapper).toContain("commitPaths(");
    expect(wrapper).toContain("assertHeadOnMain");
    expect(wrapper).toContain("assertNotDirty");
  });

  it("note add routes its mutation through runMutation", () => {
    const noteAdd = read("ingest/note-add.ts");
    expect(noteAdd).toContain("runMutation");
    expect(noteAdd).toContain('from "../workflows/mutation-order.js"');
  });

  it("every synthesis entry point routes its apply through applySynthesis, never a Phase-2 factory", () => {
    for (const rel of ["commands/enrich.ts", "commands/maintain.ts", "commands/reconcile.ts", "commands/evidence-resolve.ts"]) {
      const src = read(rel);
      expect(src, rel).toContain("applySynthesis");
      for (const name of FORBIDDEN) expect(codeLines(join(SRC, rel)).join("\n"), `${rel} uses ${name}`).not.toContain(name);
    }
  });

  it("applySynthesis installs canonical via the common runMutation + direct commitPaths order", () => {
    const synth = read("workflows/synthesis.ts");
    expect(synth).toContain("runMutation");
    expect(synth).toContain('from "./mutation-order.js"');
    for (const name of FORBIDDEN) expect(codeLines(join(SRC, "workflows/synthesis.ts")).join("\n"), `synthesis.ts uses ${name}`).not.toContain(name);
  });

  it("no source references the folded-out canonical-ref indirection", () => {
    const banned = [/git\.canonical_ref/, /refs\/atlas\/main/, /ATLAS_CANONICAL_REF/, /config\/canonical-ref/];
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const code = codeLines(file).join("\n");
      for (const re of banned) if (re.test(code)) offenders.push(`${file}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });
});
