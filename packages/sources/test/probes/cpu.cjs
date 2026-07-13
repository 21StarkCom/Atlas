/**
 * A worker that burns CPU forever — used to prove RLIMIT_CPU force-terminates a parser
 * that exceeds its CPU-seconds cap (SIGXCPU on both hosts) BEFORE the wall-clock
 * watchdog would (the test sets cpuSeconds << wallClockMs). It emits no control, so the
 * launcher observes a signalled/non-clean exit (Task 2.3 `resource-caps`, CPU).
 */
"use strict";
// Tight arithmetic loop — no syscalls, so only the CPU rlimit (not seccomp) ends it.
let x = 0;
for (;;) {
  x = Math.sqrt(x * 3.14159 + 1) + Math.sin(x);
}
