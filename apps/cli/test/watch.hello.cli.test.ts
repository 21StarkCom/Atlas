/**
 * `watch.hello` (SP-1 Phase 3 Tasks 2–3) — the real-child `--once` hello (schema-
 * conformant, exit 0; snapshot agrees with `status --json` on shared keys), the
 * ledger-absent detached hello, the IMMUTABLE `--since-seq` replay window, the
 * `emitHello` self-sufficiency proof, and the in-process poll-loop contract
 * (tick within 2×pollMs, serialized callbacks, inode-swap → "reattach",
 * stop() → "stopped", and the lost-wakeup guard).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { openConnection } from "@atlas/sqlite-store";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";
import { attachLedger, emitHello } from "../src/watch/attach.js";
import { runPollLoop } from "../src/watch/poll-loop.js";
import type { AttachContext, AttachedLedger, DetachedLedger, WatchOpts } from "../src/watch/types.js";

const Ajv2020 = ((_Ajv2020 as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown };
  errorsText: (errors?: unknown) => string;
};

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract/watch.schema.json"), "utf8"));
const validateLine = new Ajv2020({ strict: false, allErrors: true }).compile(SCHEMA);

let h: Phase2Harness;

function writeConfig(root: string, overrides: { dbPath?: string } = {}): void {
  writeFileSync(
    join(root, "brain.config.yaml"),
    [
      "vault:", `  path: ${h.vaultDir}`,
      "sqlite:", `  path: ${overrides.dbPath ?? h.dbPath}`, "  ledger_backup:", `    dir: ${join(root, ".atlas", "backups")}`, "    key_id: test-key-v1", "    keep: 10",
      "lancedb:", `  dir: ${join(root, ".atlas", "lancedb")}`,
      "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
      "git:", `  worktrees_path: ${h.worktreesPath}`, `  audit_anchor_path: ${h.anchorPath}`,
      "models: {}", "policies: {}",
      "logs:", `  dir: ${join(root, ".atlas", "logs")}`,
      "broker:", `  socket_path: ${h.socketPath}`, `  egress_socket_path: ${join(root, "egress.sock")}`, "",
    ].join("\n"),
    "utf8",
  );
}

function attachCtx(): AttachContext {
  return {
    anchorPath: h.anchorPath,
    env: { ...process.env } as NodeJS.ProcessEnv,
    broker: null,
    brokerSocket: h.socketPath,
    egressSocket: join(h.root, "egress.sock"),
  };
}

const OPTS: WatchOpts = { once: false, pollMs: 100, heartbeatSeconds: 30 };

/** Seed low-space (`run.%`) audit rows seq 0..n into the harness ledger. */
function seedAuditRows(n: number): void {
  const store = h.openStore();
  try {
    const ins = store.db.prepare(
      `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
       VALUES (?, ?, 'run.started', 'h', NULL, '2026-07-19T00:00:00.000Z')`,
    );
    for (let s = 0; s <= n; s++) ins.run(s, `run_${s}`);
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  h = await makePhase2Harness();
  writeConfig(h.root);
});
afterEach(async () => {
  await h.cleanup();
});

