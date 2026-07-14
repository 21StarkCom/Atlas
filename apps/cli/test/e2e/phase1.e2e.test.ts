/**
 * `phase1.e2e` — the Phase-1 exit surface (Task 1.9 / #25) driven through
 * `runCli(argv, env)` against a REAL broker Unix socket + the committed
 * `small-valid` fixture vault.
 *
 * Asserts the task's acceptance criteria:
 *   - `inspect --json` exits 0 and validates against `inspect.schema.json`;
 *   - `status --json` exits 0, validates against `status.schema.json`, and SHOWS
 *     the backup watermark (design D12);
 *   - `doctor` exits 0 on a provisioned host and NAMES the failing check otherwise;
 *   - CARDINALITY: the audit ref gains exactly one `run.readonly` per executed
 *     `inspect`/`status`, `db rebuild` emits exactly one `run.projection`, and
 *     `doctor` emits NO run event (it is a health surface, not a run);
 *   - read-run backup coalescing: a `run.readonly` does not each force a backup.
 *
 * These suites run WITHOUT `ATLAS_PROVISIONED` (a local in-process broker + the
 * gated custody seam), which is why the `doctor` case exercises BOTH the
 * unprovisioned (names the failing check, exit 6) and provisioned (exit 0) paths.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import _Ajv2020 from "ajv/dist/2020.js";
import {
  BrokerClient,
  BrokerService,
  generateEd25519,
  startBrokerServer,
  type AttestationKey,
  type BrokerServer,
} from "@atlas/broker";
import { openStore, READ_COALESCE_THRESHOLD } from "@atlas/sqlite-store";
import { newRunId } from "@atlas/contracts";
import { runCli } from "../../src/main.js";

const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (
  opts?: unknown,
) => {
  compile(s: unknown): ((v: unknown) => boolean) & { errors?: unknown };
  errorsText(e?: unknown): string;
};

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const KEY_ID = "cli-custody-v1";

function assertSchema(name: string, value: unknown): void {
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
  dbPath: string;
}

const ctxs: Ctx[] = [];

async function cli(c: Ctx, argv: string[], envOverride: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WritableStream;
  const stderr = { write: (s: string) => ((err += s), true) } as unknown as NodeJS.WritableStream;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => ((err += s), true);
  try {
    const code = await runCli(argv, { ...c.env, ...envOverride }, { cwd: c.cwd, stdout, stderr, root: REPO_ROOT });
    return { code, out, err };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** Count committed audit events of a given kind directly from the ledger. */
