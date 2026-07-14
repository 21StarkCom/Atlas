/**
 * `egress.socket-cancel.test` — IPC cancellation backed by a server-side
 * `AbortController` (D19). Proves two paths over a REAL Unix socket:
 *   - a `cancel` frame for an in-flight request id aborts its server-side
 *     controller, so the adapter's `transmit` sees `signal.aborted`;
 *   - a socket DISCONNECT aborts every in-flight request on that connection.
 */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import {
  EgressClient,
  EgressService,
  startEgressServer,
  mintEgressCapability,
  ProviderCallError,
  providerError,
  encodeFrame,
  type EgressServer,
  type ProviderAdapter,
  type Usage,
} from "../src/index.js";

const SECRET = randomBytes(32);
const MODEL = "gemini-3.5-flash";
const RUN = "01J9Z8Q0000000000000000000";

let server: EgressServer | undefined;
let root: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** An adapter whose `transmit` blocks until its signal aborts, then rejects `cancelled`. */
function blockingAdapter(onAbort: () => void): ProviderAdapter {
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/x", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: (_s, signal) =>
      new Promise((_res, rej) => {
        const abort = (): void => { onAbort(); rej(new ProviderCallError(providerError("cancelled", { message: "aborted" }))); };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
      }),
    parse: (_op, req) => ({ result: { text: "ok", usage: { inputTokens: 1 }, model: req.model }, usage: { inputTokens: 1 } as Usage, model: req.model }),
    costMicros: () => 0,
  };
}

function mkServer(onAbort: () => void): Promise<EgressServer> {
  root = mkdtempSync(join(tmpdir(), "atlas-egress-cancel-"));
  const svc = new EgressService({ adapter: blockingAdapter(onAbort), quarantine: { quarantine: () => Promise.resolve() }, capabilitySecret: SECRET });
  return startEgressServer(svc, join(root, "egress.sock"));
}

function cap(): ReturnType<typeof mintEgressCapability> {
  return mintEgressCapability(
    { runId: RUN },
    { operation: "generateText", model: MODEL, maxBytes: 100_000, maxTokens: 100_000, costCeiling: 100_000, allowedSensitivity: "restricted" },
    { secret: SECRET },
  );
}

describe("egress socket cancellation", () => {
  it("a cancel frame aborts the in-flight request server-side", async () => {
    let aborted = false;
    server = await mkServer(() => { aborted = true; });
    const client = await EgressClient.connect(server.socketPath);
    try {
      const ac = new AbortController();
      const p = client.invoke(
        { capability: cap(), body: { operation: "generateText", request: { model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 } }, declaredSensitivity: "internal" },
        ac.signal,
      );
      // Give the server a tick to enter transmit, then cancel.
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      const out = await p;
      expect(out.ok).toBe(false);
      if (!out.ok && "providerError" in out) expect(out.providerError.kind).toBe("cancelled");
      expect(aborted).toBe(true);
    } finally {
      client.close();
    }
  });

  it("cancels an invoke still QUEUED behind another call (finding #9)", async () => {
    // The first call blocks in transmit; the second is queued behind it. A cancel for
    // the QUEUED call must land even though its work has not started — the server now
    // registers the AbortController before queueing, so the cancel is not discarded.
    let aborts = 0;
    server = await mkServer(() => { aborts++; });
    const client = await EgressClient.connect(server.socketPath);
    try {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const params = { capability: cap(), body: { operation: "generateText", request: { model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 } }, declaredSensitivity: "internal" } as const;
      const p1 = client.invoke(params, ac1.signal); // blocks in transmit
      const p2 = client.invoke(params, ac2.signal); // queued behind p1
      await new Promise((r) => setTimeout(r, 50));
      // Cancel the QUEUED (not-yet-running) second call.
      ac2.abort();
      const out2 = await p2;
      expect(out2.ok).toBe(false);
      if (!out2.ok && "providerError" in out2) expect(out2.providerError.kind).toBe("cancelled");
      // Now release the first call and confirm it also cancelled cleanly.
      ac1.abort();
      const out1 = await p1;
      expect(out1.ok).toBe(false);
      expect(aborts).toBeGreaterThanOrEqual(1);
    } finally {
      client.close();
    }
  });

  it("a socket disconnect aborts every in-flight request", async () => {
    let aborted = false;
    server = await mkServer(() => { aborted = true; });
    // A raw client so we can hard-disconnect mid-flight.
    const raw = connect(server!.socketPath);
    await new Promise<void>((res) => raw.once("connect", () => res()));
    raw.write(
      encodeFrame({
        id: 1,
        method: "invoke",
        params: { capability: cap(), body: { operation: "generateText", request: { model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 } }, declaredSensitivity: "internal" },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    raw.destroy();
    // The server aborts the in-flight controller on disconnect.
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBe(true);
  });
});
