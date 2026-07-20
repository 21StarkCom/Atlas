/**
 * `sync-support` — the 60-B cycle-engine harness (Phase 4). An adopted-vault
 * analogue of `phase2-support`: ONE git repo carrying BOTH the live upstream
 * branch (`refs/heads/main`, written freely by the fixture "live writers") and
 * the broker-owned canonical mirror (`refs/atlas/main`, seeded at the
 * empty-tree baseline exactly like `provisioning/adopt-vault.sh`), a REAL
 * started `BrokerService` whose protected canonical ref is `refs/atlas/main`
 * (scope `"sync"` integrations go over the genuine socket), a migrated
 * workflow store with `sync_cursors` + jobs tables, and a seeded cursor row.
 *
 * Scanners run the REAL `@atlas/scan` engine; quarantine ids are
 * content-addressed (`q-<sha256[:24]>`) and recorded so tests can assert
 * quarantine-before-skip without standing up the AEAD store.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrokerClient, BrokerService, generateEd25519, startBrokerServer } from "@atlas/broker";
import { openRepo, type Repo } from "@atlas/git";
import { bindEnqueueContext } from "@atlas/jobs";
import { registerJobsMigration } from "@atlas/jobs";
import { scanBytes, SecretDetectedError } from "@atlas/scan";
import { registerSyncCursorsMigration, type LedgerBackupConfig, type Store } from "@atlas/sqlite-store";
import { openWorkflowStore } from "../../src/workflows/index.js";
import { brokerSignedIntegration } from "../../src/ingest/wiring.js";
import { seedSyncCursor } from "../../src/sync/seed.js";
import type { SyncCycleDeps } from "../../src/sync/cycle.js";
import type { ScanOutcome } from "../../src/sync/plan.js";

export const SYNC_CANONICAL_REF = "refs/atlas/main";
export const DEFAULT_UPSTREAM_REF = "refs/heads/main";
export const SOURCE_ID = "main-vault";
export const AUDIT_REF = "refs/audit/runs";
export const TRUST_REF = "refs/trust/ledger";

/** A canonical-frontmatter note body (the vault reader's contract). */
export function noteText(id: string, title: string, body = "Body."): string {
  return [
    "---",
    `id: ${id}`,
    "type: concept",
    "schema_version: 1",
    `title: ${title}`,
    "status: active",
    "created: 2026-07-20",
    "updated: 2026-07-20",
    "---",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

/** Trips the scan engine's aws-access-key-id rule deterministically. */
export const PLANTED_SECRET = `AKIA${"A".repeat(16)}`;

export interface SyncHarness {
  readonly root: string;
  readonly vaultDir: string;
  readonly upstreamRef: string;
  readonly store: Store;
  readonly repo: Repo;
  /** Recorded quarantine events (content-addressed ids). */
  readonly quarantines: { origin: string; quarantineId: string }[];
  /** Mutable failpoints threaded into deps() (Task 4.8). */
  failpoints: NonNullable<SyncCycleDeps["failpoints"]> | undefined;
  git(args: string[]): string;
  /** Write + stage a file on the upstream working tree. */
  writeUpstream(path: string, content: string): void;
  rmUpstream(path: string): void;
  mvUpstream(from: string, to: string): void;
  /** Commit staged upstream changes; returns the new upstream head OID. */
  commitUpstream(msg: string): string;
  /** The cycle deps against this harness (fresh integration per call, shared store). */
  deps(overrides?: Partial<SyncCycleDeps>): SyncCycleDeps;
  readRef(ref: string): string | null;
  cursorRow(): {
    last_absorbed_oid: string | null;
    last_synced_at: string;
    cycle_seq: number;
    pending_quarantine: string;
  };
  runRows(): { run_id: string; operation: string; status: string }[];
  jobRows(): { job_id: string; workflow: string; idempotency_key: string; payload: string; state: string }[];
  cleanup(): Promise<void>;
}

export interface SyncHarnessOptions {
  /** Override the upstream branch (proves the invariant follows the row, Task 4.10). */
  readonly upstreamRef?: string;
  readonly noteGlobs?: readonly string[];
}

export async function makeSyncHarness(opts: SyncHarnessOptions = {}): Promise<SyncHarness> {
  const upstreamRef = opts.upstreamRef ?? DEFAULT_UPSTREAM_REF;
  const upstreamBranch = upstreamRef.replace(/^refs\/heads\//, "");
  const noteGlobs = opts.noteGlobs ?? ["**/*.md"];
  const root = mkdtempSync(join(tmpdir(), "atlas-sync-"));
  const vaultDir = join(root, "vault");
  mkdirSync(vaultDir, { recursive: true });
  const dbPath = join(root, ".atlas", "atlas.db");
  mkdirSync(join(root, ".atlas"), { recursive: true });
  const worktreesPath = join(root, ".atlas", "worktrees");
  mkdirSync(worktreesPath, { recursive: true });
  const anchorPath = join(root, "anchor", "audit-anchor");
  const socketPath = join(root, "broker.sock");

  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: vaultDir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Live Writer",
        GIT_AUTHOR_EMAIL: "writer@fixture.local",
        GIT_COMMITTER_NAME: "Live Writer",
        GIT_COMMITTER_EMAIL: "writer@fixture.local",
      },
    }).trim();

  // The live upstream: one seed note committed by the fixture "live writer".
  git(["init", "-q", "-b", upstreamBranch]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(vaultDir, "seed.md"), noteText("concept-seed", "Seed"), "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "upstream seed"]);

  // Adoption baseline: refs/atlas/main at a broker-minted EMPTY-TREE commit —
  // never at the upstream head — mirroring provisioning/adopt-vault.sh. The
  // first sync fast-forwards the real notes in through the scan pipeline.
  const emptyTree = git(["hash-object", "-t", "tree", "/dev/null"]);
  const baseline = git(["commit-tree", emptyTree, "-m", "atlas: adoption baseline (empty tree)"]);
  git(["update-ref", SYNC_CANONICAL_REF, baseline]);

  const attKp = generateEd25519();
  const service = new BrokerService({
    repoDir: vaultDir,
    refs: { canonical: SYNC_CANONICAL_REF, audit: AUDIT_REF, trust: TRUST_REF },
    anchorPath,
    signers: [
      {
        signerId: "atlas-audit-attestation-v1",
        publicKey: attKp.publicKeyString,
        permittedOps: [],
        status: "active",
        enrolledAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    attestation: { signerId: "atlas-audit-attestation-v1", privateKey: attKp.privateKey, publicKey: attKp.publicKey },
    testMode: true,
  });
  await service.start();
  const server = await startBrokerServer(service, socketPath);

  const backup: LedgerBackupConfig = {
    dir: join(root, ".atlas", "backups"),
    key: randomBytes(32),
    keyId: "sync-test-v1",
    keep: 10,
  };

  const store = openWorkflowStore({ path: dbPath });
  registerSyncCursorsMigration(store);
  registerJobsMigration(store);
  store.migrate();
  let clockSeq = 0;
  const now = (): string => new Date(Date.UTC(2026, 6, 20, 12, 0, clockSeq++)).toISOString();
  seedSyncCursor(store, { sourceId: SOURCE_ID, upstreamRef, now });
  bindEnqueueContext(store.db, {
    now,
    nextJobId: () => `job-${String(++clockSeq).padStart(4, "0")}-${randomBytes(4).toString("hex")}`,
    defaultMaxAttempts: 5,
  });

  const quarantines: { origin: string; quarantineId: string }[] = [];
  const scanNoteBytes = async (bytes: Buffer, origin: string): Promise<ScanOutcome> => {
    await Promise.resolve();
    const verdict = scanBytes({ bytes, context: { origin, boundary: "pre-persistence", kind: "raw" } });
    if (verdict.clean) return { clean: true };
    const quarantineId = `q-${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}`;
    quarantines.push({ origin, quarantineId });
    return { clean: false, quarantineId };
  };
  const scanGeneratedArtifact = async (text: string, runId: string): Promise<void> => {
    await Promise.resolve();
    const origin = `run:${runId}→audit`;
    const verdict = scanBytes({
      bytes: new TextEncoder().encode(text),
      context: { origin, boundary: "generated-artifact", sink: "audit" },
    });
    if (!verdict.clean) {
      quarantines.push({ origin, quarantineId: `q-${createHash("sha256").update(text).digest("hex").slice(0, 24)}` });
      throw new SecretDetectedError(origin, verdict.findings, "generated-artifact");
    }
  };

  const repo = openRepo(vaultDir);

  const h: SyncHarness = {
    root,
    vaultDir,
    upstreamRef,
    store,
    repo,
    quarantines,
    failpoints: undefined,
    git,
    writeUpstream(path: string, content: string): void {
      mkdirSync(join(vaultDir, dirname(path)), { recursive: true });
      writeFileSync(join(vaultDir, path), content, "utf8");
      git(["add", "-A"]);
    },
    rmUpstream(path: string): void {
      git(["rm", "-q", path]);
    },
    mvUpstream(from: string, to: string): void {
      mkdirSync(join(vaultDir, dirname(to)), { recursive: true });
      git(["mv", from, to]);
    },
    commitUpstream(msg: string): string {
      git(["commit", "-q", "-m", msg]);
      return git(["rev-parse", upstreamRef]);
    },
    deps(overrides: Partial<SyncCycleDeps> = {}): SyncCycleDeps {
      return {
        store,
        repo,
        connectIntegration: async () => brokerSignedIntegration(await BrokerClient.connect(socketPath), "sync"),
        backup,
        worktreesPath,
        canonicalRef: SYNC_CANONICAL_REF,
        defaultCanonicalRef: DEFAULT_UPSTREAM_REF,
        noteGlobs,
        now,
        scanNoteBytes,
        scanGeneratedArtifact,
        ...(h.failpoints === undefined ? {} : { failpoints: h.failpoints }),
        ...overrides,
      };
    },
    readRef(ref: string): string | null {
      try {
        return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      } catch {
        return null;
      }
    },
    cursorRow() {
      return store.db
        .prepare(`SELECT last_absorbed_oid, last_synced_at, cycle_seq, pending_quarantine FROM sync_cursors WHERE source_id = ?`)
        .get(SOURCE_ID) as ReturnType<SyncHarness["cursorRow"]>;
    },
    runRows() {
      return store.db
        .prepare(`SELECT run_id, operation, status FROM agent_runs ORDER BY started_at ASC, run_id ASC`)
        .all() as ReturnType<SyncHarness["runRows"]>;
    },
    jobRows() {
      return store.db
        .prepare(`SELECT job_id, workflow, idempotency_key, payload, state FROM jobs ORDER BY created_at ASC, job_id ASC`)
        .all() as ReturnType<SyncHarness["jobRows"]>;
    },
    async cleanup(): Promise<void> {
      await server.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}
