/**
 * `status` (v2, #332) — the merged read surface, proven against the task's
 * acceptance rows by driving the REAL `brain status` through the router over a
 * real git vault + migrated projection (seeded through a real `brain sync` with
 * the deterministic in-process fake embedder — no daemon, no network):
 *
 *   - the `--json` payload validates against `status.schema.json`, carries the
 *     four sub-objects (vault / db / index / sync), and `checks[]` is EXACTLY
 *     the surviving probe set (vault-reachable, git-healthy,
 *     provider-key-present, index-not-stale, migrations-current);
 *   - a new unindexed note ⇒ `pendingNewCount:1` with `pendingChangedCount:0`;
 *     a deleted file ⇒ `pendingDroppedCount:1` — and the counts EQUAL the ones
 *     the next `sync --dry-run` reports (the shared-routine guarantee);
 *   - a failed provider-key probe (blank-Ubuntu-style env: no
 *     `ATLAS_GEMINI_API_KEY`, no reachable `security` binary) ⇒ `ok:false` at
 *     **exit 0** — unhealth never leaks into the exit code;
 *   - a DB with `0013_links_v2` pending ⇒ `migrations-current` fails,
 *     `ok:false`, **exit 0**, and status NEVER auto-applies the migration;
 *   - an absent ledger store ⇒ db zeros + failed `migrations-current` at exit 0,
 *     and the DB file is NOT created (status never conjures a store);
 *   - an unresolvable vault ⇒ **exit 2** (the one no-payload boundary).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { openStore } from "@atlas/sqlite-store";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  errorsText: (e?: unknown) => string;
};

const statusSchema = JSON.parse(
  readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", "status.schema.json"), "utf8"),
) as object;
const ajv = new Ajv({ strict: false, allErrors: true });
const validateStatus = ajv.compile(statusSchema);

const CHECK_NAMES = ["vault-reachable", "git-healthy", "provider-key-present", "index-not-stale", "migrations-current"];

let root: string;
let cwd: string;
let vaultDir: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Aryeh Stark",
  GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
  GIT_COMMITTER_NAME: "Aryeh Stark",
  GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: vaultDir, encoding: "utf8", env: GIT_ENV }).trim();
}

async function cli(argv: string[], overrideEnv?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, overrideEnv ?? env, { cwd, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

interface StatusPayload {
  command: string;
  ok: boolean;
  vault: { path: string; headSha: string; dirty: boolean; noteCount: number };
  db: { schemaVersion: number; noteCount: number; sectionCount: number; linkCount: number };
  index: { chunkCount: number; staleCount: number; embeddingModel: string };
  sync: { pendingChangedCount: number; pendingNewCount: number; pendingDroppedCount: number; pendingMovedCount: number };
  checks: { name: string; ok: boolean; detail: string | null }[];
}

/** Run `brain status --json`, assert exit 0, parse + schema-validate the payload. */
async function status(overrideEnv?: NodeJS.ProcessEnv): Promise<StatusPayload> {
  const r = await cli(["status", "--json"], overrideEnv);
  expect(r.code, r.out).toBe(0);
  const payload = JSON.parse(r.out) as StatusPayload;
  if (!validateStatus(payload)) {
    throw new Error(`status payload failed schema: ${ajv.errorsText(validateStatus.errors)}\n${JSON.stringify(payload)}`);
  }
  return payload;
}

