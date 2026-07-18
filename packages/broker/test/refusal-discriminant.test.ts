/**
 * `refusal-discriminant` (Phase 1 Task 3a) — pins `isBadRequestRefusal` to the
 * broker's OWN thrown `broker.bad_request` refusal. The CLI's anchor probe
 * consumes this discriminant so the `"broker.bad_request"` code literal never
 * leaves `@atlas/broker`; a broker-side rename fails this test rather than
 * silently reclassifying a protocol fault as unreachable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerClient, BrokerRefusal, isBadRequestRefusal, badRequestRefusal } from "../src/index.js";

describe("isBadRequestRefusal", () => {
  it("is true for a refusal produced by the broker's own factory", () => {
    // Drift guard: construct through `badRequestRefusal` — the SINGLE broker-owned
    // producer of this code — NOT a hand-built literal. A broker-side rename of the
    // code inside `badRequestRefusal` then fails BOTH producer and discriminant
    // together (they can never disagree), instead of a copied literal masking it.
    const refusal = badRequestRefusal("invalid params for getAuditChainStatus");
    expect(isBadRequestRefusal(refusal)).toBe(true);
    expect(refusal).toBeInstanceOf(BrokerRefusal);
  });

  it("narrows the type to BrokerRefusal and exposes the producer's own code", () => {
    const err: unknown = badRequestRefusal("malformed request");
    if (isBadRequestRefusal(err)) {
      // Type-level assertion: `err` is a BrokerRefusal here (code is accessible).
      // The code is READ OFF the broker-produced refusal, not asserted against a
      // copied literal — so the pin tracks the producer, not a duplicate.
      expect(err.code).toBe(badRequestRefusal("x").code);
      expect(err.exitCode).toBe(5);
    } else {
      throw new Error("expected the discriminant to match");
    }
  });

  it("is false for a different broker refusal code", () => {
    expect(isBadRequestRefusal(new BrokerRefusal("broker.internal"))).toBe(false);
    expect(isBadRequestRefusal(new BrokerRefusal("broker.cas_failed"))).toBe(false);
  });

  it("is false for a non-refusal error", () => {
    const looksLike = new Error("nope") as Error & { code: string };
    looksLike.code = "broker.bad_request"; // same code, wrong class — must NOT match
    expect(isBadRequestRefusal(looksLike)).toBe(false);
    expect(isBadRequestRefusal(new Error("boom"))).toBe(false);
  });

  it("is false for non-error values", () => {
    expect(isBadRequestRefusal(undefined)).toBe(false);
    expect(isBadRequestRefusal(null)).toBe(false);
    expect(isBadRequestRefusal({ code: "broker.bad_request" })).toBe(false);
  });
});

/**
 * The REAL anchor-RPC path (round-4 finding 2): a live {@link BrokerClient}
 * receiving a correlatable `ok:true` frame whose `result` is malformed for the
 * method it sent must reject with the broker-OWNED `broker.bad_request` refusal —
 * the exact drift anchor `isBadRequestRefusal` pins. This exercises
 * `BrokerClient.onData`'s malformed-SUCCESS branch (not the server malformed-request
 * path), so a broker-side rename of the code would fail HERE, catching the real
 * anchor-probe mis-classification the discriminant guards against.
 */
describe("BrokerClient malformed-success path routes through the broker-owned refusal", () => {
  let server: Server | undefined;
  let dir: string | undefined;
  let client: BrokerClient | undefined;
  const conns = new Set<import("node:net").Socket>();

  afterEach(async () => {
    client?.close();
    client = undefined;
    for (const s of conns) s.destroy();
    conns.clear();
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("rejects a malformed getAuditChainStatus success with isBadRequestRefusal", async () => {
    dir = mkdtempSync(join(tmpdir(), "atlas-broker-refusal-"));
    const socketPath = join(dir, "broker.sock");

    // A stub daemon that replies to any request with a correlatable ok:true frame
    // carrying a result that does NOT satisfy the getAuditChainStatus schema
    // (missing head/count) — forcing the client's validateResult → null branch.
    server = createServer((socket) => {
      conns.add(socket);
      socket.on("close", () => conns.delete(socket));
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim().length === 0) continue;
          const req = JSON.parse(line) as { id: number };
          socket.write(JSON.stringify({ id: req.id, ok: true, result: { bogus: 1 } }) + "\n");
        }
      });
    });
    await new Promise<void>((res) => server!.listen(socketPath, res));

    client = await BrokerClient.connect(socketPath);
    let caught: unknown;
    try {
      await client.getAuditChainStatus();
    } catch (e) {
      caught = e;
    }
    expect(isBadRequestRefusal(caught)).toBe(true);
    expect(caught).toBeInstanceOf(BrokerRefusal);
    expect((caught as BrokerRefusal).code).toBe(badRequestRefusal("x").code);
  });
});
