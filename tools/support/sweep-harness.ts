/**
 * `support/sweep-harness` — the arrangement world for the §13.8 `--json`
 * conformance sweep (SP-1 Phase 6). Stands up, ONCE per suite:
 *
 *  - a seeded git vault (two canonical Markdown notes),
 *  - a real `BrokerService` over its Unix-socket server (test mode; the fixture
 *    `atlas-test-approver` signer enrolled for the privileged read ops),
 *  - a real `EgressService` over its socket server with a DETERMINISTIC fake
 *    provider adapter (hash-derived embeddings — identical text ⇒ identical
 *    vector, so retrieval ranks an exact-text eval query at 1),
 *  - a `brain.config.yaml` + env (test mode, custody seam, capability key file),
 *
 * then arranges state THROUGH THE REAL BINARY (`db migrate` → `db rebuild` →
 * `index rebuild`) plus targeted SQL seeding for row-addressed commands. The
 * sweep itself only consumes `run()` + the seeded ids.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokerService,
  EgressService,
  generateEd25519,
  parsePrivateKeyFlexible,
  signBytes,
  startBrokerServer,
  startEgressServer,
  ProviderCallError,
  providerError,
  type AttestationKey,
  type ProviderAdapter,
  type Usage,
} from "@atlas/broker";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(REPO_ROOT, "apps", "cli", "dist", "bin.js");
const DIMENSIONS = 768;

/** Deterministic pseudo-embedding: identical text ⇒ identical unit-ish vector. */
function hashVector(text: string): number[] {
  const v: number[] = [];
  let seed = createHash("sha256").update(text, "utf8").digest();
  while (v.length < DIMENSIONS) {
    for (const b of seed) {
      if (v.length >= DIMENSIONS) break;
      v.push((b - 127.5) / 127.5);
    }
    seed = createHash("sha256").update(seed).digest();
  }
  return v;
}

/** A deterministic fake Gemini adapter: text ops return "ok"; embed hashes the texts. */
function sweepAdapter(): ProviderAdapter {
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: (s, signal) =>
      signal?.aborted
        ? Promise.reject(new ProviderCallError(providerError("cancelled", { message: "aborted" })))
        : Promise.resolve({ rawResponse: s.bytes, retries: 0 }),
    parse: (op, req, raw) => {
      const usage: Usage = { inputTokens: 10, outputTokens: 5 };
      if (op === "embed") {
        const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as { texts: string[] };
        return {
          result: { vectors: parsed.texts.map(hashVector), dimensions: DIMENSIONS, usage, model: req.model },
          usage,
          model: req.model,
        };
      }
      if (op === "generateObject") return { result: {}, usage, model: req.model };
      return { result: { text: "ok", usage, model: req.model }, usage, model: req.model };
    },
    costMicros: (_m: string, u: Usage) => u.inputTokens + (u.outputTokens ?? 0),
  };
}

/** A completed child invocation (async — the broker/egress servers live in THIS process). */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SweepHarness {
  readonly root: string;
  readonly dbPath: string;
  readonly vaultDir: string;
  /** Ids/paths the adapters consume — everything fixture-derived, nothing guessed. */
  readonly seeded: {
    noteId: string;
    sourceId: string;
    reviewRunId: string;
    quarantineId: string | null;
    queriesPath: string;
    labelsPath: string;
    gradSource: string;
    gradCopy: string;
  };
  run(argv: string[], opts?: { env?: Record<string, string> }): Promise<RunResult>;
  /** export-challenge → fixture-sign → authorization file; returns the file path. */
  authorize(challengeJson: string): string;
  cleanup(): Promise<void>;
}

