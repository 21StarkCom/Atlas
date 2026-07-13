/**
 * A worker that floods STDERR (fd 2) without bound — proves the launcher caps the
 * stderr channel and force-kills, rather than accumulating unbounded diagnostics in the
 * trusted parent (wing round-3 finding 5). Emits no control message.
 */
"use strict";
const fs = require("node:fs");
const chunk = Buffer.alloc(64 * 1024, 0x45); // 64 KiB of 'E'
for (;;) {
  try {
    fs.writeSync(2, chunk);
  } catch {
    break; // pipe closed on kill
  }
}
