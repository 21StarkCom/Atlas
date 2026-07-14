/**
 * `jobs.cross-process-cancel` (Task 2.7 / finding 1) — cancellation against an ACTUAL
 * running `brain jobs run` process.
 *
 * The wing reviewer flagged that `jobs cancel` reported `cancel-requested` for a running
 * job while nothing crossed the process boundary to stop it — the only signal was an
 * unshared process-local registry. This exercises the durable cross-process channel:
 * a real `brain jobs run` process claims and PARKS on a job, a SEPARATE real
 * `brain jobs cancel <jobId>` process records a durable cancel intent, and the running
 * process observes it at its next cooperative checkpoint, aborts the handler, and
 * reconciles the job to `cancelled`.
 *
 * Skips when the compiled `dist/bin.js` is absent (built by `pnpm -r build`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJobsStore, enqueue, bindEnqueueContext, readSnapshot, type JobSpec } from "@atlas/jobs";

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

function writeConfig(cwd: string, root: string): void {
  const config = [
    "vault:",
    `  path: ${join(cwd, "vault")}`,
    "sqlite:",
    "  path: ./.atlas/atlas.db",
    "  ledger_backup:",
    "    dir: ./.atlas/backups",
    "lancedb:",
    "  dir: ./.atlas/lancedb",
    "indexing:",
    "  chunker_version: 1",
    "  embedding_model: gemini-embedding-001",
    "  dimensions: 768",
    "git:",
    "  worktrees_path: ./.atlas/worktrees",
    `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}",
    "policies: {}",
    "logs:",
    "  dir: ./.atlas/logs",
    "broker:",
    `  socket_path: ${join(root, "b.sock")}`,
    `  egress_socket_path: ${join(root, "e.sock")}`,
    "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
}

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-jobs-cancel-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(join(cwd, "vault"), { recursive: true });
  writeConfig(cwd, root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const brainSync = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8" });

async function waitFor(pred: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!existsSync(BIN))("jobs.cross-process-cancel (real processes)", () => {
  it("a separate `brain jobs cancel` cancels a job running in another process", async () => {
    const dbPath = join(cwd, ".atlas", "atlas.db");
    const migrated = brainSync(["db", "migrate", "--json"], { ...process.env, NO_COLOR: "1" });
    expect(migrated.status, migrated.stderr).toBe(0);

    const seedStore = openJobsStore({ path: dbPath });
    try {
      const spec: JobSpec = { workflow: "test-cap", idempotencyKey: "run", payload: {} };
      bindEnqueueContext(seedStore.db, { now: () => new Date().toISOString(), nextJobId: () => "job-run", defaultMaxAttempts: 5 });
      seedStore.db.transaction(() => enqueue(seedStore.db, spec))();
    } finally {
      seedStore.close();
    }

    const execLog = join(root, "exec.log");
    const startedDir = join(root, "started");
    // A gate file that is NEVER created → the handler parks until it is cancelled.
    const gate = join(root, "gate-never");
    const runEnv = {
      ...process.env,
      NO_COLOR: "1",
      ATLAS_TEST_JOB_HANDLER: "1",
      ATLAS_TEST_JOB_WORKFLOW: "test-cap",
      ATLAS_TEST_JOB_EXEC_LOG: execLog,
      ATLAS_TEST_JOB_STARTED_DIR: startedDir,
      ATLAS_TEST_JOB_GATE_FILE: gate,
    };

    const proc = spawn(process.execPath, [BIN, "jobs", "run", "job-run", "--json"], { cwd, env: runEnv });
    let out = "";
    proc.stdout.on("data", (d) => (out += String(d)));
    const done = new Promise<{ code: number | null }>((resolve) => proc.on("close", (code) => resolve({ code })));

    try {
      // The job is now running and parked (holding the runner lock).
      await waitFor(() => existsSync(startedDir) && readdirSync(startedDir).length >= 1);
      expect(readSnapshotState(dbPath, "job-run")).toBe("running");

      // A SEPARATE process requests cancel → durable intent recorded, reports cancel-requested.
      const cancel = brainSync(["jobs", "cancel", "job-run", "--json"], { ...process.env, NO_COLOR: "1" });
      expect(cancel.status, cancel.stderr).toBe(0);
      expect(JSON.parse(cancel.stdout).items[0].outcome).toBe("cancel-requested");

      // The running process observes the intent, aborts the handler, reconciles to cancelled.
      const { code } = await done;
      expect(code).toBe(0);
      const report = JSON.parse(out);
      expect(report.items[0].outcome).toBe("cancelled");
      expect(readSnapshotState(dbPath, "job-run")).toBe("cancelled");

      // The handler executed exactly once (it started before being cancelled).
      expect(readFileSync(execLog, "utf8").trim().split("\n").filter(Boolean)).toEqual(["job-run"]);
    } finally {
      proc.kill();
    }
  }, 30000);
});

/** Read a job's state through a fresh, independent store connection. */
function readSnapshotState(dbPath: string, jobId: string): string | undefined {
  const store = openJobsStore({ path: dbPath });
  try {
    return readSnapshot(store, jobId)?.state;
  } finally {
    store.close();
  }
}
