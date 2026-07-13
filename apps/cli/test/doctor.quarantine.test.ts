/**
 * `doctor.quarantine.test` (Task 2.2 / #28) — the `quarantine-security` doctor check
 * validates the ACTUAL custody posture (not merely that an ACL row exists), treats
 * an invalid/unreadable dir as action-required (never an escaping internal failure),
 * and degrades (not fails) on crash-leftover temps.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkQuarantineSecurity } from "../src/commands/doctor.js";
import type { RunContext } from "../src/main.js";

const GOOD_ACL = {
  keys: [
    { key: "quarantine-aead", mode: "0600", identity: "agent", file: "quarantine-aead.key", readableBy: ["trusted-cli"], parserModelDenied: true },
  ],
  group: { notMembers: ["atlas-egress"] },
  paths: { keysDir: { darwin: "/usr/local/etc/atlas/keys", linux: "/etc/atlas/keys" } },
};

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "atlas-doctor-q-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A minimal RunContext for the check: repo cwd (walked for the ACL), vault + quarantine config, env. */
function ctxWith(opts: { acl?: unknown; quarantineDir?: string; env?: NodeJS.ProcessEnv }): RunContext {
  const repo = join(base, "repo");
  mkdirSync(join(repo, "provisioning"), { recursive: true });
  if (opts.acl !== undefined) {
    writeFileSync(join(repo, "provisioning", "keys.acl.json"), JSON.stringify(opts.acl));
  }
  return {
    cwd: repo,
    env: opts.env ?? {},
    config: {
      config: {
        vault: { path: join(base, "vault") },
        quarantine: { dir: opts.quarantineDir, keep: 200, retention_days: 30, key_id: "cli-custody-v1", revoked_key_ids: [] },
      },
    },
  } as unknown as RunContext;
}

describe("quarantine-security doctor check", () => {
  it("ok when the ACL posture is correct and no store exists yet", () => {
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: join(base, "state", "q") }));
    expect(c.status).toBe("ok");
  });

  it("action-required when readableBy widens beyond trusted-cli", () => {
    const acl = { ...GOOD_ACL, keys: [{ ...GOOD_ACL.keys[0], readableBy: ["trusted-cli", "atlas-egress"] }] };
    const c = checkQuarantineSecurity(ctxWith({ acl, quarantineDir: join(base, "state", "q") }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/readableBy/);
  });

  it("action-required when parserModelDenied is not set", () => {
    const acl = { ...GOOD_ACL, keys: [{ ...GOOD_ACL.keys[0], parserModelDenied: false }] };
    const c = checkQuarantineSecurity(ctxWith({ acl, quarantineDir: join(base, "state", "q") }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/parserModelDenied|parser\/model/);
  });

  it("action-required when the file/identity does not match provisioning", () => {
    const acl = { ...GOOD_ACL, keys: [{ ...GOOD_ACL.keys[0], file: "trusted-cli-v1.key", identity: "trusted-cli" }] };
    const c = checkQuarantineSecurity(ctxWith({ acl, quarantineDir: join(base, "state", "q") }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/file|identity/);
  });

  it("action-required when the configured dir is inside the repository (never an internal crash)", () => {
    const repoInner = join(base, "repo", ".atlas", "q");
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: repoInner }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/inside the repository|invalid/);
  });

  it("action-required on a group/other-accessible store dir", () => {
    const q = join(base, "state", "q");
    mkdirSync(q, { recursive: true, mode: 0o777 });
    chmodSync(q, 0o777); // force the loose mode past umask
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: q }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/group\/other-accessible/);
  });

  it("degraded on a crash-leftover temp file", () => {
    const q = join(base, "state", "q");
    mkdirSync(q, { recursive: true, mode: 0o700 });
    writeFileSync(join(q, ".qtmp-leftover"), "ciphertext");
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: q }));
    expect(c.status).toBe("degraded");
    expect(c.detail).toMatch(/temp file/);
  });

  const BUNDLE = `q-${"a".repeat(32)}.aqz`;

  it("action-required when the store dir is a SYMLINK (lstat, not stat — the check must not follow it)", () => {
    const realTarget = join(base, "state", "real-q");
    mkdirSync(realTarget, { recursive: true, mode: 0o700 });
    const link = join(base, "state", "q");
    symlinkSync(realTarget, link);
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: link }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/symlink/);
  });

  it("action-required when a bundle-named entry holds PLAINTEXT (a valid-looking name is not enough)", () => {
    const q = join(base, "state", "q");
    mkdirSync(q, { recursive: true, mode: 0o700 });
    writeFileSync(join(q, BUNDLE), "this is not an encrypted bundle");
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: q }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/plaintext|not a sealed bundle|invalid quarantine entry/);
  });

  it("action-required when a bundle-named entry is a DIRECTORY (not a regular file)", () => {
    const q = join(base, "state", "q");
    mkdirSync(q, { recursive: true, mode: 0o700 });
    mkdirSync(join(q, BUNDLE));
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: q }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/not a regular file/);
  });

  it("action-required on a CORRUPT (well-formed JSON, wrong shape) bundle", () => {
    const q = join(base, "state", "q");
    mkdirSync(q, { recursive: true, mode: 0o700 });
    writeFileSync(join(q, BUNDLE), JSON.stringify({ not: "a bundle" }));
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: q }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/malformed bundle shape|invalid quarantine entry/);
  });

  it("action-required when a STRUCTURALLY-VALID bundle exists but the AEAD custody key is unavailable (no false-healthy)", () => {
    // A bundle could only be written with custody available; a custody failure while
    // sealed bundles remain must NOT report ok — their integrity can no longer be verified.
    const q = join(base, "state", "q");
    mkdirSync(q, { recursive: true, mode: 0o700 });
    const itemId = "a".repeat(32);
    const bundle = {
      nonce: "AAAAAAAAAAAAAAAA",
      authTag: "AAAAAAAAAAAAAAAAAAAAAA==",
      ciphertext: "AAAA",
      header: {
        magic: "ATLAS-QUARANTINE",
        version: 2,
        keyId: "cli-custody-v1",
        itemId,
        createdAt: "2026-07-13T00:00:00.000Z",
        expiresAt: "2026-08-12T00:00:00.000Z",
      },
    };
    writeFileSync(join(q, BUNDLE), JSON.stringify(bundle));
    // No ATLAS_TEST_MODE ⇒ custody resolves to the (absent) system keys dir ⇒ unavailable.
    const c = checkQuarantineSecurity(ctxWith({ acl: GOOD_ACL, quarantineDir: q }));
    expect(c.status).toBe("action-required");
    expect(c.detail).toMatch(/custody key is unavailable|integrity cannot be verified/);
  });
});
