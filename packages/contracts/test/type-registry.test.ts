import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveType, classificationToSensitivity, isRegisteredType,
  STRICT_TYPES, LOOSE_TYPES, SCHEMA_VERSION, MANAGED_FRONTMATTER,
} from "../src/type-registry.js";

const TAXO = JSON.parse(readFileSync(new URL("./fixtures/vault-taxonomy.json", import.meta.url), "utf8"));

describe("type-registry — exact membership", () => {
  it("registers EXACTLY the 15 expected names (12 vault + 3 V1 compat)", () => {
    expect([...STRICT_TYPES].sort()).toEqual(
      [...TAXO.strictTypes, ...TAXO.v1CompatStrict].sort());
    expect([...LOOSE_TYPES].sort()).toEqual(
      [...TAXO.looseTypes, ...TAXO.v1CompatLoose].sort());
    expect(new Set([...STRICT_TYPES, ...LOOSE_TYPES]).size).toBe(15);
  });
  it("V1 compat: concept/source are STRICT, note is LOOSE, all three registered", () => {
    expect(resolveType("concept").tier).toBe("strict");
    expect(resolveType("source").tier).toBe("strict");
    expect(resolveType("note").tier).toBe("loose");
    for (const t of ["concept", "source", "note"]) expect(isRegisteredType(t)).toBe(true);
  });
  it("every vault strict type resolves strict; every vault loose type resolves loose", () => {
    for (const t of TAXO.strictTypes) expect(resolveType(t)).toMatchObject({ name: t, tier: "strict" });
    for (const t of TAXO.looseTypes) expect(resolveType(t)).toMatchObject({ name: t, tier: "loose" });
  });
  it("an UNKNOWN type is accepted as a loose def keeping its name (open registry)", () => {
    expect(resolveType("podcast")).toEqual({ name: "podcast", tier: "loose", defaultSensitivity: "internal" });
    expect(isRegisteredType("podcast")).toBe(false);
  });
  it("empty/whitespace/absent type defaults to loose 'note'; whitespace is trimmed", () => {
    expect(resolveType("")).toMatchObject({ name: "note", tier: "loose" });
    expect(resolveType("   ")).toMatchObject({ name: "note", tier: "loose" });
    expect(resolveType(null)).toMatchObject({ name: "note", tier: "loose" });
    expect(resolveType("  repo  ")).toMatchObject({ name: "repo", tier: "strict" });
  });
  it("maps classification to sensitivity (public→public, else→internal; never above internal)", () => {
    expect(classificationToSensitivity("public")).toBe("public");
    expect(classificationToSensitivity("personal")).toBe("internal");
    expect(classificationToSensitivity("internal")).toBe("internal");
    expect(classificationToSensitivity(undefined)).toBe("internal");
    expect(classificationToSensitivity("weird")).toBe("internal");
  });
  it("SCHEMA_VERSION is a positive integer and MANAGED_FRONTMATTER is the emit order", () => {
    expect(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1).toBe(true);
    expect(MANAGED_FRONTMATTER[0]).toBe("id");
    expect(MANAGED_FRONTMATTER).toContain("declaredSensitivity");
  });
});

import { existsSync } from "node:fs";

describe("type-registry ↔ canonical taxonomy drift (unconditional CI gate)", () => {
  it("registry tiers match the checked-in canonical taxonomy fixture EXACTLY", () => {
    for (const t of [...TAXO.strictTypes, ...TAXO.v1CompatStrict]) expect(resolveType(t), `strict ${t}`).toMatchObject({ tier: "strict" });
    for (const t of [...TAXO.looseTypes, ...TAXO.v1CompatLoose]) expect(resolveType(t), `loose ${t}`).toMatchObject({ tier: "loose" });
    // no extra registrations beyond the fixture
    const expected = new Set([...TAXO.strictTypes, ...TAXO.v1CompatStrict, ...TAXO.looseTypes, ...TAXO.v1CompatLoose]);
    for (const t of [...STRICT_TYPES, ...LOOSE_TYPES]) expect(expected.has(t), `unexpected registration ${t}`).toBe(true);
  });
});

describe("type-registry ↔ live Vault Schema.md (optional, informational)", () => {
  const SCHEMA = process.env.ATLAS_VAULT_SCHEMA ?? "/Users/aryeh/Code/Vaults/main-vault/00_System/Vault Schema.md";
  it.runIf(existsSync(SCHEMA))("live schema still matches the canonical fixture (edit the fixture if this fails)", () => {
    const md = readFileSync(SCHEMA, "utf8");
    const section = (h: string) => (md.split(`## ${h}`)[1] ?? "").split("\n## ")[0];
    const listed = (h: string) => [...section(h).matchAll(/^-\s+([a-z-]+)\s*$/gm)].map((m) => m[1]!);
    const liveStrict = listed("Strict note types");
    const liveLoose = listed("Loose note types");
    if (liveStrict.length) expect(new Set(liveStrict)).toEqual(new Set(TAXO.strictTypes));
    if (liveLoose.length) expect(new Set(liveLoose)).toEqual(new Set(TAXO.looseTypes));
  });
});
