/**
 * `doctor.provisioning.test` (Phase 1 Task 3 / round-4 finding 5) — pins the
 * `provisioning-presence` check to its PRE-Phase-1 behavior: a socket **artifact**
 * (`existsSync`) probe with a byte-exact diagnostic, NOT a live-connection probe.
 * Broker LIVENESS is a separate concern owned by the anchor check + the shared
 * `probeDaemon` consumers (`assertReadAuditReady`); swapping this presence check to a
 * live connect changed its verdict + wording and duplicated that liveness. These
 * goldens fail if the artifact check or its exact message ever drifts again.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProvisioning } from "../src/commands/doctor.js";
import type { RunContext } from "../src/main.js";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "atlas-doctor-prov-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/**
 * A provisioned ctx (ATLAS_PROVISIONED=1, ATLAS_TEST_MODE=1) with a resolvable AEAD
 * custody key (via the gated test seam) so the ONLY variable is the broker socket
 * ARTIFACT — letting us assert its exact diagnostic in isolation.
 */
function provisionedCtx(socketPath: string): RunContext {
  const custodyDir = join(base, "custody");
  mkdirSync(custodyDir, { recursive: true });
  // A 32-byte base64 key so `backupConfig` resolves (custody present, not the variable).
  writeFileSync(join(custodyDir, "cli-custody-v1.key"), Buffer.alloc(32).toString("base64"));
  return {
    cwd: base,
    env: { ATLAS_PROVISIONED: "1", ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: custodyDir },
    config: {
      config: {
        broker: { socket_path: socketPath },
        git: { audit_anchor_path: join(base, "anchor") },
        sqlite: {
          path: join(base, "ledger.db"),
          ledger_backup: { key_id: "cli-custody-v1", dir: join(base, "backups"), keep: 5 },
        },
      },
    },
  } as unknown as RunContext;
}

describe("provisioning-presence: socket ARTIFACT check (byte-parity)", () => {
  it("flags an ABSENT broker socket with the exact pre-refactor diagnostic (not a liveness probe)", () => {
    const socket = join(base, "broker.sock"); // never created ⇒ artifact absent
    const c = checkProvisioning(provisionedCtx(socket));
    expect(c.status).toBe("action-required");
    // Byte-exact: the message is `broker socket <path> absent (is the broker daemon
    // running?)`, NOT a live-connection error like `... not reachable (ECONNREFUSED)`.
    expect(c.detail).toBe(
      `incomplete provisioning: broker socket ${socket} absent (is the broker daemon running?)`,
    );
  });

  it("does NOT flag the socket when the ARTIFACT is present (no live connection required)", () => {
    const socket = join(base, "broker.sock");
    writeFileSync(socket, ""); // a mere artifact — nothing is listening on it
    const c = checkProvisioning(provisionedCtx(socket));
    // Presence of the artifact alone clears the socket check — proving this is an
    // existsSync probe, not a connect() that would fail on this dead file.
    expect(c.status).toBe("ok");
    expect(c.detail ?? "").not.toMatch(/broker socket/);
  });
});
