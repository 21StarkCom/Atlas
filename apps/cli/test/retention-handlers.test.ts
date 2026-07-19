/**
 * `retention-handlers` (Task 4.10) — the EXECUTE side of retention registration.
 *
 * `retention/jobs.ts` enqueues one job per `retention-matrix.md` class; this suite
 * covers the handlers that actually run them (`retention/handlers.ts`), one describe
 * per class:
 *
 *  - **lancedb-compaction** (matrix row 27) — obsolete generations hard-deleted after
 *    activation, under the table-scoped exclusive maintenance lock;
 *  - **log-rotation** (matrix row 26) — rotation + size/AGE retention, hard delete;
 *  - **backup-prune** (matrix row 18) — keep-N ∪ keep-forever-latest, `.tmp-*` sweep;
 *  - **quarantine-expiry** (matrix row 31) — TTL expiry + keep-N trim, crash-safe.
 *
 * Three properties every handler shares and this suite pins:
 *   1. **Laziness** — `buildRetentionHandlers` dereferences nothing at build time
 *      (the registry-completeness gate builds it with a stub `deps`).
 *   2. **Payload validation** — a malformed payload is a PERMANENT failure
 *      (`kind: "validation"`), never a transient one that burns the attempt budget.
 *   3. **No SQLite mutation** — every retention class is filesystem/LanceDB-only, so
 *      handlers return `{}` and never a `commit` closure (which would also require a
 *      `sideEffectId`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { classifyError, type JobHandlerContext, type JobHandlerResult } from "@atlas/jobs";
import { openStore, registerGenerationMigration, takeBackup, type Store } from "@atlas/sqlite-store";
import {
  assembleRows,
  chunkNote,
  generationId,
  openSearchTable,
  writeGeneration,
  type IndexingConfig,
  type SearchTable,
} from "@atlas/lancedb-index";
import type { ParsedNote } from "@atlas/contracts";
import { QUARANTINE_KEY_BYTES, QuarantineStore } from "../src/quarantine/store.js";
import { buildRetentionHandlers } from "../src/retention/handlers.js";
import { RETENTION_WORKFLOWS } from "../src/retention/jobs.js";
import type { JobHandlerDeps } from "../src/commands/job-handlers.js";
import type { RunContext } from "../src/handlers.js";

const CFG: IndexingConfig = { chunker_version: 1, embedding_model: "test-embed", dimensions: 3 };
const NOW = "2026-07-16T12:00:00.000Z";
const DAY_MS = 86_400_000;

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "atlas-retention-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A silent logger — handlers log progress; the tests assert effects, not lines. */
const silentLog = (): RunContext["log"] => {
  const noop = (): void => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
  return log as unknown as RunContext["log"];
};

interface CtxOverrides {
  readonly lancedbDir?: string;
  readonly logsDir?: string;
  readonly logsMaxFiles?: number;
  readonly logsRetentionDays?: number;
  readonly backupDir?: string;
  readonly backupKeep?: number;
  readonly custodyDir?: string;
  readonly quarantineDir?: string;
  readonly quarantineKeep?: number;
}

/** A minimal `RunContext` carrying exactly what the retention handlers read. */
function ctx(over: CtxOverrides = {}): RunContext {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  return {
    cwd: repo,
    runId: "run-retention",
    log: silentLog(),
    env: {
      ATLAS_TEST_MODE: "1",
      ...(over.custodyDir !== undefined ? { ATLAS_CUSTODY_TEST_DIR: over.custodyDir } : {}),
    } as NodeJS.ProcessEnv,
    config: {
      config: {
        vault: { path: join(base, "vault") },
        indexing: { chunker_version: CFG.chunker_version, embedding_model: CFG.embedding_model, dimensions: CFG.dimensions },
        lancedb: { dir: over.lancedbDir ?? join(base, "lancedb") },
        logs: {
          dir: over.logsDir ?? join(base, "logs"),
          max_files: over.logsMaxFiles ?? 3,
          max_bytes: 1_000_000,
          retention_days: over.logsRetentionDays ?? 7,
        },
        sqlite: {
          path: join(base, "ledger.db"),
          ledger_backup: { dir: over.backupDir ?? join(base, "backups"), key_id: "primary", keep: over.backupKeep ?? 10 },
        },
        quarantine: {
          dir: over.quarantineDir ?? join(base, "state", "quarantine"),
          keep: over.quarantineKeep ?? 200,
          retention_days: 30,
          key_id: "cli-custody-v1",
          revoked_key_ids: [],
        },
      },
    },
  } as unknown as RunContext;
}

