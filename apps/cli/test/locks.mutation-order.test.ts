/**
 * locks.mutation-order — the Phase-2 task-2.3 gate (plan §Phase-2 task 3).
 *
 * Proves, against a REAL fixture vault repo driven through the compiled `brain`
 * binary (no daemon, no provisioning, no live model/egress — post-ADR-0003), that
 * the brain-owned advisory vault lock spans the WHOLE mutation order and is
 * contended by every derived-store writer. The proofs use ACTUAL overlapping OS
 * processes coordinated by a deterministic pre-apply barrier (`ATLAS_TEST_MUTATION_*`,
 * a no-op unless armed): invocation-1 acquires `vault-maintenance`, grounds, and
 * PARKS at the pre-apply Git boundary HOLDING the lock — before it commits — so a
 * concurrent invocation-2 can be observed losing the lock while nothing has been
 * mutated yet, then invocation-1 is released and commits under the same held lock.
 *
 *   row d   — an external git `index.lock` PRESENT AT STARTUP + a mutating command
 *             ⇒ a DISTINCT preflight failure (exit 2, `git-index-locked`), separate
 *             from the advisory lock; removing it lets the same command succeed.
 *   row d2  — two overlapping mutations: invocation-1 parks holding the lock
 *             (pre-commit); invocation-2 exits 2 (`locked:vault-maintenance`) with NO
 *             working-tree, NO projection, and NO HEAD change; released, invocation-1
 *             commits — EXACTLY ONE new commit total.
 *   row d3  — `sync` launched while a mutation holds the vault lock exits 2
 *             (`locked:vault-maintenance`) with the seeded index + cursor + job state
 *             byte-unchanged (no partial write).
 *   row d.apply — an external git `index.lock` created AFTER grounding, while a
 *             mutation is parked at the pre-apply boundary, is still caught
 *             (`git-index-locked`, exit 2) — no commit, no projection change (the
 *             lock-entry check alone would miss it).
 *
 * The capture path funnels through the `@atlas/sources` sandbox worker, so the suite
 * gates on the compiled `dist/bin.js`
 * (like `jobs.single-runner-exclusion.test.ts`).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "@atlas/sqlite-store";

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const KEY_ID = "cli-custody-v1"; // config-schema default for sqlite.ledger_backup.key_id
const CANONICAL_REF = "refs/heads/main";

// v2 (#334): the sandbox jail is retired — the only gate is the compiled binary.
const enabled = existsSync(BIN);
const describeIf = enabled ? describe : describe.skip;
if (!existsSync(BIN)) {
  // eslint-disable-next-line no-console
  console.warn(`[locks.mutation-order] SKIPPED — dist/bin.js absent (run \`pnpm -r build\`)`);
}

interface Ctx {
  root: string;
  cwd: string;
  vaultDir: string;
  dbPath: string;
  lancedbDir: string;
  env: NodeJS.ProcessEnv;
  git(args: string[]): string;
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Aryeh Stark",
  GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
  GIT_COMMITTER_NAME: "Aryeh Stark",
  GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
});

function setup(): Ctx {
  const root = mkdtempSync(join("/tmp", "atlas-lockord-"));
  const cwd = join(root, "work");
  const vaultDir = join(cwd, "vault");
  const custodyDir = join(root, "custody");
  const anchorPath = join(root, "anchor", "audit-anchor");
  const dbPath = join(cwd, ".atlas", "atlas.db");
  const lancedbDir = join(cwd, ".atlas", "lancedb");
  for (const d of [cwd, vaultDir, custodyDir, join(cwd, ".atlas")]) mkdirSync(d, { recursive: true });

  // The ledger-backup AEAD custody key `backupConfig` resolves through the test seam.
  writeFileSync(join(custodyDir, `${KEY_ID}.key`), Buffer.from(randomBytes(32)).toString("base64"), "utf8");
  // The quarantine AEAD key: `<custodyDir>/agent/quarantine-aead.key`, raw 32 bytes,
  // 0600 inside a 0700 parent (the real trusted-CLI custody posture buildGuard checks).
  const agentKeysDir = join(custodyDir, "agent");
  mkdirSync(agentKeysDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentKeysDir, "quarantine-aead.key"), randomBytes(32), { mode: 0o600 });

  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: vaultDir, encoding: "utf8", env: gitEnv() }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(vaultDir, "README.md"), "seed\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  // Canonical ref = refs/heads/main (the seed commit) so `source add` FF-advances a
  // ref our git assertions can read; otherwise the default refs/atlas/main is unborn.
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
    // Post-#325 `git.canonical_ref` is gone from the strict schema — canonical
    // is ALWAYS refs/heads/main; CANONICAL_REF above is assertion shorthand only.
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
    `  socket_path: ${join(root, "b.sock")}`,
    `  egress_socket_path: ${join(root, "e.sock")}`,
    "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATLAS_TEST_MODE: "1",
    ATLAS_CUSTODY_TEST_DIR: custodyDir,
    NO_COLOR: "1",
  };
  return { root, cwd, vaultDir, dbPath, lancedbDir, env, git };
}

/** Run `brain` to completion, capturing exit code + stdout/stderr. */
function brainSync(c: Ctx, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: c.cwd, env: { ...c.env, ...extraEnv }, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** Spawn `brain` in the background; returns the process + a promise of its result. */
function brainAsync(c: Ctx, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { proc: ChildProcess; done: Promise<{ code: number | null; out: string; err: string }> } {
  const proc = spawn(process.execPath, [BIN, ...args], { cwd: c.cwd, env: { ...c.env, ...extraEnv } });
  let out = "";
  let err = "";
  proc.stdout?.on("data", (d) => (out += String(d)));
  proc.stderr?.on("data", (d) => (err += String(d)));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    proc.on("close", (code) => resolve({ code, out, err }));
  });
  return { proc, done };
}

