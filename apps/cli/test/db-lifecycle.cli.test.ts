/**
 * `db-lifecycle.cli` — runCli-LEVEL acceptance tests for the Task-1.7 privileged
 * ledger DR surface (round-3 finding 10). The DR-subsystem suites in
 * `@atlas/sqlite-store` drive `restoreBackup`/`finalizeLedgerWrite`/`execAuthorized`
 * directly; a reviewer correctly noted that bypasses the CLI. THESE tests exercise
 * the whole surface through `runCli(argv, env)` against a REAL broker Unix socket:
 *
 *   - **socket authorization** — `db restore --export-challenge` mints over the
 *     socket (exit 6 action-required), the challenge is signed by an enrolled
 *     approver, and `db restore --authorization` verifies over the socket (exit 0);
 *   - **key custody** — the AEAD key is read only through the gated platform-custody
 *     seam (`ATLAS_TEST_MODE=1` + `ATLAS_CUSTODY_TEST_DIR`); a missing custody key is
 *     `key-unavailable` (exit 2);
 *   - **lock ordering** — the authorized restore acquires the exclusive
 *     `vault-maintenance` ⊐ `ledger-maintenance` locks (§2.5 order) and completes,
 *     and `db backup` runs under `ledger-maintenance`;
 *   - **blocked recovery** — a blocked watermark is cleared by an authorized
 *     `db backup --force-unblock` (exit 0), and read-only `db verify` still works;
 *   - **output schemas** — every `--json` success/challenge validates against the
 *     committed `docs/specs/cli-contract/*.schema.json`;
 *   - **required exit/error codes** — bare `--backup`/missing `--authorization`/
 *     not-found/wrong-content all map to their committed codes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import _Ajv2020 from "ajv/dist/2020.js";
import {
  BrokerService,
  generateEd25519,
  signBytes,
  startBrokerServer,
  type AttestationKey,
  type BrokerServer,
} from "@atlas/broker";
import { finalizeLedgerWrite, openStore, type AuditEventDraft } from "@atlas/sqlite-store";
import { newRunId } from "@atlas/contracts";
import { runCli } from "../src/main.js";

// ajv ships a CJS default export; normalize the interop shape for NodeNext + tsc.
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (
  opts?: unknown,
) => {
  compile(s: unknown): ((v: unknown) => boolean) & { errors?: unknown };
  errorsText(e?: unknown): string;
};

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const CANONICAL_COMMIT = "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182";
const APPROVER_SIGNER_ID = "atlas-approver-cli-01";
const KEY_ID = "cli-custody-v1"; // config-schema default for sqlite.ledger_backup.key_id

function assertSchema(name: string, value: unknown): void {
  // A fresh Ajv per compile keeps the schema's `$id` from colliding across calls.
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`${name} output failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
  }
}

interface Ctx {
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  service: BrokerService;
  server: BrokerServer;
  approverPriv: ReturnType<typeof generateEd25519>["privateKey"];
  dbPath: string;
  backupDir: string;
}

const ctxs: Ctx[] = [];

/**
 * Run a command through runCli, capturing output. `emitJson`/`writeErrorEnvelope`
 * default to the REAL `process.stdout`, so we patch `process.stdout.write` (and
 * stderr) for the duration rather than relying on the injected stream alone.
 */
