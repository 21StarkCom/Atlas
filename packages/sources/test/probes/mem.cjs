/**
 * A worker that grows resident memory without bound — used to prove the memory cap
 * force-terminates it. On Linux RLIMIT_AS makes the allocation fail (non-zero exit); on
 * macOS (no enforced RLIMIT_AS) the launcher's RSS watchdog SIGKILLs it. Either way it
 * never exits cleanly (Task 2.3 `resource-caps`, memory). Allocates in modest chunks
 * with a tick delay so the ~120ms RSS poll can catch it well before the host is stressed.
 */
"use strict";
const held = [];
let mb = 0;
const grow = () => {
  try {
    // Touch every page (zero-fill) so RSS — not just virtual size — climbs.
    held.push(Buffer.alloc(20 * 1024 * 1024, 1));
    mb += 20;
    if (mb > 4096) return; // safety ceiling; the cap should have fired long before
    setTimeout(grow, 25);
  } catch {
    // RLIMIT_AS (Linux) — allocation refused: exit non-zero so the launcher sees it.
    process.exit(9);
  }
};
grow();