describe.skipIf(!existsSync(BIN))("brain watch --once (real child)", () => {
  const run = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

  it("emits exactly one schema-conformant watch.hello and exits 0", () => {
    // NB: the v1 "snapshot agrees with status --json" parity half was RETIRED with
    // the v1 status surface (#332) — the v2 merged `status` no longer carries the
    // openRuns/jobs/backup/audit snapshot (`watch` itself retires in #333).
    const w = run(["watch", "--json", "--once"], h.root);
    expect(w.status, w.stdout + w.stderr).toBe(0);
    const lines = w.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const hello = JSON.parse(lines[0]!);
    expect(hello.event).toBe("watch.hello");
    expect(validateLine(hello), JSON.stringify(validateLine.errors)).toBe(true);
    expect(hello.ledger).toEqual({ attached: true, path: h.dbPath });
    expect(hello.resume).toEqual({ auditHeadSeq: -1 }); // empty ledger — the −1 seed convention
    expect(hello.replay).toBeUndefined();
    expect(hello.config).toEqual({ pollMs: 500, heartbeatSeconds: 30 });
    expect(hello.snapshot.daemons.broker.reachable).toBe(true); // harness broker is live
  }, 30_000);

  it("ledger-absent hello reports attached:false with resume/replay absent (exit 0)", () => {
    writeConfig(h.root, { dbPath: join(h.root, ".atlas", "missing.db") });
    const w = run(["watch", "--json", "--once"], h.root);
    expect(w.status, w.stdout + w.stderr).toBe(0);
    const hello = JSON.parse(w.stdout.trim().split("\n")[0]!);
    expect(validateLine(hello), JSON.stringify(validateLine.errors)).toBe(true);
    expect(hello.ledger.attached).toBe(false);
    expect(hello.resume).toBeUndefined();
    expect(hello.replay).toBeUndefined();
    expect(hello.snapshot).toEqual({ daemons: hello.snapshot.daemons }); // daemons only
  }, 30_000);

  it("missing --json is a usage error: exit 5, exactly one envelope, no event line", () => {
    const w = run(["watch", "--once"], h.root);
    expect(w.status).toBe(5);
    expect(w.stdout).not.toContain("watch.hello");
  }, 30_000);
});

describe("immutable replay window (in-process attach)", () => {
  it("a row committed into range AFTER attach is absent from the captured window", async () => {
    seedAuditRows(5);
    const att = await attachLedger(h.dbPath, { ...OPTS, sinceSeq: 1 }, attachCtx());
    expect(att.attached).toBe(true);
    const a = att as AttachedLedger;
    try {
      expect(a.replay).toBeDefined();
      expect(a.replay!.rows.map((r) => r.seq)).toEqual([2, 3, 4, 5]);
      // Late commit into the > sinceSeq range from a second connection:
      seedAuditRowsAppend(6);
      expect(a.replay!.rows).toHaveLength(4); // immutable — the late row surfaces via the live diff
      expect(a.replay!.rows.some((r) => r.seq === 6)).toBe(false);
      expect(a.resumeCursor).toBe(1); // min(sinceSeq, prefix) = sinceSeq in a normal resume
    } finally {
      a.ledger.close();
    }
  });

  function seedAuditRowsAppend(seq: number): void {
    const store = h.openStore();
    try {
      store.db
        .prepare(
          `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
           VALUES (?, ?, 'run.started', 'h', NULL, '2026-07-19T00:00:01.000Z')`,
        )
        .run(seq, `run_${seq}`);
    } finally {
      store.close();
    }
  }
});

describe("emitHello self-sufficiency (reads only the Attachment)", () => {
  it("attached + detached lines validate against watch.schema.json and carry att.path/att.config", async () => {
    const detached: DetachedLedger = {
      attached: false,
      path: "/tmp/some.db",
      config: { pollMs: 250, heartbeatSeconds: 10 },
      snapshot: { daemons: { broker: { socketPath: "/b.sock", reachable: false }, egress: { socketPath: "/e.sock", reachable: true } } },
      daemonState: { broker: { known: true, reachable: false }, egress: { known: true, reachable: true } },
      pendingDaemonFaults: [],
    };
    const lines: unknown[] = [];
    const emit = async (l: unknown): Promise<void> => {
      lines.push(l);
    };
    await emitHello(detached, emit);

    const att = await attachLedger(h.dbPath, OPTS, attachCtx());
    expect(att.attached).toBe(true);
    const a = att as AttachedLedger;
    try {
      await emitHello(a, emit);
    } finally {
      a.ledger.close();
    }
    for (const l of lines) {
      expect(validateLine(l), JSON.stringify(validateLine.errors)).toBe(true);
    }
    const [d, at] = lines as [Record<string, any>, Record<string, any>];
    expect(d.ledger.path).toBe("/tmp/some.db");
    expect(d.config).toEqual({ pollMs: 250, heartbeatSeconds: 10 });
    expect(d.resume).toBeUndefined();
    expect(at.ledger.path).toBe(h.dbPath);
    expect(at.config).toEqual({ pollMs: 100, heartbeatSeconds: 30 });
    expect(at.resume).toEqual({ auditHeadSeq: -1 });
  });
});