async function cli(c: Ctx, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WritableStream;
  const stderr = { write: (s: string) => ((err += s), true) } as unknown as NodeJS.WritableStream;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => ((err += s), true);
  try {
    const code = await runCli(argv, c.env, { cwd: c.cwd, stdout, stderr, root: REPO_ROOT });
    return { code, out, err };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** Sign a `db restore --export-challenge` / force-unblock challenge into an authorization file. */
function signAuthorization(c: Ctx, challengeJson: string, path: string): void {
  const challenge = JSON.parse(challengeJson);
  const signature = signBytes(new TextEncoder().encode(challenge.signingPayload), c.approverPriv);
  const auth = { schemaVersion: 1, challenge, signature, signerId: APPROVER_SIGNER_ID };
  writeFileSync(path, JSON.stringify(auth), "utf8");
}

async function setup(): Promise<Ctx> {
  // A SHORT root under /tmp — Unix socket paths have a ~104-byte limit (macOS).
  const root = mkdtempSync(join("/tmp", "atlas-cli-"));
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const custodyDir = join(root, "custody");
  mkdirSync(custodyDir, { recursive: true });
  const vaultDir = join(cwd, "vault");
  mkdirSync(vaultDir, { recursive: true });
  const dbPath = join(cwd, ".atlas", "atlas.db");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  const backupDir = join(cwd, ".atlas", "backups");
  const socketPath = join(root, "b.sock");
  const anchorPath = join(root, "anchor", "audit-anchor");

  // Custody: the AEAD key, ONLY reachable through the gated test seam.
  writeFileSync(join(custodyDir, `${KEY_ID}.key`), Buffer.from(randomBytes(32)).toString("base64"), "utf8");

  // A seed git repo for the broker's protected refs.
  const git = (args: string[]): void => {
    execFileSync("git", args, {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Aryeh Stark",
        GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
        GIT_COMMITTER_NAME: "Aryeh Stark",
        GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
      },
    });
  };
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
  const service = new BrokerService({
    repoDir,
    refs: { canonical: "refs/heads/main", audit: "refs/audit/runs", trust: "refs/trust/ledger" },
    anchorPath,
    signers: [
      {
        signerId: attestation.signerId,
        publicKey: attKp.publicKeyString,
        permittedOps: [],
        status: "active",
        enrolledAt: "2026-07-01T00:00:00.000Z",
      },
      {
        signerId: APPROVER_SIGNER_ID,
        publicKey: approverKp.publicKeyString,
        permittedOps: ["db restore", "db backup --force-unblock"],
        status: "active",
        enrolledAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    attestation,
    testMode: true,
  });
  const server = await startBrokerServer(service, socketPath);

  // brain.config.yaml — the CLI loads paths relative to `cwd`.
  const config = [
    "vault:",
    `  path: ${vaultDir}`,
    "sqlite:",
    "  path: ./.atlas/atlas.db",
    "  ledger_backup:",
    "    dir: ./.atlas/backups",
    "    keep: 10",
    "  ledger_retention: keep-forever",
    "  raw_payload_store: false",
    "lancedb:",
    "  dir: ./.atlas/lancedb",
    "indexing:",
    "  chunker_version: 1",
    "  embedding_model: gemini-embedding-001",
    "  dimensions: 768",
    "git:",
    "  worktrees_path: ./.atlas/worktrees",
    "  auto_commit_risk_levels: [1, 2]",
    `  audit_anchor_path: ${anchorPath}`,
    "models:",
    "  generation_model: gemini-3-5-flash",
    "  embedding_model: gemini-embedding-001",
    "policies:",
    "  tier2_min_confidence: 0.8",
    "  tier2_max_changed_lines: 50",
    "  tier2_max_sections: 3",
    "  default_sensitivity: internal",
    "  require_sources_for_synthesis: true",
    "logs:",
    "  dir: ./.atlas/logs",
    "  max_files: 10",
    "  max_bytes: 10485760",
    "broker:",
    `  socket_path: ${socketPath}`,
    `  egress_socket_path: ${join(root, "e.sock")}`,
    "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATLAS_TEST_MODE: "1",
    ATLAS_CUSTODY_TEST_DIR: custodyDir,
    ATLAS_IDENTITY: "trusted-cli",
    NO_COLOR: "1",
  };

  // Seed one committed ledger-writing run through the REAL §2.8 orchestrator so the
  // backup has non-trivial content (the broker instance is the same one the socket wraps).
  const store = openStore({ path: dbPath });
  store.migrate();
  const rid = newRunId();
  const draft: AuditEventDraft = {
    schemaVersion: 1,
    eventId: newRunId(),
    kind: "run.projection",
    occurredAt: "2026-07-12T09:14:22.581Z",
    runId: rid,
    subjects: [],
    canonicalCommit: CANONICAL_COMMIT,
    detail: {},
  };
  await finalizeLedgerWrite(store, service, {
    runId: rid,
    event: draft,
    backup: { dir: backupDir, key: Buffer.from(readFileSync(join(custodyDir, `${KEY_ID}.key`), "utf8").trim(), "base64"), keyId: KEY_ID, keep: 10 },
    ledgerWrite: [
      {
        sql: `INSERT INTO agent_runs (run_id, operation, status, started_at, updated_at)
              VALUES (?, 'refresh', 'integrated', '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z')`,
        params: [rid],
      },
    ],
  });
  store.close();

  const c: Ctx = { root, cwd, env, service, server, approverPriv: approverKp.privateKey, dbPath, backupDir };
  ctxs.push(c);
  return c;
}

let c: Ctx;
beforeEach(async () => {
  c = await setup();
});
afterEach(async () => {
  const cur = ctxs.pop();
  if (cur) {
    await cur.server.close();
    rmSync(cur.root, { recursive: true, force: true });
  }
});

describe("db lifecycle via runCli (round-3 finding 10)", () => {
  it("db backup --json reads the custody key, advances the watermark, matches the output schema", async () => {
    const r = await cli(c, ["db", "backup", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    assertSchema("db-backup", out);
    expect(out.command).toBe("db backup");
    expect(out.healthy).toBe(true);
    expect(out.backupRef).toMatch(/\.abk$/);
  });

  it("db verify --backup <ref> --json passes for a real bundle and matches the schema", async () => {
    const b = JSON.parse((await cli(c, ["db", "backup", "--json"])).out);
    const r = await cli(c, ["db", "verify", "--backup", b.backupRef, "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    assertSchema("db-verify", out);
    expect(out.ok).toBe(true);
    expect(out.backup.decryptable).toBe(true);
  });

  it("bare `db verify --backup` (no value) is a USAGE error (exit 5)", async () => {
    const r = await cli(c, ["db", "verify", "--backup", "--json"]);
    // `--json` is consumed as the flag's value only if it looks like a value; here
    // the parser treats a following flag-shaped token as the missing value → usage.
    expect(r.code).toBe(5);
  });

  it("full socket-authorized restore round-trip through runCli (mint → sign → restore)", async () => {
    const b = JSON.parse((await cli(c, ["db", "backup", "--json"])).out);

    // 1) --export-challenge mints over the socket → exit 6 + an AuthorizationChallenge.
    const ch = await cli(c, ["db", "restore", b.backupRef, "--export-challenge", "--json"]);
    expect(ch.code).toBe(6);
    const challenge = JSON.parse(ch.out);
    expect(challenge.intendedEffect.kind).toBe("restore");

    // 2) Sign the challenge with the enrolled approver key.
    const authPath = join(c.cwd, "auth.json");
    signAuthorization(c, ch.out, authPath);

    // 3) Simulate data loss (delete the business rows), then restore under the
    // socket-verified authorization and assert the rows come back byte-equal.
    let store = openStore({ path: c.dbPath });
    const before = store.db.prepare(`SELECT * FROM agent_runs ORDER BY run_id`).all();
    expect(before.length).toBe(1);
    store.db.prepare(`DELETE FROM agent_runs`).run();
    store.close();

    const r = await cli(c, ["db", "restore", b.backupRef, "--authorization", authPath, "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    assertSchema("db-restore", out);
    expect(out.command).toBe("db restore");
    expect(out.rebuildHooksRun.some((h: { hook: string; ok: boolean }) => h.hook === "projection-rebuild" && h.ok)).toBe(true);

    // The business row is recovered byte-equal AND the D6 db.restore row landed.
    store = openStore({ path: c.dbPath });
    const after = store.db.prepare(`SELECT * FROM agent_runs ORDER BY run_id`).all();
    expect(after).toEqual(before);
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'db.restore'`).get() as { n: number };
    expect(n.n).toBe(1);
    store.close();
  });

  it("db restore without an authorization is action-required (exit 6)", async () => {
    const b = JSON.parse((await cli(c, ["db", "backup", "--json"])).out);
    const r = await cli(c, ["db", "restore", b.backupRef, "--json"]);
    expect(r.code).toBe(6);
    expect(JSON.parse(r.out).code).toBe("authorization-required");
  });

  it("db restore of a non-existent backup is backup-not-found (exit 1)", async () => {
    const r = await cli(c, ["db", "restore", "does-not-exist.abk", "--authorization", "x", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).code).toBe("backup-not-found");
  });

  it("a stale authorization for a different content hash is rejected over the socket (exit 2)", async () => {
    const b1 = JSON.parse((await cli(c, ["db", "backup", "--json"])).out);
    // Mint + sign an authorization bound to backup b1.
    const ch = await cli(c, ["db", "restore", b1.backupRef, "--export-challenge", "--json"]);
    const authPath = join(c.cwd, "auth.json");
    signAuthorization(c, ch.out, authPath);
    // Take a SECOND, different backup (adds a new run first so the content hash differs).
    const store = openStore({ path: c.dbPath });
    const rid = newRunId();
    await finalizeLedgerWrite(store, c.service, {
      runId: rid,
      event: {
        schemaVersion: 1,
        eventId: newRunId(),
        kind: "run.projection",
        occurredAt: "2026-07-12T10:00:00.000Z",
        runId: rid,
        subjects: [],
        canonicalCommit: CANONICAL_COMMIT,
        detail: {},
      },
      backup: { dir: c.backupDir, key: Buffer.from(readFileSync(join(c.root, "custody", `${KEY_ID}.key`), "utf8").trim(), "base64"), keyId: KEY_ID, keep: 10 },
      ledgerWrite: [],
    });
    store.close();
    const b2 = JSON.parse((await cli(c, ["db", "backup", "--json"])).out);
    // Try to restore b2 with b1's authorization → the broker drift gate refuses it.
    const r = await cli(c, ["db", "restore", b2.backupRef, "--authorization", authPath, "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).code).toBe("authorization-invalid");
  });

  it("blocked watermark: read-only db verify still works; authorized --force-unblock clears it", async () => {
    // Block the watermark directly (simulates exhausted backup retries).
    let store = openStore({ path: c.dbPath });
    store.db.prepare(`UPDATE backup_watermark SET healthy = 0 WHERE id = 1`).run();
    store.close();

    // Read-only diagnostic still works even while blocked.
    const v = await cli(c, ["db", "verify", "--json"]);
    expect(v.code).toBe(0);

    // Authorized --force-unblock over the socket clears the block.
    const ch = await cli(c, ["db", "backup", "--force-unblock", "--export-challenge", "--json"]);
    expect(ch.code).toBe(6);
    const authPath = join(c.cwd, "fu.json");
    signAuthorization(c, ch.out, authPath);
    const r = await cli(c, ["db", "backup", "--force-unblock", "--authorization", authPath, "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    assertSchema("db-backup", out);
    expect(out.healthy).toBe(true);

    store = openStore({ path: c.dbPath });
    const h = store.db.prepare(`SELECT healthy FROM backup_watermark WHERE id = 1`).get() as { healthy: number };
    expect(h.healthy).toBe(1);
    const fu = store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'db.force_unblock'`).get() as { n: number };
    expect(fu.n).toBe(1);
    store.close();
  });

  it("a backup taken under a ROTATED-OUT key is still restorable via its stamped key id (finding 7)", async () => {
    // Backup under the current key id (cli-custody-v1) — the bundle stamps that id.
    const b = JSON.parse((await cli(c, ["db", "backup", "--json"])).out);

    // Rotate: the config now points at a NEW key id; custody RETAINS the prior key.
    const newKeyId = "cli-custody-v2";
    writeFileSync(join(c.root, "custody", `${newKeyId}.key`), Buffer.from(randomBytes(32)).toString("base64"), "utf8");
    const configPath = join(c.cwd, "brain.config.yaml");
    const rotated = readFileSync(configPath, "utf8").replace(
      "  ledger_backup:\n    dir: ./.atlas/backups",
      `  ledger_backup:\n    dir: ./.atlas/backups\n    key_id: ${newKeyId}`,
    );
    writeFileSync(configPath, rotated, "utf8");

    // Authorize + restore the OLD (v1-stamped) backup. Restore must resolve the key
    // STAMPED in the bundle (v1), not the current configured key (v2), or the
    // retained backup would be unrestorable after rotation.
    const ch = await cli(c, ["db", "restore", b.backupRef, "--export-challenge", "--json"]);
    expect(ch.code).toBe(6);
    const authPath = join(c.cwd, "rot.json");
    signAuthorization(c, ch.out, authPath);
    const r = await cli(c, ["db", "restore", b.backupRef, "--authorization", authPath, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).command).toBe("db restore");
  });

  it("a missing custody key is `key-unavailable` (exit 2), never a plaintext fallback", async () => {
    // Point the gated custody seam at an empty dir: no key material available.
    const emptyCustody = join(c.root, "empty-custody");
    mkdirSync(emptyCustody, { recursive: true });
    const r = await cli(
      { ...c, env: { ...c.env, ATLAS_CUSTODY_TEST_DIR: emptyCustody } },
      ["db", "backup", "--json"],
    );
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).code).toBe("key-unavailable");
  });
});
