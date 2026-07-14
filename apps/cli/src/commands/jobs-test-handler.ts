/**
 * A deterministic, ENV-GATED job handler for the real-process acceptance tests
 * (Task 2.7 / findings 1 & 3). The single-runner-exclusion and cross-process-cancel
 * acceptance tests must spawn actual `brain jobs run` processes, but a real drain has
 * no registered workflow executor in this build (those arrive with Phase-2 capture).
 * This seam registers one — but ONLY when `ATLAS_TEST_JOB_HANDLER=1`, so a production
 * `brain` never carries a test workflow. It mirrors the existing gated test seams in
 * `backup-config.ts` (`ATLAS_TEST_MODE`/`ATLAS_CUSTODY_TEST_DIR`).
 *
 * Behaviour (env-driven):
 *  - `ATLAS_TEST_JOB_WORKFLOW` — the workflow to register (default `test-cap`);
 *  - `ATLAS_TEST_JOB_EXEC_LOG` — append `<jobId>\n` on each execution (exactly-once proof);
 *  - `ATLAS_TEST_JOB_STARTED_DIR` — touch `<dir>/<jobId>` when the handler starts (so the
 *    test knows the drain holds the lock / is parked before racing a second process);
 *  - `ATLAS_TEST_JOB_GATE_FILE` — if set, PARK until this file exists, polling the
 *    `AbortSignal` each tick so a cross-process cancel is observed (→ `AbortError`);
 *  - `ATLAS_TEST_JOB_POLL_MS` (default 20) / `ATLAS_TEST_JOB_PARK_TIMEOUT_MS`
 *    (default 20000) — park cadence + a safety timeout so a wedged test never hangs forever.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobHandler } from "@atlas/jobs";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Register the env-gated test handler on `register` iff `ATLAS_TEST_JOB_HANDLER=1`. */
export function installTestJobHandler(
  env: NodeJS.ProcessEnv,
  register: (workflow: string, handler: JobHandler) => void,
): void {
  if (env.ATLAS_TEST_JOB_HANDLER !== "1") return;

  const workflow = env.ATLAS_TEST_JOB_WORKFLOW ?? "test-cap";
  const execLog = env.ATLAS_TEST_JOB_EXEC_LOG;
  const startedDir = env.ATLAS_TEST_JOB_STARTED_DIR;
  const gateFile = env.ATLAS_TEST_JOB_GATE_FILE;
  const pollMs = Number(env.ATLAS_TEST_JOB_POLL_MS ?? "20");
  const timeoutMs = Number(env.ATLAS_TEST_JOB_PARK_TIMEOUT_MS ?? "20000");

  const handler: JobHandler = async ({ jobId, signal }) => {
    if (execLog) appendFileSync(execLog, `${jobId}\n`); // one line per execution
    if (startedDir) {
      mkdirSync(startedDir, { recursive: true });
      writeFileSync(join(startedDir, encodeURIComponent(jobId)), "");
    }
    if (gateFile) {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(gateFile)) {
        if (signal.aborted) throw { name: "AbortError", message: "cancelled while parked" };
        if (Date.now() > deadline) throw { kind: "timeout", message: "test handler park timed out" };
        await sleep(pollMs);
      }
    }
    return {};
  };

  register(workflow, handler);
}
