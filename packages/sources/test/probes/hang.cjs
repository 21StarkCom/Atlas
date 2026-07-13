/**
 * A worker that never terminates — used to prove the wall-clock watchdog force-kills
 * a hung parser AND that the launcher still cleans up the worker-private temp after
 * the forced termination (Task 2.3 `resource-caps` + cleanup acceptance).
 */
"use strict";
// Keep the event loop alive forever; only SIGKILL from the watchdog ends this.
setInterval(() => {}, 1 << 30);