function writeNote(rel: string, id: string): void {
  const text = `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\nstatus: active\ncreated: 2026-07-22\nupdated: 2026-07-22\n---\n# ${id}\n\nBody of ${id}.\n\n## Detail\n\nMore about ${id}.\n`;
  writeFileSync(join(vaultDir, rel), text, "utf8");
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-status-"));
  cwd = join(root, "work");
  vaultDir = join(cwd, "vault");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(vaultDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: vaultDir });
  git(["config", "commit.gpgsign", "false"]);
  dbPath = join(cwd, ".atlas", "atlas.db");
  const config = [
    "vault:", `  path: ${vaultDir}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  // ATLAS_GEMINI_API_KEY makes provider-key-present deterministically TRUE
  // (independent of this machine's real Keychain).
  env = { ...process.env, NO_COLOR: "1", ATLAS_TEST_MODE: "1", ATLAS_FAKE_PROVIDER: "1", ATLAS_GEMINI_API_KEY: "test-key" };

  writeNote("a.md", "concept-a");
  writeNote("b.md", "concept-b");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed notes"]);
  const mig = await cli(["db", "migrate", "--json"]);
  expect(mig.code, mig.out).toBe(0);
  const sync = await cli(["sync", "--json"]);
  expect(sync.code, sync.out).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("brain status — the v2 merged read surface", () => {
  it("payload validates, carries the four sub-objects, and checks[] is exactly the surviving probe set", async () => {
    const s = await status();
    expect(s.command).toBe("status");
    expect(s.checks.map((c) => c.name)).toEqual(CHECK_NAMES); // exactly the five, once each
    expect(s.ok).toBe(true);
    for (const c of s.checks) expect(c, c.name).toMatchObject({ ok: true, detail: null });

    // vault — the working tree as-is: clean, both notes parsed, HEAD pinned.
    expect(s.vault).toMatchObject({ path: vaultDir, dirty: false, noteCount: 2 });
    expect(s.vault.headSha).toBe(git(["rev-parse", "HEAD"]));

    // db — projection counts from the migrated store; schema head is 0015.
    expect(s.db.noteCount).toBe(2);
    expect(s.db.linkCount).toBe(0);
    expect(s.db.schemaVersion).toBe(15);
    expect(s.db.sectionCount).toBeGreaterThan(0); // vault-derived (## Detail per note)

    // index — the baseline sync embedded both notes; nothing stale.
    expect(s.index.chunkCount).toBeGreaterThan(0);
    expect(s.index.staleCount).toBe(0);
    expect(s.index.embeddingModel).toBe("gemini-embedding-001");

    // sync — a reconciled tree has an all-zero pending picture.
    expect(s.sync).toEqual({ pendingChangedCount: 0, pendingNewCount: 0, pendingDroppedCount: 0, pendingMovedCount: 0 });
  });

  it("a new unindexed note ⇒ pendingNewCount:1 / pendingChangedCount:0; a deletion ⇒ pendingDroppedCount:1 — equal to sync --dry-run (shared routine)", async () => {
    writeNote("c.md", "concept-c"); // uncommitted — dirt is sync's normal input
    let s = await status();
    expect(s.sync).toMatchObject({ pendingNewCount: 1, pendingChangedCount: 0, pendingDroppedCount: 0 });

    unlinkSync(join(vaultDir, "b.md"));
    s = await status();
    expect(s.sync).toMatchObject({ pendingNewCount: 1, pendingDroppedCount: 1 });

    // The shared-routine guarantee: the very next sync classifies IDENTICALLY.
    const dry = await cli(["sync", "--dry-run", "--json"]);
    expect(dry.code, dry.out).toBe(0);
    const d = JSON.parse(dry.out) as { changedCount: number; newCount: number; droppedCount: number; movedCount: number };
    expect(s.sync).toEqual({
      pendingChangedCount: d.changedCount,
      pendingNewCount: d.newCount,
      pendingDroppedCount: d.droppedCount,
      pendingMovedCount: d.movedCount,
    });

    // An edited note lands in pendingChangedCount (not new).
    appendFileSync(join(vaultDir, "a.md"), "\nrevised prose\n");
    s = await status();
    expect(s.sync.pendingChangedCount).toBe(1);
  });

  it("a failed provider-key probe (blank-Ubuntu-style env) ⇒ ok:false at exit 0 — unhealth never leaks into the exit code", async () => {
    // No env key + no reachable `security` binary (the probe threads env.PATH
    // into the subprocess) — the NON-throwing probe reports false, nothing throws.
    const blank: NodeJS.ProcessEnv = { ...env, PATH: "/var/empty" };
    delete blank.ATLAS_GEMINI_API_KEY;
    const s = await status(blank);
    expect(s.ok).toBe(false);
    const probe = s.checks.find((c) => c.name === "provider-key-present")!;
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/ATLAS_GEMINI_API_KEY/);
    // Every other probe still passes — the failure is isolated data.
    for (const c of s.checks.filter((c) => c.name !== "provider-key-present")) expect(c.ok, c.name).toBe(true);
  });

  it("0015 pending ⇒ migrations-current fails, ok:false, exit 0 — and status NEVER auto-applies", async () => {
    // Arrange "0015 pending" (this phase's newest core migration) at the read surface
    // the check consumes: the schema-version table (migrations-current is a read-only
    // version read). Deleting the newest applied row leaves 0014 as the head.
    const s0 = openStore({ path: dbPath });
    s0.db.prepare(`DELETE FROM db_schema_migrations WHERE id = '0015_source_registry'`).run();
    s0.close();

    const s = await status();
    expect(s.ok).toBe(false);
    const check = s.checks.find((c) => c.name === "migrations-current")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/0015_source_registry/);
    expect(check.detail).toMatch(/db migrate/);
    expect(s.db.schemaVersion).toBe(14); // the latest APPLIED id is now 0014

    // Never auto-applies: the version row is still absent after the read.
    const s1 = openStore({ path: dbPath });
    try {
      expect(s1.db.prepare(`SELECT 1 FROM db_schema_migrations WHERE id = '0015_source_registry'`).get()).toBeUndefined();
    } finally {
      s1.close();
    }
  });

  it("an absent ledger store ⇒ db zeros + failed migrations-current at exit 0, and the DB file is NOT created", async () => {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const s = await status();
    expect(s.ok).toBe(false);
    expect(s.db).toMatchObject({ schemaVersion: 0, noteCount: 0, linkCount: 0 });
    expect(s.checks.find((c) => c.name === "migrations-current")!.ok).toBe(false);
    // The whole tree reads as pending-new against the empty projection — still
    // the one shared routine, degraded to an empty row set.
    expect(s.sync.pendingNewCount).toBe(2);
    // status never conjures a store.
    expect(existsSync(dbPath)).toBe(false);
  });

  it("a structurally-broken note DEGRADES (vault-reachable fails, counts zeroed) at exit 0 — while sync itself still fail-closes exit 2", async () => {
    // Review finding (#332): the diagnostic surface must not die exactly when
    // the vault is unhealthy. A note sync cannot classify (invalid frontmatter)
    // fails sync (a writer) closed at exit 2 — but status reports it as data.
    writeFileSync(join(vaultDir, "broken.md"), "---\nid: [oops\n---\nbody\n", "utf8");

    const s = await status(); // exit 0 asserted inside
    expect(s.ok).toBe(false);
    const reach = s.checks.find((c) => c.name === "vault-reachable")!;
    expect(reach.ok).toBe(false);
    expect(reach.detail).toMatch(/broken\.md/);
    // The pending picture is zeroed — a classification over an unreliable
    // id→note map would report false drops.
    expect(s.sync).toEqual({ pendingChangedCount: 0, pendingNewCount: 0, pendingDroppedCount: 0, pendingMovedCount: 0 });

    // The writer policy is UNCHANGED: sync refuses the same vault at exit 2.
    const r = await cli(["sync", "--json"]);
    expect(r.code, r.out).toBe(2);
    expect((JSON.parse(r.out) as { code?: string }).code).toBe("vault-error");
  });

  it("a pending FEATURE migration (0008) also fails migrations-current — the required set is db migrate's own", async () => {
    // Review finding (#332): the check must cover the SAME set a real
    // `brain db migrate` applies (core + jobs/workflows/generation/sync-cursors),
    // not a hand-pinned core list — a store missing 0008 would otherwise report
    // healthy and then die exit 4 inside the next sync's adoptConfig.
    const s0 = openStore({ path: dbPath });
    s0.db.prepare(`DELETE FROM db_schema_migrations WHERE id = '0008_index_config_revision'`).run();
    s0.close();

    const s = await status();
    expect(s.ok).toBe(false);
    const check = s.checks.find((c) => c.name === "migrations-current")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/0008_index_config_revision/);
  });

  it("an unresolvable vault ⇒ exit 2 (the one no-payload boundary)", async () => {
    const config = readFileSync(join(cwd, "brain.config.yaml"), "utf8").replace(vaultDir, join(root, "no-such-vault"));
    writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
    const r = await cli(["status", "--json"]);
    expect(r.code, r.out).toBe(2);
    const err = JSON.parse(r.out) as { code?: string };
    expect(err.code).toBe("vault-error");
  });

  it("any flag or argument ⇒ exit 5 (usage)", async () => {
    const r = await cli(["status", "--verbose-checks", "--json"]);
    expect(r.code).toBe(5);
  });
});