/** Parse the JSON error envelope emitted on a `--json` failure. */
function envelope(out: string): { code: string; retryable?: boolean; details?: Record<string, unknown> } {
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
  return JSON.parse(line);
}

/** Write a source file into the vault and stage+commit it (source add reads the file). */
function seedSource(c: Ctx, name: string, body: string): string {
  const p = join(c.vaultDir, name);
  writeFileSync(p, body, "utf8");
  c.git(["add", name]);
  c.git(["commit", "-q", "-m", `add ${name}`]);
  return p;
}

/**
 * The projection/ledger tables a source-capture mutation writes — the notes
 * projection AND the provenance/idempotency/run state a bare `notesCount()` cannot
 * see (a lock loser that partially captured could add a source_captures /
 * source_renditions / content_blobs / workflow_idempotency / agent_runs row without
 * ever touching `notes`). Snapshotting all of them proves ZERO mutation, not just
 * an unchanged note count.
 */
const MUTATION_TABLES = [
  "notes",
  "note_identity_keys",
  "note_links",
  "content_blobs",
  "source_captures",
  "source_renditions",
  "evidence",
  "workflow_idempotency",
  "agent_runs",
] as const;

/**
 * A deterministic digest of ALL mutation-relevant projection/ledger state — every
 * present table's full row set, column-ordered then row-ordered so the hash is
 * stable regardless of insertion order. "" when the DB does not exist yet. Detects
 * any source/provenance/idempotency/run write a note count would miss.
 */
