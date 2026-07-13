/**
 * `provisioning-keys.test` — round-3 finding 1.
 *
 * The broker + test-signer must run against EXACTLY the key material Task-1.0
 * provisioning installs: OpenSSL-generated Ed25519 **PEM** files (`audit-
 * attestation.key`/`.pub`, `approval-verify.pub`, `atlas-test-approver.key`) and
 * NO `signers.json` — the signer registry is derived from those files. This test
 * generates the keys the way provisioning does (`openssl genpkey`) and drives a
 * live `BrokerService` + the `tools/test-signer.ts` CLI against them.
 */
import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSerialize, newRunId, type AuditEvent, type SignedAuditEvent } from "@atlas/contracts";
import {
  BrokerRefusal,
  BrokerService,
  DEFAULT_ATTESTATION_SIGNER_ID,
  DEFAULT_APPROVER_SIGNER_ID,
  DEFAULT_PROTECTED_REFS,
  TEST_SIGNER_ID,
  deriveSignerRegistryFromKeyFiles,
  loadAttestationKey,
  loadSignerRegistry,
  parsePrivateKeyFlexible,
  signBytes,
  signRaw,
  type PrivilegedOpDescriptor,
} from "../src/index.js";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "test-signer.ts");
const ZERO = "0".repeat(40);
const COMMIT = "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** Generate an Ed25519 keypair exactly like provisioning: `openssl genpkey`. */
function genKeypair(base: string): void {
  execFileSync("openssl", ["genpkey", "-algorithm", "ed25519", "-out", `${base}.key`]);
  execFileSync("openssl", ["pkey", "-in", `${base}.key`, "-pubout", "-out", `${base}.pub`]);
}

/** Lay out a provisioning-shaped broker keys dir and a seeded git repo. */
function provision(): { keysDir: string; repoDir: string; anchorPath: string; approverKeyPath: string } {
  root = mkdtempSync(join(tmpdir(), "atlas-prov-"));
  const keysDir = join(root, "keys", "atlas-broker");
  mkdirSync(keysDir, { recursive: true });

  // audit-attestation (private + public), approval-verify (public only, the
  // approver's private stays with the HSM — kept here purely to sign in-test),
  // and the fixture test approver private key.
  genKeypair(join(keysDir, "audit-attestation"));
  const approverBase = join(root, "approver");
  genKeypair(approverBase);
  // Provisioning ships only the approver's PUBLIC key into the broker keys dir.
  execFileSync("cp", ["-f", `${approverBase}.pub`, join(keysDir, "approval-verify.pub")]);
  genKeypair(join(keysDir, "atlas-test-approver"));

  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "Aryeh Stark", GIT_AUTHOR_EMAIL: "aryeh@21stark.com", GIT_COMMITTER_NAME: "Aryeh Stark", GIT_COMMITTER_EMAIL: "aryeh@21stark.com" },
    });
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  return { keysDir, repoDir, anchorPath: join(root, "anchor", "audit-anchor"), approverKeyPath: `${approverBase}.key` };
}

function service(keysDir: string, repoDir: string, anchorPath: string, testMode = false): BrokerService {
  return new BrokerService({
    repoDir,
    refs: DEFAULT_PROTECTED_REFS,
    anchorPath,
    signers: loadSignerRegistry(keysDir),
    attestation: loadAttestationKey(keysDir, DEFAULT_ATTESTATION_SIGNER_ID),
    testMode,
  });
}

const OP: PrivilegedOpDescriptor = {
  op: "git approve",
  runId: "01J9Z8Q0000000000000000000",
  targetCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  canonicalBaseCommit: COMMIT,
  intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:3f9ac012" },
};

describe("broker against provisioning-generated PEM keys (finding 1)", () => {
  it("derives the signer registry from the provisioned key files (no signers.json)", () => {
    const { keysDir } = provision();
    const registry = deriveSignerRegistryFromKeyFiles(keysDir);
    const ids = registry.map((e) => e.signerId).sort();
    expect(ids).toEqual([TEST_SIGNER_ID, DEFAULT_APPROVER_SIGNER_ID, DEFAULT_ATTESTATION_SIGNER_ID].sort());
    // Every derived public key is in the package-native `ed25519:` form.
    for (const e of registry) expect(e.publicKey.startsWith("ed25519:")).toBe(true);
    // The approver is permitted for the registry-privileged ops; attestation for none.
    expect(registry.find((e) => e.signerId === DEFAULT_APPROVER_SIGNER_ID)!.permittedOps).toContain("git approve");
    expect(registry.find((e) => e.signerId === DEFAULT_ATTESTATION_SIGNER_ID)!.permittedOps).toEqual([]);
  });

  it("appends an attestation-signed audit event with the provisioned attestation key", async () => {
    const { keysDir, repoDir, anchorPath } = provision();
    const att = loadAttestationKey(keysDir, DEFAULT_ATTESTATION_SIGNER_ID);
    const svc = service(keysDir, repoDir, anchorPath);
    await svc.start();

    const event: AuditEvent = {
      schemaVersion: 1,
      eventId: newRunId(),
      kind: "run.integrated",
      seq: 0,
      occurredAt: "2026-07-12T09:14:22.581Z",
      runId: newRunId(),
      subjects: [],
      canonicalCommit: COMMIT,
      prevAuditHead: ZERO,
      detail: {},
    };
    const signed: SignedAuditEvent = {
      event,
      signature: signRaw(canonicalSerialize(event), att.privateKey),
      signerId: DEFAULT_ATTESTATION_SIGNER_ID,
    };
    const res = await svc.appendAuditEvent(signed);
    expect(res.seq).toBe(0);
  });

  it("verifies an approver authorization signed by the provisioned approval-verify key", () => {
    const { keysDir, repoDir, anchorPath, approverKeyPath } = provision();
    const svc = service(keysDir, repoDir, anchorPath);
    const challenge = svc.mintChallenge(OP);
    const approverKey = parsePrivateKeyFlexible(execFileSync("cat", [approverKeyPath], { encoding: "utf8" }));
    const response = {
      schemaVersion: 1,
      challenge,
      signature: signBytes(new TextEncoder().encode(challenge.signingPayload), approverKey),
      signerId: DEFAULT_APPROVER_SIGNER_ID,
    };
    const res = svc.execAuthorized(OP, response as never);
    expect(res.code).toBe("authz.ok");
  });

  it("the test-signer CLI reads the provisioned PEM key; broker accepts in test mode, D20-rejects in prod", () => {
    const { keysDir, repoDir, anchorPath } = provision();
    // The CLI reads `<keysDir>/atlas-test-approver.key` (PEM) directly.
    const runSigner = (challenge: unknown): unknown =>
      JSON.parse(
        execFileSync("node", [TOOL, "--key", "atlas-test-approver", "--keys-dir", keysDir], {
          input: JSON.stringify(challenge),
          encoding: "utf8",
        }),
      );

    const testSvc = service(keysDir, repoDir, anchorPath, true);
    const auth = runSigner(testSvc.mintChallenge(OP));
    expect(testSvc.execAuthorized(OP, auth as never).code).toBe("authz.ok");

    const prodSvc = service(keysDir, repoDir, anchorPath, false);
    const auth2 = runSigner(prodSvc.mintChallenge(OP));
    let err: unknown;
    try {
      prodSvc.execAuthorized(OP, auth2 as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("authz.signer_not_permitted");
    expect((err as BrokerRefusal).detail.d20).toBe(true);
  });
});
