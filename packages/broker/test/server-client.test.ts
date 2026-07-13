/**
 * `server-client.test` — the Unix-socket IPC seam (D10). Round-trips every
 * client method through the framed-JSON server against a real `BrokerService`,
 * and asserts refusals cross the seam as `BrokerRefusal` with their stable code.
 */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerClient, BrokerRefusal, startBrokerServer, type BrokerServer } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
let server: BrokerServer | undefined;
let client: BrokerClient | undefined;
let sockDir: string | undefined;

afterEach(async () => {
  client?.close();
  if (server) await server.close();
  if (sockDir) rmSync(sockDir, { recursive: true, force: true });
  h?.cleanup();
  server = undefined;
  client = undefined;
  sockDir = undefined;
});

async function connect(): Promise<{ client: BrokerClient }> {
  sockDir = mkdtempSync(join(tmpdir(), "atlas-sock-"));
  const socketPath = join(sockDir, "broker.sock");
  server = await startBrokerServer(h.service, socketPath);
  client = await BrokerClient.connect(socketPath);
  return { client };
}

describe("broker IPC round-trip", () => {
  it("appends an audit event over the socket", async () => {
    h = createHarness();
    const { client } = await connect();
    const res = await client.appendAuditEvent(h.signedAuditEvent(0));
    expect(res.seq).toBe(0);
    expect(h.ref("refs/audit/runs")).toBe(res.head);
  });

  it("advances a protected ref over the socket", async () => {
    h = createHarness();
    const { client } = await connect();
    const tip = h.ref("refs/heads/main");
    const child = h.commitChild(tip, { "notes/a.md": "hi\n" });
    const res = await client.advanceProtectedRef({
      ref: "refs/heads/main",
      expectedOld: tip,
      newCommit: child,
      manifest: {
        schemaVersion: 1,
        runId: "01J9Z8Q0000000000000000000",
        state: "integrated",
        createdAt: "2026-07-12T09:00:00.000Z",
        canonicalBaseCommit: "0".repeat(40),
        targets: ["notes/a"],
      },
      auditEvent: h.boundAuditEvent(0, "01J9Z8Q0000000000000000000", child),
    });
    expect(res.ok).toBe(true);
    expect(h.ref("refs/heads/main")).toBe(child);
  });

  it("mints a challenge over the socket", async () => {
    h = createHarness();
    const { client } = await connect();
    const ch = await client.mintChallenge({
      op: "git approve",
      canonicalBaseCommit: "b".repeat(40),
      intendedEffect: { kind: "integrate", tier: 1, changePlanDigest: "sha256:abcd" },
    });
    expect(ch.op).toBe("git approve");
    expect(ch.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("propagates a typed refusal across the seam", async () => {
    h = createHarness();
    const { client } = await connect();
    await client.appendAuditEvent(h.signedAuditEvent(5));
    const err = await client.appendAuditEvent(h.signedAuditEvent(2)).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("broker.audit_seq_nonmonotonic");
    expect((err as BrokerRefusal).exitCode).toBe(1);
  });
});
