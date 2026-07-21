/**
 * `loadBrokerConfigFromEnv` must honour the adopted canonical ref (60-A / #60).
 *
 * REGRESSION (live drive 2026-07-21): the CLI resolves `git.canonical_ref`
 * (`refs/atlas/main` for an adopted vault) via `protectedRefsFor`, but the BROKER
 * DAEMON built its config from `loadBrokerConfigFromEnv`, which hardcoded
 * `DEFAULT_PROTECTED_REFS` (`refs/heads/main`) with no env override. On the live
 * main-vault drive every scope-"sync" integrate then CAS-mismatched
 * ("capture base moved: expected <refs/atlas/main head>, canonical is <refs/heads/main
 * head>") — and had the upstream branch happened to match, the daemon would have
 * advanced `refs/heads/main`, the exact write the adoption invariant forbids. The
 * in-process test harness constructs `BrokerService` with the right refs directly,
 * so it never exercised the daemon env path. This binds it.
 */
import { afterEach, describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrokerConfigFromEnv, DEFAULT_CANONICAL_REF } from "../src/index.js";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A keys dir with the provisioning-shaped Ed25519 attestation key files (no signers.json). */
function keysDir(): string {
  dir = mkdtempSync(join(tmpdir(), "atlas-broker-cfg-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(join(dir, "audit-attestation.key"), privateKey);
  writeFileSync(join(dir, "audit-attestation.pub"), publicKey);
  return dir;
}

function baseEnv(kd: string): NodeJS.ProcessEnv {
  return {
    ATLAS_BROKER_KEYS_DIR: kd,
    ATLAS_VAULT_REPO_DIR: "/tmp/does-not-matter-here",
    ATLAS_AUDIT_ANCHOR_PATH: join(kd, "anchor"),
  };
}

describe("loadBrokerConfigFromEnv — canonical ref", () => {
  it("defaults to refs/heads/main when ATLAS_CANONICAL_REF is unset (plain vault)", () => {
    const cfg = loadBrokerConfigFromEnv(baseEnv(keysDir()));
    expect(cfg.refs.canonical).toBe(DEFAULT_CANONICAL_REF);
    expect(cfg.refs.canonical).toBe("refs/heads/main");
  });

  it("uses ATLAS_CANONICAL_REF when set (adopted vault → refs/atlas/main)", () => {
    const cfg = loadBrokerConfigFromEnv({ ...baseEnv(keysDir()), ATLAS_CANONICAL_REF: "refs/atlas/main" });
    expect(cfg.refs.canonical).toBe("refs/atlas/main");
  });

  it("never lets the override touch audit/trust — only canonical is adoptable", () => {
    const cfg = loadBrokerConfigFromEnv({ ...baseEnv(keysDir()), ATLAS_CANONICAL_REF: "refs/atlas/main" });
    expect(cfg.refs.audit).toBe("refs/audit/runs");
    expect(cfg.refs.trust).toBe("refs/trust/ledger");
  });

  it("treats a blank ATLAS_CANONICAL_REF as unset (never installs an empty ref name)", () => {
    const cfg = loadBrokerConfigFromEnv({ ...baseEnv(keysDir()), ATLAS_CANONICAL_REF: "" });
    expect(cfg.refs.canonical).toBe(DEFAULT_CANONICAL_REF);
  });
});
