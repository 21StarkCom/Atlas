/**
 * `approval-boundary.adversarial.test` (Phase-1 subset).
 *
 *  - forged signature → typed refusal (`authz.signature_invalid`)
 *  - replayed authorization → typed refusal (`authz.nonce_replayed`)
 *  - expired authorization → typed refusal (`authz.nonce_expired`)
 *  - non-monotonic audit append → typed refusal (`broker.audit_seq_nonmonotonic`)
 *  - agent direct `update-ref` on a protected ref → EACCES (filesystem perms) —
 *    gated on `ATLAS_PROVISIONED=1` (needs the real two-UID layout from Task 1.0).
 *
 * Every refusal carries the contract's stable error code.
 */
import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerRefusal, Authorizer, generateEd25519, signBytes, type PrivilegedOpDescriptor } from "../src/index.js";
import type { SignerRegistryEntry } from "@atlas/contracts";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
// Broker-owned dirs created under /tmp by the separation test; some need sudo to remove.
const sepDirs: string[] = [];
afterEach(() => {
  h?.cleanup();
  while (sepDirs.length) {
    const d = sepDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Ref backend is broker-owned; best-effort sudo cleanup, ignore failure.
      try {
        execFileSync("sudo", ["-n", "rm", "-rf", d], { stdio: "ignore" });
      } catch {
        /* leave it for the OS temp reaper */
      }
    }
  }
});

const OP: PrivilegedOpDescriptor = {
  op: "git approve",
  runId: "01J9Z8Q0000000000000000000",
  targetCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:3f9ac012" },
};

describe("adversarial authorization paths → typed refusals", () => {
  it("refuses a forged signature", () => {
    h = createHarness();
    const { challenge } = h.authorize(OP, "approver");
    const forged = { schemaVersion: 1, challenge, signature: "ed25519:" + "A".repeat(86), signerId: h.approverSignerId };
    const err = tryVerify(() => h.service.execAuthorized(OP, forged as never));
    expect(err.code).toBe("authz.signature_invalid");
    expect(err.exitCode).toBe(1);
  });

  it("refuses a replayed authorization", () => {
    h = createHarness();
    const { response } = h.authorize(OP, "approver");
    h.service.execAuthorized(OP, response as never); // first use consumes the nonce
    const err = tryVerify(() => h.service.execAuthorized(OP, response as never));
    expect(err.code).toBe("authz.nonce_replayed");
  });

  it("refuses an expired authorization", () => {
    // Drive the Authorizer directly with a fast-forwarded clock.
    let t = 1_000_000;
    const kp = generateEd25519();
    const signers: SignerRegistryEntry[] = [
      {
        signerId: "atlas-approver-hsm-01",
        publicKey: kp.publicKeyString,
        permittedOps: ["git approve"],
        status: "active",
        enrolledAt: "2026-07-01T00:00:00.000Z",
      },
    ];
    const authz = new Authorizer(signers, false, () => t);
    const ch = authz.mintChallenge(OP);
    t += 301_000;
    const res = {
      schemaVersion: 1,
      challenge: ch,
      signature: signBytes(new TextEncoder().encode(ch.signingPayload), kp.privateKey),
      signerId: "atlas-approver-hsm-01",
    };
    const err = tryVerify(() => authz.verify(res));
    expect(err.code).toBe("authz.nonce_expired");
  });

  it("refuses a non-monotonic audit append", async () => {
    h = createHarness();
    await h.service.appendAuditEvent(h.signedAuditEvent(4));
    const err = await h.service.appendAuditEvent(h.signedAuditEvent(4)).catch((e) => e);
    // seq 4 is a re-append of a DIFFERENT (runId,seq) so it is non-monotonic, not idempotent
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("broker.audit_seq_nonmonotonic");
  });
});

/**
 * The live two-UID separation guarantee: the agent identity cannot mutate a
 * protected ref directly (§4 — the broker is the *sole* protected-ref mutator).
 *
 * This is a real OS-enforcement check, not a broker-logic check: it must run
 * `git update-ref` **as `atlas-agent`** against a repo whose ref backend is
 * broker-owned and group/other-unwritable. Establishing that layout (chown to
 * `atlas-broker`, drop group/other write) and dropping to `atlas-agent` both
 * need `sudo`, so the test is gated on passwordless `sudo -n` to both root and
 * `atlas-agent` in addition to `ATLAS_PROVISIONED=1`. It runs in CI (provisioned
 * runner, passwordless sudo) and skips on a dev box without it — running the
 * mutation as the repo-owning user, as the prior version did, could never
 * produce EACCES and so proved nothing.
 */
describe("agent direct protected-ref write (provisioned only)", () => {
  const sudoN = (args: string[]): { ok: boolean; stderr: string } => {
    try {
      execFileSync("sudo", ["-n", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true, stderr: "" };
    } catch (err) {
      return { ok: false, stderr: String((err as { stderr?: string }).stderr ?? err) };
    }
  };

  const provisioned = process.env.ATLAS_PROVISIONED === "1";
  // Need passwordless sudo to root (to build the broker-owned layout) AND to
  // atlas-agent (to attempt the write under the agent identity).
  const canSudo = provisioned && sudoN(["true"]).ok && sudoN(["-u", "atlas-agent", "true"]).ok;

  it.skipIf(!canSudo)("an agent update-ref on a protected ref fails (permission denied)", () => {
    // A world-traversable location (NOT the 0700 mkdtemp dir) so atlas-agent can
    // reach the repo — the denial must come from the ref ACL, not the parent dir.
    const repoDir = mkdtempSync(join("/tmp", "atlas-sep-"));
    sepDirs.push(repoDir);
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Aryeh Stark",
          GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
          GIT_COMMITTER_NAME: "Aryeh Stark",
          GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
        },
      }).trim();

    git(["init", "-q", "-b", "main"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repoDir, "README.md"), "seed\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);
    // A child commit for the agent to (try to) install — its object is written
    // by the current user into the (soon group/other-readable) object store.
    const tree = git(["write-tree"]);
    const child = git(["commit-tree", tree, "-p", git(["rev-parse", "HEAD"]), "-m", "child"]);

    // Two-UID protected-ref layout: repo dir + objects are traversable/readable
    // by others; the ref backend (refs/, packed-refs, logs) is broker-owned and
    // group/other-unwritable, so the agent cannot create the `*.lock` file.
    execFileSync("chmod", ["-R", "a+rX", repoDir]);
    const g = join(repoDir, ".git");
    sudoN(["chown", "-R", "atlas-broker", join(g, "refs"), join(g, "logs")]);
    // packed-refs may not exist yet; pack them so the file is present + locked.
    git(["pack-refs", "--all"]);
    sudoN(["chown", "atlas-broker", join(g, "packed-refs")]);
    sudoN(["chmod", "-R", "go-w", join(g, "refs"), join(g, "logs"), join(g, "packed-refs")]);

    let threw = false;
    try {
      // Run the mutation AS atlas-agent — this is the identity being denied.
      execFileSync(
        "sudo",
        ["-n", "-u", "atlas-agent", "git", "-C", repoDir, "update-ref", "refs/heads/main", child],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      threw = true;
      expect(String((err as { stderr?: string }).stderr ?? err)).toMatch(
        /EACCES|permission denied|cannot lock ref|unable to (create|write)/i,
      );
    }
    expect(threw).toBe(true);
  });
});

function tryVerify(fn: () => unknown): BrokerRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof BrokerRefusal) return err;
    throw err;
  }
  throw new Error("expected a BrokerRefusal");
}
