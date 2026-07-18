/**
 * `daemon-probe` (Phase 1 Task 3) — the typed connect/close daemon probe. Covers
 * all three outcomes: `reachable` (a live socket), `unreachable` (a missing
 * socket → `ENOENT`, ordinary socket-down → the `daemon` event seam), and
 * `fault` (a non-socket-down error — an over-long `sun_path`; the seam Phase 4
 * maps to `watch.error`). Socket-failure classification goes through the shared
 * `isTransportError` (no second list). Note the regular-file case is
 * OS-divergent: connect(2) gives ENOTSOCK on macOS but ECONNREFUSED on Linux.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDaemon, isReachable } from "../src/health/probe.js";

let dir: string;
let server: Server | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-daemon-probe-"));
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Start a bare Unix-socket listener (accepts and closes; the probe sends no bytes). */
function listen(path: string): Promise<void> {
  server = createServer((sock) => sock.end());
  return new Promise((res) => server!.listen(path, () => res()));
}

describe("probeDaemon", () => {
  it("returns reachable for a live socket", async () => {
    const path = join(dir, "live.sock");
    await listen(path);
    const p = await probeDaemon(path);
    expect(p.status).toBe("reachable");
    expect(p.socketPath).toBe(path);
    expect(isReachable(p)).toBe(true);
  });

  it("returns unreachable (ENOENT) for a missing socket", async () => {
    const p = await probeDaemon(join(dir, "missing.sock"));
    expect(p.status).toBe("unreachable");
    if (p.status === "unreachable") expect(p.code).toBe("ENOENT");
    expect(isReachable(p)).toBe(false);
  });

  it("returns fault for a non-socket-down error (an over-long sun_path → EINVAL/ENAMETOOLONG)", async () => {
    // A path exceeding the kernel sun_path limit fails with a code outside the
    // transport set on every platform (macOS: EINVAL, Linux: EINVAL/ENAMETOOLONG),
    // unlike the regular-file probe below, whose code is OS-divergent.
    const p = await probeDaemon(join(dir, "x".repeat(200) + ".sock"));
    expect(p.status).toBe("fault");
    if (p.status === "fault") {
      expect(["EINVAL", "ENAMETOOLONG"]).toContain(p.code);
      expect(p.message.length).toBeGreaterThan(0);
    }
    expect(isReachable(p)).toBe(false);
  });

  it("classifies a regular file by the platform's connect(2) code (macOS ENOTSOCK → fault; Linux ECONNREFUSED → unreachable)", async () => {
    const path = join(dir, "regular.txt");
    writeFileSync(path, "not a socket");
    const p = await probeDaemon(path);
    if (process.platform === "linux") {
      expect(p.status).toBe("unreachable");
      if (p.status === "unreachable") expect(p.code).toBe("ECONNREFUSED");
    } else {
      expect(p.status).toBe("fault");
      if (p.status === "fault") expect(p.code).toBe("ENOTSOCK");
    }
    expect(isReachable(p)).toBe(false);
  });
});