export async function makeSweepHarness(): Promise<SweepHarness> {
  const root = mkdtempSync(join(tmpdir(), "atlas-sweep-"));
  // The quarantine store must be OUTSIDE the repo + vault (isolation boundary,
  // `quarantine-dir-invalid`) — a dedicated sibling temp dir, not under `root`.
  const quarantineDir = mkdtempSync(join(tmpdir(), "atlas-sweep-quarantine-"));
  const vaultDir = join(root, "vault");
  const atlasDir = join(root, ".atlas");
  const custodyDir = join(atlasDir, "custody");
  const keysDir = join(root, "keys");
  const dbPath = join(atlasDir, "atlas.db");
  const brokerSocket = join(root, "broker.sock");
  const egressSocket = join(root, "egress.sock");
  for (const d of [vaultDir, atlasDir, custodyDir, keysDir, join(atlasDir, "worktrees"), join(atlasDir, "logs")]) {
    mkdirSync(d, { recursive: true });
  }

  // --- the vault: two canonical notes, committed ---------------------------
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: vaultDir,
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
  const alphaBody = "The alpha concept explains deterministic sweep embeddings.";
  writeFileSync(
    join(vaultDir, "note-alpha.md"),
    ["---", "id: concept-alpha", "title: Alpha", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-14", "updated: 2026-07-14", "---", "# Alpha", alphaBody, ""].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(vaultDir, "note-beta.md"),
    ["---", "id: concept-beta", "title: Beta", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-14", "updated: 2026-07-14", "---", "# Beta", "The beta note body.", ""].join("\n"),
    "utf8",
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  // --- broker (test mode; fixture approver enrolled for the privileged reads) ---
  const attKp = generateEd25519();
  const attestation: AttestationKey = {
    signerId: "atlas-audit-attestation-v1",
    privateKey: attKp.privateKey,
    publicKey: attKp.publicKey,
  };
  const approverKp = generateEd25519();
  writeFileSync(join(keysDir, "atlas-test-approver.key"), approverKp.privateKeyString ?? "", "utf8");
  const service = new BrokerService({
    repoDir: vaultDir,
    refs: { canonical: "refs/heads/main", audit: "refs/audit/runs", trust: "refs/atlas/trust" },
    anchorPath: join(root, "anchor", "audit-anchor"),
    signers: [
      { signerId: attestation.signerId, publicKey: attKp.publicKeyString, permittedOps: [], status: "active", enrolledAt: "2026-07-01T00:00:00.000Z" },
      { signerId: "atlas-test-approver", publicKey: approverKp.publicKeyString, permittedOps: ["quarantine inspect", "quarantine resolve"], status: "active", enrolledAt: "2026-07-01T00:00:00.000Z" },
    ],
    attestation,
    testMode: true,
  });
  await service.start();
  const brokerServer = await startBrokerServer(service, brokerSocket);

  // --- egress (deterministic fake adapter over the real socket) -------------
  const capabilitySecretText = randomBytes(32).toString("hex");
  const capabilityKeyPath = join(custodyDir, "egress-capability.key");
  writeFileSync(capabilityKeyPath, `${capabilitySecretText}\n`, "utf8");
  const egress = new EgressService({
    adapter: sweepAdapter(),
    quarantine: { quarantine: () => Promise.resolve() },
    capabilitySecret: Buffer.from(capabilitySecretText, "utf8"),
  });
  const egressServer = await startEgressServer(egress, egressSocket);

  // --- config + env ---------------------------------------------------------
  const backupKey = randomBytes(32);
  writeFileSync(join(custodyDir, "test-key-v1.key"), backupKey.toString("base64"), "utf8");
  writeFileSync(
    join(root, "brain.config.yaml"),
    [
      "vault:", `  path: ${vaultDir}`,
      "sqlite:", `  path: ${dbPath}`, "  ledger_backup:", `    dir: ${join(atlasDir, "backups")}`, "    key_id: test-key-v1", "    keep: 10",
      "lancedb:", `  dir: ${join(atlasDir, "lancedb")}`,
      "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", `  dimensions: ${DIMENSIONS}`,
      "git:", `  worktrees_path: ${join(atlasDir, "worktrees")}`, `  audit_anchor_path: ${join(root, "anchor", "audit-anchor")}`,
      "models: {}", "policies: {}",
      "logs:", `  dir: ${join(atlasDir, "logs")}`,
      "quarantine:", `  dir: ${quarantineDir}`,
      "broker:", `  socket_path: ${brokerSocket}`, `  egress_socket_path: ${egressSocket}`, "",
    ].join("\n"),
    "utf8",
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NO_COLOR: "1",
    ATLAS_TEST_MODE: "1",
    ATLAS_CUSTODY_TEST_DIR: custodyDir,
    ATLAS_EGRESS_CAPABILITY_KEY: capabilityKeyPath,
  };

  // ASYNC by necessity, not preference: the broker/egress socket servers run in
  // THIS process. A spawnSync child that RPCs the broker deadlocks — the child
  // waits on the socket while the blocked parent can never service the accept.
  const run = (argv: string[], opts: { env?: Record<string, string> } = {}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...argv], {
        cwd: root,
        env: { ...env, ...(opts.env ?? {}) },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  // --- arrangement through the REAL binary ----------------------------------
  const must = async (p: Promise<RunResult>, what: string, okCodes: number[] = [0]): Promise<RunResult> => {
    const r = await p;
    if (!okCodes.includes(r.status ?? -1)) {
      throw new Error(`sweep arrangement: ${what} exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }
    return r;
  };
  await must(run(["db", "migrate", "--json"]), "db migrate");
  await must(run(["db", "rebuild", "--json"]), "db rebuild");
  await must(run(["index", "rebuild", "--json"]), "index rebuild");

  // --- targeted SQL seeding for row-addressed commands -----------------------
  const sourceHash = "b".repeat(64);
  const sourceId = `sha256:${sourceHash}:text/plain`;
  const reviewRunId = "01SWEEPRUNREVIEWPENDING000";
  {
    // Direct writes through a plain connection (the arrangement writer, not watch).
    const mod = (await import("@atlas/sqlite-store")) as typeof import("@atlas/sqlite-store");
    const db = mod.openConnection({ path: dbPath });
    try {
      db.prepare(
        `INSERT INTO content_blobs (raw_content_hash, canonical_media_type, size_bytes, vault_path, first_seen_at)
         VALUES (?, 'text/plain', 10, 'sources/sweep', '2026-07-19')`,
      ).run(sourceHash);
      db.prepare(
        `INSERT INTO agent_runs (run_id, operation, status, checkpoint_seq, tier, started_at, updated_at)
         VALUES (?, 'enrich', 'review-pending', 4, 3, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')`,
      ).run(reviewRunId);
      const head = git(["rev-parse", "HEAD"]);
      db.prepare(
        `INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at)
         VALUES (?, ?, 'base', 'refs/heads/main', ?, '2026-07-19T00:00:01.000Z')`,
      ).run(`${reviewRunId}:base`, reviewRunId, head);
      db.prepare(
        `INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at)
         VALUES (?, ?, 'agent-committed', ?, ?, '2026-07-19T00:00:02.000Z')`,
      ).run(`${reviewRunId}:agent-committed`, reviewRunId, `refs/agent/${reviewRunId}`, head);
    } finally {
      db.close();
    }
  }

  // --- a quarantined item, produced by the REAL fail-closed ingest path ------
  // Quarantine AEAD key custody: `<custody>/agent/quarantine-aead.key`, parent 0700
  // (the trusted-CLI custody posture the store enforces before any bundle write).
  const agentCustody = join(custodyDir, "agent");
  mkdirSync(agentCustody, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentCustody, "quarantine-aead.key"), randomBytes(32), { mode: 0o600 }); // exactly 32 RAW bytes

  // The inspectable class is GRADUATION-quarantined items (bootstrap-migration §7),
  // so the arrangement runs a real `graduation scan` over a dirty source: a
  // secret-bearing vault whose finding hard-fails the scan (exit 3) and lands in
  // the quarantine store WITH graduation metadata.
  const dirtySource = join(root, "dirty-vault");
  mkdirSync(dirtySource, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dirtySource });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dirtySource });
  writeFileSync(join(dirtySource, "leaky.md"), `# Leaky\n\naws key AKIA${"A".repeat(16)} lives here\n`, "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dirtySource });
  execFileSync("git", ["-c", "user.name=Aryeh Stark", "-c", "user.email=aryeh@21stark.com", "commit", "-q", "-m", "seed"], { cwd: dirtySource });
  const ingest = await run(["graduation", "scan", "--source", dirtySource, "--copy", join(root, "dirty-copy"), "--json"]);
  let quarantineId: string | null = null;
  if (ingest.status === 3) {
    const qdir = quarantineDir;
    try {
      // Bundle filenames are `q-<hex32>.qbundle`; the store's read() takes the BARE
      // hex id (it re-prefixes `q-` itself), so strip both prefix and suffix.
      const bundle = readdirSync(qdir).find((f) => /^q-[0-9a-f]{32}\./.test(f));
      if (bundle !== undefined) quarantineId = bundle.replace(/^q-/, "").replace(/\.[^.]+$/, "");
    } catch {
      quarantineId = null;
    }
    // Prefer the id the envelope itself reports, when present.
    try {
      const envl = JSON.parse(ingest.stdout.trim().split("\n").pop()!);
      const fromEnvelope =
        envl?.details?.quarantineId ?? envl?.details?.id ?? envl?.errors?.[0]?.details?.quarantineId;
      if (typeof fromEnvelope === "string") quarantineId = fromEnvelope;
    } catch {
      /* keep the directory-derived id */
    }
  }

  // --- eval set fixture (exact-text queries → hash-embedding rank 1) ---------
  const queriesPath = join(root, "eval-queries.json");
  const labelsPath = join(root, "eval-labels.json");
  writeFileSync(queriesPath, JSON.stringify({ version: 1, queries: [{ id: "q1", text: alphaBody }] }), "utf8");
  writeFileSync(labelsPath, JSON.stringify({ version: 1, labels: { q1: ["concept-alpha"] } }), "utf8");

  // --- graduation scan/audit source + copy -----------------------------------
  const gradSource = vaultDir; // the clean seeded vault IS a valid graduation source
  const gradCopy = join(root, "grad-copy");

  const authorize = (challengeJson: string): string => {
    const challenge = JSON.parse(challengeJson) as { signingPayload: string };
    const privateKey = parsePrivateKeyFlexible(readFileSync(join(keysDir, "atlas-test-approver.key"), "utf8"));
    const signature = signBytes(new TextEncoder().encode(challenge.signingPayload), privateKey);
    const response = { schemaVersion: 1, challenge, signature, signerId: "atlas-test-approver" };
    const authPath = join(root, `auth-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(authPath, JSON.stringify(response), "utf8");
    return authPath;
  };

  return {
    root,
    dbPath,
    vaultDir,
    seeded: {
      noteId: "concept-alpha",
      sourceId,
      reviewRunId,
      quarantineId,
      queriesPath,
      labelsPath,
      gradSource,
      gradCopy,
    },
    run,
    authorize,
    async cleanup(): Promise<void> {
      await egressServer.close();
      await brokerServer.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(quarantineDir, { recursive: true, force: true });
    },
  };
}
