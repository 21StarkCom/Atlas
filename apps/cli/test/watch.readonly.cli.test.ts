/**
 * `watch.readonly` (SP-1 Phase 5 Task 5, §13.10) — the BEHAVIORAL prohibited-
 * effects proof: across attach → ≥1 heartbeat → ≥1 domain event → SIGTERM,
 * `watch` writes NOTHING — no new audit row (no `run.readonly`, the §5.1
 * decision), no watermark/backup movement, no lock file — and the ledger handle
 * it holds is read-only by construction (a write through the same opener path
 * throws SQLITE_READONLY).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openConnection, openReadonlyLedger } from "@atlas/sqlite-store";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

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

interface LedgerState {
  auditRows: { seq: number; event_type: string }[];
  watermark: unknown;
  backups: string[];
}

function snapshotState(): LedgerState {
  const db = openConnection({ path: h.dbPath });
  try {
    return {
      auditRows: db.prepare(`SELECT seq, event_type FROM audit_events ORDER BY seq`).all() as LedgerState["auditRows"],
      watermark: db.prepare(`SELECT * FROM backup_watermark`).all(),
      backups: existsSync(join(h.root, ".atlas", "backups")) ? readdirSync(join(h.root, ".atlas", "backups")).sort() : [],
    };
  } finally {
    db.close();
  }
}

describe.skipIf(!existsSync(BIN))("brain watch — behavioral read-only proof (§13.10)", () => {
  it("attach → heartbeat → domain event → SIGTERM mutates NOTHING (no audit row, no watermark, no backup, no lock)", async () => {
    // Seed one pre-existing row so the stream has an attach-time baseline.
    {
      const db = openConnection({ path: h.dbPath });
      db.prepare(
        `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
         VALUES (0, 'run_0', 'run.started', 'h', NULL, '2026-07-19T08:00:00.000Z')`,
      ).run();
      db.close();
    }
    const before = snapshotState();

    const lines: Record<string, any>[] = [];
    child = spawn(process.execPath, [BIN, "watch", "--json", "--poll-ms", "100", "--heartbeat-seconds", "5"], {
      cwd: h.root,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() !== "") lines.push(JSON.parse(line));
      }
    });
    const exited = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));

    const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > 20_000) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitFor(() => lines.some((l) => l.event === "watch.hello" && l.ledger?.attached === true), "hello");
    // A domain event driven by the TEST writer (the only writer in the room).
    {
      const db = openConnection({ path: h.dbPath });
      db.prepare(
        `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
         VALUES (1, 'run_1', 'run.integrated', 'h', NULL, '2026-07-19T08:00:01.000Z')`,
      ).run();
      db.close();
    }
    await waitFor(() => lines.some((l) => l.event === "audit" && l.seq === 1), "the domain event");
    await waitFor(() => lines.some((l) => l.event === "watch.heartbeat"), "a heartbeat");
    child.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);

    const after = snapshotState();
    // The ONLY delta is the row the TEST wrote: no run.readonly, no watch-authored
    // audit row of any kind, no watermark/backup movement.
    expect(after.auditRows).toEqual([...before.auditRows, { seq: 1, event_type: "run.integrated" }]);
    expect(after.auditRows.some((r) => r.event_type === "run.readonly")).toBe(false);
    expect(after.watermark).toEqual(before.watermark);
    expect(after.backups).toEqual(before.backups);
    // No lock artifacts appeared under the state dir.
    const atlasDir = readdirSync(join(h.root, ".atlas")).filter((f) => f.includes("lock"));
    expect(atlasDir).toEqual([]);
  }, 60_000);

  it("the opener path watch uses is read-only by construction: a write through it throws SQLITE_READONLY", () => {
    const ledger = openReadonlyLedger(h.dbPath);
    try {
      expect(() =>
        ledger.db
          .prepare(`INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at) VALUES (99, 'x', 'run.started', 'h', NULL, 'now')`)
          .run(),
      ).toThrow(/readonly/i);
    } finally {
      ledger.close();
    }
  });
});
