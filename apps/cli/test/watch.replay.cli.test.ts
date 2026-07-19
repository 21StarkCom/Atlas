/**
 * `watch.replay` (SP-1 Phase 5 Tasks 1+3) — `--since-seq` over the immutable
 * captured window: exact `k+1..N` re-send in strict `seq` order, the announced
 * `events` count, the PRE-replay checkpoint rule (`hello.resume = min(k,prefix)`,
 * then an immediate heartbeat at the new prefix), the seq-0 pin (`-1` replays
 * row 0), cursor-above-head (a rewound head yields `replay.events:0` and a hello
 * cursor below the persisted one — never a failure, never a pruning inference),
 * and the two-sided high-space split (pre-attach backlog suppressed; post-hello
 * high-space rows live-only and cursor-invisible).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openConnection } from "@atlas/sqlite-store";
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

function seed(seqs: number[], eventType = "run.started"): void {
  const db = openConnection({ path: h.dbPath });
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

function spawnWatch(args: string[]): { lines: Record<string, any>[]; exited: Promise<number | null> } {
  const lines: Record<string, any>[] = [];
  child = spawn(process.execPath, [BIN, "watch", "--json", "--poll-ms", "100", "--heartbeat-seconds", "300", ...args], {
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

describe.skipIf(!existsSync(BIN))("brain watch --since-seq (real child)", () => {
  it("replays exactly k+1..N in seq order with the pre-replay checkpoint, then an immediate post-replay heartbeat", async () => {
    seed([0, 1, 2, 3, 4, 5]); // rows 0..5
    const { lines, exited } = spawnWatch(["--since-seq", "2"]);
    // Hello announces the window and carries the PRE-replay checkpoint (k, not N).
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.heartbeat"), 15_000, "the post-replay heartbeat");
    const hello = lines[0]!;
    expect(hello.event).toBe("watch.hello");
    expect(hello.replay).toEqual({ sinceSeq: 2, events: 3 });
    expect(hello.resume).toEqual({ auditHeadSeq: 2 });
    // The replayed rows are ordinary audit lines, strictly ordered, count = announced.
    const hbIdx = lines.findIndex((l) => l.event === "watch.heartbeat");
    const replayed = lines.slice(1, hbIdx).filter((l) => l.event === "audit");
    expect(replayed.map((l) => l.seq)).toEqual([3, 4, 5]);
    // The immediate heartbeat advances the cursor to the new contiguous prefix.
    expect(lines[hbIdx]!.resume).toEqual({ auditHeadSeq: 5 });
    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 40_000);

  it("--since-seq -1 replays from row 0 (the seq-0 pin a >=0 floor would hide)", async () => {
    seed([0, 1]);
    const { lines, exited } = spawnWatch(["--since-seq", "-1"]);
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.heartbeat"), 15_000, "the post-replay heartbeat");
    const hello = lines[0]!;
    expect(hello.replay).toEqual({ sinceSeq: -1, events: 2 });
    expect(hello.resume).toEqual({ auditHeadSeq: -1 });
    const hbIdx = lines.findIndex((l) => l.event === "watch.heartbeat");
    expect(lines.slice(1, hbIdx).filter((l) => l.event === "audit").map((l) => l.seq)).toEqual([0, 1]);
    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 40_000);

  it("cursor above head (post-restore rewind): replay.events 0, hello cursor below the persisted one, stream stays live", async () => {
    seed([0, 1]); // head is 1; the consumer persisted 10 before a rewind
    const { lines, exited } = spawnWatch(["--since-seq", "10"]);
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.heartbeat"), 15_000, "the post-replay heartbeat");
    const hello = lines[0]!;
    expect(hello.replay).toEqual({ sinceSeq: 10, events: 0 });
    expect(hello.resume.auditHeadSeq).toBeLessThan(10); // the rewind detection signal (= 1)
    expect(hello.resume.auditHeadSeq).toBe(1);
    // The stream continues from the rewound head: a new row still arrives live.
    seed([2]);
    await waitFor(lines, (ls) => ls.some((l) => l.event === "audit" && l.seq === 2), 5_000, "the live row after rewind");
    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 40_000);

  it("high-space split: pre-attach non-run.% backlog is suppressed; a post-hello high-space row streams live and never enters the cursor", async () => {
    seed([0, 1]);
    seed([1_000_000_000_000], "db.backup"); // pre-attach high-space backlog
    const { lines, exited } = spawnWatch(["--since-seq", "-1"]);
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.heartbeat"), 15_000, "the post-replay heartbeat");
    // Backlog high-space row: neither replayed nor emitted live (baseline-seen).
    expect(lines.filter((l) => l.event === "audit" && l.seq >= 1_000_000_000_000)).toHaveLength(0);
    // A NEW high-space row after hello streams live…
    seed([1_000_000_000_001], "evidence.retry_enqueued");
    await waitFor(lines, (ls) => ls.some((l) => l.event === "audit" && l.seq === 1_000_000_000_001), 5_000, "the live high-space row");
    // …and never moves the cursor: force a heartbeat via a low-space row + check.
    seed([2]);
    await waitFor(lines, (ls) => ls.some((l) => l.event === "audit" && l.seq === 2), 5_000, "the live low-space row");
    const lastCursor = [...lines].reverse().find((l) => l.resume !== undefined)?.resume.auditHeadSeq;
    expect(lastCursor).toBeLessThan(1_000_000_000_000);
    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 40_000);

  it("immutable window: a row committed after hello never inflates the announced count — it arrives as a live line instead", async () => {
    seed([0, 1, 2]);
    const { lines, exited } = spawnWatch(["--since-seq", "0"]);
    await waitFor(lines, (ls) => ls.length >= 1, 15_000, "hello");
    expect(lines[0]!.replay).toEqual({ sinceSeq: 0, events: 2 });
    seed([3]); // commits into the > 0 range AFTER the hello
    await waitFor(lines, (ls) => ls.some((l) => l.event === "audit" && l.seq === 3), 10_000, "the late row (live)");
    // Replay lines (before the post-replay heartbeat) are exactly the captured 1,2.
    const hbIdx = lines.findIndex((l) => l.event === "watch.heartbeat");
    const replayed = lines.slice(1, hbIdx).filter((l) => l.event === "audit").map((l) => l.seq);
    expect(replayed).toEqual([1, 2]);
    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 40_000);
});
