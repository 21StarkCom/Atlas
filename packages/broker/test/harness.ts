/**
 * Shared broker test harness: a temp git repo + generated keys + a wired
 * `BrokerService`. Everything runs locally (no OS provisioning) so the Phase-1
 * subset of the adversarial suite is exercisable without `ATLAS_PROVISIONED`.
 */
import { execFileSync } from "node:child_process";
import { createPublicKey, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalSerialize,
  newRunId,
  type AuditEvent,
  type SignedAuditEvent,
  type SignerRegistryEntry,
} from "@atlas/contracts";
import {
  BrokerService,
  generateEd25519,
  signRaw,
  signBytes,
  type AttestationKey,
  type PrivilegedOpDescriptor,
} from "../src/index.js";
import { TEST_SIGNER_ID } from "../src/authorize.js";

export interface Harness {
  readonly service: BrokerService;
  readonly repoDir: string;
  readonly anchorPath: string;
  readonly attestation: AttestationKey;
  readonly canonicalRef: string;
  readonly cleanup: () => void;
  /** Build a fresh BrokerService over the SAME repo/anchor/keys (restart simulation). */
  newService(opts?: { testMode?: boolean }): BrokerService;
  git(args: string[]): string;
  /** Current SHA of a ref. */
  ref(name: string): string;
  /** Create a commit child of `parentSha` touching `files`; returns its SHA (does not move any ref). */
  commitChild(parentSha: string, files: Record<string, string>, msg?: string): string;
  /** A signed audit event with the given seq (signed by the attestation key). */
  signedAuditEvent(seq: number, over?: Partial<AuditEvent>): SignedAuditEvent;
  /**
   * A signed audit event bound to a concrete protected-ref operation: its
   * `runId` + `canonicalCommit` match the manifest run + the commit being
   * installed, and its kind is a canonical-installing kind (round-3 finding 2).
   */
  boundAuditEvent(seq: number, runId: string, canonicalCommit: string, over?: Partial<AuditEvent>): SignedAuditEvent;
  /** Mint a challenge then sign it with a signer's private key → AuthorizationResponse JSON object. */
  authorize(op: PrivilegedOpDescriptor, signer: "approver" | "test"): { challenge: unknown; response: unknown };
  readonly approverSignerId: string;
  /** The enrolled approver's private key (a VALID registry signer, but NOT the audit attestation identity). */
  readonly approverPrivateKey: KeyObject;
  /** The `atlas-test-approver` PKCS#8 `ed25519:` private-key string (for the test-signer CLI). */
  readonly testApproverKeyString: string;
}

const created: string[] = [];

export function createHarness(opts: { testMode?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "atlas-broker-"));
  created.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const anchorPath = join(root, "anchor", "audit-anchor");

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
  const canonicalRef = "refs/heads/main";

  // Keys: attestation (audit signer) + approver (authorization signer) + test approver.
  const attKp = generateEd25519();
  const attestation: AttestationKey = {
    signerId: "atlas-audit-attestation-v1",
    privateKey: attKp.privateKey,
    publicKey: attKp.publicKey,
  };
  const approverKp = generateEd25519();
  const testKp = generateEd25519();
  const approverSignerId = "atlas-approver-hsm-01";

  const allOps = [
    "git approve",
    "git refresh",
    "git rollback",
    "purge",
    "db restore",
    "graduation migrate",
    "source trust promote",
    "source trust revoke",
    "db backup --force-unblock",
  ];
  const signers: SignerRegistryEntry[] = [
    {
      signerId: attestation.signerId,
      publicKey: attKp.publicKeyString,
      permittedOps: [],
      status: "active",
      enrolledAt: "2026-07-01T00:00:00.000Z",
    },
    {
      signerId: approverSignerId,
      publicKey: approverKp.publicKeyString,
      permittedOps: allOps,
      status: "active",
      enrolledAt: "2026-07-01T00:00:00.000Z",
    },
    {
      signerId: TEST_SIGNER_ID,
      publicKey: testKp.publicKeyString,
      permittedOps: allOps,
      status: "active",
      enrolledAt: "2026-07-01T00:00:00.000Z",
    },
  ];

  const buildService = (o: { testMode?: boolean } = {}): BrokerService =>
    new BrokerService({
      repoDir,
      refs: { canonical: canonicalRef, audit: "refs/audit/runs", trust: "refs/trust/ledger" },
      anchorPath,
      signers,
      attestation,
      testMode: o.testMode ?? opts.testMode ?? false,
    });

  const service = buildService();

  const ref = (name: string): string => git(["rev-parse", name]);

  const commitChild = (parentSha: string, files: Record<string, string>, msg = "child"): string => {
    git(["read-tree", parentSha]);
    for (const [path, content] of Object.entries(files)) {
      const abs = join(repoDir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      git(["add", path]);
    }
    const tree = git(["write-tree"]);
    return git(["commit-tree", tree, "-p", parentSha, "-m", msg]);
  };

  const ZERO_OID = "0".repeat(40);
  const currentAuditHead = (): string => {
    try {
      // `--verify --quiet` returns empty + exit 1 (no stderr) when the ref is absent.
      const head = git(["rev-parse", "--verify", "--quiet", "refs/audit/runs"]);
      return head.length > 0 ? head : ZERO_OID;
    } catch {
      return ZERO_OID; // ref absent ⇒ the first event chains onto ZERO
    }
  };

  const signedAuditEvent = (seq: number, over: Partial<AuditEvent> = {}): SignedAuditEvent => {
    const event: AuditEvent = {
      schemaVersion: 1,
      eventId: newRunId(),
      kind: "run.integrated",
      seq,
      occurredAt: "2026-07-12T09:14:22.581Z",
      runId: newRunId(),
      subjects: [],
      canonicalCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
      // Chain onto the live audit head so appends satisfy the prevAuditHead check.
      prevAuditHead: currentAuditHead(),
      detail: {},
      ...over,
    };
    const signature = signRaw(canonicalSerialize(event), attestation.privateKey);
    return { event, signature, signerId: attestation.signerId };
  };

  const boundAuditEvent = (
    seq: number,
    runId: string,
    canonicalCommit: string,
    over: Partial<AuditEvent> = {},
  ): SignedAuditEvent =>
    signedAuditEvent(seq, { kind: "run.integrated", runId, canonicalCommit, ...over });

  const authorize = (
    op: PrivilegedOpDescriptor,
    signer: "approver" | "test",
  ): { challenge: unknown; response: unknown } => {
    const challenge = service.mintChallenge(op);
    const key: KeyObject = signer === "approver" ? approverKp.privateKey : testKp.privateKey;
    const signerId = signer === "approver" ? approverSignerId : TEST_SIGNER_ID;
    const signature = signBytes(new TextEncoder().encode(challenge.signingPayload), key);
    return { challenge, response: { schemaVersion: 1, challenge, signature, signerId } };
  };

  return {
    service,
    repoDir,
    anchorPath,
    attestation,
    canonicalRef,
    approverSignerId,
    git,
    ref,
    commitChild,
    signedAuditEvent,
    boundAuditEvent,
    authorize,
    newService: buildService,
    approverPrivateKey: approverKp.privateKey,
    testApproverKeyString: testKp.privateKeyString,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Ensure a fresh public key derives cleanly (used by some assertions). */
export function pubOf(priv: KeyObject): KeyObject {
  return createPublicKey(priv);
}
