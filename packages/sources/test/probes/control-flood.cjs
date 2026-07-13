/**
 * A worker that floods the fd3 CONTROL channel without bound — proves the launcher caps
 * the control channel and force-kills, so a compromised worker cannot exhaust trusted-
 * process memory by flooding fd3 (wing round-3 finding 5).
 */
"use strict";
const fs = require("node:fs");
const CONTROL_FD = 3;
const chunk = Buffer.alloc(64 * 1024, 0x43); // 64 KiB of 'C'
for (;;) {
  try {
    fs.writeSync(CONTROL_FD, chunk);
  } catch {
    break; // pipe closed on kill
  }
}
