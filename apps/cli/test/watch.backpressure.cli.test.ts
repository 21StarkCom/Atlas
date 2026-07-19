/**
 * `watch.backpressure` (SP-1 Phase 4 Task 4) — the blocking NDJSON writer:
 * `emitLineAwaitable` resolves only after the stream accepts the line (on
 * `drain` when `write()` returned false), preserving order with nothing dropped
 * for a slow consumer; C0 AND C1 control characters (incl. U+009B CSI) in
 * free-text serialize escaped; EPIPE-class failures reject with
 * `StdoutClosedError` (the stream maps it to exit 0). Plus a real-child
 * slow-consumer run: hundreds of events read late arrive complete and in order.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { openConnection } from "@atlas/sqlite-store";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";
import { emitLineAwaitable, escapeControls, StdoutClosedError } from "../src/errors/envelope.js";
import { buildWatchError } from "../src/watch/events.js";

const Ajv2020 = ((_Ajv2020 as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown };
};
const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract/watch.schema.json"), "utf8"));
const validateLine = new Ajv2020({ strict: false, allErrors: true }).compile(SCHEMA);

/** A WriteStream stand-in that reports "full" and drains on command. */
class SlowStream extends EventEmitter {
  written: string[] = [];
  full = false;
  private pending: ((err?: Error) => void)[] = [];
  write(chunk: string, cb?: (err?: Error) => void): boolean {
    this.written.push(chunk);
    if (this.full) {
      if (cb) this.pending.push(cb);
      return false;
    }
    cb?.();
    return true;
  }
  drain(): void {
    this.full = false;
    for (const cb of this.pending.splice(0)) cb();
    this.emit("drain");
  }
}

describe("emitLineAwaitable (blocking writer)", () => {
  it("awaits drain when write() returns false — order preserved, nothing dropped", async () => {
    const s = new SlowStream();
    s.full = true;
    let resolved = false;
    const p = emitLineAwaitable({ v: 1, n: 1 }, s as unknown as NodeJS.WriteStream).then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false); // still backpressured
    s.drain();
    await p;
    expect(resolved).toBe(true);
    // A sequential producer stays in order across a full/drain cycle.
    await emitLineAwaitable({ v: 1, n: 2 }, s as unknown as NodeJS.WriteStream);
    expect(s.written.map((w) => JSON.parse(w).n)).toEqual([1, 2]);
    expect(s.written.every((w) => w.endsWith("\n"))).toBe(true);
  });

  it("EPIPE rejects with StdoutClosedError (detach is success, not failure)", async () => {
    const s = new SlowStream();
    s.write = (_c: string, cb?: (err?: Error) => void): boolean => {
      const e = new Error("broken pipe") as NodeJS.ErrnoException;
      e.code = "EPIPE";
      cb?.(e);
      return true;
    };
    await expect(emitLineAwaitable({ v: 1 }, s as unknown as NodeJS.WriteStream)).rejects.toBeInstanceOf(StdoutClosedError);
  });

  it("C0 + C1 control characters in free-text serialize escaped (incl. U+009B CSI) and stay schema-valid", async () => {
    const s = new SlowStream();
    const line = buildWatchError("ledger", "test", "bad \u0000 and \u009b[31m sneaky");
    await emitLineAwaitable(line, s as unknown as NodeJS.WriteStream);
    const raw = s.written[0]!;
    // eslint-disable-next-line no-control-regex
    expect(raw.trimEnd()).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/); // no raw control bytes on the wire
    expect(raw).toContain("\\u0000");
    expect(raw).toContain("\\u009b");
    const parsed = JSON.parse(raw);
    expect(parsed.message).toContain("\u0000"); // round-trips to the original text
    expect(parsed.message).toContain("\u009b");
    expect(validateLine(parsed), JSON.stringify((validateLine as any).errors)).toBe(true);
  });

  it("escapeControls covers the full C0 + C1 ranges and leaves normal text alone", () => {
    expect(escapeControls("plain text stays")).toBe("plain text stays");
    expect(escapeControls("\u0001")).toBe("\\u0001");
    expect(escapeControls("\u007f")).toBe("\\u007f");
    expect(escapeControls("\u0085")).toBe("\\u0085");
  });
});

describe.skipIf(!existsSync(BIN))("slow consumer (real child)", () => {
  let h: Phase2Harness;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    h = await makePhase2Harness();
    writeFileSync(
      join(h.root, "brain.config.yaml"),
      [
        "vault:", `  path: ${h.vaultDir}`,
        "sqlite:", `  path: ${h.dbPath}`, "  ledger_backup:", `    dir: ${join(h.root, ".atlas", "backups")}`, "    key_id: test-key-v1", "    keep: 10",
        "lancedb:", `  dir: ${join(h.root, ".atlas", "lancedb")}`,
        "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
        "git:", `  worktrees_path: ${h.worktreesPath}`, `  audit_anchor_path: ${h.anchorPath}`,
        "models: {}", "policies: {}",
        "logs:", `  dir: ${join(h.root, ".atlas", "logs")}`,
        "broker:", `  socket_path: ${h.socketPath}`, `  egress_socket_path: ${join(h.root, "egress.sock")}`, "",
      ].join("\n"),
      "utf8",
    );
  });
  afterEach(async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    child = undefined;
    await h.cleanup();
  });

  it("300 events produced while the reader is paused arrive complete and in seq order", async () => {
    child = spawn(process.execPath, [BIN, "watch", "--json", "--poll-ms", "100", "--heartbeat-seconds", "300"], {
      cwd: h.root,
      env: { ...process.env, NO_COLOR: "1" },
    });
    // Do NOT attach a data handler yet — the pipe fills while the consumer sleeps.
    await new Promise((r) => setTimeout(r, 1500));
    const db = openConnection({ path: h.dbPath });
    try {
      const ins = db.prepare(
        `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
         VALUES (?, ?, 'run.started', 'h', NULL, '2026-07-19T08:00:00.000Z')`,
      );
      for (let s = 0; s < 300; s++) ins.run(s, `run_${s}`);
    } finally {
      db.close();
    }
    await new Promise((r) => setTimeout(r, 2000)); // producer works against the unread pipe

    const lines: Record<string, any>[] = [];
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() !== "") lines.push(JSON.parse(line));
      }
    });
    const t0 = Date.now();
    for (;;) {
      const audits = lines.filter((l) => l.event === "audit");
      if (audits.length >= 300) break;
      if (Date.now() - t0 > 20_000) throw new Error(`only ${audits.length}/300 audit lines arrived`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const seqs = lines.filter((l) => l.event === "audit").map((l) => l.seq);
    expect(seqs).toEqual([...Array(300).keys()]); // every line, strict seq order, none dropped
    child.kill("SIGTERM");
  }, 60_000);
});
