import { defineConfig } from "vitest/config";

/**
 * The sandbox suites spawn real confined worker processes and exercise resource caps
 * whose in-sandbox watchdogs use wall-clock budgets up to ~25s (a flooding/hung worker
 * is force-killed by the launcher, not by vitest). The default 5s test timeout would
 * fire BEFORE those caps do — especially under the CPU contention of a parallel
 * `pnpm -r test` — surfacing a spurious timeout instead of the real cap outcome. Raise
 * the test/hook timeout comfortably above every `wallClockMs` used in the suite.
 */
export default defineConfig({
  test: {
    testTimeout: 40_000,
    hookTimeout: 40_000,
  },
});
