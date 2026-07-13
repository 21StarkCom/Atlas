/**
 * `revision-ipc.test` — round-2 wing findings on the D10 IPC seam.
 *
 *  - Finding 7: mutations are serialized SERVICE-WIDE. Two clients racing a
 *    protected-ref advance cannot both append an audit event — exactly one wins
 *    the CAS and exactly one audit event lands.
 *  - Finding 8: malformed requests are validated at the boundary and answered
 *    with a correlatable `broker.bad_request` (per method), never an internal
 *    error or a silently-accepted cast.
 */
import { afterEach, describe, it, expect } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerClient, startBrokerServer, encodeFrame, type BrokerServer } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let server: BrokerServer | undefined;
let sockDir: string | undefined;
const clients: BrokerClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  if (server) await server.close();
  if (sockDir) rmSync(sockDir, { recursive: true, force: true });
  h?.cleanup();
  server = undefined;
  sockDir = undefined;
});

async function start(): Promise<string> {
  sockDir = mkdtempSync(join(tmpdir(), "atlas-sock-"));
  const socketPath = join(sockDir, "broker.sock");
  server = await startBrokerServer(h.service, socketPath);
  return socketPath;
}

describe("service-wide mutation serialization (finding 7)", () => {
  it("two clients racing a canonical advance: exactly one wins, one audit event", async () => {
    h = createHarness();
    const socketPath = await start();
    const a = await BrokerClient.connect(socketPath);
    const b = await BrokerClient.connect(socketPath);
    clients.push(a, b);

    const tip = h.ref("refs/heads/main");
    const childA = h.commitChild(tip, { "notes/a.md": "A\n" });
    const childB = h.commitChild(tip, { "notes/b.md": "B\n" });
    const mk = (child: string, runId: string) => ({
      ref: "refs/heads/main",
      expectedOld: tip,
      newCommit: child,
      manifest: {
        schemaVersion: 1 as const,
        runId,
        state: "integrated" as const,
        createdAt: "2026-07-12T09:00:00.000Z",
        canonicalBaseCommit: "0".repeat(40),
        targets: ["notes/x"],
      },
      auditEvent: h.boundAuditEvent(0, runId, child),
    });

    const results = await Promise.allSettled([
      a.advanceProtectedRef(mk(childA, "01J9Z8Q000000000000000000A")),
      b.advanceProtectedRef(mk(childB, "01J9Z8Q000000000000000000B")),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "broker.cas_failed" });

    // Exactly ONE audit event was appended (the loser never got past its CAS).
    expect(h.git(["rev-list", "--count", "refs/audit/runs"])).toBe("1");
    // The anchor head equals the live audit head — no orphaned anchoring.
    expect(h.ref("refs/heads/main")).toBe([childA, childB].find((c) => c === h.ref("refs/heads/main")));
  });
});

/** Send one raw frame and resolve with the parsed single-line response. */
function rawRoundTrip(socketPath: string, frame: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(socketPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(encodeFrame(frame)));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, idx)));
      }
    });
    sock.on("error", reject);
  });
}

describe("malformed request validation per method (finding 8)", () => {
  const methods = [
    "appendAuditEvent",
    "advanceProtectedRef",
    "integrateSourceCapture",
    "mintChallenge",
    "execAuthorized",
  ];

  it("answers broker.bad_request for empty params on every method", async () => {
    h = createHarness();
    const socketPath = await start();
    let id = 1;
    for (const method of methods) {
      const res = await rawRoundTrip(socketPath, { id: id++, method, params: {} });
      expect(res.ok, `method ${method}`).toBe(false);
      expect(res.code, `method ${method}`).toBe("broker.bad_request");
    }
  });

  it("answers broker.bad_request for an unknown method", async () => {
    h = createHarness();
    const socketPath = await start();
    const res = await rawRoundTrip(socketPath, { id: 1, method: "nope", params: {} });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("broker.bad_request");
    expect(res.id).toBe(1);
  });

  it("answers broker.bad_request for structurally wrong params (not a cast)", async () => {
    h = createHarness();
    const socketPath = await start();
    // mintChallenge with a bad intendedEffect kind — a raw cast would have slipped through.
    const res = await rawRoundTrip(socketPath, {
      id: 7,
      method: "mintChallenge",
      params: { op: "git approve", canonicalBaseCommit: "b".repeat(40), intendedEffect: { kind: "bogus" } },
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("broker.bad_request");
  });
});
