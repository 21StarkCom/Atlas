/**
 * `contracts.operations.test` — the Phase-2 op-schema seam contract (Task 2.0).
 *
 * Two guarantees:
 *   1. Every operation in `CHANGE_PLAN_OPS` (all 15) has a validating sample that
 *      the `ChangePlanSchema` union accepts, and the union covers exactly those
 *      op names — no missing member, no stray.
 *   2. Each op sample round-trips canonical serialization BYTE-IDENTICALLY across
 *      SEPARATE node processes. Byte-identity across the CLI/broker seam is THE
 *      hard contract: the CLI mints a plan and the broker independently
 *      re-derives + re-verifies it, so the two processes must agree to the byte.
 *      We spawn a serialization worker (a distinct process importing the built
 *      dist) TWICE and assert its stdout is identical run-to-run, and that it
 *      equals the vitest process's own in-process serialization — three
 *      independent processes, one canonical form.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";
import {
  canonicalSerialize,
  ChangePlanSchema,
  CHANGE_PLAN_OPS,
  CHANGE_PLAN_OPERATION_NAMES,
} from "../src/index.js";
// The fixtures are plain data (no Zod) so the worker process and this process
// serialize the exact same objects.
// @ts-ignore — .mjs fixture has no type declarations; shape is asserted at runtime.
import { OP_SAMPLES } from "./op-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const distIndex = join(pkgRoot, "dist", "index.js");
const worker = join(here, "serialize-op-worker.mjs");

/** Newest mtime under a directory tree (for a cheap staleness check). */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    const m = entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs;
    if (m > newest) newest = m;
  }
  return newest;
}

beforeAll(() => {
  // The worker imports the compiled dist. In the graded flow `pnpm -r build`
  // runs first; when running the suite standalone, build (or rebuild if stale)
  // so the worker sees the current op schemas.
  const stale = !existsSync(distIndex) || newestMtime(join(pkgRoot, "src")) > statSync(distIndex).mtimeMs;
  if (stale) {
    execFileSync("pnpm", ["-s", "build"], { cwd: pkgRoot, stdio: "inherit" });
  }
}, 120_000);

function runWorker(): string {
  return execFileSync(process.execPath, [worker], { cwd: pkgRoot, encoding: "utf8" });
}

const samples = OP_SAMPLES as unknown[];

/**
 * The finalized 12-op ChangePlan union (v2 contract demolition + the #337
 * persistence strip that retired the rendition-pinned claims/evidence ops) written
 * as a LITERAL tuple — the anti-drift anchor. Comparing the two coupled internal
 * lists to each other would pass even if a finalized op were swapped out in BOTH;
 * pinning to this literal set catches that. The retired trust ops
 * (`PromoteTrust`/`RevokeTrust`) and the retired claims/evidence ops
 * (`CreateClaim`/`AttachEvidence`/`UpdateEvidenceVerification`) must be absent from
 * every surface.
 */
const FINALIZED_12_OPS = [
  "AddAlias",
  "AppendSection",
  "CreateNote",
  "CreateRelationship",
  "CreateTask",
  "ProposeArchive",
  "ProposeMerge",
  "ProposeRename",
  "SetFrontmatterField",
  "SetLink",
  "UpdateSection",
  "UpdateTaskState",
].sort();
const RETIRED_TRUST_OPS = ["PromoteTrust", "RevokeTrust"];
const RETIRED_EVIDENCE_OPS = ["CreateClaim", "AttachEvidence", "UpdateEvidenceVerification"];

