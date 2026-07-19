/**
 * `watch.reattach` (SP-1 Phase 5 Task 2) — the recoverable-ledger-fault path:
 * an atomic replace at the same path fires `watch.error(source:"ledger")` then a
 * FRESH `watch.hello` (new incarnation, rewound cursor honest) and streaming
 * continues; the incarnation reset re-emits seqs the previous incarnation already
 * observed (a stale set would suppress them forever); a deleted-and-gone ledger
 * drops into the detached loop and re-creating it attaches again (re-attach and
 * startup-detached share one path).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openConnection } from "@atlas/sqlite-store";
import { openJobsStore } from "@atlas/jobs";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";
import { openWorkflowStore } from "../src/workflows/index.js";

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

let h: Phase2Harness;
let child: ChildProcessWithoutNullStreams | undefined;

beforeEach(async () => {
  h = await makePhase2Harness();
  openJobsStore({ path: h.dbPath }).close();
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

function seed(path: string, seqs: number[], eventType = "run.started"): void {
  const db = openConnection({ path });
  try {
    const ins = db.prepare(
      `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
       VALUES (?, ?, ?, 'h', NULL, '2026-07-19T08:00:00.000Z')`,
    );
    for (const s of seqs) ins.run(s, `run_${s}`, eventType);
  } finally {
    db.close();
  }
}

/** Fold the WAL into the main file so a file-level copy/rename carries every commit. */
function checkpoint(path: string): void {
  const db = openConnection({ path });
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function spawnWatch(): { lines: Record<string, any>[]; exited: Promise<number | null> } {
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
  return { lines, exited };
}

async function waitFor(
  lines: Record<string, any>[],
  pred: (ls: Record<string, any>[]) => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (pred(lines)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}; lines: ${JSON.stringify(lines).slice(0, 3000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!existsSync(BIN))("brain watch — mid-stream re-attach (real child)", () => {
  it("atomic replace with an older cut: watch.error(ledger) → fresh hello with the rewound cursor → incarnation reset re-emits an already-seen seq", async () => {
    // Prepare the OLDER cut (a restore bundle stand-in): a copy taken at seq {0}.
    seed(h.dbPath, [0]);
    checkpoint(h.dbPath); // fold the WAL in — the copy must carry seq 0
    const olderCut = `${h.dbPath}.older`;
    copyFileSync(h.dbPath, olderCut);
    // The live ledger advances to seq {0,1,2}.
    seed(h.dbPath, [1, 2]);

    const { lines, exited } = spawnWatch();
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.hello" && l.ledger?.attached === true), 15_000, "hello");
    expect(lines[0]!.resume).toEqual({ auditHeadSeq: 2 });

    // Atomic restore: replace the path with the older cut (new inode, rewound head).
    // Drop the live db's WAL sidecars first — a real `db restore` swaps the whole
    // file set, and a stale foreign WAL must not shadow the older cut.
    rmSync(`${h.dbPath}-wal`, { force: true });
    rmSync(`${h.dbPath}-shm`, { force: true });
    renameSync(olderCut, h.dbPath);
    await waitFor(
      lines,
      (ls) => ls.some((l) => l.event === "watch.error" && l.source === "ledger"),
      10_000,
      "the ledger watch.error",
    );
    await waitFor(
      lines,
      (ls) => ls.filter((l) => l.event === "watch.hello").length >= 2,
      10_000,
      "the fresh hello",
    );
    const fresh = lines.filter((l) => l.event === "watch.hello")[1]!;
    expect(fresh.ledger.attached).toBe(true);
    expect(fresh.resume).toEqual({ auditHeadSeq: 0 }); // the rewound cursor, honest

    // Incarnation reset: seqs 1,2 (already emitted by the PREVIOUS incarnation)
    // re-commit in the restored ledger — both must be RE-emitted, plus a high-space
    // row whose seq the old incarnation could have seen.
    const freshHelloIdx = lines.findIndex((l, i) => l.event === "watch.hello" && i > 0);
    seed(h.dbPath, [1, 2]);
    seed(h.dbPath, [1_000_000_000_000], "db.backup");
    await waitFor(
      lines,
      (ls) =>
        ls.slice(freshHelloIdx).some((l) => l.event === "audit" && l.seq === 1) &&
        ls.slice(freshHelloIdx).some((l) => l.event === "audit" && l.seq === 2) &&
        ls.slice(freshHelloIdx).some((l) => l.event === "audit" && l.seq === 1_000_000_000_000),
      10_000,
      "the re-emitted seqs in the new incarnation",
    );
    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 60_000);

  it("detach-into-detached-loop: a deleted ledger yields a detached hello + heartbeats; re-creating it attaches again", async () => {
    seed(h.dbPath, [0]);
    const { lines, exited } = spawnWatch();
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.hello" && l.ledger?.attached === true), 15_000, "hello");

    // Delete the ledger and leave it gone (WAL sidecars too, so re-create is clean).
    rmSync(h.dbPath);
    rmSync(`${h.dbPath}-wal`, { force: true });
    rmSync(`${h.dbPath}-shm`, { force: true });
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.error" && l.source === "ledger"), 10_000, "the ledger watch.error");
    await waitFor(
      lines,
      (ls) => ls.some((l) => l.event === "watch.hello" && l.ledger?.attached === false),
      10_000,
      "the detached hello",
    );
    await waitFor(
      lines,
      (ls) => ls.some((l) => l.event === "watch.heartbeat" && l.ledger?.attached === false),
      15_000,
      "a detached heartbeat",
    );

    // Re-create + migrate → a fresh ATTACHED hello (re-attach ≡ startup-detached path).
    openWorkflowStore({ path: h.dbPath }).close();
    await waitFor(
      lines,
      (ls) => {
        const hellos = ls.filter((l) => l.event === "watch.hello");
        return hellos.length >= 3 && hellos[hellos.length - 1]!.ledger.attached === true;
      },
      10_000,
      "the re-attached hello",
    );
    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 60_000);
});
