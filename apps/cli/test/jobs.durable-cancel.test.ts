/**
 * `jobs.durable-cancel` (Task 2.7 / finding 3) — the cancellation intent is DURABLE in
 * SQLite and observed from durable state, NOT a filesystem marker.
 *
 * The wing reviewer flagged that a running-job cancel was COMMITTED and its idempotency
 * result PUBLISHED before the filesystem cancel marker was written — a crash or
 * marker-write failure in that window left a replayable `cancel-requested` success with
 * NOTHING observable to stop the job (and replay returned before any repair could run).
 * These exercise the fix against ACTUAL `brain` processes, covering the three regressions
 * the reviewer required were genuinely reproduced:
 *
 *  - IDEMPOTENT PUBLICATION / REPLAY (against a GENUINELY RUNNING job): a keyed
 *    `jobs cancel <runningJob> --idempotency-key k` on a real, parked-and-running process
 *    exercises the running-job `cancel-requested` branch — it records the durable intent
 *    AND publishes its result in ONE transaction. The runner is SUSPENDED (SIGSTOP) across
 *    the cancel so its 50 ms poll cannot consume the intent mid-assertion; an identical
 *    retry with the same key REPLAYS the published result BYTE-IDENTICALLY without
 *    recording a second intent (exactly ONE durable row). Resuming the runner (SIGCONT)
 *    then observes the single durable intent and reconciles the job to `cancelled`.
 *  - UNWRITABLE FORMER-MARKER LOCATION: the ACTUAL path the removed filesystem-marker
 *    implementation wrote to (`<ledgerDir>/jobs-cancel`, i.e. `cwd/.atlas/jobs-cancel`) is
 *    made INVALID for a marker write (a regular file occupies it, so the former
 *    `mkdirSync(dir)` would throw). Cancel still succeeds and is honored — because nothing
 *    is written there; the intent lives only in SQLite. Gated by SIGSTOP/SIGCONT so the
 *    poll cannot consume the intent before the assertion.
 *  - CRASH: a REAL running `jobs run` process is SUSPENDED (SIGSTOP) so its poll cannot
 *    observe the cancel and it cannot exit, the durable intent is recorded, the process is
 *    then SIGKILLed mid-flight, its stale lock reclaimed, and the NEXT drain's dead-runner
 *    recovery observes the durable intent and reconciles the job to `cancelled`. The intent
 *    survives the crash because it was committed, not merely written to disk.
 *
 * The runner is deterministically GATED (SUSPEND before cancelling, RESUME/KILL after the
 * intent-count assertion) so no test races the runner's 50 ms cancellation poll.
 *
 * Skips when the compiled `dist/bin.js` is absent (built by `pnpm -r build`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJobsStore, enqueue, bindEnqueueContext, claimNext, readSnapshot, type JobSpec } from "@atlas/jobs";

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
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-jobs-durable-cancel-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(join(cwd, "vault"), { recursive: true });
  writeConfig(cwd, root);
  dbPath = join(cwd, ".atlas", "atlas.db");
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

/** Migrate the ledger through the real composition root (applies 0002 + 0007). */
function migrate(): void {
  const migrated = brainSync(["db", "migrate", "--json"], { ...process.env, NO_COLOR: "1" });
  expect(migrated.status, migrated.stderr).toBe(0);
}

/** Seed a job (using the injected 2-arg enqueue seam) with an optional in-flight claim. */
function seed(spec: JobSpec, jobId: string, claim = false): void {
  const store = openJobsStore({ path: dbPath });
  try {
    bindEnqueueContext(store.db, { now: () => new Date().toISOString(), nextJobId: () => jobId, defaultMaxAttempts: 5 });
    store.db.transaction(() => enqueue(store.db, spec))();
    if (claim) claimNext(store.db, new Date().toISOString(), jobId); // → running (simulate a runner)
  } finally {
    store.close();
  }
}

