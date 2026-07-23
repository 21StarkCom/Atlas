/**
 * `jobs.cli` (Task 2.7) — runCli-LEVEL acceptance for the `jobs` command surface:
 * the SSOT selector rules (`jobs retry`/`cancel` with NO selector ⇒ exit 5;
 * `<jobId>` + `--all` ⇒ exit 5), the `{ items, aggregate }` batch protocol, and
 * `--json` output validating against the committed `jobs-*.schema.json`. Drain
 * mechanics + exclusion are covered by the `@atlas/jobs` lifecycle suite and
 * `jobs.single-runner-exclusion.test.ts`; this asserts the CLI contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { canonicalStringify } from "@atlas/contracts";
import { openStore } from "@atlas/sqlite-store";
import { openJobsStore, enqueue, bindEnqueueContext, claimNext, completeJob, failJob, readSnapshot, type JobSpec } from "@atlas/jobs";
import { reconcileIdempotency } from "../src/workflows/index.js";
import { runCli } from "../src/main.js";

const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile(s: unknown): ((v: unknown) => boolean) & { errors?: unknown };
  errorsText(e?: unknown): string;
};

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function assertSchema(name: string, value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${name} failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-jobs-cli-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  mkdirSync(join(cwd, "vault"), { recursive: true });
  const config = [
    "vault:",
    `  path: ${join(cwd, "vault")}`,
    "sqlite:",
    "  path: ./.atlas/atlas.db",
    "  ledger_backup:",
    "    dir: ./.atlas/backups",
    "lancedb:",
    "  dir: ./.atlas/lancedb",
    "indexing:",
    "  chunker_version: 1",
    "  embedding_model: gemini-embedding-001",
    "  dimensions: 768",
    "git:",
    "  worktrees_path: ./.atlas/worktrees",
    `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}",
    "policies: {}",
    "logs:",
    "  dir: ./.atlas/logs",
    "broker:",
    `  socket_path: ${join(root, "b.sock")}`,
    `  egress_socket_path: ${join(root, "e.sock")}`,
    "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1" };
  // `db migrate` is the shared migration composition root: it registers the
  // feature-owned migrations (0002_jobs + 0006_workflow_idempotency) before applying
  // them, so the jobs commands below open an ALREADY-migrated store (they never
  // migrate on their own — round-2 finding F1).
  const migrated = await cli(["db", "migrate", "--json"]);
  expect(migrated.code, migrated.out).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, env, { cwd, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("jobs.cli", () => {
  it("`<jobId>` and `--all` together exit 5 (mutually exclusive)", async () => {
    // v2 (#333): `jobs retry|cancel` are retired — `run` is the one selector-taking survivor.
    const { code } = await cli(["jobs", "run", "job-x", "--all", "--json"]);
    expect(code).toBe(5);
  });

  it("`jobs run` on an empty queue exits 0 with an empty batch (schema-valid)", async () => {
    const { code, out } = await cli(["jobs", "run", "--json"]);
    expect(code).toBe(0);
    const obj = JSON.parse(out);
    assertSchema("jobs-run", obj);
    expect(obj).toEqual({
      command: "jobs run",
      items: [],
      aggregate: { exitCode: 0, succeeded: 0, failed: 0, skipped: 0, actionRequired: 0 },
    });
  });

  it("`jobs list` returns a schema-valid paginated envelope", async () => {
    const { code, out } = await cli(["jobs", "list", "--json"]);
    expect(code).toBe(0);
    const obj = JSON.parse(out);
    assertSchema("jobs-list", obj);
    expect(obj.pagination).toEqual({ limit: 50, offset: 0, total: 0, hasMore: false });
  });

  it("`jobs list` on a SEEDED row is the additive-only projection (exact serialized object + key order)", async () => {
    // Seed exactly one pending job with a PINNED clock so `updatedAt`/`nextRunAt`
    // are deterministic and the whole serialized object can be asserted verbatim.
    const FIXED = "2026-07-18T12:00:00.000Z";
    const store = openJobsStore({ path: join(cwd, ".atlas", "atlas.db") });
    try {
      bindEnqueueContext(store.db, { now: () => FIXED, nextJobId: () => "job-seed", defaultMaxAttempts: 5 });
      store.db.transaction(() => enqueue(store.db, { workflow: "reverify", idempotencyKey: "seed-list", payload: { x: 1 } }))();
    } finally {
      store.close();
    }

    const { code, out } = await cli(["jobs", "list", "--json"]);
    expect(code, out).toBe(0);
    const obj = JSON.parse(out);
    assertSchema("jobs-list", obj);
    expect(obj.jobs.length).toBe(1);

    // Exact KEY ORDER — proves `updatedAt` is the ONLY new field, APPENDED, and no
    // pre-existing field moved (a pending job has `nextRunAt`, no `lastError`).
    // `Object.keys` reflects JSON serialization order for string keys.
    expect(Object.keys(obj.jobs[0])).toEqual([
      "jobId",
      "workflow",
      "state",
      "attempts",
      "maxAttempts",
      "nextRunAt",
      "updatedAt",
    ]);

    // Exact serialized VALUES — the additive `updatedAt` carries the row's
    // last-mutation time; every prior field is byte-for-byte what it was pre-change.
    expect(obj.jobs[0]).toEqual({
      jobId: "job-seed",
      workflow: "reverify",
      state: "pending",
      attempts: 0,
      maxAttempts: 5,
      updatedAt: FIXED,
      nextRunAt: FIXED,
    });
    expect(obj.pagination).toEqual({ limit: 50, offset: 0, total: 1, hasMore: false });
  });


  it("`jobs list --limit` out of range exits 5", async () => {
    const { code } = await cli(["jobs", "list", "--limit", "9999", "--json"]);
    expect(code).toBe(5);
  });

  // ── caller-idempotency for the key-accepting jobs commands (round-2 finding F2) ──

  const dbPath = (): string => join(cwd, ".atlas", "atlas.db");

  /** Seed a job row directly (the CLI has no enqueue surface). */
  function seedJob(spec: JobSpec, jobId: string): void {
    const store = openJobsStore({ path: dbPath() });
    try {
      bindEnqueueContext(store.db, { now: () => new Date().toISOString(), nextJobId: () => jobId, defaultMaxAttempts: 5 });
      store.db.transaction(() => enqueue(store.db, spec))();
    } finally {
      store.close();
    }
  }

  /** The `requestHashScope` digest the jobs commands compute for a selector. */
  function reqHash(command: string, jobId: string | null, all: boolean): string {
    return createHash("sha256").update(canonicalStringify({ command, jobId, all })).digest("hex");
  }

  it("reuse of --idempotency-key with a CHANGED request is rejected (exit 1, idempotency-key-conflict)", async () => {
    // v2 (#333): retry/cancel are retired — `jobs run` carries the caller-idempotency surface.
    const a = await cli(["jobs", "run", "job-a", "--idempotency-key", "kdup", "--json"]);
    expect(a.code, a.out).toBe(0);
    // Same key, DIFFERENT selector (job-b) ⇒ a different request ⇒ conflict.
    const b = await cli(["jobs", "run", "job-b", "--idempotency-key", "kdup", "--json"]);
    expect(b.code).toBe(1);
    expect(JSON.parse(b.out).code).toBe("idempotency-key-conflict");
  });

  it("a repeated key REPLAYS the prior result without re-executing", async () => {
    seedJob({ workflow: "cap", idempotencyKey: "seed-c", payload: {} }, "job-c");
    const first = await cli(["jobs", "run", "job-c", "--idempotency-key", "kc", "--json"]);
    expect(first.code, first.out).toBe(0);
    const o1 = JSON.parse(first.out);
    expect(o1.items).toHaveLength(1); // the drain processed job-c (outcome per the env's handler registry)

    // Replay: same key + same selector returns the IDENTICAL result even though job-c
    // already ran — a non-idempotent re-run would instead report a different batch.
    const second = await cli(["jobs", "run", "job-c", "--idempotency-key", "kc", "--json"]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out)).toEqual(o1);
  });

  it("a concurrent duplicate (same key still in-progress) blocks with exit 2", async () => {
    // Simulate a still-running duplicate: an in-progress idempotency slot for the same
    // (command, key, requestHash) owned by another run. A retry blocks on the key
    // rather than executing the work a second time.
    const store = openStore({ path: dbPath() });
    try {
      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO workflow_idempotency
             (command, idempotency_key, request_hash, run_id, state, result_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'in-progress', NULL, ?, ?)`,
        )
        .run("jobs run", "kx", reqHash("jobs run", "job-z", false), "run-other", now, now);
    } finally {
      store.close();
    }
    const r = await cli(["jobs", "run", "job-z", "--idempotency-key", "kx", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).code).toBe("idempotency-in-progress");
  });

  // ── crash / lost-response crash-safety (round finding 2) ──
  // A crash between the queue mutation and the idempotency-result publish leaves the
  // `(command, key)` slot `in-progress` with no run row. Startup reconciliation frees
  // it; a repeat command must then re-drive the work SAFELY — reproducing the identical
  // result (retry/cancel are atomic: nothing committed on crash) and never double-
  // executing (run: a completed job is terminal and is never re-claimed).

  /** Simulate a crash: insert the `in-progress` slot a crashed command left behind. */
  function insertCrashedSlot(command: string, key: string, requestHash: string): void {
    const store = openStore({ path: dbPath() });
    try {
      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO workflow_idempotency
             (command, idempotency_key, request_hash, run_id, state, result_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'in-progress', NULL, ?, ?)`,
        )
        .run(command, key, requestHash, "run-crashed", now, now);
    } finally {
      store.close();
    }
  }

  /** Run the startup idempotency reconciler (frees the crashed, run-less slot). */
  function reconcile(): number {
    const store = openStore({ path: dbPath() });
    try {
      return reconcileIdempotency(store.db, new Date().toISOString());
    } finally {
      store.close();
    }
  }



  it("jobs run: a crashed drain's freed slot never re-executes a job that already completed", async () => {
    // A crashed `jobs run --all --key krun` that drained job-run2 to `succeeded` then
    // died before publishing. Reconcile frees the slot; the repeat run must NOT re-run
    // the already-terminal job (exactly-once execution holds despite the lost response).
    seedJob({ workflow: "cap", idempotencyKey: "seed-run2", payload: {} }, "job-run2");
    const store = openJobsStore({ path: dbPath() });
    try {
      const now = new Date().toISOString();
      claimNext(store.db, now, "job-run2");
      completeJob(store.db, "job-run2", 1, now, null); // succeeded, attempts == 1
      expect(readSnapshot(store, "job-run2")!.attempts).toBe(1);
    } finally {
      store.close();
    }
    insertCrashedSlot("jobs run", "krun", reqHash("jobs run", null, true));
    expect(reconcile()).toBeGreaterThanOrEqual(1);

    const r = await cli(["jobs", "run", "--all", "--idempotency-key", "krun", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).items).toEqual([]); // terminal job not re-claimed
    const s2 = openJobsStore({ path: dbPath() });
    try {
      const snap = readSnapshot(s2, "job-run2")!;
      expect(snap.state).toBe("succeeded");
      expect(snap.attempts).toBe(1); // NOT re-executed
    } finally {
      s2.close();
    }
  });
});
