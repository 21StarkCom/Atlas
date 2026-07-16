/**
 * `crash-recovery.failpoints` (Task 4.11) — the failpoint suite GENERATED from
 * `recovery-state-machine.md`'s `stateTable`. Asserts the crash-recovery contract is fully
 * specified at every failpoint: a crash BEFORE and AFTER each progression checkpoint's atomic
 * write, and mid-write of every terminal (base + `failed@`/`cancelled@` suffixed). Each generated
 * failpoint must carry a complete recovery contract (idempotency anchor, recovery action, retained
 * artifacts, worktree cleanup); the matrix must be complete against the §2.5 state set; and the
 * committed matrix doc must not have drifted. The reconciler's runtime handling of these transitions
 * (integrated→finalized, mid-§2.8 crashes, orphaned-worktree sweep) is exercised by `workflows-core`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadStateTable,
  RECOVERY_CHECKPOINTS,
  RECOVERY_TERMINALS,
  FAILABLE_CHECKPOINTS,
} from "../../../tools/cli-contract.ts";
import {
  generateFailpoints,
  expectedFailpointCount,
  renderFailpointsDoc,
  FAILPOINTS_DOC_PATH,
  type Failpoint,
} from "../../../tools/gen-failpoints.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const TABLE = loadStateTable(REPO_ROOT);
const FPS = generateFailpoints(TABLE);
const byId = new Map(FPS.map((f) => [f.id, f]));

describe("crash-recovery failpoint matrix — completeness (Task 4.11)", () => {
  it("generates exactly the expected number of failpoints, all ids unique", () => {
    expect(FPS.length).toBe(expectedFailpointCount());
    expect(new Set(FPS.map((f) => f.id)).size).toBe(FPS.length);
  });

  it("every progression checkpoint contributes a crash BEFORE and AFTER its atomic write", () => {
    for (const cp of RECOVERY_CHECKPOINTS) {
      expect(byId.has(`${cp}@before-write`), `${cp} before-write`).toBe(true);
      expect(byId.has(`${cp}@after-write`), `${cp} after-write`).toBe(true);
      expect(byId.get(`${cp}@before-write`)!.kind).toBe("checkpoint");
    }
  });

  it("every terminal (base + failed@/cancelled@ suffixed) contributes a mid-write crash", () => {
    for (const t of RECOVERY_TERMINALS) expect(byId.has(`${t}@terminal-write`), `${t}`).toBe(true);
    for (const cp of FAILABLE_CHECKPOINTS) {
      expect(byId.has(`failed@${cp}@terminal-write`), `failed@${cp}`).toBe(true);
      expect(byId.has(`cancelled@${cp}@terminal-write`), `cancelled@${cp}`).toBe(true);
    }
  });

  it("the integration-hash idempotency anchor is present on BOTH sides of the integrated write", () => {
    const before = byId.get("integrated@before-write")!;
    const after = byId.get("integrated@after-write")!;
    // Both sides key recovery on the SAME durable idempotency anchor (the integration hash),
    // so a crash on either side converges to one canonical install (no lost/duplicate commit).
    expect(before.idempotencyCheck).toBe(after.idempotencyCheck);
    expect(before.idempotencyCheck.length).toBeGreaterThan(0);
    expect(after.nextStates).toContain("reindexed");
  });
});

describe("crash-recovery failpoint matrix — per-failpoint recovery contract (Task 4.11)", () => {
  it("every failpoint carries a complete, non-empty recovery contract", () => {
    for (const f of FPS) {
      expect(f.recoveryAction.trim().length, `${f.id} recoveryAction`).toBeGreaterThan(0);
      expect(f.idempotencyCheck.trim().length, `${f.id} idempotencyCheck`).toBeGreaterThan(0);
      expect(f.retainedArtifacts.length, `${f.id} retainedArtifacts`).toBeGreaterThan(0);
      expect(f.worktreeCleanup.trim().length, `${f.id} worktreeCleanup`).toBeGreaterThan(0);
      expect(f.expectedRecovery.trim().length, `${f.id} expectedRecovery`).toBeGreaterThan(0);
    }
  });

  it("checkpoint failpoints declare the next states recovery may advance to", () => {
    for (const f of FPS.filter((x) => x.kind === "checkpoint")) {
      expect(f.nextStates.length, `${f.id} nextStates`).toBeGreaterThan(0);
    }
  });

  it("terminal failpoints declare their run.* audit event and advance nowhere", () => {
    for (const f of FPS.filter((x) => x.kind === "terminal")) {
      expect(f.auditEmission, `${f.id} auditEmission`).toMatch(/^run\./);
      expect(f.nextStates, `${f.id} nextStates`).toEqual([]);
    }
  });
});

describe("crash-recovery failpoint matrix — load-bearing guarantees (Task 4.11)", () => {
  it("a stateTable row missing a recovery field cannot generate a failpoint (the generator refuses)", () => {
    for (const field of ["recoveryAction", "idempotencyCheck", "retainedArtifacts", "worktreeCleanup", "atomicWrite"]) {
      const mutated = { ...TABLE, states: TABLE.states.map((s, i) => (i === 0 ? { ...s, [field]: field === "retainedArtifacts" ? [] : "" } : s)) };
      expect(() => generateFailpoints(mutated as never), `dropping ${field}`).toThrow(new RegExp(field));
    }
  });

  it("the committed matrix doc matches the generator output (--check would be clean)", () => {
    const committed = readFileSync(join(REPO_ROOT, FAILPOINTS_DOC_PATH), "utf8");
    expect(renderFailpointsDoc(FPS)).toBe(committed);
  });

  it("every generated failpoint names a §2.5 state the reconciler recognizes", () => {
    const known = new Set<string>([
      ...RECOVERY_CHECKPOINTS,
      ...RECOVERY_TERMINALS,
      ...FAILABLE_CHECKPOINTS.flatMap((cp) => [`failed@${cp}`, `cancelled@${cp}`]),
    ]);
    for (const f of FPS as Failpoint[]) expect(known.has(f.state), `${f.id} → ${f.state}`).toBe(true);
  });
});