describe("poll loop (in-process)", () => {
  async function attached(): Promise<AttachedLedger> {
    const att = await attachLedger(h.dbPath, OPTS, attachCtx());
    expect(att.attached).toBe(true);
    return att as AttachedLedger;
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("a cross-connection commit fires onTick within 2×pollMs; stop() resolves 'stopped'", async () => {
    const a = await attached();
    try {
      let ticks = 0;
      const handle = runPollLoop(a, OPTS, async () => {
        ticks++;
        return "continue";
      }, async () => {});
      seedAuditRows(0);
      await sleep(OPTS.pollMs * 2 + 100);
      expect(ticks).toBeGreaterThanOrEqual(1);
      handle.stop();
      await expect(handle.done).resolves.toBe("stopped");
    } finally {
      a.ledger.close();
    }
  });

  it("callbacks are serialized — a second commit never overlaps an in-flight onTick", async () => {
    const a = await attached();
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      let calls = 0;
      const handle = runPollLoop(a, OPTS, async () => {
        inFlight++;
        calls++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(150); // longer than pollMs — the next tick MUST wait
        inFlight--;
        return "continue";
      }, async () => {});
      seedAuditRows(0);
      await sleep(120);
      seedAuditRowsExtra(1);
      await sleep(500);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(maxInFlight).toBe(1);
      handle.stop();
      await handle.done;
    } finally {
      a.ledger.close();
    }
  });

  it("lost-wakeup guard: a commit landing during an active onTick still fires a later tick", async () => {
    const a = await attached();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let calls = 0;
      const handle = runPollLoop(a, OPTS, async () => {
        calls++;
        if (calls === 1) {
          // Block the first callback; commit a NEW row after its source read.
          seedAuditRowsExtra(1);
          await gate;
        }
        return "continue";
      }, async () => {});
      seedAuditRows(0); // triggers the first tick
      await sleep(300);
      expect(calls).toBe(1); // still blocked
      release();
      await sleep(OPTS.pollMs * 3 + 100);
      // data_version was stored BEFORE the callback ran, so the mid-callback commit
      // left it ahead of the stored value — a subsequent tick fired.
      expect(calls).toBeGreaterThanOrEqual(2);
      handle.stop();
      await handle.done;
    } finally {
      a.ledger.close();
    }
  });

  it("a throwing onTick rejects done (never a silently-dead queue / forever-pending stream)", async () => {
    const a = await attached();
    try {
      const handle = runPollLoop(a, OPTS, async () => {
        throw new Error("tick exploded");
      }, async () => {});
      seedAuditRows(0);
      await expect(handle.done).rejects.toThrow("tick exploded");
    } finally {
      a.ledger.close();
    }
  });

  it("an inode swap (atomic replace) resolves done with 'reattach'", async () => {
    const a = await attached();
    try {
      const handle = runPollLoop(a, OPTS, async () => "continue", async () => {});
      // Atomic replace at the same path: copy → rename (new inode).
      const clonePath = `${h.dbPath}.clone`;
      const bytes = readFileSync(h.dbPath);
      writeFileSync(clonePath, bytes);
      renameSync(clonePath, h.dbPath);
      await expect(handle.done).resolves.toBe("reattach");
    } finally {
      a.ledger.close();
    }
  });

  function seedAuditRowsExtra(seq: number): void {
    // A direct writable connection (NOT the harness store — keep it cheap per call).
    const db = openConnection({ path: h.dbPath });
    try {
      db.prepare(
        `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
         VALUES (?, ?, 'run.started', 'h', NULL, '2026-07-19T00:00:02.000Z')`,
      ).run(seq, `run_${seq}`);
    } finally {
      db.close();
    }
  }
});
