/**
 * `watch.ordering` (SP-1 Phase 4 Task 3) — §7.4 coalescing + control events:
 * two rapid job transitions inside one poll interval emit ONE event with the
 * final state (kubectl MODIFIED semantics); the heartbeat carries the contiguous-
 * prefix cursor; daemon reachability drives a `daemon` event on TRANSITION only;
 * a probe `fault` emits a non-fatal `watch.error` and the stream continues; an
 * initial fault records `{known:false}`, so a later success fabricates NO phantom
 * `false→true` transition.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { openConnection } from "@atlas/sqlite-store";
import { openJobsStore } from "@atlas/jobs";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";
import { attachLedger } from "../src/watch/attach.js";
import { diffSources } from "../src/watch/diff.js";
import { heartbeatTick } from "../src/watch/heartbeat.js";
import type { AttachContext, AttachedLedger } from "../src/watch/types.js";

let h: Phase2Harness;
let server: Server | undefined;

beforeEach(async () => {
  h = await makePhase2Harness();
  openJobsStore({ path: h.dbPath }).close();
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  await h.cleanup();
});

function ctx(): AttachContext {
  return {
    anchorPath: h.anchorPath,
    env: { ...process.env } as NodeJS.ProcessEnv,
    broker: null,
    brokerSocket: h.socketPath,
    egressSocket: join(h.root, "egress.sock"),
  };
}

async function attached(c: AttachContext = ctx()): Promise<AttachedLedger> {
  const att = await attachLedger(h.dbPath, { once: false, pollMs: 100, heartbeatSeconds: 30 }, c);
  expect(att.attached).toBe(true);
  return att as AttachedLedger;
}

function sql(fn: (db: ReturnType<typeof openConnection>) => void): void {
  const db = openConnection({ path: h.dbPath });
  try {
    fn(db);
  } finally {
    db.close();
  }
}

const NOW = "2026-07-19T08:00:00.000Z";

function listen(path: string): Promise<void> {
  server = createServer((sock) => sock.end());
  return new Promise((r) => server!.listen(path, () => r()));
}

describe("current-state coalescing (§7.4)", () => {
  it("two rapid job transitions inside one interval emit ONE event carrying the final state", async () => {
    const a = await attached();
    try {
      sql((db) => {
        db.prepare(
          `INSERT INTO jobs (job_id, workflow, idempotency_key, state, attempts, max_attempts, next_run_at, payload, payload_hash, created_at, updated_at)
           VALUES ('job_c', 'ingest', 'k', 'pending', 0, 3, NULL, '{}', 'h', ?, ?)`,
        ).run(NOW, NOW);
        // pending → running → succeeded, all before the next diff tick
        db.prepare(`UPDATE jobs SET state = 'running', attempts = 1, updated_at = ? WHERE job_id = 'job_c'`).run(NOW);
        db.prepare(`UPDATE jobs SET state = 'succeeded', updated_at = ? WHERE job_id = 'job_c'`).run(NOW);
      });
      const events = diffSources(a.connection, a.baselines).filter((e) => e.event === "job");
      expect(events).toHaveLength(1);
      expect(events[0]!.state).toBe("succeeded"); // the final state, not per-transition
      // The intermediate states are gone; a second diff with no change emits nothing.
      expect(diffSources(a.connection, a.baselines).filter((e) => e.event === "job")).toHaveLength(0);
    } finally {
      a.ledger.close();
    }
  });

  it("append-only sources never coalesce: every audit row emits exactly once, in seq order", async () => {
    const a = await attached();
    try {
      sql((db) => {
        for (const s of [0, 1, 2]) {
          db.prepare(
            `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
             VALUES (?, ?, 'run.started', 'h', NULL, ?)`,
          ).run(s, `run_${s}`, NOW);
        }
      });
      const events = diffSources(a.connection, a.baselines).filter((e) => e.event === "audit");
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(diffSources(a.connection, a.baselines).filter((e) => e.event === "audit")).toHaveLength(0);
      expect(a.baselines.auditContiguousPrefix).toBe(2); // prefix advanced through the run
    } finally {
      a.ledger.close();
    }
  });
});

describe("heartbeat + daemon probes (heartbeatTick)", () => {
  const capture = (): { lines: Record<string, any>[]; emit: (l: unknown) => Promise<void> } => {
    const lines: Record<string, any>[] = [];
    return {
      lines,
      emit: async (l: unknown) => {
        lines.push(l as Record<string, any>);
      },
    };
  };

  it("the heartbeat carries the contiguous-prefix cursor; a daemon transition emits exactly one daemon event", async () => {
    const a = await attached();
    try {
      // Seed a known prefix.
      sql((db) =>
        db.prepare(
          `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
           VALUES (0, 'run_0', 'run.started', 'h', NULL, ?)`,
        ).run(NOW),
      );
      diffSources(a.connection, a.baselines); // advance the prefix to 0

      const { lines, emit } = capture();
      await heartbeatTick(a, emit);
      const hb = lines.find((l) => l.event === "watch.heartbeat")!;
      expect(hb.resume).toEqual({ auditHeadSeq: 0 });
      // The harness broker is live: baseline was reachable at attach → no transition.
      expect(lines.filter((l) => l.event === "daemon")).toHaveLength(0);

      // Egress was unreachable at attach ({known:true, reachable:false}); bring a
      // socket up at the egress path → exactly one false→true transition.
      await listen(join(h.root, "egress.sock"));
      lines.length = 0;
      await heartbeatTick(a, emit);
      const transitions = lines.filter((l) => l.event === "daemon");
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ daemon: "egress", reachable: true, previousReachable: false });

      // Steady state: a further heartbeat emits NO daemon event (transition-only).
      lines.length = 0;
      await heartbeatTick(a, emit);
      expect(lines.filter((l) => l.event === "daemon")).toHaveLength(0);
    } finally {
      a.ledger.close();
    }
  });

  it("a probe fault emits watch.error (stream continues); a later success fabricates NO phantom transition", async () => {
    const a = await attached();
    try {
      const { lines, emit } = capture();
      const goodPath = a.snapshot.daemons.egress.socketPath;
      // Fault: an over-long sun_path — a non-transport error on every platform.
      a.snapshot.daemons.egress = { socketPath: join(h.root, "x".repeat(200) + ".sock"), reachable: false };
      await heartbeatTick(a, emit);
      const errs = lines.filter((l) => l.event === "watch.error" && l.source === "egress");
      expect(errs).toHaveLength(1);
      expect(a.baselines.daemonState.egress).toEqual({ known: false }); // unknown, NOT reachable:false

      // Success after the fault: NO daemon event (a {known:false} baseline is not a
      // reachable:false comparand), only the baseline update.
      await listen(goodPath);
      a.snapshot.daemons.egress = { socketPath: goodPath, reachable: false };
      lines.length = 0;
      await heartbeatTick(a, emit);
      expect(lines.filter((l) => l.event === "daemon")).toHaveLength(0);
      expect(a.baselines.daemonState.egress).toEqual({ known: true, reachable: true });

      // Only a REAL transition (observed reachable → unreachable) emits.
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
      lines.length = 0;
      await heartbeatTick(a, emit);
      const t = lines.filter((l) => l.event === "daemon");
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({ daemon: "egress", reachable: false, previousReachable: true });
    } finally {
      a.ledger.close();
    }
  });
});
