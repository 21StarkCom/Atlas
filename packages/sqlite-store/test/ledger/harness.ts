/**
 * Shared harness for the Task-1.7 ledger DR tests: a temp git repo + a wired
 * in-process `BrokerService` (the real F4 internal-signing path) + a file-backed
 * `Store`. Everything runs locally (no OS provisioning) so the crash-recovery,
 * fail-closed, and DR-round-trip suites run without `ATLAS_PROVISIONED`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { newRunId, type AuditEvent, type AuthorizationResponse } from "@atlas/contracts";
import {
  BrokerService,
  generateEd25519,
  signBytes,
  type AttestationKey,
  type PrivilegedOpDescriptor,
} from "@atlas/broker";
import { openStore, type Store, type AuditEventDraft, type LedgerBackupConfig } from "../../src/index.js";

const CANONICAL_COMMIT = "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182";

/** The enrolled approver identity the DR tests sign privileged authorizations with. */
export const APPROVER_SIGNER_ID = "atlas-approver-test-01";

export interface LedgerHarness {
  readonly service: BrokerService;
  readonly dir: string;
  readonly dbPath: string;
  readonly backup: LedgerBackupConfig;
  openStore(): Store;
  /** A fresh `BrokerService` over the SAME repo/anchor/keys (restart simulation). */
  newService(): BrokerService;
  /** Build an `AuditEventDraft` for `runId` (sans seq/prevAuditHead). */
  draft(runId: string, over?: Partial<AuditEventDraft>): AuditEventDraft;
  /**
   * Mint + sign a privileged authorization the real broker way (enrolled approver
   * key over `challenge.signingPayload`), so DR tests exercise the actual
   * challenge/authorization path rather than bypassing it.
   */
  authorize(op: PrivilegedOpDescriptor): AuthorizationResponse;
  cleanup(): void;
}

const roots: string[] = [];

export async function createLedgerHarness(): Promise<LedgerHarness> {
  const root = mkdtempSync(join(tmpdir(), "atlas-ledger-"));
  roots.push(root);
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const dbDir = join(root, "db");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "ledger.db");
  const backupDir = join(root, "backups");
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

  const attKp = generateEd25519();
  const attestation: AttestationKey = {
    signerId: "atlas-audit-attestation-v1",
    privateKey: attKp.privateKey,
    publicKey: attKp.publicKey,
  };
  const approverKp = generateEd25519();
  const signers = [
    {
      signerId: attestation.signerId,
      publicKey: attKp.publicKeyString,
      permittedOps: [] as string[],
      status: "active" as const,
      enrolledAt: "2026-07-01T00:00:00.000Z",
    },
    {
      // The enrolled approver the DR tests sign privileged `db restore` /
      // `db backup --force-unblock` authorizations with (the real challenge path).
      signerId: APPROVER_SIGNER_ID,
      publicKey: approverKp.publicKeyString,
      permittedOps: ["db restore", "db backup --force-unblock"] as string[],
      status: "active" as const,
      enrolledAt: "2026-07-01T00:00:00.000Z",
    },
  ];

  const newService = (): BrokerService =>
    new BrokerService({
      repoDir,
      refs: { canonical: "refs/heads/main", audit: "refs/audit/runs", trust: "refs/trust/ledger" },
      anchorPath,
      signers,
      attestation,
      testMode: true,
    });
  const service = newService();
  await service.start();

  const backup: LedgerBackupConfig = {
    dir: backupDir,
    key: randomBytes(32),
    keyId: "test-key-v1",
    keep: 10,
  };

  // The sample kind for these §2.8 ordering/DR fixtures is a NON-canonical-installing
  // kind. `finalizeLedgerWrite` submits its event to the broker's signing entry point,
  // which refuses to attest `run.integrated`/`run.rolled_back` — those assert a
  // canonical ref move, so they may only be produced by the protected-ref path that
  // OBSERVES the move (see `AuditLog.signAndAppend`). These tests exercise the
  // cross-store ordering/backup/restore protocol, not a canonical install, so a
  // projection event is the faithful fixture.
  const draft = (runId: string, over: Partial<AuditEventDraft> = {}): AuditEventDraft => ({
    schemaVersion: 1,
    eventId: newRunId(),
    kind: "run.projection",
    occurredAt: "2026-07-12T09:14:22.581Z",
    runId,
    subjects: [],
    canonicalCommit: CANONICAL_COMMIT,
    detail: {},
    ...over,
  });

  return {
    service,
    dir: root,
    dbPath,
    backup,
    openStore(): Store {
      const store = openStore({ path: dbPath });
      store.migrate();
      return store;
    },
    newService,
    draft,
    authorize(op: PrivilegedOpDescriptor): AuthorizationResponse {
      const challenge = service.mintChallenge(op);
      const signature = signBytes(new TextEncoder().encode(challenge.signingPayload), approverKp.privateKey);
      return { schemaVersion: 1, challenge, signature, signerId: APPROVER_SIGNER_ID };
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** ULID generator for run ids in tests. */
export function runId(): string {
  return newRunId();
}

export type { AuditEvent };
