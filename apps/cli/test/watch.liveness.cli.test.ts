/**
 * `watch.liveness` (SP-1 Phase 4 Tasks 1–2) — the cross-process liveness pin
 * (§9.3/§13.3): the writer is THIS test process, the watcher a spawned child;
 * every domain source (job insert, low-space audit append, model_calls insert,
 * watermark flip) surfaces as a correctly-shaped event within 2×pollMs, in
 * per-source order. Also the §7.6 SSOT agreement: the `job` event payload equals
 * the `jobs list --json` row field-for-field (exercising the schema replica the
 * drift test pins structurally), and `watermarkSeq` is the only invented name.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { openConnection } from "@atlas/sqlite-store";
import { openJobsStore } from "@atlas/jobs";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";

const Ajv2020 = ((_Ajv2020 as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown };
};
const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract/watch.schema.json"), "utf8"));
const validateLine = new Ajv2020({ strict: false, allErrors: true }).compile(SCHEMA);

let h: Phase2Harness;
let child: ChildProcessWithoutNullStreams | undefined;

function writeConfig(): void {
  writeFileSync(
    join(h.root, "brain.config.yaml"),
    [
      "vault:", `  path: ${h.vaultDir}`,
      "sqlite:", `  path: ${h.dbPath}`, "  ledger_backup:", `    dir: ${join(h.root, ".atlas", "backups")}`, "    key_id: test-key-v1", "    keep: 10",
      "lancedb:", `  dir: ${join(h.root, ".atlas", "lancedb")}`,
      "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
      "git:", `  worktrees_path: ${h.worktreesPath}`, `  audit_anchor_path: ${h.anchorPath}`,
      "models: {}", "policies: {}",
      "logs:", `  dir: ${join(h.root, ".atlas", "logs")}`,
      "broker:", `  socket_path: ${h.socketPath}`, `  egress_socket_path: ${join(h.root, "egress.sock")}`, "",
    ].join("\n"),
    "utf8",
  );
}

beforeEach(async () => {
  h = await makePhase2Harness();
  writeConfig();
  // Apply the jobs migration (0002) — the harness core migrations don't include it.
  openJobsStore({ path: h.dbPath }).close();
});
afterEach(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  child = undefined;
  await h.cleanup();
});

function spawnWatch(): { lines: Record<string, any>[]; exited: Promise<number | null> } {
  const lines: Record<string, any>[] = [];
  child = spawn(process.execPath, [BIN, "watch", "--json", "--poll-ms", "100", "--heartbeat-seconds", "300"], {
    cwd: h.root,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() !== "") lines.push(JSON.parse(line));
    }
  });
  const exited = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));
  return { lines, exited };
}

async function waitFor(
  lines: Record<string, any>[],
  pred: (ls: Record<string, any>[]) => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (pred(lines)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}; lines: ${JSON.stringify(lines)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function sql(fn: (db: ReturnType<typeof openConnection>) => void): void {
  const db = openConnection({ path: h.dbPath });
  try {
    fn(db);
  } finally {
    db.close();
  }
}

const NOW = "2026-07-19T08:00:00.000Z";

describe.skipIf(!existsSync(BIN))("brain watch — cross-process liveness (real child)", () => {
  it("job / audit (both spaces) / model_call / backup changes each surface as schema-valid events", async () => {
    const { lines, exited } = spawnWatch();
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.hello" && l.ledger?.attached === true), 15_000, "hello");

    // 1) job insert
    sql((db) =>
      db
        .prepare(
          `INSERT INTO jobs (job_id, workflow, idempotency_key, state, attempts, max_attempts, next_run_at, payload, payload_hash, created_at, updated_at)
           VALUES ('job_w1', 'ingest', 'k1', 'pending', 0, 3, '2026-07-19T09:00:00.000Z', '{}', 'h', ?, ?)`,
        )
        .run(NOW, NOW),
    );
    await waitFor(lines, (ls) => ls.some((l) => l.event === "job" && l.jobId === "job_w1"), 5_000, "the job event");
    const job = lines.find((l) => l.event === "job" && l.jobId === "job_w1")!;
    expect(validateLine(job), JSON.stringify((validateLine as any).errors)).toBe(true);
    expect(job.state).toBe("pending");

    // 2) low-space audit append + a high-space (non-run.%) row
    sql((db) => {
      db.prepare(
        `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
         VALUES (0, 'run_a', 'run.started', 'h', 'abc', ?)`,
      ).run(NOW);
      db.prepare(
        `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
         VALUES (1000000000000, 'run_a', 'db.backup', 'h', NULL, ?)`,
      ).run(NOW);
    });
    await waitFor(
      lines,
      (ls) => ls.some((l) => l.event === "audit" && l.seq === 0) && ls.some((l) => l.event === "audit" && l.seq === 1000000000000),
      5_000,
      "both audit events",
    );
    const low = lines.find((l) => l.event === "audit" && l.seq === 0)!;
    expect(low.eventType).toBe("run.started");
    expect(low.gitHead).toBe("abc");
    const high = lines.find((l) => l.event === "audit" && l.seq === 1000000000000)!;
    expect(high.eventType).toBe("db.backup");
    expect(high.gitHead).toBeUndefined(); // NULL ⇒ omitted
    expect(validateLine(low)).toBe(true);
    expect(validateLine(high)).toBe(true);

    // 3) model_calls insert (needs an agent_runs parent — FKs are ON)
    sql((db) => {
      db.prepare(
        `INSERT INTO agent_runs (run_id, operation, status, checkpoint_seq, started_at, updated_at)
         VALUES ('run_mc', 'ingest', 'planned', 0, ?, ?)`,
      ).run(NOW, NOW);
      db.prepare(
        `INSERT INTO model_calls (call_id, run_id, provider, model, operation, input_tokens, output_tokens, cost_micros, created_at)
         VALUES ('call_1', 'run_mc', 'gemini', 'gemini-embedding-001', 'embed', 12, 0, 3, ?)`,
      ).run(NOW);
    });
    await waitFor(lines, (ls) => ls.some((l) => l.event === "model_call" && l.callId === "call_1"), 5_000, "the model_call event");
    const mc = lines.find((l) => l.event === "model_call")!;
    expect(validateLine(mc)).toBe(true);
    expect(mc).toMatchObject({ runId: "run_mc", provider: "gemini", operation: "embed", inputTokens: 12, costMicros: 3 });

    // 4) watermark flip — the row is created lazily by the backup subsystem, so
    // seed it the way the first backup would; the event mirrors the row, DDL `seq`
    // exposed as watermarkSeq.
    sql((db) =>
      db
        .prepare(
          `INSERT INTO backup_watermark (id, seq, healthy, last_backup_at, updated_at) VALUES (1, 0, 0, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET seq = 0, healthy = 0, updated_at = excluded.updated_at`,
        )
        .run(NOW),
    );
    await waitFor(lines, (ls) => ls.some((l) => l.event === "backup" && l.healthy === false), 5_000, "the backup event");
    const backup = lines.find((l) => l.event === "backup")!;
    expect(validateLine(backup)).toBe(true);
    expect(backup.watermarkSeq).toBe(0);
    expect(backup.seq).toBeUndefined(); // the rename is total — no raw DDL name leaks

    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 60_000);

  it("watch and `jobs list --json` agree on the same row (the §7.6 SSOT projection)", async () => {
    const { lines, exited } = spawnWatch();
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.hello"), 15_000, "hello");
    sql((db) =>
      db
        .prepare(
          `INSERT INTO jobs (job_id, workflow, idempotency_key, state, attempts, max_attempts, next_run_at, payload, payload_hash, created_at, updated_at)
           VALUES ('job_agree', 'enrich', 'k2', 'pending', 1, 5, NULL, '{}', 'h', ?, ?)`,
        )
        .run(NOW, NOW),
    );
    await waitFor(lines, (ls) => ls.some((l) => l.event === "job" && l.jobId === "job_agree"), 5_000, "the job event");
    const ev = lines.find((l) => l.event === "job" && l.jobId === "job_agree")!;

    const r = spawnSync(process.execPath, [BIN, "jobs", "list", "--json"], { cwd: h.root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const listed = JSON.parse(r.stdout.trim().split("\n")[0]!).jobs.find((j: any) => j.jobId === "job_agree");
    expect(listed).toBeDefined();
    // The event payload (minus the v/event/at envelope) IS the jobs-list row.
    const { v: _v, event: _e, at: _a, ...payload } = ev;
    expect(payload).toEqual(listed);
    expect(ev.nextRunAt).toBeUndefined(); // null ⇒ omitted, both surfaces

    child!.kill("SIGTERM");
    await expect(exited).resolves.toBe(0);
  }, 60_000);
});