function projectionSnapshot(dbPath: string): string {
  if (!existsSync(dbPath)) return "";
  const store = openStore({ path: dbPath });
  try {
    const h = createHash("sha256");
    const hasTable = store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`);
    for (const t of MUTATION_TABLES) {
      if (hasTable.get(t) === undefined) continue;
      const cols = (store.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);
      const order = cols.map((_, i) => i + 1).join(",");
      const rows = store.db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all();
      h.update(t);
      h.update("\0");
      h.update(JSON.stringify(rows));
      h.update("\0");
    }
    return h.digest("hex");
  } finally {
    store.close();
  }
}

/** Deterministic content hash over a directory tree (relative path + bytes), "" if absent. */
function dirDigest(dir: string): string {
  if (!existsSync(dir)) return "";
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        h.update(relative(dir, full));
        h.update("\0");
        h.update(readFileSync(full));
        h.update("\0");
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

async function waitFor(pred: () => boolean, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Spawn a REAL `brain source add` that parks at the pre-apply Git boundary HOLDING
 * the `vault-maintenance` lock (barrier armed via env). Resolves once the started
 * marker proves it is parked (lock held, nothing committed yet); the returned
 * `release` writes the gate file to let it commit, and `done` awaits its exit.
 */
function parkedMutation(c: Ctx, src: string): { started: Promise<void>; release: () => void; done: Promise<{ code: number | null; out: string; err: string }> } {
  const startedFile = join(c.root, `started-${randomBytes(4).toString("hex")}`);
  const gateFile = join(c.root, `gate-${randomBytes(4).toString("hex")}`);
  const { done } = brainAsync(c, ["source", "add", src, "--json"], {
    ATLAS_TEST_MUTATION_STARTED_FILE: startedFile,
    ATLAS_TEST_MUTATION_GATE_FILE: gateFile,
  });
  return {
    started: waitFor(() => existsSync(startedFile)),
    release: () => writeFileSync(gateFile, "", "utf8"),
    done,
  };
}

let c: Ctx;
beforeEach(() => {
  c = setup();
});
afterEach(() => {
  rmSync(c.root, { recursive: true, force: true });
});

describeIf("locks.mutation-order (Phase-2 task 2.3: d / d2 / d3)", () => {
  it("row d — an external git index.lock present at startup ⇒ distinct preflight exit 2 (git-index-locked)", () => {
    const src = seedSource(c, "row-d.md", "# row d\n\nplain body, no secrets.\n");
    const before = c.git(["rev-parse", CANONICAL_REF]);

    // Plant an external index.lock: another git process is mid-write.
    const indexLock = join(c.vaultDir, ".git", "index.lock");
    writeFileSync(indexLock, "", "utf8");

    const blocked = brainSync(c, ["source", "add", src, "--json"]);
    expect(blocked.code).toBe(2);
    const env = envelope(blocked.out);
    expect(env.code).toBe("git-index-locked");
    // DISTINCT from the advisory-lock failure class.
    expect(env.code).not.toMatch(/^locked:/);
    // Nothing committed while the index.lock stood.
    expect(c.git(["rev-parse", CANONICAL_REF])).toBe(before);

    // Remove it → the SAME command now succeeds and advances canonical.
    rmSync(indexLock, { force: true });
    const ok = brainSync(c, ["source", "add", src, "--json"]);
    expect(ok.code, ok.err).toBe(0);
    expect(c.git(["rev-parse", CANONICAL_REF])).not.toBe(before);
  });

  it("row d2 — overlapping mutations: exactly one commits, the loser exits 2 with zero working-tree/projection/HEAD change", async () => {
    const first = seedSource(c, "row-d2-a.md", "# d2 a\n\nfirst mutation body.\n");
    const second = seedSource(c, "row-d2-b.md", "# d2 b\n\nsecond mutation body.\n");

    const headBefore = c.git(["rev-parse", CANONICAL_REF]);

    // Invocation-1: a REAL `source add` that acquires the vault lock, grounds, and
    // PARKS at the pre-apply boundary — holding the lock, before its commit.
    const inv1 = parkedMutation(c, first);
    await inv1.started;

    // Parked pre-commit: HEAD unmoved and NO git index.lock present — so the loser
    // below is excluded by the ADVISORY lock, not git's transient index.lock.
    expect(c.git(["rev-parse", CANONICAL_REF])).toBe(headBefore);
    expect(existsSync(join(c.vaultDir, ".git", "index.lock"))).toBe(false);

    const projectionBefore = projectionSnapshot(c.dbPath);
    const statusBefore = c.git(["status", "--porcelain"]);

    // Invocation-2 (loser): overlaps invocation-1, must fail FAST (no queueing).
    const loser = brainSync(c, ["source", "add", second, "--json"]);
    expect(loser.code).toBe(2);
    const env = envelope(loser.out);
    expect(env.code).toBe("locked:vault-maintenance");
    expect(env.retryable).toBe(true);
    // Zero change: HEAD, the FULL projection/ledger snapshot (notes + provenance +
    // idempotency + run state), and the working tree exactly as before.
    expect(c.git(["rev-parse", CANONICAL_REF])).toBe(headBefore);
    expect(projectionSnapshot(c.dbPath)).toBe(projectionBefore);
    expect(c.git(["status", "--porcelain"])).toBe(statusBefore);

    // Release invocation-1 → it commits under the same continuously-held lock.
    inv1.release();
    const r1 = await inv1.done;
    expect(r1.code, r1.err).toBe(0);

    // EXACTLY ONE new commit total (invocation-1's); the loser never committed.
    const newCommits = c.git(["rev-list", "--count", `${headBefore}..${CANONICAL_REF}`]);
    expect(newCommits).toBe("1");

    // The previously-losing mutation now commits cleanly (lock free).
    const retry = brainSync(c, ["source", "add", second, "--json"]);
    expect(retry.code, retry.err).toBe(0);
    expect(c.git(["rev-list", "--count", `${headBefore}..${CANONICAL_REF}`])).toBe("2");
  }, 40000);

  it("row d3 — sync launched while a mutation holds the vault lock ⇒ sync exits 2, no partial write to index/cursor/job state", async () => {
    const src = seedSource(c, "row-d3.md", "# d3\n\nmutation body.\n");

    // Migrate so cursor/job tables exist, then seed populated index + cursor + job
    // state whose byte-image must survive a lock-losing sync untouched.
    const migrated = brainSync(c, ["db", "migrate", "--json"]);
    expect(migrated.code, migrated.err).toBe(0);
    mkdirSync(c.lancedbDir, { recursive: true });
    writeFileSync(join(c.lancedbDir, "sentinel.lance"), randomBytes(64));
    const store = openStore({ path: c.dbPath });
    try {
      store.db.prepare(
        `INSERT INTO sync_cursors (source_id, upstream_ref, last_absorbed_oid, last_synced_at, cycle_seq, pending_quarantine)
         VALUES ('vault', 'refs/heads/main', 'oid-seed', '2026-07-22T00:00:00.000Z', 7, '[]')`,
      ).run();
      store.db.prepare(
        `INSERT INTO jobs (job_id, workflow, idempotency_key, state, attempts, max_attempts, next_run_at, payload, payload_hash, created_at, updated_at)
         VALUES ('job-seed', 'index:reconcile', 'seed-key', 'pending', 0, 5, '2026-07-22T00:00:00.000Z', '{}', 'seed-hash', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z')`,
      ).run();
    } finally {
      store.close();
    }

    const indexBefore = dirDigest(c.lancedbDir);
    // Snapshot ALL cursor + job rows (deterministically ordered) — a single-row
    // get() would miss a partially-enqueued second job / cursor a losing sync wrote.
    const cursorsBefore = readRows(c.dbPath, "SELECT * FROM sync_cursors ORDER BY source_id, upstream_ref");
    const jobsBefore = readRows(c.dbPath, "SELECT * FROM jobs ORDER BY job_id");
    const headBefore = c.git(["rev-parse", CANONICAL_REF]);

    // A REAL mutation parks holding vault-maintenance.
    const inv1 = parkedMutation(c, src);
    await inv1.started;

    try {
      const sync = brainSync(c, ["sync", "--json"]);
      expect(sync.code).toBe(2);
      expect(envelope(sync.out).code).toBe("locked:vault-maintenance");

      // The lock is taken before ANY sync work — assert the full index, cursor, and
      // job snapshots + HEAD are byte-identical WHILE invocation-1 is still parked
      // (before it is released and commits). Proves the losing sync wrote nothing.
      expect(dirDigest(c.lancedbDir)).toBe(indexBefore);
      expect(readRows(c.dbPath, "SELECT * FROM sync_cursors ORDER BY source_id, upstream_ref")).toEqual(cursorsBefore);
      expect(readRows(c.dbPath, "SELECT * FROM jobs ORDER BY job_id")).toEqual(jobsBefore);
      expect(c.git(["rev-parse", CANONICAL_REF])).toBe(headBefore);
    } finally {
      inv1.release();
      await inv1.done;
    }
  }, 40000);

  it("row d.apply — an external index.lock created AFTER grounding (at the apply boundary) ⇒ git-index-locked, no commit/projection change", async () => {
    const src = seedSource(c, "row-d-apply.md", "# d apply\n\nmutation body.\n");
    const headBefore = c.git(["rev-parse", CANONICAL_REF]);
    const projectionBefore = projectionSnapshot(c.dbPath);

    // Park at the pre-apply boundary (lock held, grounding done, nothing committed).
    const inv1 = parkedMutation(c, src);
    await inv1.started;

    // Plant an external index.lock NOW — after grounding, before the parked apply.
    // The lock-entry preflight already passed; only the pre-apply RE-CHECK can catch it.
    const indexLock = join(c.vaultDir, ".git", "index.lock");
    writeFileSync(indexLock, "", "utf8");

    // Release → the re-check at the apply boundary must refuse with git-index-locked.
    inv1.release();
    const r1 = await inv1.done;
    expect(r1.code).toBe(2);
    expect(envelope(r1.out).code).toBe("git-index-locked");

    // No commit, no projection/ledger mutation of any kind.
    expect(c.git(["rev-parse", CANONICAL_REF])).toBe(headBefore);
    expect(projectionSnapshot(c.dbPath)).toBe(projectionBefore);

    // Remove it → the same command now succeeds.
    rmSync(indexLock, { force: true });
    const ok = brainSync(c, ["source", "add", src, "--json"]);
    expect(ok.code, ok.err).toBe(0);
    expect(c.git(["rev-parse", CANONICAL_REF])).not.toBe(headBefore);
  }, 40000);
});

/** Read ALL rows a query returns as plain objects (deterministic full snapshot). */
function readRows(dbPath: string, sql: string): Record<string, unknown>[] {
  const store = openStore({ path: dbPath });
  try {
    return store.db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    store.close();
  }
}