function auditCount(c: Ctx, eventType: string): number {
  const store = openStore({ path: c.dbPath });
  try {
    const row = store.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type = ?`).get(eventType) as {
      n: number;
    };
    return row.n;
  } finally {
    store.close();
  }
}

/** The AUTHORITATIVE git audit-ref state (count + head) via the broker interface. */
async function gitChain(c: Ctx): Promise<{ ok: boolean; head: string; count: number }> {
  const client = await BrokerClient.connect(c.server.socketPath);
  try {
    const s = await client.getAuditChainStatus();
    return { ok: s.ok, head: s.head, count: s.count };
  } finally {
    client.close();
  }
}

/** The committed `run.*` audit event kinds, in seq order. */
function runEventKinds(c: Ctx): string[] {
  const store = openStore({ path: c.dbPath });
  try {
    return (
      store.db
        .prepare(`SELECT event_type FROM audit_events WHERE event_type NOT LIKE 'db.%' ORDER BY seq ASC`)
        .all() as { event_type: string }[]
    ).map((r) => r.event_type);
  } finally {
    store.close();
  }
}

async function setup(): Promise<Ctx> {
  const root = mkdtempSync(join("/tmp", "atlas-p1-"));
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  const custodyDir = join(root, "custody");
  mkdirSync(custodyDir, { recursive: true });

  // The vault is a copy of the committed `small-valid` fixture (3 valid notes).
  const vaultDir = join(cwd, "vault");
  cpSync(join(REPO_ROOT, "fixtures", "small-valid"), vaultDir, { recursive: true });

  const dbPath = join(cwd, ".atlas", "atlas.db");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  const backupDir = join(cwd, ".atlas", "backups");
  const socketPath = join(root, "b.sock");
  const anchorPath = join(root, "anchor", "audit-anchor");

  writeFileSync(join(custodyDir, `${KEY_ID}.key`), Buffer.from(randomBytes(32)).toString("base64"), "utf8");

  // Seed git repo for the broker's protected refs.
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
    ],
    attestation,
    testMode: true,
  });
  const server = await startBrokerServer(service, socketPath);

  const config = [
    "vault:",
    `  path: ${vaultDir}`,
    "sqlite:",
    "  path: ./.atlas/atlas.db",
    "  ledger_backup:",
    `    dir: ${backupDir}`,
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
    "  generation_model: gemini-3.5-flash",
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

  // Migrate the ledger up front (the `db migrate` command is a separate task).
  const store = openStore({ path: dbPath });
  store.migrate();
  store.close();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATLAS_TEST_MODE: "1",
    ATLAS_CUSTODY_TEST_DIR: custodyDir,
    ATLAS_IDENTITY: "trusted-cli",
    NO_COLOR: "1",
  };
  // ATLAS_PROVISIONED is deliberately UNSET here so `doctor` names the missing
  // provisioning; the provisioned-path test sets it per-invocation.
  delete env.ATLAS_PROVISIONED;

  const c: Ctx = { root, cwd, env, service, server, dbPath };
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

describe("phase-1 exit surface (inspect / doctor / status + audit wiring)", () => {
  it("inspect --json exits 0, is schema-valid, and reports the small-valid inventory", async () => {
    const r = await cli(c, ["inspect", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    assertSchema("inspect", out);
    expect(out.command).toBe("inspect");
    expect(out.noteCount).toBe(3);
    expect(out.ok).toBe(true);
    expect(out.issues).toEqual([]);
    expect(out.vault).toContain("vault");
  });

  it("inspect reports a projection summary that DIVERGES before rebuild and reconciles after (finding F9)", async () => {
    // The ledger is migrated (projection store available) but not yet rebuilt, so
    // the 3 vault notes are absent from the projection → diverged.
    const before = JSON.parse((await cli(c, ["inspect", "--json"])).out);
    expect(before.projection.available).toBe(true);
    expect(before.projection.noteCount).toBe(0);
    expect(before.projection.diverged).toBe(true);

    // After a rebuild the projection matches the vault → no divergence.
    expect((await cli(c, ["db", "rebuild", "--json"])).code).toBe(0);
    const after = JSON.parse((await cli(c, ["inspect", "--json"])).out);
    expect(after.projection.available).toBe(true);
    expect(after.projection.noteCount).toBe(3);
    expect(after.projection.diverged).toBe(false);
  });

  it("db rebuild --from-git is rejected, not falsely reported successful (finding F4)", async () => {
    const r = await cli(c, ["db", "rebuild", "--from-git", "--json"]);
    expect(r.code).toBe(5); // usage/unsupported, not exit 0
    expect(r.out + r.err).toMatch(/from-git|not supported/i);
    // And no run.projection was recorded for the rejected invocation.
    expect(auditCount(c, "run.projection")).toBe(0);
  });

  it("emits EXACTLY one run.readonly per executed inspect — git ref advances by one, SQLite agrees (cardinality)", async () => {
    // Assert against the AUTHORITATIVE git ref (round-3 finding 7), not only SQLite.
    const g0 = await gitChain(c);
    expect(g0.ok).toBe(true);
    expect(g0.count).toBe(0);
    expect(auditCount(c, "run.readonly")).toBe(0);

    await cli(c, ["inspect", "--json"]);
    const g1 = await gitChain(c);
    expect(g1.count).toBe(1); // ref commit delta is exactly one
    expect(g1.head).not.toBe(g0.head); // head advanced
    expect(auditCount(c, "run.readonly")).toBe(1); // SQLite cross-check agrees

    await cli(c, ["inspect", "--json"]);
    const g2 = await gitChain(c);
    expect(g2.count).toBe(2);
    expect(g2.head).not.toBe(g1.head);
    expect(auditCount(c, "run.readonly")).toBe(2);

    // Every committed run event is a run.readonly (kind assertion).
    expect(runEventKinds(c)).toEqual(["run.readonly", "run.readonly"]);
  });

  it("a read run does NOT anchor when the broker is unreachable, and the git ref is unchanged (degrade)", async () => {
    await cli(c, ["inspect", "--json"]); // one real event
    const before = await gitChain(c);
    expect(before.count).toBe(1);

    // Stop the broker: the read must still succeed (exit 0) but anchor nothing.
    await c.server.close();
    const r = await cli(c, ["inspect", "--json"]);
    expect(r.code).toBe(0); // the summary is never gated on the audit
    const out = JSON.parse(r.out);
    expect(out.noteCount).toBe(3);
    // No new committed run.readonly in SQLite (the append degraded to pending).
    expect(auditCount(c, "run.readonly")).toBe(1);

    // Restart the broker on the same socket and confirm the ref never advanced
    // during the outage (only the original event is anchored).
    c.server = await startBrokerServer(c.service, c.server.socketPath);
    const after = await gitChain(c);
    expect(after.count).toBe(1);
    expect(after.head).toBe(before.head);
  });

  it("converges an interrupted run on the next call and is idempotent (outage/restart, finding 3)", async () => {
    // Anchor one event (seq 0).
    await cli(c, ["inspect", "--json"]);
    expect((await gitChain(c)).count).toBe(1);

    // Simulate an outage that left the NEXT sequence (1) durably `pending` — a run
    // whose intent txn committed but whose broker append never landed (the gapless
    // broker would reject seq 2 forever unless seq 1 converges first).
    const pendingRunId = newRunId();
    const pendingEvent = {
      schemaVersion: 1,
      eventId: newRunId(),
      kind: "run.readonly",
      occurredAt: "2026-07-12T00:00:00.000Z",
      runId: pendingRunId,
      subjects: [],
      canonicalCommit: "0".repeat(40),
      detail: { command: "inspect" },
      seq: 1,
    };
    {
      const store = openStore({ path: c.dbPath });
      try {
        store.db
          .prepare(
            `INSERT INTO audit_intents (run_id, seq, payload_hash, event_json, write_json, state, created_at, updated_at)
             VALUES (@run_id, @seq, @ph, @ev, '[]', 'pending', @now, @now)`,
          )
          .run({ run_id: pendingRunId, seq: 1, ph: "pending-hash", ev: JSON.stringify(pendingEvent), now: "2026-07-12T00:00:00.000Z" });
      } finally {
        store.close();
      }
    }

    // A fresh inspect: reconcile-before-allocate drains the pending seq 1 AND then
    // appends the fresh read (seq 2), so the gapless chain advances without deadlock.
    const r = await cli(c, ["inspect", "--json"]);
    expect(r.code).toBe(0);
    const g = await gitChain(c);
    expect(g.ok).toBe(true);
    expect(g.count).toBe(3); // seq 0 + reconciled seq 1 + fresh seq 2
    expect(auditCount(c, "run.readonly")).toBe(3);
    expect(runEventKinds(c)).toEqual(["run.readonly", "run.readonly", "run.readonly"]);

    // Idempotency: another inspect neither duplicates nor loses events (+1 only).
    await cli(c, ["inspect", "--json"]);
    expect((await gitChain(c)).count).toBe(4);
    expect(auditCount(c, "run.readonly")).toBe(4);
  });

  it("read-run backup coalescing eventually takes a covering backup at the threshold (finding 7)", async () => {
    // Below the debounce window: no backup. Crossing it: a covering backup lands.
    for (let i = 0; i < READ_COALESCE_THRESHOLD + 1; i++) await cli(c, ["inspect", "--json"]);
    expect(auditCount(c, "run.readonly")).toBe(READ_COALESCE_THRESHOLD + 1);
    // The accumulated coalesced-read gap crossed READ_COALESCE_THRESHOLD, so at
    // least one read took its covering backup rather than amplifying unbounded.
    expect(auditCount(c, "db.backup")).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("read-run backup coalescing: repeated inspects do not each force a full backup", async () => {
    for (let i = 0; i < 3; i++) await cli(c, ["inspect", "--json"]);
    // Three coalesced reads → three run.readonly events but NO db.backup rows.
    expect(auditCount(c, "run.readonly")).toBe(3);
    expect(auditCount(c, "db.backup")).toBe(0);
  });

  it("status --json exits 0, is schema-valid, shows the watermark, and emits one run.readonly", async () => {
    const before = auditCount(c, "run.readonly");
    const r = await cli(c, ["status", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    assertSchema("status", out);
    expect(out.command).toBe("status");
    // D12: the watermark is shown.
    expect(out.backup).toBeDefined();
    expect(typeof out.backup.watermarkSeq).toBe("number");
    expect(typeof out.backup.coveredSeq).toBe("number");
    expect(typeof out.backup.healthy).toBe("boolean");
    expect(auditCount(c, "run.readonly")).toBe(before + 1);
  });

  it("db rebuild emits EXACTLY one run.projection (cardinality)", async () => {
    expect(auditCount(c, "run.projection")).toBe(0);
    const r = await cli(c, ["db", "rebuild", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    assertSchema("db-rebuild", out);
    expect(out.command).toBe("db rebuild");
    expect(out.rebuilt.find((t: { table: string; rows: number }) => t.table === "notes")?.rows).toBe(3);
    expect(auditCount(c, "run.projection")).toBe(1);
    // A projection IS a real state change → it takes its covering backup.
    expect(auditCount(c, "db.backup")).toBe(1);
  });

  it("doctor NAMES the failing check and exits 6 on an unprovisioned host", async () => {
    const r = await cli(c, ["doctor", "--json"]);
    expect(r.code).toBe(6);
    const out = JSON.parse(r.out);
    assertSchema("doctor", out);
    expect(out.status).toBe("action-required");
    const prov = out.checks.find((x: { id: string }) => x.id === "provisioning-presence");
    expect(prov.status).toBe("action-required");
    expect(prov.detail).toMatch(/not provisioned/i);
  });

  it("doctor exits 0 on a provisioned host", async () => {
    const r = await cli(c, ["doctor", "--json"], { ATLAS_PROVISIONED: "1" });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    assertSchema("doctor", out);
    expect(out.status).not.toBe("action-required");
    expect(out.checks.every((x: { status: string }) => x.status !== "action-required")).toBe(true);
  });

  it("doctor emits NO run event (it is a health surface, not a run)", async () => {
    const beforeRo = auditCount(c, "run.readonly");
    const beforeProj = auditCount(c, "run.projection");
    await cli(c, ["doctor", "--json"], { ATLAS_PROVISIONED: "1" });
    expect(auditCount(c, "run.readonly")).toBe(beforeRo);
    expect(auditCount(c, "run.projection")).toBe(beforeProj);
  });
});