/** Invoke one workflow's handler with a payload (and an optional pre-aborted signal). */
async function run(
  deps: JobHandlerDeps,
  workflow: string,
  payload: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<JobHandlerResult> {
  const handler = buildRetentionHandlers(deps)[workflow];
  expect(handler).toBeDefined();
  const jctx: JobHandlerContext = { jobId: `job-${workflow}`, workflow, attempt: 1, payload, signal, now: NOW };
  return handler!(jctx);
}

/** The classification the runner would give a thrown handler error. */
async function classifyThrown(p: Promise<unknown>): Promise<{ cls: string; code: string }> {
  try {
    await p;
  } catch (e) {
    const c = classifyError(e);
    return { cls: c.cls, code: c.code };
  }
  throw new Error("expected the handler to throw");
}

/** Backdate a path's mtime by `ms` so an age-based sweep sees it as old. */
function backdate(path: string, ms: number): void {
  const t = (Date.parse(NOW) - ms) / 1000;
  utimesSync(path, t, t);
}

// ---------------------------------------------------------------------------
// Build-time laziness + coverage
// ---------------------------------------------------------------------------

describe("buildRetentionHandlers — shape + laziness", () => {
  it("covers every RETENTION_WORKFLOWS entry and dereferences nothing at build time", () => {
    // The registry-completeness gate builds the production registry with a STUB deps
    // object; touching `deps.ctx`/`deps.store` here would throw.
    const handlers = buildRetentionHandlers({} as JobHandlerDeps);
    expect(Object.keys(handlers).sort()).toEqual([...RETENTION_WORKFLOWS].sort());
    for (const w of RETENTION_WORKFLOWS) expect(typeof handlers[w]).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// retention:backup-prune (matrix row 18)
// ---------------------------------------------------------------------------

describe("retention:backup-prune", () => {
  /** Provision the ledger-backup custody key the gated test seam reads. */
  function custody(): string {
    const dir = join(base, "custody");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "primary.key"), Buffer.from(randomBytes(32)).toString("base64"), { mode: 0o600 });
    return dir;
  }

  function custodyKey(custodyDir: string): Uint8Array {
    return new Uint8Array(Buffer.from(readFileSync(join(custodyDir, "primary.key"), "utf8").trim(), "base64"));
  }

  /** Seed `count` distinct verified bundles (each a fresh committed run ⇒ distinct cut). */
  async function seedBackups(store: Store, custodyDir: string, dir: string, count: number): Promise<void> {
    const cfg = { dir, key: custodyKey(custodyDir), keyId: "primary", keep: 100 }; // seed without pruning
    for (let i = 0; i < count; i++) {
      // A committed audit event per iteration advances the safe cut so each bundle
      // gets a distinct, monotonically-increasing cutSeq (deterministic sort).
      store.db
        .prepare(`INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at) VALUES (?, 'r', 'run.projection', 'h', NULL, ?)`)
        .run(i, `2026-07-1${i + 1}T00:00:00.000Z`);
      await takeBackup(store, cfg, { audit: false, now: () => `2026-07-1${i + 1}T00:00:00.000Z` });
    }
  }

  it("prunes to keep-N ∪ keep-forever-latest, sweeps .tmp-* leftovers, and mutates no SQLite", async () => {
    const custodyDir = custody();
    const c = ctx({ custodyDir });
    const dir = c.config.config.sqlite.ledger_backup.dir;
    const store = openStore({ path: join(base, "ledger.db") });
    store.migrate();
    try {
      await seedBackups(store, custodyDir, dir, 3);
      expect(readdirSync(dir).filter((n) => !n.startsWith("."))).toHaveLength(3);

      // A crash leftover from an interrupted write must be swept.
      writeFileSync(join(dir, ".tmp-9-deadbeef"), "leftover");

      const res = await run({ ctx: c, store }, "retention:backup-prune", { period: "2026-07-16", keep: 1 });
      expect(res.commit).toBeUndefined(); // filesystem-only ⇒ no atomic SQLite effect
      const left = readdirSync(dir);
      expect(left.filter((n) => n.startsWith(".tmp-"))).toHaveLength(0);
      expect(left.filter((n) => !n.startsWith("."))).toHaveLength(1); // keep-forever-latest
    } finally {
      store.close();
    }
  });

  it("rejects a payload without a positive integer keep as a PERMANENT failure", async () => {
    const c = ctx({ custodyDir: custody() });
    const store = openStore({ path: ":memory:" });
    try {
      expect(await classifyThrown(run({ ctx: c, store }, "retention:backup-prune", { period: "2026-07-16" }))).toMatchObject({ cls: "permanent", code: "validation" });
      expect(await classifyThrown(run({ ctx: c, store }, "retention:backup-prune", { period: "2026-07-16", keep: 0 }))).toMatchObject({ cls: "permanent" });
      expect(await classifyThrown(run({ ctx: c, store }, "retention:backup-prune", "nope"))).toMatchObject({ cls: "permanent" });
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// retention:quarantine-expiry (matrix row 31)
// ---------------------------------------------------------------------------

describe("retention:quarantine-expiry", () => {
  /** Provision the REAL agent custody layout the quarantine store resolves. */
  function custody(): string {
    const root = join(base, "keys");
    const agent = join(root, "agent");
    mkdirSync(agent, { recursive: true, mode: 0o700 });
    writeFileSync(join(agent, "quarantine-aead.key"), Buffer.from(randomBytes(QUARANTINE_KEY_BYTES)), { mode: 0o600 });
    return root;
  }

  /** Seal one item under a BACKDATED clock so its stamped `expiresAt` is already past. */
  function seedExpired(c: RunContext, keysRoot: string): void {
    const key = new Uint8Array(readFileSync(join(keysRoot, "agent", "quarantine-aead.key")));
    const store = new QuarantineStore({
      dir: c.config.config.quarantine.dir,
      key,
      keyId: "cli-custody-v1",
      retentionDays: 1,
      autoRetention: false,
      clock: () => new Date(Date.now() - 10 * DAY_MS),
    });
    store.quarantineItem({ bytes: new TextEncoder().encode("sealed"), origin: "note.md", findings: [] });
  }

  it("expires TTL-elapsed items and sweeps stale temps without a SQLite commit", async () => {
    const keysRoot = custody();
    const c = ctx({ custodyDir: keysRoot });
    const store = openStore({ path: ":memory:" });
    try {
      seedExpired(c, keysRoot);
      const qdir = c.config.config.quarantine.dir;
      expect(readdirSync(qdir).filter((n) => n.startsWith("q-"))).toHaveLength(1);

      const stale = join(qdir, ".qtmp-crash");
      writeFileSync(stale, "remnant");
      backdate(stale, 10 * DAY_MS);

      const res = await run({ ctx: c, store }, "retention:quarantine-expiry", { period: "2026-07-16" });
      expect(res.commit).toBeUndefined();
      expect(readdirSync(qdir).filter((n) => n.startsWith("q-"))).toHaveLength(0);
      expect(readdirSync(qdir).filter((n) => n.startsWith(".qtmp-"))).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("rejects a payload without a period as a PERMANENT failure", async () => {
    const c = ctx({ custodyDir: custody() });
    const store = openStore({ path: ":memory:" });
    try {
      expect(await classifyThrown(run({ ctx: c, store }, "retention:quarantine-expiry", {}))).toMatchObject({ cls: "permanent", code: "validation" });
      expect(await classifyThrown(run({ ctx: c, store }, "retention:quarantine-expiry", null))).toMatchObject({ cls: "permanent" });
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// retention:log-rotation (matrix row 26)
// ---------------------------------------------------------------------------

describe("retention:log-rotation", () => {
  function seedLogs(dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const name of ["atlas.log", "atlas.log.1", "atlas.log.2", "atlas.log.7"]) {
      writeFileSync(join(dir, name), `{"msg":"${name}"}\n`);
    }
  }

  it("expires rotated files past the window and trims indices beyond max_files", async () => {
    const dir = join(base, "logs");
    seedLogs(dir);
    // `.1` is fresh; `.2` is past the 7-day window; `.7` is beyond max_files=3.
    backdate(join(dir, "atlas.log.2"), 30 * DAY_MS);
    backdate(join(dir, "atlas.log.7"), 1 * DAY_MS);
    const c = ctx({ logsDir: dir, logsMaxFiles: 3, logsRetentionDays: 7 });
    const store = openStore({ path: ":memory:" });
    try {
      const res = await run({ ctx: c, store }, "retention:log-rotation", { period: "2026-07-16" });
      expect(res.commit).toBeUndefined();
      const left = readdirSync(dir).sort();
      expect(left).toContain("atlas.log");
      expect(left).toContain("atlas.log.1");
      expect(left).not.toContain("atlas.log.2"); // hard-deleted on expiry
      expect(left).not.toContain("atlas.log.7"); // beyond max_files
    } finally {
      store.close();
    }
  });

  it("age-rotates a quiescent active log the size trigger can never reach", async () => {
    const dir = join(base, "logs");
    mkdirSync(dir, { recursive: true });
    const active = join(dir, "atlas.log");
    writeFileSync(active, `{"msg":"ancient"}\n`);
    backdate(active, 30 * DAY_MS); // untouched for a month, far below max_bytes
    const c = ctx({ logsDir: dir, logsMaxFiles: 3, logsRetentionDays: 7 });
    const store = openStore({ path: ":memory:" });
    try {
      await run({ ctx: c, store }, "retention:log-rotation", { period: "2026-07-16" });
      // Rotated out of the way AND expired in the same pass (its mtime survives the
      // rename, and it is past the window) — matrix row 26: hard delete on expiry.
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects a payload without a period as a PERMANENT failure", async () => {
    const c = ctx({ logsDir: join(base, "logs") });
    const store = openStore({ path: ":memory:" });
    try {
      expect(await classifyThrown(run({ ctx: c, store }, "retention:log-rotation", { period: 7 }))).toMatchObject({ cls: "permanent", code: "validation" });
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// retention:lancedb-compaction (matrix row 27)
// ---------------------------------------------------------------------------

describe("retention:lancedb-compaction", () => {
  function note(id: string, body: string, hash: string): ParsedNote {
    return {
      id,
      path: `${id}.md`,
      type: "concept",
      schemaVersion: 1,
      title: id,
      status: "active",
      created: "2026-07-15T00:00:00Z",
      updated: "2026-07-15T00:00:00Z",
      aliases: [],
      sources: [],
      declaredSensitivity: "internal",
      links: [],
      sections: { heading: "", level: 0, path: "", children: [] },
      contentHash: hash,
      raw: body,
    };
  }

  /** Write an ORPHAN generation (never CAS-activated ⇒ not in the SQLite active set). */
  async function seedOrphan(dir: string): Promise<SearchTable> {
    const conn = await lancedb.connect(dir);
    const table = await openSearchTable(conn, CFG);
    const n = note("alpha", "Meridian prose about the index.", "h-orphan");
    const chunks = chunkNote(n, CFG);
    await writeGeneration(table, assembleRows(chunks, chunks.map(() => [1, 0, 0]), CFG, generationId(n, CFG)));
    return table;
  }

  function migratedStore(): Store {
    const s = openStore({ path: join(base, "gen.db") });
    registerGenerationMigration(s);
    s.migrate();
    return s;
  }

  it("hard-deletes chunks whose generation is not SQLite-active", async () => {
    const dir = join(base, "lancedb");
    const table = await seedOrphan(dir);
    expect(await table.countRows()).toBeGreaterThan(0);
    const store = migratedStore();
    try {
      const res = await run({ ctx: ctx({ lancedbDir: dir }), store }, "retention:lancedb-compaction", { period: "2026-07-16" });
      expect(res.commit).toBeUndefined(); // LanceDB-only; SQLite is the fence, untouched
      // Re-open the table: the deletion lands on the handler's own connection; a stale
      // handle caches its version, so read a fresh one to observe the reclaimed rows.
      const fresh = await openSearchTable(await lancedb.connect(dir), CFG);
      expect(await fresh.countRows()).toBe(0);
    } finally {
      store.close();
    }
  });

  it("is a no-op when no index is configured (absent dir/table)", async () => {
    const store = migratedStore();
    try {
      const res = await run({ ctx: ctx({ lancedbDir: join(base, "no-such-index") }), store }, "retention:lancedb-compaction", { period: "2026-07-16" });
      expect(res).toEqual({});
    } finally {
      store.close();
    }
  });

  it("observes the cancel signal at a checkpoint and leaves the index untouched", async () => {
    const dir = join(base, "lancedb");
    const table = await seedOrphan(dir);
    const before = await table.countRows();
    const store = migratedStore();
    const ac = new AbortController();
    ac.abort();
    try {
      const c = await classifyThrown(run({ ctx: ctx({ lancedbDir: dir }), store }, "retention:lancedb-compaction", { period: "2026-07-16" }, ac.signal));
      expect(c).toMatchObject({ cls: "cancelled", code: "cancelled" });
      expect(await table.countRows()).toBe(before); // nothing deleted before the checkpoint
    } finally {
      store.close();
    }
  });

  it("rejects a payload without a period as a PERMANENT failure", async () => {
    const store = migratedStore();
    try {
      expect(await classifyThrown(run({ ctx: ctx(), store }, "retention:lancedb-compaction", []))).toMatchObject({ cls: "permanent", code: "validation" });
    } finally {
      store.close();
    }
  });
});

/** `statSync` is only used to assert the fixtures actually exist before a sweep. */
export const _fixtureGuard = statSync;
