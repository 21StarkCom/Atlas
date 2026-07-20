/**
 * `enroll-signer.test` (SP-3 §7) — the behavioral contract of
 * `provisioning/enroll-signer.sh` + its merge core, exercised against an isolated
 * temp `keysDir` (ATLAS_ENROLL_TEST_MODE=1 skips the root gate / chown / broker
 * restart). Asserts the §7 rules and that the result loads via `loadSignerRegistry`.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";

// Each test shells out to bash → node (the merge helper) several times; on a slow
// machine those subprocess round trips exceed the 5s default. The work is trivial
// on CI — this only lifts the wall-clock ceiling.
vi.setConfig({ testTimeout: 60000 });
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSignerRegistry, SIGNATURE_AUTHORIZABLE_OPS } from "@atlas/broker";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "provisioning/enroll-signer.sh");
const QUARANTINE_OPS = ["quarantine inspect", "quarantine resolve"];

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function ed25519Pem(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
}
function p256Pem(): string {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
}

/** A provisioning-shaped broker keys dir (seeds an attestation pub so it materializes). */
function keysDir(): string {
  root = mkdtempSync(join(tmpdir(), "atlas-enroll-"));
  const kd = join(root, "atlas-broker");
  mkdirSync(kd, { recursive: true });
  writeFileSync(join(kd, "audit-attestation.pub"), ed25519Pem());
  return kd;
}

interface Run { code: number; stderr: string }
function enroll(kd: string, args: string[], env: Record<string, string> = {}): Run {
  // spawnSync so stderr is captured on BOTH the success and failure paths (the
  // script writes all human output to stderr; stdout stays empty).
  const r = spawnSync("bash", [SCRIPT, ...args, "--keys-dir", kd], {
    encoding: "utf8",
    env: { ...process.env, ATLAS_ENROLL_TEST_MODE: "1", ...env },
  });
  return { code: r.status ?? 1, stderr: r.stderr ?? "" };
}

function pemFile(kd: string, name: string, pem: string): string {
  const p = join(dirname(kd), name);
  writeFileSync(p, pem);
  return p;
}

function registry(kd: string): ReturnType<typeof loadSignerRegistry> {
  return loadSignerRegistry(kd);
}