/** Read a durable value through a fresh, independent store connection. */
function withStore<T>(fn: (store: ReturnType<typeof openJobsStore>) => T): T {
  const store = openJobsStore({ path: dbPath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

const intentCount = (): number =>
  withStore((s) => (s.db.prepare(`SELECT COUNT(*) AS n FROM job_cancellations`).get() as { n: number }).n);

const parkedRunEnv = (execLog: string, startedDir: string, gate: string): NodeJS.ProcessEnv => ({
  ...process.env,
  NO_COLOR: "1",
  ATLAS_TEST_JOB_HANDLER: "1",
  ATLAS_TEST_JOB_WORKFLOW: "test-cap",
  ATLAS_TEST_JOB_EXEC_LOG: execLog,
  ATLAS_TEST_JOB_STARTED_DIR: startedDir,
  ATLAS_TEST_JOB_GATE_FILE: gate, // never created → parks until cancelled
});

/** Spawn a parked `jobs run <jobId>` and resolve once its handler has started (job running). */
async function spawnParkedRun(
  jobId: string,
  execLog: string,
  startedDir: string,
  gate: string,
): Promise<{ proc: ReturnType<typeof spawn>; out: () => string; done: Promise<{ code: number | null }> }> {
  const proc = spawn(process.execPath, [BIN, "jobs", "run", jobId, "--json"], {
    cwd,
    env: parkedRunEnv(execLog, startedDir, gate),
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += String(d)));
  const done = new Promise<{ code: number | null }>((resolve) => proc.on("close", (code) => resolve({ code })));
  await waitFor(() => existsSync(startedDir) && readdirSync(startedDir).length >= 1);
  return { proc, out: () => out, done };
}

/**
 * SUSPEND the runner (SIGSTOP) so it makes no progress — its 50 ms cancellation poll
 * cannot consume a durable intent, and it cannot exit — while a cancel is recorded and
 * the durable state asserted. This is the deterministic gate the wing required.
 */
function suspend(proc: ReturnType<typeof spawn>): void {
  proc.kill("SIGSTOP");
}

/** RESUME the runner (SIGCONT) so it observes the durable intent at its next poll tick. */
function resume(proc: ReturnType<typeof spawn>): void {
  proc.kill("SIGCONT");
}

describe.skipIf(!existsSync(BIN))("jobs.durable-cancel (real processes)", () => {
  it("idempotent publication/replay on a RUNNING job: keyed `jobs cancel` publishes atomically, replays byte-identically, one durable intent, then is observed", async () => {
    migrate();
    // A GENUINELY RUNNING job (parked handler) — so the keyed cancel exercises the
    // running-job `cancel-requested` branch + durable-intent publication, NOT the trivial
    // pending → cancelled path.
    seed({ workflow: "test-cap", idempotencyKey: "run", payload: {} }, "job-run");
    const run = await spawnParkedRun("job-run", join(root, "exec.log"), join(root, "started"), join(root, "gate-never"));
    try {
      expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("running");

      // SUSPEND the runner so its 50 ms poll cannot consume the intent while we assert
      // the durable state + replay — the job stays `running` across both cancels.
      suspend(run.proc);

      // First keyed cancel: the queue mutation (durable intent INSERT) AND the published
      // result commit in ONE atomic transaction (runKeyedAtomic) → `cancel-requested`.
      const c1 = brainSync(["jobs", "cancel", "job-run", "--idempotency-key", "k1", "--json"], { ...process.env, NO_COLOR: "1" });
      expect(c1.status, c1.stderr).toBe(0);
      expect(JSON.parse(c1.stdout).items[0].outcome).toBe("cancel-requested");
      expect(intentCount()).toBe(1); // exactly one durable intent recorded
      expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("running"); // still running (poll suspended)

      // Identical retry (same key + request): REPLAYS the published result WITHOUT
      // re-running the work — byte-identical output — and records NO second intent.
      const c2 = brainSync(["jobs", "cancel", "job-run", "--idempotency-key", "k1", "--json"], { ...process.env, NO_COLOR: "1" });
      expect(c2.status, c2.stderr).toBe(0);
      expect(c2.stdout).toBe(c1.stdout);
      expect(intentCount()).toBe(1); // still exactly one — replay recorded nothing new

      // Reusing the SAME key with a DIFFERENT request is rejected (never silently re-published).
      const conflict = brainSync(["jobs", "cancel", "--all", "--idempotency-key", "k1", "--json"], { ...process.env, NO_COLOR: "1" });
      expect(conflict.status).not.toBe(0);
      expect(intentCount()).toBe(1);

      // RESUME the runner: it observes the single durable intent at its next poll tick and
      // reconciles the job to `cancelled` — the cancellation IS eventually observed.
      resume(run.proc);
      const { code } = await run.done;
      expect(code).toBe(0);
      expect(JSON.parse(run.out()).items[0].outcome).toBe("cancelled");
      expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("cancelled");
      expect(intentCount()).toBe(0); // consumed by the finalization that cancelled the job
    } finally {
      run.proc.kill("SIGCONT"); // ensure not left stopped
      run.proc.kill();
    }
  }, 30000);

  it("an UNWRITABLE former-marker location does not break cancellation — the intent lives only in SQLite", async () => {
    migrate();
    seed({ workflow: "test-cap", idempotencyKey: "run", payload: {} }, "job-run");

    // The ACTUAL path the removed filesystem-marker implementation wrote to was
    // `<ledgerDir>/jobs-cancel` (i.e. `cwd/.atlas/jobs-cancel`). Occupy it with a REGULAR
    // FILE so a marker write there is impossible — the former `mkdirSync(dir)` would throw
    // ENOTDIR/EEXIST. If cancellation still depended on writing a marker it would fail;
    // because the intent is durable in SQLite, cancel succeeds and never touches this path.
    const formerMarkerPath = join(cwd, ".atlas", "jobs-cancel");
    writeFileSync(formerMarkerPath, "not-a-directory", "utf8");
    const formerUntouched = (): boolean =>
      existsSync(formerMarkerPath) && readFileSync(formerMarkerPath, "utf8") === "not-a-directory";

    const run = await spawnParkedRun("job-run", join(root, "exec.log"), join(root, "started"), join(root, "gate-never"));
    try {
      expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("running");

      // SUSPEND so the poll cannot consume the intent before the assertions.
      suspend(run.proc);
      const cancel = brainSync(["jobs", "cancel", "job-run", "--json"], { ...process.env, NO_COLOR: "1" });
      expect(cancel.status, cancel.stderr).toBe(0); // succeeds despite the unwritable former-marker path
      expect(JSON.parse(cancel.stdout).items[0].outcome).toBe("cancel-requested");
      expect(intentCount()).toBe(1); // recorded durably in SQLite …
      expect(formerUntouched()).toBe(true); // … and the former marker path was NOT written

      // RESUME: the drain observes the durable intent and cancels — no marker ever involved.
      resume(run.proc);
      const { code } = await run.done;
      expect(code).toBe(0);
      expect(JSON.parse(run.out()).items[0].outcome).toBe("cancelled");
      expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("cancelled");
      expect(formerUntouched()).toBe(true); // still untouched after the drain observed it
      expect(intentCount()).toBe(0);
    } finally {
      run.proc.kill("SIGCONT");
      run.proc.kill();
    }
  }, 30000);

  it("crash: a SIGKILLed running process leaves the durable intent, which the next drain recovers and honors", async () => {
    migrate();
    seed({ workflow: "test-cap", idempotencyKey: "run", payload: {} }, "job-run");

    const execLog = join(root, "exec.log");
    const run = await spawnParkedRun("job-run", execLog, join(root, "started"), join(root, "gate-never"));
    expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("running");

    // SUSPEND the process BEFORE recording the intent: its 50 ms poll cannot observe the
    // cancel (so it can't cooperatively exit `cancelled`) and it cannot exit on its own —
    // guaranteeing it is still genuinely `running` when we SIGKILL it below.
    suspend(run.proc);

    // Record the durable cancel intent while the job is genuinely running in the child.
    const cancel = brainSync(["jobs", "cancel", "job-run", "--json"], { ...process.env, NO_COLOR: "1" });
    expect(cancel.status, cancel.stderr).toBe(0);
    expect(JSON.parse(cancel.stdout).items[0].outcome).toBe("cancel-requested");
    expect(intentCount()).toBe(1);
    expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("running");

    // CRASH the (suspended) running process (real SIGKILL — SIGKILL terminates even a
    // stopped process; no cleanup, no cooperative cancel path ever ran).
    run.proc.kill("SIGKILL");
    await run.done;
    // The job is still `running` in SQLite (the claim committed) and the intent persists —
    // it was committed, not merely written to disk.
    expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("running");
    expect(intentCount()).toBe(1);

    // The crashed runner left a STALE lock file (dead pid); reclaim it as an operator's
    // `doctor --reclaim-locks` would (removing it directly keeps this test focused on the
    // durable-cancel recovery path, independent of doctor's host probes).
    const staleLock = join(cwd, ".atlas", "locks", "jobs-runner.lock");
    expect(existsSync(staleLock)).toBe(true);
    rmSync(staleLock, { force: true });

    // The NEXT drain: dead-runner recovery observes the durable intent BEFORE attempt-budget
    // handling and reconciles the job directly to `cancelled` (finding 3), consuming it.
    const restart = brainSync(["jobs", "run", "job-run", "--json"], parkedRunEnv(execLog, join(root, "started2"), join(root, "gate2")));
    expect(restart.status, restart.stderr).toBe(0);
    expect(withStore((s) => readSnapshot(s, "job-run")?.state)).toBe("cancelled");
    expect(intentCount()).toBe(0); // no stranded intent
  }, 30000);
});
