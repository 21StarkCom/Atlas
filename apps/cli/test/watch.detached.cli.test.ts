/**
 * `watch.detached` (SP-1 Phase 3 Task 4) — the startup-detached → attach → fresh
 * hello transition over the REAL child: a missing ledger path yields a detached
 * `watch.hello` (no resume/replay) + cursor-less detached heartbeats; creating and
 * migrating the ledger under the running watcher produces a fresh attached hello
 * with a real cursor. The delayed-migration case (file present but unmigrated)
 * keeps the watcher detached — `ledgerSchemaState:"absent"` polls on, no exit-4
 * crash on missing tables — until migrations land.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openConnection } from "@atlas/sqlite-store";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";
import { openWorkflowStore } from "../src/workflows/index.js";

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

let h: Phase2Harness;
let child: ChildProcessWithoutNullStreams | undefined;

beforeEach(async () => {
  h = await makePhase2Harness();
});
afterEach(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  child = undefined;
  await h.cleanup();
});

function writeConfig(dbPath: string): void {
  writeFileSync(
    join(h.root, "brain.config.yaml"),
    [
      "vault:", `  path: ${h.vaultDir}`,
      "sqlite:", `  path: ${dbPath}`, "  ledger_backup:", `    dir: ${join(h.root, ".atlas", "backups")}`, "    key_id: test-key-v1", "    keep: 10",
      "lancedb:", `  dir: ${join(h.root, ".atlas", "lancedb")}`,
      "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
      "git:", `  worktrees_path: ${h.worktreesPath}`, `  audit_anchor_path: ${h.anchorPath}`,
      "models: {}", "policies: {}",
      "logs:", `  dir: ${join(h.root, ".atlas", "logs")}`,
      "broker:", `  socket_path: ${h.socketPath}`, `  egress_socket_path: ${join(h.root, "egress.sock")}`, "",
    ].join("\n"),
    "utf8",
  );
}

/** Spawn `brain watch --json` and collect parsed NDJSON lines as they arrive. */
function spawnWatch(args: string[]): { lines: Record<string, any>[]; exited: Promise<number | null> } {
  const lines: Record<string, any>[] = [];
  child = spawn(process.execPath, [BIN, "watch", "--json", ...args], {
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
  return { lines, exited };
}

/** Await a predicate over the collected lines (poll every 50 ms, bounded). */
async function waitFor(
  lines: Record<string, any>[],
  pred: (ls: Record<string, any>[]) => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (pred(lines)) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timeout waiting for ${what}; lines: ${JSON.stringify(lines)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!existsSync(BIN))("brain watch — startup-detached transition (real child)", () => {
  it("missing ledger: detached hello + cursor-less heartbeat; create+migrate → fresh attached hello, then SIGTERM exits 0", async () => {
    const dbPath = join(h.root, ".atlas", "late.db");
    writeConfig(dbPath);
    const { lines, exited } = spawnWatch(["--poll-ms", "100", "--heartbeat-seconds", "5"]);

    // First line: detached hello, no resume/replay.
    await waitFor(lines, (ls) => ls.length >= 1, 10_000, "the detached hello");
    const hello = lines[0]!;
    expect(hello.event).toBe("watch.hello");
    expect(hello.ledger).toEqual({ attached: false, path: dbPath });
    expect(hello.resume).toBeUndefined();
    expect(hello.replay).toBeUndefined();
    expect(hello.snapshot.openRuns).toBeUndefined(); // daemons-only snapshot

    // A detached heartbeat (no cursor) arrives at the heartbeat cadence.
    await waitFor(
      lines,
      (ls) => ls.some((l) => l.event === "watch.heartbeat" && l.ledger?.attached === false && l.resume === undefined),
      15_000,
      "a cursor-less detached heartbeat",
    );

    // Create + migrate the ledger under the running watcher → fresh attached hello.
    mkdirSync(join(h.root, ".atlas"), { recursive: true });
    openWorkflowStore({ path: dbPath }).close();
    await waitFor(
      lines,
      (ls) => ls.some((l) => l.event === "watch.hello" && l.ledger?.attached === true),
      10_000,
      "the fresh attached hello",
    );
    const fresh = lines.filter((l) => l.event === "watch.hello" && l.ledger?.attached === true)[0]!;
    expect(fresh.resume).toEqual({ auditHeadSeq: -1 }); // a real (empty-ledger) cursor
    expect(fresh.ledger.path).toBe(dbPath);

    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 40_000);

  it("delayed migration: a present-but-unmigrated file stays detached (no exit-4), attaches after db migrate", async () => {
    const dbPath = join(h.root, ".atlas", "unmigrated.db");
    // A REAL SQLite file with no Atlas migrations (created-but-unmigrated poll race).
    {
      const db = openConnection({ path: dbPath });
      db.prepare(`CREATE TABLE placeholder (x INTEGER)`).run();
      db.close();
    }
    writeConfig(dbPath);
    const { lines, exited } = spawnWatch(["--poll-ms", "100", "--heartbeat-seconds", "5"]);

    await waitFor(lines, (ls) => ls.length >= 1, 10_000, "the detached hello");
    expect(lines[0]!.event).toBe("watch.hello");
    expect(lines[0]!.ledger.attached).toBe(false);

    // Stays detached: a heartbeat arrives, the process has NOT crashed exit-4.
    await waitFor(
      lines,
      (ls) => ls.some((l) => l.event === "watch.heartbeat" && l.ledger?.attached === false),
      15_000,
      "a detached heartbeat on the unmigrated file",
    );
    expect(child!.exitCode).toBeNull();

    // Run migrations → the watcher attaches with a fresh hello.
    openWorkflowStore({ path: dbPath }).close();
    await waitFor(
      lines,
      (ls) => ls.some((l) => l.event === "watch.hello" && l.ledger?.attached === true),
      10_000,
      "the attached hello after migration",
    );

    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 40_000);
});
