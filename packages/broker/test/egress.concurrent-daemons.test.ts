/**
 * `egress.concurrent-daemons.test` (D19, finding #3) — two defences against a
 * budget bypass via CONCURRENT daemons:
 *
 *   1. **Live-socket refusal.** Startup used to UNCONDITIONALLY unlink an existing
 *      socket, so a second daemon could bind and run with an INDEPENDENT in-memory
 *      tally. `startEgressServer` now REFUSES a live socket (and reclaims only a
 *      stale one).
 *   2. **Cross-process budget CAS.** Two `EgressService`s sharing ONE persistent
 *      `FileBudgetStore` reserve through a transactional (locked, re-read) update, so
 *      their COMBINED reservations honour a SINGLE run ceiling — they cannot both
 *      reserve from a stale total and jointly overrun it.
 */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { QuarantineSink } from "@atlas/scan";
import {
  EgressService,
  FileBudgetStore,
  startEgressServer,
  mintEgressCapability,
  EgressClient,
  type EgressServer,
  type ProviderAdapter,
  type EgressCapability,
  type GenerateTextRequest,
  type Usage,
} from "../src/index.js";

const SECRET = randomBytes(32);
const MODEL = "gemini-3.5-flash";
const RUN = "01J9Z8Q0000000000000000000";

let root: string | undefined;
const servers: EgressServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A fake adapter whose projected + actual cost is a FIXED 100 micro-USD per call. */
function fixedCostAdapter(): ProviderAdapter {
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: () => Promise.resolve({ rawResponse: Buffer.from(JSON.stringify({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }), "utf8"), retries: 0 }),
    parse: (_op, req, raw) => {
      const json = JSON.parse(Buffer.from(raw).toString("utf8")) as { usage?: Usage };
      const usage: Usage = json.usage ?? { inputTokens: 1, outputTokens: 1 };
      return { result: { text: "ok", usage, model: req.model }, usage, model: req.model };
    },
    costMicros: () => 100, // fixed projected AND actual cost per call
  };
}

function memSink(): QuarantineSink {
  return { quarantine: () => Promise.resolve() };
}

const textReq = (input = "hello"): GenerateTextRequest => ({ model: MODEL, prompt: { ref: "prompts/extract@1" }, input, maxTokens: 8 });

/** A capability with a cost ceiling that fits EXACTLY three 100-micro calls. */
function cap(): EgressCapability {
  return mintEgressCapability(
    { runId: RUN },
    { operation: "generateText", model: MODEL, maxBytes: 10_000_000, maxTokens: 10_000_000, costCeiling: 300, allowedSensitivity: "confidential" },
    { secret: SECRET },
  );
}

describe("egress concurrent-daemon budget ceiling (D19, finding #3)", () => {
  it("two daemons sharing ONE budget store cannot jointly exceed the run cost ceiling", async () => {
    root = mkdtempSync(join(tmpdir(), "atlas-egress-2daemon-"));
    const statePath = join(root, "budget-state.json");
    // Two INDEPENDENT services (two "daemons") over the SAME persistent store.
    const mk = (): EgressService =>
      new EgressService({ adapter: fixedCostAdapter(), quarantine: memSink(), capabilitySecret: SECRET, budgetStore: new FileBudgetStore(statePath) });
    const a = mk();
    const b = mk();

    // Drive five calls alternating between the two daemons. Only 300/100 = 3 may pass.
    const services = [a, b, a, b, a];
    const outcomes = [];
    for (const svc of services) {
      outcomes.push(await svc.invoke({ capability: cap(), body: { operation: "generateText", request: textReq() }, declaredSensitivity: "internal" }));
    }
    const succeeded = outcomes.filter((o) => o.ok).length;
    const costRefused = outcomes.filter((o) => !o.ok && !o.providerError && o.refusal.code === "egress.cost_budget_exceeded").length;
    expect(succeeded).toBe(3); // exactly the ceiling — not 5, not 6
    expect(costRefused).toBe(2);

    // The SHARED (authoritative) on-disk tally is capped at the ceiling — neither
    // daemon reserved from a stale total. A per-daemon in-memory view may lag its
    // peer, but the persistent CAS state is the boundary that actually gates spend.
    const persisted = new FileBudgetStore(statePath).load()[RUN];
    expect(persisted?.costMicros).toBe(300);
    expect(persisted?.costMicros).toBeLessThanOrEqual(300);
  });
});

describe("egress live-socket refusal (D19, finding #3)", () => {
  it("REFUSES to start a second daemon over a LIVE socket", async () => {
    root = mkdtempSync(join(tmpdir(), "atlas-egress-live-"));
    const sockPath = join(root, "egress.sock");
    const svc = new EgressService({ adapter: fixedCostAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    servers.push(await startEgressServer(svc, sockPath));
    // A first client proves the socket is live.
    const client = await EgressClient.connect(sockPath);
    client.close();
    // A second daemon on the same live socket must be refused (not silently unlink it).
    await expect(startEgressServer(svc, sockPath)).rejects.toThrow(/live egress daemon is already listening/);
  });

  it("RECLAIMS a stale socket file (no live listener)", async () => {
    root = mkdtempSync(join(tmpdir(), "atlas-egress-stale-"));
    const sockPath = join(root, "egress.sock");
    // A leftover regular file at the socket path — not a live listener.
    writeFileSync(sockPath, "stale");
    const svc = new EgressService({ adapter: fixedCostAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const server = await startEgressServer(svc, sockPath); // reclaims the stale path
    servers.push(server);
    const client = await EgressClient.connect(sockPath);
    client.close();
  });
});