describe("op sample coverage", () => {
  it("the union declares EXACTLY the 12 finalized op names (literal), trust + evidence ops absent", () => {
    // Pin both the name list and the union to a LITERAL tuple, not to each other.
    expect([...CHANGE_PLAN_OPS].sort()).toEqual(FINALIZED_12_OPS);
    expect([...CHANGE_PLAN_OPERATION_NAMES].sort()).toEqual(FINALIZED_12_OPS);
    expect(CHANGE_PLAN_OPS.length).toBe(12);
    // The retired claims/evidence ops are gone from the name list AND the union.
    for (const op of RETIRED_EVIDENCE_OPS) {
      expect(CHANGE_PLAN_OPS as readonly string[]).not.toContain(op);
      expect(CHANGE_PLAN_OPERATION_NAMES as readonly string[]).not.toContain(op);
    }
    // The retired trust ops are gone from the name list AND the runtime union.
    for (const op of RETIRED_TRUST_OPS) {
      expect(CHANGE_PLAN_OPS as readonly string[]).not.toContain(op);
      expect(CHANGE_PLAN_OPERATION_NAMES as readonly string[]).not.toContain(op);
    }
  });

  it("rejects a retired trust op as an unknown discriminant, and drops its public exports", async () => {
    const base = ChangePlanSchema.parse(samples[0]);
    for (const op of RETIRED_TRUST_OPS) {
      expect(() => ChangePlanSchema.parse({ ...base, operation: { op, opVersion: 1 } })).toThrow();
    }
    // The op-schema/result exports the retired ops carried are no longer part of
    // the public surface (byte-source demolition, not merely union-narrowing).
    const contracts = (await import("../src/index.js")) as Record<string, unknown>;
    for (const name of [
      "PromoteTrustOpSchema",
      "RevokeTrustOpSchema",
      "PromoteTrustResult",
      "RevokeTrustResult",
    ]) {
      expect(contracts[name], `export ${name} must be absent`).toBeUndefined();
    }
  });

  it("has exactly one validating sample per op", () => {
    const covered = new Set<string>();
    for (const s of samples) {
      const plan = ChangePlanSchema.parse(s); // throws if invalid
      covered.add(plan.operation.op);
    }
    expect([...covered].sort()).toEqual([...CHANGE_PLAN_OPS].sort());
    expect(samples.length).toBe(CHANGE_PLAN_OPS.length);
  });

  it("rejects an unknown op discriminant and unknown payload keys", () => {
    const base = ChangePlanSchema.parse(samples[0]);
    expect(() => ChangePlanSchema.parse({ ...base, operation: { op: "NotAnOp", opVersion: 1 } })).toThrow();
    expect(() =>
      ChangePlanSchema.parse({ ...base, operation: { ...base.operation, stowaway: true } }),
    ).toThrow();
  });

  it("rejects an unknown TOP-LEVEL envelope field (R3-F2: strict envelope, no silent strip)", () => {
    const base = ChangePlanSchema.parse(samples[0]);
    expect(() => ChangePlanSchema.parse({ ...base, stowaway: true })).toThrow();
  });
});

describe("per-op cross-field invariants are rejected in-schema (R3-F3)", () => {
  // Locate a valid sample per op so each negative case mutates a known-good base.
  const byOp = new Map<string, Record<string, unknown>>();
  for (const s of samples as Record<string, unknown>[]) {
    byOp.set((s.operation as { op: string }).op, s);
  }
  const mutateOp = (op: string, patch: Record<string, unknown>, drop: string[] = []) => {
    const base = byOp.get(op)!;
    const operation = { ...(base.operation as Record<string, unknown>), ...patch };
    for (const k of drop) delete operation[k];
    return { ...base, operation };
  };

  it("SetFrontmatterField: mode=update without expectedCurrentValueHash is rejected", () => {
    expect(() =>
      ChangePlanSchema.parse(mutateOp("SetFrontmatterField", { mode: "update" }, ["expectedCurrentValueHash"])),
    ).toThrow();
  });

  it("SetFrontmatterField: mode=add carrying expectedCurrentValueHash is rejected", () => {
    expect(() =>
      ChangePlanSchema.parse(mutateOp("SetFrontmatterField", { mode: "add", expectedCurrentValueHash: "sha256:" + "a".repeat(64) })),
    ).toThrow();
  });

  it("SetFrontmatterField: targeting the immutable 'id' field is rejected", () => {
    expect(() => ChangePlanSchema.parse(mutateOp("SetFrontmatterField", { field: "id" }))).toThrow();
  });

  it("ProposeRename: an empty rename (no rename fields) is rejected", () => {
    expect(() =>
      ChangePlanSchema.parse(
        mutateOp("ProposeRename", {}, ["newTitle", "newSlug", "newFilename", "newAliases"]),
      ),
    ).toThrow();
  });
});

describe("byte-identical canonical serialization across processes", () => {
  it("two separate worker processes emit identical stdout", () => {
    const a = runWorker();
    const b = runWorker();
    expect(a).toBe(b);
    // one hash line per op + the two trailing rejection lines (payload + top-level).
    expect(a.trim().split("\n").length).toBe(CHANGE_PLAN_OPS.length + 2);
  });

  it("the worker's parse-then-serialize hashes equal this process's, and it rejects unknown keys", () => {
    // Parse INDEPENDENTLY in this process too, then serialize the validated value
    // — the seam contract is over parsed ChangePlans, not raw fixtures.
    const expected = samples
      .map((s, i) => {
        const parsed = ChangePlanSchema.parse(s);
        const hex = createHash("sha256").update(canonicalSerialize(parsed)).digest("hex");
        return `${i}\t${parsed.operation.op}\t${hex}`;
      })
      .concat(["unknown-key-rejected\ttrue", "toplevel-unknown-key-rejected\ttrue"])
      .join("\n");
    expect(runWorker().trim()).toBe(expected.trim());
  });

  it("parsing then serializing is byte-stable and independent of raw key order", () => {
    for (const s of samples) {
      const parsed = ChangePlanSchema.parse(s);
      // canonical form of the parsed value is deterministic call-to-call…
      expect(canonicalSerialize(parsed)).toEqual(canonicalSerialize(parsed));
      // …and equals the canonical form of the raw fixture (key order is normalized away).
      expect(canonicalSerialize(parsed)).toEqual(canonicalSerialize(s));
    }
  });
});
