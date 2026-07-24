/**
 * `no-retired-reference` (v2 #335) — the machine proof that the demolition is
 * complete on SEMANTICS, not just imports. It greps every RUNTIME source file for
 * a reference to a retired package, socket path, env var, canonical-ref
 * indirection, or a surviving retired-semantic symbol, and fails on any hit.
 *
 * Scope: apps-slash-src, packages-slash-src, and the runtime tools .ts files —
 * EXCLUDING tests (.test.ts), the immutable migration DDL under
 * packages/sqlite-store/migrations (append-only checksum-guarded historical
 * vocabulary), and the EXEMPT set below. COMMENT lines are excluded (a retired
 * term may be NAMED in a "this is retired" note); only executable code is matched
 * — the discipline mutation-order.routing already uses.
 *
 * The gate self-tests: a planted retired reference fails; a clean tree passes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "./cli-contract.js";

const root = findRepoRoot();

/**
 * The EXEMPT paths (repo-relative), the single locations permitted to name a
 * retired resource: the deprovision allowlist enumerates the retired Keychain
 * items to delete (§intent success criteria); the canonical-ref cutover artifact
 * names the old ref until its Phase-5 deletion; and this gate + its self-test.
 */
const EXEMPT = new Set<string>([
  "provisioning/macos/deprovision-macos.sh",
  "provisioning/deprovision-allowlist.txt",
  "tools/cutover-canonical-ref.ts",
  "tools/no-retired-reference.test.ts",
]);

/** Roots swept for runtime source. */
const SWEEP_ROOTS = ["apps", "packages", "tools"];

/** A source dir is skipped wholesale (never runtime, or immutable vocabulary). */
function skipDir(rel: string): boolean {
  return (
    rel.endsWith("/node_modules") ||
    rel.endsWith("/dist") ||
    rel === "packages/sqlite-store/migrations" ||
    rel.endsWith("/test") ||
    rel.endsWith("/tests")
  );
}

/** Every runtime `.ts` file under the sweep roots (tests + dist + migrations excluded). */
function runtimeSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs)) {
      const childAbs = join(abs, entry);
      const childRel = rel === "" ? entry : `${rel}/${entry}`;
      if (statSync(childAbs).isDirectory()) {
        if (!skipDir(childRel)) walk(childAbs, childRel);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
        if (!EXEMPT.has(childRel)) out.push(childRel);
      }
    }
  };
  for (const r of SWEEP_ROOTS) walk(join(root, r), r);
  return out;
}

/** A file's EXECUTABLE lines — drops `//`, `*`, `/*` leading-comment lines (the
 * `mutation-order.routing` rule) so a retired term named in a doc note is allowed. */
function codeLines(rel: string): string {
  return readFileSync(join(root, rel), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

/**
 * The retired references. Each is a substring matched against a file's executable
 * lines. Killed-package imports + transport/custody knobs + canonical-ref
 * indirection + the retired semantic symbols (ADR-0003 / #326 / #333 / #334 / #335).
 */
const FORBIDDEN: readonly { needle: string; why: string }[] = [
  { needle: "@atlas/broker", why: "the broker package is retired" },
  { needle: "@atlas/scan", why: "the scan package is retired" },
  { needle: "ATLAS_EGRESS_CAPABILITY_KEY", why: "the egress capability custody is retired" },
  { needle: "ATLAS_CANONICAL_REF", why: "the canonical-ref indirection is retired (canonical IS refs/heads/main)" },
  { needle: "refs/atlas/main", why: "the adopted-vault canonical ref is retired (canonical IS refs/heads/main)" },
  { needle: "git.canonical_ref", why: "the config canonical-ref field is retired" },
  { needle: "DEFAULT_CANONICAL_REF", why: "the canonical-ref indirection helper is retired" },
  { needle: "effectiveRisk", why: "the risk-tier gate is retired" },
  { needle: "mutationPolicyFor", why: "the mutation-policy tier machinery is retired" },
  { needle: "GeneratedArtifactGuard", why: "the scan guards are retired" },
  { needle: "PrePersistenceGuard", why: "the scan guards are retired" },
  { needle: "assertClean", why: "the scan-before-persist gate is retired" },
  { needle: "inputsTrusted", why: "the trust-taint machinery is retired" },
  { needle: "evidenceValid", why: "the trust-taint machinery is retired" },
  { needle: "PromoteTrust", why: "the trust mutation ops are retired" },
  { needle: "RevokeTrust", why: "the trust mutation ops are retired" },
  { needle: "makeBrokerIntegrator", why: "the Phase-2 broker integrator is retired" },
  { needle: "brokerSignedIntegration", why: "the Phase-2 broker integrator is retired" },
  { needle: "makeInProcessBrokerClient", why: "the Phase-2 broker client is retired" },
  { needle: '"review-pending"', why: "the Tier-3 review park is retired" },
  { needle: "'review-pending'", why: "the Tier-3 review park is retired" },
  { needle: '"review_pending"', why: "the Tier-3 review park is retired" },
  { needle: "'review_pending'", why: "the Tier-3 review park is retired" },
  { needle: '"tier-3"', why: "the Tier-3 review tier is retired" },
  { needle: "'tier-3'", why: "the Tier-3 review tier is retired" },
];

describe("no-retired-reference gate (v2 #335)", () => {
  const files = runtimeSourceFiles();

  it("sweeps a non-trivial runtime surface", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no runtime source references a retired package / knob / semantic symbol", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const code = codeLines(rel);
      for (const { needle, why } of FORBIDDEN) {
        if (code.includes(needle)) offenders.push(`${rel}: "${needle}" — ${why}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  // ── self-test: the gate actually catches a planted reference ────────────────
  it("a planted retired reference WOULD fail (the gate is not vacuous)", () => {
    const planted = `import { PrePersistenceGuard } from "@atlas/scan";\nconst x = "tier-3";\n`;
    const hits = FORBIDDEN.filter((f) => planted.includes(f.needle)).map((f) => f.needle);
    expect(hits).toEqual(expect.arrayContaining(["@atlas/scan", "PrePersistenceGuard", '"tier-3"']));
  });

  it("a COMMENT naming a retired term is allowed (only executable code is matched)", () => {
    // This very line names PrePersistenceGuard and "tier-3" in a comment; the gate
    // must not flag this test file's own prose (it is EXEMPT regardless, but the
    // codeLines() filter is what makes the allowance general).
    const commentOnly = ` * the retired PrePersistenceGuard and "tier-3" park`;
    const stripped = commentOnly
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(stripped).toBe("");
  });
});
