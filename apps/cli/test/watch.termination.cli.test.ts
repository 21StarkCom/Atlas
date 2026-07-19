/**
 * `watch.termination` (SP-1 Phase 5 Task 4) — §10.1 exit semantics over the real
 * child: SIGINT/SIGTERM → exit 0 (from an attached AND a detached state — the
 * persistent latch reaches whichever loop is active); a consumer closing the read
 * end (`head -1`-style) → exit 0, never SIGPIPE/141; broken config → exit 2 with
 * one envelope; a broker `bad_request` protocol error during the snapshot probe →
 * exit 4, exactly one envelope, no event line — while mere unreachability
 * DEGRADES to `sqlite-only` and streams on (the §13.11 contrast pair).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePhase2Harness, type Phase2Harness } from "./e2e/phase2-support.js";

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

let h: Phase2Harness;
let child: ChildProcessWithoutNullStreams | undefined;

function writeConfig(overrides: { brokerSocket?: string } = {}): void {
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
      "broker:", `  socket_path: ${overrides.brokerSocket ?? h.socketPath}`, `  egress_socket_path: ${join(h.root, "egress.sock")}`, "",
    ].join("\n"),
    "utf8",
  );
}

beforeEach(async () => {
  h = await makePhase2Harness();
  writeConfig();
});
afterEach(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  child = undefined;
  await h.cleanup();
});

function spawnWatch(args: string[] = [], cfg: { dbMissing?: boolean } = {}): {
  lines: Record<string, any>[];
  stdout: () => string;
  exited: Promise<number | null>;
} {
  const lines: Record<string, any>[] = [];
  let raw = "";
  child = spawn(process.execPath, [BIN, "watch", "--json", "--poll-ms", "100", "--heartbeat-seconds", "5", ...args], {
    cwd: h.root,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    raw += d.toString("utf8");
    buf += d.toString("utf8");
    for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() !== "") lines.push(JSON.parse(line));
    }
  });
  const exited = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));
  void cfg;
  return { lines, stdout: () => raw, exited };
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
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}; got ${JSON.stringify(lines).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!existsSync(BIN))("brain watch — termination & fatal framing (real child)", () => {
  it("SIGINT from an ATTACHED stream exits 0; SIGTERM from a DETACHED stream exits 0 (the latch reaches either loop)", async () => {
    const a = spawnWatch();
    await waitFor(a.lines, (ls) => ls.some((l) => l.event === "watch.hello" && l.ledger?.attached === true), 15_000, "attached hello");
    child!.kill("SIGINT");
    await expect(a.exited).resolves.toBe(0);
    child = undefined;

    writeConfig(); // same config; point sqlite at a missing path for the detached case
    writeFileSync(
      join(h.root, "brain.config.yaml"),
      (await import("node:fs")).readFileSync(join(h.root, "brain.config.yaml"), "utf8").replace(h.dbPath, join(h.root, ".atlas", "gone.db")),
      "utf8",
    );
    const d = spawnWatch();
    await waitFor(d.lines, (ls) => ls.some((l) => l.event === "watch.hello" && l.ledger?.attached === false), 15_000, "detached hello");
    child!.kill("SIGTERM");
    await expect(d.exited).resolves.toBe(0);
  }, 60_000);

  it("a consumer closing the read end exits 0 (never 141/SIGPIPE)", async () => {
    const { lines, exited } = spawnWatch();
    await waitFor(lines, (ls) => ls.some((l) => l.event === "watch.hello"), 15_000, "hello");
    // Close the read end while the producer keeps heartbeating (5s cadence).
    child!.stdout.destroy();
    const code = await exited;
    expect(code).toBe(0);
  }, 60_000);

  it("broken config → exit 2, one envelope, no event line", () => {
    writeFileSync(join(h.root, "brain.config.yaml"), "vault: [not, a, mapping\n", "utf8");
    const r = spawnSync(process.execPath, [BIN, "watch", "--json", "--once"], { cwd: h.root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(r.status).toBe(2);
    const out = r.stdout.trim().split("\n").filter((l) => l !== "");
    expect(out).toHaveLength(1);
    const env = JSON.parse(out[0]!);
    expect(env.code).toBeTruthy();
    expect(env.event).toBeUndefined();
  });

  it("a broker `bad_request` refusal at the snapshot probe is FATAL (CliError exit 4); mere unreachability degrades and streams on", async () => {
    // Deterministic in-process pin: a probe whose RPC throws the canonical
    // broker.bad_request refusal makes attachLedger throw the internal CliError
    // (the orchestrator's mapped exit 4, one envelope via runCli).
    const { badRequestRefusal } = await import("@atlas/broker");
    const { attachLedger } = await import("../src/watch/attach.js");
    const { CliError } = await import("../src/errors/envelope.js");
    const refusingProbe = {
      getAuditChainStatus: (): Promise<never> => Promise.reject(badRequestRefusal("malformed correlated result")),
    };
    const err = await attachLedger(
      h.dbPath,
      { once: true, pollMs: 500, heartbeatSeconds: 30 },
      { anchorPath: h.anchorPath, env: process.env, broker: refusingProbe, brokerSocket: h.socketPath, egressSocket: join(h.root, "egress.sock") },
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as InstanceType<typeof CliError>).exitCode).toBe(4);
    expect((err as Error).message).toContain("broker.bad_request");

    // Contrast (real child): an UNREACHABLE broker (no socket at all) degrades to
    // sqlite-only and the stream stays alive — unreachable ≠ protocol-error.
    writeConfig({ brokerSocket: join(h.root, "absent.sock") });
    const q = spawnWatch();
    await waitFor(q.lines, (ls) => ls.some((l) => l.event === "watch.hello"), 15_000, "the degraded hello");
    const hello = q.lines.find((l) => l.event === "watch.hello")!;
    expect(hello.snapshot.audit.anchorSource).toBe("sqlite-only");
    await waitFor(q.lines, (ls) => ls.some((l) => l.event === "watch.heartbeat"), 15_000, "a heartbeat (stream alive)");
    child!.kill("SIGTERM");
    await expect(q.exited).resolves.toBe(0);
  }, 60_000);
});
