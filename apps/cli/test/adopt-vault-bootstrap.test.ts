/**
 * adopt-vault-bootstrap — unit + integration coverage for the adopt-vault.sh
 * bootstrap logic (60-A task 1.6).
 *
 * Tests the three independently-testable parts of the adoption pipeline:
 *   1. Empty-tree baseline commit + refs/atlas/main creation (raw git)
 *   2. sync_cursors seeding + idempotency (already covered by sync-seed.test.ts;
 *      repeated here in the adoption context)
 *   3. State validation: ref resolves, cursor at zero-state, upstream unchanged
 *
 * The OQ#2 adversarial ref-boundary check (atlas-agent denied write on
 * refs/atlas/*, atlas-broker permitted) requires real OS users and gates on
 * ATLAS_PROVISIONED=1 — tested in provisioning-gated suites.
 *
 * The shell script (provisioning/adopt-vault.sh) requires root + a running
 * brain binary and is NOT invoked here; these tests verify the underlying logic.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, registerSyncCursorsMigration } from "@atlas/sqlite-store";
import { seedSyncCursor } from "../src/sync/seed.js";

// ─── git helpers (no @atlas/git — that package's runGit is unexported) ───────

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Create a minimal git repo with one commit on refs/heads/main. */
function initRepo(dir: string): string {
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@test"]);
  git(dir, ["config", "user.name", "Test"]);
  // commit a single file so refs/heads/main is a real commit
  execFileSync("sh", ["-c", `echo "hello" > welcome.md`], { cwd: dir });
  git(dir, ["add", "welcome.md"]);
  git(dir, [
    "commit",
    "-m",
    "initial",
    "--author=Test <test@test>",
    "--date=2020-01-01T00:00:00Z",
  ]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Create the broker-authored empty-tree baseline commit for refs/atlas/main. */
function createAdoptionBaseline(dir: string, canonicalRef: string, sourceId: string): string {
  const emptyTree = git(dir, ["hash-object", "-t", "tree", "/dev/null"]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "atlas-broker",
    GIT_AUTHOR_EMAIL: "atlas-broker@atlas",
    GIT_COMMITTER_NAME: "atlas-broker",
    GIT_COMMITTER_EMAIL: "atlas-broker@atlas",
    GIT_AUTHOR_DATE: "1970-01-01T00:00:00+00:00",
    GIT_COMMITTER_DATE: "1970-01-01T00:00:00+00:00",
  };
  const baselineOid = execFileSync(
    "git",
    ["commit-tree", emptyTree, "-m", `atlas: adoption baseline [source=${sourceId}]`],
    { cwd: dir, encoding: "utf8", env },
  ).trim();
  git(dir, ["update-ref", canonicalRef, baselineOid]);
  return baselineOid;
}

/** Open a migrated in-memory store (sync_cursors migration included). */
function migratedStore() {
  const store = openStore({ path: ":memory:" });
  registerSyncCursorsMigration(store);
  store.migrate();
  return store;
}

// ─── test suite ──────────────────────────────────────────────────────────────

describe("adopt-vault-bootstrap — ref creation", () => {
  it("creates refs/atlas/main at an empty-tree commit (never at refs/heads/main)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-adopt-"));
    try {
      const upstreamOid = initRepo(dir);
      const baselineOid = createAdoptionBaseline(dir, "refs/atlas/main", "main-vault");

      // refs/atlas/main must resolve to the NEW commit
      const atlasOid = git(dir, ["rev-parse", "refs/atlas/main"]);
      expect(atlasOid).toBe(baselineOid);

      // refs/heads/main must be UNCHANGED
      const mainOid = git(dir, ["rev-parse", "refs/heads/main"]);
      expect(mainOid).toBe(upstreamOid);

      // The baseline commit must be at an empty tree
      const treeOid = git(dir, ["rev-parse", "refs/atlas/main^{tree}"]);
      const emptyTree = git(dir, ["hash-object", "-t", "tree", "/dev/null"]);
      expect(treeOid).toBe(emptyTree);

      // The baseline commit must have no parent
      const parents = execFileSync("git", ["log", "--format=%P", "refs/atlas/main", "-1"], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
      expect(parents).toBe(""); // no parent = initial commit

      // Authorship must be broker-attributed (deterministic)
      const author = git(dir, ["log", "--format=%ae", "refs/atlas/main", "-1"]);
      expect(author).toBe("atlas-broker@atlas");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — re-running createAdoptionBaseline returns same OID (deterministic commit)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-adopt-"));
    try {
      initRepo(dir);
      const oid1 = createAdoptionBaseline(dir, "refs/atlas/main", "main-vault");
      // Re-creating would overwrite the ref, but the COMMIT OID is deterministic
      // (same empty tree + fixed author + fixed date + same message)
      const oid2 = createAdoptionBaseline(dir, "refs/atlas/main", "main-vault");
      expect(oid1).toBe(oid2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adopt-vault-bootstrap — seeding + state validation", () => {
  it("happy path: ref + cursor both valid after adoption steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-adopt-"));
    const store = migratedStore();
    try {
      const upstreamOid = initRepo(dir);
      const baselineOid = createAdoptionBaseline(dir, "refs/atlas/main", "main-vault");

      // Seed the sync_cursors row (as adopt-vault.sh calls seed-cli)
      const seedResult = seedSyncCursor(store, {
        sourceId: "main-vault",
        upstreamRef: "refs/heads/main",
        now: () => "2026-07-19T12:00:00Z",
      });
      expect(seedResult.seeded).toBe(true);

      // Validate ref
      expect(git(dir, ["rev-parse", "refs/atlas/main"])).toBe(baselineOid);
      // Validate upstream unchanged
      expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(upstreamOid);
      // Validate cursor row
      const row = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id = 'main-vault'`).get() as {
        upstream_ref: string;
        last_absorbed_oid: string | null;
        cycle_seq: number;
        pending_quarantine: string;
      };
      expect(row.upstream_ref).toBe("refs/heads/main");
      expect(row.last_absorbed_oid).toBeNull();
      expect(row.cycle_seq).toBe(0);
      expect(row.pending_quarantine).toBe("[]");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("full adoption is idempotent — running twice leaves the same valid state", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-adopt-"));
    const store = migratedStore();
    try {
      initRepo(dir);

      // First adoption pass
      const oid1 = createAdoptionBaseline(dir, "refs/atlas/main", "main-vault");
      seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/heads/main" });

      // Second adoption pass (simulating operator re-running the script)
      const oid2 = createAdoptionBaseline(dir, "refs/atlas/main", "main-vault");
      const reseed = seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/heads/main" });

      // Ref: same deterministic OID (idempotent commit)
      expect(oid1).toBe(oid2);
      // Seed: INSERT OR IGNORE was a no-op
      expect(reseed.seeded).toBe(false);
      // State: cursor still at zero-state (no sync has run)
      const row = store.db.prepare(`SELECT last_absorbed_oid, cycle_seq FROM sync_cursors WHERE source_id = 'main-vault'`).get() as {
        last_absorbed_oid: string | null;
        cycle_seq: number;
      };
      expect(row.last_absorbed_oid).toBeNull();
      expect(row.cycle_seq).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idempotency preserves an already-advanced cursor (simulate sync having run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-adopt-"));
    const store = migratedStore();
    try {
      initRepo(dir);
      createAdoptionBaseline(dir, "refs/atlas/main", "main-vault");

      // Seed initial cursor
      seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/heads/main" });

      // Simulate a sync that advanced the cursor
      store.db
        .prepare(
          `UPDATE sync_cursors SET last_absorbed_oid = ?, cycle_seq = 5 WHERE source_id = 'main-vault'`,
        )
        .run("a".repeat(40));

      const advancedRow = store.db
        .prepare(`SELECT last_absorbed_oid, cycle_seq FROM sync_cursors WHERE source_id = 'main-vault'`)
        .get() as { last_absorbed_oid: string | null; cycle_seq: number };
      expect(advancedRow.last_absorbed_oid).toBe("a".repeat(40));
      expect(advancedRow.cycle_seq).toBe(5);

      // Re-seed (operator re-runs adopt-vault.sh by mistake) — must be a no-op
      const reseed = seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/heads/main" });
      expect(reseed.seeded).toBe(false);

      const afterRow = store.db
        .prepare(`SELECT last_absorbed_oid, cycle_seq FROM sync_cursors WHERE source_id = 'main-vault'`)
        .get() as { last_absorbed_oid: string | null; cycle_seq: number };
      expect(afterRow.last_absorbed_oid).toBe("a".repeat(40));
      expect(afterRow.cycle_seq).toBe(5);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adopt-vault-bootstrap — OQ#2 boundary (ATLAS_PROVISIONED=1 only)", () => {
  const provisioned = process.env["ATLAS_PROVISIONED"] === "1";
  // chown to atlas-broker:atlas-broker requires root — skip if not running as root
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(!provisioned || !isRoot)(
    "atlas-agent is denied update-ref on refs/atlas/* (adversarial)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "atlas-adopt-oq2-"));
      try {
        initRepo(dir);
        const baselineOid = createAdoptionBaseline(dir, "refs/atlas/main", "main-vault");

        // Lock the refs/atlas/ directory to atlas-broker (as adopt-vault.sh does)
        execFileSync("chown", ["-R", "atlas-broker:atlas-broker", `${dir}/.git/refs/atlas`]);
        execFileSync("chmod", ["0700", `${dir}/.git/refs/atlas`]);

        // Verify ownership
        const st = statSync(`${dir}/.git/refs/atlas`);
        expect(st.mode & 0o777).toBe(0o700);

        // Adversarial: atlas-agent must be denied
        let agentSucceeded = false;
        try {
          execFileSync(
            "sudo",
            ["-n", "-u", "atlas-agent", "git", "-C", dir, "update-ref", "refs/atlas/main", baselineOid],
            { stdio: "ignore" },
          );
          agentSucceeded = true;
        } catch {
          // Expected: EACCES denied
        }
        expect(agentSucceeded, "OQ#2: atlas-agent must NOT be able to write refs/atlas/main").toBe(false);

        // Control: atlas-broker must succeed
        let brokerFailed = false;
        try {
          execFileSync(
            "sudo",
            ["-n", "-u", "atlas-broker", "git", "-C", dir, "update-ref", "refs/atlas/main", baselineOid],
            { stdio: "ignore" },
          );
        } catch {
          brokerFailed = true;
        }
        expect(brokerFailed, "OQ#2 control: atlas-broker must be able to write refs/atlas/main").toBe(false);
      } finally {
        // Clean up (as root since we chowned it)
        try { execFileSync("chmod", ["-R", "755", `${dir}/.git/refs/atlas`]); } catch { /* best-effort */ }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("adopt-vault-bootstrap — adopt-vault.sh argument validation", () => {
  it("script is executable", () => {
    const root = join(import.meta.dirname, "../../..");
    const script = join(root, "provisioning/adopt-vault.sh");
    const mode = statSync(script).mode;
    // Owner-executable bit (0o100) must be set
    expect(mode & 0o100).not.toBe(0);
  });
});
