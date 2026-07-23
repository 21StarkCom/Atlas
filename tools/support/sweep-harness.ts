/**
 * `support/sweep-harness` — the arrangement world for the §13.8 `--json`
 * conformance sweep. v2 (#334): DAEMON-FREE — the broker/egress processes are
 * retired (ADR-0003), so the harness stands up only:
 *
 *  - a seeded git vault (two canonical Markdown notes),
 *  - the gated in-process fake provider (`ATLAS_FAKE_PROVIDER=1`) — the same
 *    DETERMINISTIC hash-embedding fake (identical text ⇒ identical vector, so
 *    retrieval ranks an exact-text eval query at 1),
 *  - a `brain.config.yaml` + env (test mode, fake-provider flag),
 *
 * then arranges state THROUGH THE REAL BINARY (`db migrate` → `db rebuild` →
 * `index rebuild`) plus targeted SQL seeding for row-addressed commands. The
 * sweep itself only consumes `run()` + the seeded ids.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(REPO_ROOT, "apps", "cli", "dist", "bin.js");
const DIMENSIONS = 768;

/** A completed child invocation. */
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
    queriesPath: string;
    labelsPath: string;
  };
  run(argv: string[], opts?: { env?: Record<string, string> }): Promise<RunResult>;
  cleanup(): Promise<void>;
}

export async function makeSweepHarness(): Promise<SweepHarness> {
  const root = mkdtempSync(join(tmpdir(), "atlas-sweep-"));
  const quarantineDir = mkdtempSync(join(tmpdir(), "atlas-sweep-quarantine-"));
  const vaultDir = join(root, "vault");
  const atlasDir = join(root, ".atlas");
  const dbPath = join(atlasDir, "atlas.db");
  for (const d of [vaultDir, atlasDir, join(atlasDir, "worktrees"), join(atlasDir, "logs")]) {
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

  // --- config + env (the broker/quarantine sections are dead knobs the strict
  // schema still requires until the #343 config rebase; nothing dials them) ---
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
      "broker:", `  socket_path: ${join(root, "broker.sock")}`, `  egress_socket_path: ${join(root, "egress.sock")}`, "",
    ].join("\n"),
    "utf8",
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NO_COLOR: "1",
    ATLAS_TEST_MODE: "1",
    // Select the gated in-process fake provider (no key, no network).
    ATLAS_FAKE_PROVIDER: "1",
  };

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
  {
    // Direct writes through a plain connection (the arrangement writer).
    const mod = (await import("@atlas/sqlite-store")) as typeof import("@atlas/sqlite-store");
    const db = mod.openConnection({ path: dbPath });
    try {
      db.prepare(
        `INSERT INTO content_blobs (raw_content_hash, canonical_media_type, size_bytes, vault_path, first_seen_at)
         VALUES (?, 'text/plain', 10, 'sources/sweep', '2026-07-19')`,
      ).run(sourceHash);
    } finally {
      db.close();
    }
  }

  // --- eval set fixture (exact-text queries → hash-embedding rank 1) ---------
  const queriesPath = join(root, "eval-queries.json");
  const labelsPath = join(root, "eval-labels.json");
  writeFileSync(queriesPath, JSON.stringify({ version: 1, queries: [{ id: "q1", text: alphaBody }] }), "utf8");
  writeFileSync(labelsPath, JSON.stringify({ version: 1, labels: { q1: ["concept-alpha"] } }), "utf8");

  return {
    root,
    dbPath,
    vaultDir,
    seeded: {
      noteId: "concept-alpha",
      sourceId,
      queriesPath,
      labelsPath,
    },
    run,
    async cleanup(): Promise<void> {
      rmSync(root, { recursive: true, force: true });
      rmSync(quarantineDir, { recursive: true, force: true });
    },
  };
}
