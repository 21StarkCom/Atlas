/**
 * `jobs.single-runner-exclusion` (Task 2.7 acceptance / finding 3) — TWO ACTUAL
 * `brain jobs run` PROCESSES against the compiled bin: one drains, the other exits
 * `2 locked:jobs-runner`, and every job executes EXACTLY ONCE.
 *
 * This spawns real OS processes (not two in-process lock managers), so it exercises
 * the true cross-process exclusion path end-to-end: independent SQLite connections,
 * the file-backed `jobs-runner` lock keyed on holder pid (Task 1.8), real CLI
 * dispatch, and the `exit 2` / `locked:jobs-runner` envelope mapping. The winner's
 * test handler (env-gated, `ATLAS_TEST_JOB_HANDLER=1`) PARKS on its first job — so it
 * holds the exclusive lock open while the loser races and is rejected — then a gate
 * file releases it to drain the rest. Exactly-once is proven by an append-only exec
 * log the handler writes per execution.
 *
 * Skips when the compiled `dist/bin.js` is absent (built by `pnpm -r build` before
 * `pnpm -r test`), matching `bin.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJobsStore, enqueue, bindEnqueueContext, type JobSpec } from "@atlas/jobs";

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
  root = mkdtempSync(join(tmpdir(), "atlas-jobs-excl-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(join(cwd, "vault"), { recursive: true });
  writeConfig(cwd, root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const brainSync = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8" });

/** Await a spawned `brain` process, capturing its exit code + stdout. */
function brainAsync(args: string[], env: NodeJS.ProcessEnv): { proc: ReturnType<typeof spawn>; done: Promise<{ code: number | null; out: string }> } {
  const proc = spawn(process.execPath, [BIN, ...args], { cwd, env });
  let out = "";
  proc.stdout.on("data", (d) => (out += String(d)));
  const done = new Promise<{ code: number | null; out: string }>((resolve) => {
    proc.on("close", (code) => resolve({ code, out }));
  });
  return { proc, done };
}

async function waitFor(pred: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!existsSync(BIN))("jobs.single-runner-exclusion (real processes)", () => {
  it("one process drains every job exactly once; a concurrent process exits 2 locked:jobs-runner", async () => {
    const dbPath = join(cwd, ".atlas", "atlas.db");
    // `db migrate` is the composition root that applies 0002_jobs (real process).
    const migrated = brainSync(["db", "migrate", "--json"], { ...process.env, NO_COLOR: "1" });
    expect(migrated.status, migrated.stderr).toBe(0);

    // Seed three jobs directly (the CLI has no enqueue surface).
    const seedStore = openJobsStore({ path: dbPath });
    try {
      const now = new Date().toISOString();
      for (const [i, key] of [["1", "a"], ["2", "b"], ["3", "c"]] as const) {
        const spec: JobSpec = { workflow: "test-cap", idempotencyKey: key, payload: { i } };
        bindEnqueueContext(seedStore.db, { now: () => now, nextJobId: () => `job-${i}`, defaultMaxAttempts: 5 });
        seedStore.db.transaction(() => enqueue(seedStore.db, spec))();
      }
    } finally {
      seedStore.close();
    }

    const execLog = join(root, "exec.log");
    const startedDir = join(root, "started");
    const gate = join(root, "gate");
    const winnerEnv = {
      ...process.env,
      NO_COLOR: "1",
      ATLAS_TEST_JOB_HANDLER: "1",
      ATLAS_TEST_JOB_WORKFLOW: "test-cap",
      ATLAS_TEST_JOB_EXEC_LOG: execLog,
      ATLAS_TEST_JOB_STARTED_DIR: startedDir,
      ATLAS_TEST_JOB_GATE_FILE: gate, // absent → the first job parks, holding the lock
    };

    // Winner: drains under the exclusive lock, parked on its first job.
    const winner = brainAsync(["jobs", "run", "--all", "--json"], winnerEnv);
    try {
      await waitFor(() => existsSync(startedDir) && readdirSync(startedDir).length >= 1);

      // Loser: a concurrent runner is rejected with `locked:jobs-runner` (exit 2).
      const loser = brainSync(["jobs", "run", "--all", "--json"], { ...process.env, NO_COLOR: "1" });
      expect(loser.status).toBe(2);
      expect(JSON.parse(loser.stdout).code).toBe("locked:jobs-runner");

      // Release the winner → it drains the remaining jobs and exits 0.
      writeFileSync(gate, "");
      const { code, out } = await winner.done;
      expect(code, out).toBe(0);

      const report = JSON.parse(out);
      expect(report.aggregate).toMatchObject({ exitCode: 0, succeeded: 3, failed: 0 });
      expect(report.items.map((i: { outcome: string }) => i.outcome)).toEqual(["succeeded", "succeeded", "succeeded"]);

      // Every job executed EXACTLY ONCE (one exec-log line per job, no duplicates).
      const executed = readFileSync(execLog, "utf8").trim().split("\n").filter(Boolean).sort();
      expect(executed).toEqual(["job-1", "job-2", "job-3"]);

      // The lock file is released after the drain.
      expect(existsSync(join(cwd, ".atlas", "locks", "jobs-runner.lock"))).toBe(false);
    } finally {
      winner.proc.kill();
    }
  }, 30000);
});
