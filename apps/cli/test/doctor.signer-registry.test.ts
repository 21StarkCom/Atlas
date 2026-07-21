/**
 * `doctor.signer-registry.test` (SP-3 R2) — positive + negative coverage for the
 * `signer-registry` integrity check: every condition it names has a passing and a
 * failing case. Drives `checkSignerRegistry(ctx)` directly with a temp broker keys
 * dir via `ATLAS_BROKER_KEYS_DIR`.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSignerRegistry } from "../src/commands/doctor.js";
import type { RunContext } from "../src/main.js";

let base: string;
let keysDir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "atlas-doctor-signer-"));
  keysDir = join(base, "atlas-broker");
  mkdirSync(keysDir, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function ctx(env: Record<string, string> = {}): RunContext {
  return {
    cwd: base,
    env: { ATLAS_BROKER_KEYS_DIR: keysDir, ...env },
    config: { config: {} },
  } as unknown as RunContext;
}

function ed25519Native(): string {
  const der = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  return "ed25519:" + Buffer.from(der).toString("base64url");
}
function p256Native(): string {
  const der = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" });
  return "p256:" + Buffer.from(der).toString("base64url");
}
function ed25519Pem(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
}

const ATTEST = {
  signerId: "atlas-audit-attestation-v1",
  publicKey: ed25519Native(),
  permittedOps: [],
  status: "active",
  enrolledAt: "2026-07-01T00:00:00.000Z",
};
const NINE_OPS = ["db restore", "git approve", "git refresh", "git rollback", "graduation migrate", "purge", "source trust promote", "source trust revoke", "db backup --force-unblock"];

function writeSigners(entries: unknown[]): void {
  writeFileSync(join(keysDir, "signers.json"), JSON.stringify(entries, null, 2));
}

describe("signer-registry doctor check (R2)", () => {
  it("ok when no explicit signers.json (derivation in effect)", () => {
    const c = checkSignerRegistry(ctx());
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/derivation in effect/);
  });

  // #297 (SP-3 P6): a check that verified NOTHING must not read green. The
  // broker keys dir is 0700/atlas-broker, so the operator UID that normally runs
  // `doctor` cannot resolve or read it — that is `skipped`, never a vacuous `ok`.
  it("skipped (not ok) when no broker keys dir can be resolved", () => {
    // No ATLAS_BROKER_KEYS_DIR and a cwd with no provisioning/keys.acl.json.
    const c = checkSignerRegistry({
      cwd: base,
      env: {},
      config: { config: {} },
    } as unknown as RunContext);
    expect(c.status).toBe("skipped");
    expect(c.status).not.toBe("ok");
    expect(c.detail).toMatch(/atlas-broker/);
  });

  it("skipped (not a false ok, not action-required) when the keys dir is unreadable to this user", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root bypasses perms
    writeSigners([ATTEST]); // a real registry exists…
    chmodSync(keysDir, 0o000); // …but this UID can't read the dir
    try {
      const c = checkSignerRegistry(ctx());
      expect(c.status).toBe("skipped"); // NOT "ok" (green-wash) and NOT "action-required" (false alarm)
      expect(c.detail).toMatch(/not readable/);
    } finally {
      chmodSync(keysDir, 0o700); // restore so afterEach can clean up
    }
  });

  it("ok for a valid registry: attestation + a presence p256 signer", () => {
    writeSigners([
      ATTEST,
      {
        signerId: "approver-se-mac-v1",
        alg: "p256",
        presence: true,
        publicKey: p256Native(),
        permittedOps: [...NINE_OPS, "quarantine inspect", "quarantine resolve"],
        status: "active",
        enrolledAt: "2026-07-20T00:00:00.000Z",
      },
    ]);
    const c = checkSignerRegistry(ctx());
    expect(c.status).toBe("ok");
  });

  it("action-required when the attestation entry is MISSING", () => {
    writeSigners([
      { signerId: "approver-se-mac-v1", alg: "p256", presence: true, publicKey: p256Native(), permittedOps: NINE_OPS, status: "active", enrolledAt: "2026-07-20T00:00:00.000Z" },
    ]);
    const c = checkSignerRegistry(ctx());
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/attestation entry .* MISSING/);
  });

  it("action-required when an entry fails the registry schema (bad alg)", () => {
    writeSigners([ATTEST, { signerId: "x", alg: "p384", publicKey: p256Native(), permittedOps: [], status: "active", enrolledAt: "2026-07-20T00:00:00.000Z" }]);
    const c = checkSignerRegistry(ctx());
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/registry schema/);
  });

  it("action-required when a quarantine op is carried without presence:true + p256", () => {
    writeSigners([
      ATTEST,
      { signerId: "bad", publicKey: ed25519Native(), permittedOps: [...NINE_OPS, "quarantine resolve"], status: "active", enrolledAt: "2026-07-20T00:00:00.000Z" },
    ]);
    const c = checkSignerRegistry(ctx());
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/quarantine op without presence/);
  });

  it("action-required when ATLAS_TEST_MODE=1 on a provisioned host with an active fixture signer", () => {
    writeSigners([
      ATTEST,
      { signerId: "atlas-test-approver-p256", alg: "p256", publicKey: p256Native(), permittedOps: NINE_OPS, status: "active", enrolledAt: "2026-07-20T00:00:00.000Z" },
    ]);
    const c = checkSignerRegistry(ctx({ ATLAS_TEST_MODE: "1", ATLAS_PROVISIONED: "1" }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/ATLAS_TEST_MODE=1 on a provisioned host/);
  });

  it("ok with an active fixture signer when test mode is NOT set (D20 gates it at authorize time)", () => {
    writeSigners([
      ATTEST,
      { signerId: "atlas-test-approver-p256", alg: "p256", publicKey: p256Native(), permittedOps: NINE_OPS, status: "active", enrolledAt: "2026-07-20T00:00:00.000Z" },
    ]);
    const c = checkSignerRegistry(ctx());
    expect(c.status).toBe("ok");
  });

  it("action-required on the orphaned approval-verify.pub trap (non-empty, no matching active entry)", () => {
    writeSigners([ATTEST]); // explicit registry with NO approver entry
    writeFileSync(join(keysDir, "approval-verify.pub"), ed25519Pem()); // a key that isn't enrolled
    const c = checkSignerRegistry(ctx());
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/approval-verify\.pub is non-empty but no active/);
  });

  it("ok when approval-verify.pub matches an active enrolled entry", () => {
    // One keypair used for BOTH the file and the registry entry (same fingerprint).
    const kp = generateKeyPairSync("ed25519");
    const pubPem = kp.publicKey.export({ format: "pem", type: "spki" }).toString();
    const pubNative = "ed25519:" + Buffer.from(kp.publicKey.export({ format: "der", type: "spki" })).toString("base64url");
    writeSigners([
      ATTEST,
      { signerId: "approval-verify", publicKey: pubNative, permittedOps: NINE_OPS, status: "active", enrolledAt: "2026-07-20T00:00:00.000Z" },
    ]);
    writeFileSync(join(keysDir, "approval-verify.pub"), pubPem);
    const c = checkSignerRegistry(ctx());
    expect(c.status).toBe("ok");
  });
});