describe("enroll-signer.sh — §7 enrollment contract", () => {
  it("materializes the derived registry then appends a p256 presence signer", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "se.pem", p256Pem());
    const r = enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"]);
    expect(r.code).toBe(0);
    const reg = registry(kd);
    // Materialized: attestation + both fixtures + the new signer.
    expect(reg.find((e) => e.signerId === "atlas-audit-attestation-v1")).toBeDefined();
    expect(reg.find((e) => e.signerId === "atlas-test-approver-p256")).toBeDefined();
    const se = reg.find((e) => e.signerId === "approver-se-h-v1")!;
    expect(se.alg).toBe("p256");
    expect(se.presence).toBe(true);
    expect(se.status).toBe("active");
    // presence ⇒ the two quarantine ops on top of the base set.
    expect(new Set(se.permittedOps)).toEqual(new Set([...SIGNATURE_AUTHORIZABLE_OPS, ...QUARANTINE_OPS]));
  });

  it("a non-presence signer's non-quarantine permittedOps equals SIGNATURE_AUTHORIZABLE_OPS exactly", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "se.pem", p256Pem());
    expect(enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256"]).code).toBe(0);
    const se = registry(kd).find((e) => e.signerId === "approver-se-h-v1")!;
    expect(se.presence).toBeUndefined();
    expect(new Set(se.permittedOps)).toEqual(new Set(SIGNATURE_AUTHORIZABLE_OPS));
    for (const q of QUARANTINE_OPS) expect(se.permittedOps).not.toContain(q);
  });

  it("re-enrolling the identical id+key+presence is an idempotent no-op", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "se.pem", p256Pem());
    const args = ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"];
    expect(enroll(kd, args).code).toBe(0);
    const before = readFileSync(join(kd, "signers.json"), "utf8");
    const r2 = enroll(kd, args);
    expect(r2.code).toBe(0);
    expect(r2.stderr).toContain("already enrolled identically");
    expect(readFileSync(join(kd, "signers.json"), "utf8")).toBe(before);
  });

  it("REFUSES aliasing — the same key under a different active signerId", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "se.pem", p256Pem());
    expect(enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"]).code).toBe(0);
    const r = enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v2", "--alg", "p256", "--presence"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/aliasing refused/);
    expect(registry(kd).find((e) => e.signerId === "approver-se-h-v2")).toBeUndefined();
  });

  it("REFUSES a silent key swap — same signerId, different key", () => {
    const kd = keysDir();
    const a = pemFile(kd, "a.pem", p256Pem());
    const b = pemFile(kd, "b.pem", p256Pem());
    expect(enroll(kd, ["--pubkey", a, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"]).code).toBe(0);
    const r = enroll(kd, ["--pubkey", b, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/DIFFERENT key|Rotate/);
  });

  it("REFUSES a silent rights change — same id+key but presence dropped", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "se.pem", p256Pem());
    expect(enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"]).code).toBe(0);
    const r = enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/different presence|rights change|Rotate/);
  });

  it("REFUSES --presence on --alg ed25519", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "ed.pem", ed25519Pem());
    const r = enroll(kd, ["--pubkey", pem, "--signer-id", "file-approver-v1", "--alg", "ed25519", "--presence"]);
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/--presence requires --alg p256/);
  });

  it("enrolls an ed25519 break-glass approver (no presence, no quarantine ops)", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "ed.pem", ed25519Pem());
    expect(enroll(kd, ["--pubkey", pem, "--signer-id", "file-approver-v1", "--alg", "ed25519"]).code).toBe(0);
    const e = registry(kd).find((x) => x.signerId === "file-approver-v1")!;
    expect(e.alg).toBeUndefined();
    expect(new Set(e.permittedOps)).toEqual(new Set(SIGNATURE_AUTHORIZABLE_OPS));
  });

  it("revokes by flipping status + revokedAt; re-revoke preserves revokedAt; unknown id fails and mutates nothing", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "se.pem", p256Pem());
    expect(enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"]).code).toBe(0);
    expect(enroll(kd, ["--revoke", "--signer-id", "approver-se-h-v1"]).code).toBe(0);
    let e = registry(kd).find((x) => x.signerId === "approver-se-h-v1")!;
    expect(e.status).toBe("revoked");
    expect(e.revokedAt).toBeTruthy();
    const firstRevokedAt = e.revokedAt;
    expect(enroll(kd, ["--revoke", "--signer-id", "approver-se-h-v1"]).code).toBe(0);
    e = registry(kd).find((x) => x.signerId === "approver-se-h-v1")!;
    expect(e.revokedAt).toBe(firstRevokedAt); // preserved

    const before = readFileSync(join(kd, "signers.json"), "utf8");
    const r = enroll(kd, ["--revoke", "--signer-id", "does-not-exist-v9"]);
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(kd, "signers.json"), "utf8")).toBe(before); // no mutation
  });

  it("ATLAS_DRY_RUN mutates nothing", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "se.pem", p256Pem());
    const r = enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256"], { ATLAS_DRY_RUN: "1" });
    expect(r.code).toBe(0);
    expect(existsSync(join(kd, "signers.json"))).toBe(false);
  });

  it("writes signers.json at 0600 and it loads via loadSignerRegistry", () => {
    const kd = keysDir();
    const pem = pemFile(kd, "se.pem", p256Pem());
    expect(enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"]).code).toBe(0);
    const mode = statSync(join(kd, "signers.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(() => loadSignerRegistry(kd)).not.toThrow();
  });

  it("rejects a --pubkey that does not parse as the named algorithm", () => {
    const kd = keysDir();
    // an ed25519 key offered as p256
    const pem = pemFile(kd, "ed.pem", ed25519Pem());
    const r = enroll(kd, ["--pubkey", pem, "--signer-id", "approver-se-h-v1", "--alg", "p256", "--presence"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/does not parse as a p256/);
  });
});
