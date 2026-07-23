/**
 * locks.conflict-matrix — coexistence, ordering, and dead-pid auto-reclaim (v2, #333).
 *
 * Two independent managers over the SAME lock dir stand in for two processes.
 * `isAlive` is injected so liveness is deterministic (no real forking).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLockManager,
  LOCK_SCOPES,
  lockRank,
  subsumes,
  scopesConflict,
  type LockScope,
  type LockManager,
} from "../src/locks/manager.js";
import { CliError } from "../src/errors/envelope.js";

let dir: string;
const ALIVE = new Set<number>();
const isAlive = (pid: number): boolean => ALIVE.has(pid);

function mgr(pid: number): LockManager {
  ALIVE.add(pid);
  return createLockManager({ dir, pid, isAlive, now: () => "2026-07-12T00:00:00.000Z" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-locks-"));
  ALIVE.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function expectLocked(fn: () => Promise<unknown>, scope: LockScope): Promise<CliError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    const ce = e as CliError;
    expect(ce.code).toBe(`locked:${scope}`);
    expect(ce.exitCode).toBe(2);
    return ce;
  }
  throw new Error(`expected locked:${scope}`);
}

describe("locks.conflict-matrix", () => {
  it("a second live holder of the SAME scope fails with locked:<scope> (exit 2)", async () => {
    const a = mgr(101);
    const b = mgr(102);
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    const held = a.withLock("vault-maintenance", async () => {
      await gate;
    });
    // While a holds it, b cannot acquire.
    const err = await expectLocked(
      () => b.withLock("vault-maintenance", async () => undefined),
      "vault-maintenance",
    );
    expect(err.details).toMatchObject({ scope: "vault-maintenance", holderPid: 101 });
    expect(err.retryable).toBe(true);
    released();
    await held;
    // Now b can acquire.
    await b.withLock("vault-maintenance", () => undefined);
  });

  // The normative cross-process conflict matrix (design §process-concurrency): the
  // four exclusive scopes form a single containment chain, so a live foreign holder
  // of ANY scope excludes acquisition of ANY comparable scope — not just an
  // identical name. We assert both directions of the load-bearing pairs.
  const CONFLICT_PAIRS: Array<[LockScope, LockScope]> = [
    // vault-maintenance (broadest) must exclude every narrower mutation, and be
    // excluded by any of them held first — incl. an ordinary canonical mutation.
    ["vault-maintenance", "canonical-integration"],
    ["canonical-integration", "vault-maintenance"],
    ["vault-maintenance", "ledger-maintenance"],
    ["vault-maintenance", "jobs-runner"],
    ["ledger-maintenance", "canonical-integration"],
    ["canonical-integration", "ledger-maintenance"],
    ["ledger-maintenance", "jobs-runner"],
    ["jobs-runner", "canonical-integration"],
    ["canonical-integration", "jobs-runner"],
  ];

  for (const [held, wanted] of CONFLICT_PAIRS) {
    it(`a live holder of ${held} blocks acquiring ${wanted} (locked:${held}, exit 2)`, async () => {
      const a = mgr(200);
      const b = mgr(300);
      let free!: () => void;
      const gate = new Promise<void>((r) => (free = r));
      const running = a.withLock(held, async () => {
        await gate;
      });
      await expectLocked(() => b.withLock(wanted, async () => undefined), held);
      free();
      await running;
      // Once released, the previously-blocked scope is acquirable.
      await b.withLock(wanted, () => undefined);
    });
  }

  it("scopesConflict matches the total-chain matrix (all named pairs conflict)", () => {
    for (const a of LOCK_SCOPES) {
      for (const b of LOCK_SCOPES) {
        expect(scopesConflict(a, b)).toBe(true);
      }
    }
    // Containment direction: a broader scope subsumes a narrower one (and itself).
    expect(subsumes("vault-maintenance", "canonical-integration")).toBe(true);
    expect(subsumes("canonical-integration", "vault-maintenance")).toBe(false);
    expect(subsumes("jobs-runner", "jobs-runner")).toBe(true);
  });

  it("a broader lock and a narrower lock NEST within the SAME process", async () => {
    // The matrix conflict is CROSS-process only; one process legally nests
    // broad→narrow (that is the global acquisition order).
    const a = mgr(250);
    await a.withLock("vault-maintenance", async () => {
      await a.withLock("canonical-integration", () => {
        expect(a.heldScopes()).toEqual(["vault-maintenance", "canonical-integration"]);
      });
    });
  });

  it("enforces the GLOBAL order: nesting must go broad → narrow", async () => {
    const a = mgr(301);
    // vault-maintenance ⊐ ledger-maintenance ⊐ jobs-runner ⊐ canonical-integration
    await a.withLock("vault-maintenance", async () => {
      await a.withLock("ledger-maintenance", async () => {
        await a.withLock("canonical-integration", () => {
          expect(a.heldScopes()).toEqual([
            "vault-maintenance",
            "ledger-maintenance",
            "canonical-integration",
          ]);
        });
      });
    });
  });

  it("rejects out-of-order nesting as an internal error (exit 4)", async () => {
    const a = mgr(302);
    await a.withLock("canonical-integration", async () => {
      await expect(
        a.withLock("vault-maintenance", () => undefined),
      ).rejects.toMatchObject({ code: "internal", exitCode: 4 });
    });
  });

  it("releases the lock even when the body throws", async () => {
    const a = mgr(401);
    await expect(
      a.withLock("ledger-maintenance", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(a.inspect("ledger-maintenance")).toBeNull();
    // Re-acquirable afterward.
    await a.withLock("ledger-maintenance", () => undefined);
  });

  it("auto-reclaims a PROVABLY-dead holder on acquire (v2 #333 — doctor --reclaim-locks is retired)", async () => {
    // Simulate a crashed holder: a stale lock file whose pid is not alive. The
    // next acquirer reclaims it in place — a crash never wedges the writers
    // behind a dead pid (the explicit reclaim command died with `doctor`).
    writeFileSync(
      join(dir, "jobs-runner.lock"),
      JSON.stringify({ scope: "jobs-runner", pid: 999999, startedAt: "2026-07-12T00:00:00.000Z" }),
    );
    const b = mgr(501); // 999999 is not in ALIVE
    let ran = false;
    await b.withLock("jobs-runner", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(b.inspect("jobs-runner")).toBeNull(); // released cleanly after the reclaim-and-take
  });

  it("never reclaims a LIVE holder on acquire", async () => {
    const live = mgr(701);
    let free!: () => void;
    const gate = new Promise<void>((r) => (free = r));
    const held = live.withLock("jobs-runner", async () => {
      await gate;
    });
    const b = mgr(501);
    await expectLocked(() => b.withLock("jobs-runner", async () => undefined), "jobs-runner");
    free();
    await held;
  });

  it("reclaimLocks() — the manual sweep — clears dead locks and leaves live ones", async () => {
    const live = mgr(601);
    // A live holder on vault-maintenance…
    let free!: () => void;
    const gate = new Promise<void>((r) => (free = r));
    const held = live.withLock("vault-maintenance", async () => {
      await gate;
    });
    // …and a dead holder left behind on jobs-runner (a crashed foreign process).
    writeFileSync(
      join(dir, "jobs-runner.lock"),
      JSON.stringify({ scope: "jobs-runner", pid: 999998, startedAt: "2026-07-12T00:00:00.000Z" }),
    );
    const reclaimed = live.reclaimLocks();
    expect(reclaimed).toEqual(["jobs-runner"]);
    expect(live.inspect("jobs-runner")).toBeNull();
    expect(live.inspect("vault-maintenance")).not.toBeNull(); // live lock untouched
    free();
    await held;
    // After reclaim, jobs-runner is acquirable again.
    await live.withLock("jobs-runner", () => undefined);
  });

  it("NEVER removes an acquire guard owned by a LIVE process; fails fast instead", async () => {
    // A live foreign process is mid-acquire (holds the guard). We MUST NOT steal it
    // on any spin/timeout budget — that would let two acquirers run their
    // scan+create concurrently and defeat the atomic cross-scope conflict check.
    ALIVE.add(777); // the guard holder is alive
    writeFileSync(join(dir, ".acquire.guard"), "777");
    const b = createLockManager({
      dir,
      pid: 888,
      isAlive,
      now: () => "2026-07-12T00:00:00.000Z",
      guardWaitMs: 20, // short budget so the test exercises contention quickly
    });
    ALIVE.add(888);
    try {
      await b.withLock("vault-maintenance", async () => undefined);
      throw new Error("expected guard contention to fail fast");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe("locked:acquire-guard");
      expect((e as CliError).exitCode).toBe(2);
      expect((e as CliError).retryable).toBe(true);
    }
    // The live-owned guard survived — never force-removed.
    expect(readFileSync(join(dir, ".acquire.guard"), "utf8")).toBe("777");
    // …and no scope lock was taken.
    expect(b.inspect("vault-maintenance")).toBeNull();
  });

  it("reclaims a STALE acquire guard (dead owner) and proceeds", async () => {
    // A guard left by a crashed acquirer (dead pid) IS safely reclaimable.
    writeFileSync(join(dir, ".acquire.guard"), "999999"); // not in ALIVE
    const b = mgr(890);
    await b.withLock("vault-maintenance", async () => {
      expect(b.heldScopes()).toEqual(["vault-maintenance"]);
    });
    expect(b.inspect("vault-maintenance")).toBeNull();
  });

  it("global order ranks the four scopes broad→narrow", () => {
    expect(LOCK_SCOPES).toEqual([
      "vault-maintenance",
      "ledger-maintenance",
      "jobs-runner",
      "canonical-integration",
    ]);
    expect(lockRank("vault-maintenance")).toBeLessThan(lockRank("ledger-maintenance"));
    expect(lockRank("ledger-maintenance")).toBeLessThan(lockRank("jobs-runner"));
    expect(lockRank("jobs-runner")).toBeLessThan(lockRank("canonical-integration"));
  });
});
