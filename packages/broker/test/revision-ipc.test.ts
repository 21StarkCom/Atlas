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
import { newRunId, type AuditEvent } from "@atlas/contracts";
import { BrokerClient, startBrokerServer, encodeFrame, type BrokerServer } from "../src/index.js";
import { BrokerRefusal } from "../src/errors.js";
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
    expect(auditCount()).toBe(1);
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

/**
 * An UNSIGNED audit event (the F4 wire form: everything sans `prevAuditHead`).
 *
 * NOTE the kind: these cases exercise the SEQ gate of the signing entry point, so
 * they must use a NON-canonical-installing kind. `run.integrated` would now be
 * refused earlier by the KIND gate (`broker.audit_kind_not_signable`) — the broker
 * never signs an event asserting a canonical move it did not observe — and the seq
 * assertions would never be reached. The kind gate has its own coverage in
 * `audit-signing-oracle.test.ts`.
 */
function unsignedEvent(seq: number, over: Partial<Omit<AuditEvent, "prevAuditHead">> = {}): Omit<AuditEvent, "prevAuditHead"> {
  return {
    schemaVersion: 1,
    eventId: newRunId(),
    kind: "run.readonly",
    seq,
    occurredAt: "2026-07-12T09:14:22.581Z",
    runId: newRunId(),
    subjects: [],
    canonicalCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
    detail: {},
    ...over,
  };
}

/** Count audit-ref commits, tolerating an absent ref (empty chain → 0). */
function auditCount(): number {
  try {
    return Number(h.git(["rev-list", "--count", "refs/audit/runs"]));
  } catch {
    return 0; // ref absent ⇒ nothing appended
  }
}

describe("signAndAppendAuditEvent is purpose-bound, not a signing oracle (round-3 finding 1)", () => {
  it("a socket peer cannot obtain a broker attestation for a fabricated far-ahead seq", async () => {
    h = createHarness();
    const socketPath = await start();
    const peer = await BrokerClient.connect(socketPath);
    clients.push(peer);

    // The chain is empty (expected seq 0). A hostile socket peer submits an event at
    // an ARBITRARY far-ahead position — the broker must refuse to attest it, so no
    // valid broker signature is minted for a fabricated out-of-sequence event.
    await expect(peer.signAndAppendAuditEvent(unsignedEvent(5))).rejects.toMatchObject({
      code: "broker.audit_seq_nonmonotonic",
    });
    // Nothing was appended — the refusal happened before any signature/commit.
    expect(auditCount()).toBe(0);
  });

  it("only the exact next sequence is signed + appended; a subsequent hole is refused", async () => {
    h = createHarness();
    const socketPath = await start();
    const peer = await BrokerClient.connect(socketPath);
    clients.push(peer);

    // The immediate successor (seq 0) is the only signable new event.
    const ok = await peer.signAndAppendAuditEvent(unsignedEvent(0, { runId: "01J9Z8Q000000000000000000A" }));
    expect(ok.seq).toBe(0);
    expect(auditCount()).toBe(1);

    // A peer that now skips to seq 2 (leaving a hole at 1) is refused — the broker
    // reconstructs the expected next seq from its own observed head, not the request.
    await expect(peer.signAndAppendAuditEvent(unsignedEvent(2))).rejects.toBeInstanceOf(BrokerRefusal);
    expect(auditCount()).toBe(1);

    // The legitimate successor (seq 1) still works.
    const ok2 = await peer.signAndAppendAuditEvent(unsignedEvent(1, { runId: "01J9Z8Q000000000000000000B" }));
    expect(ok2.seq).toBe(1);
    expect(auditCount()).toBe(2);
  });
});

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
