/**
 * A worker that floods the output pipe (fd 1) past the byte ceiling — used to prove
 * the launcher caps output and force-kills rather than accepting an unbounded (or
 * truncated-but-"successful") stream (Task 2.3 `resource-caps`, output-bytes).
 */
"use strict";
const fs = require("node:fs");
const chunk = Buffer.alloc(64 * 1024, 0x41); // 64 KiB of 'A'
// Write until the launcher kills us for exceeding maxOutputBytes.
for (;;) {
  try {
    fs.writeSync(1, chunk);
  } catch {
    break; // pipe closed on kill
  }
}
