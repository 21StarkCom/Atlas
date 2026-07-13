/**
 * `revision-round3.test` — round-3 wing findings.
 *
 *  - Finding 3: advanceProtectedRef binds the authorization to the op + intended
 *    effect of the requested ref mutation; a challenge for a DIFFERENT op/effect
 *    (same run/target/base) is refused (swapped-op / swapped-effect).
 *  - Finding 4: the WORM anchor detects a same-prefix-length rewrite followed by
 *    an append — a live chain LONGER than the anchor no longer passes on count.
 *  - Finding 5: the client rejects a malformed but correlatable success response
 *    for EVERY method rather than resolving a typed call with garbage.
 */
import { afterEach, describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntendedEffect } from "@atlas/contracts";
import {
  BrokerClient,
  BrokerRefusal,
  encodeFrame,
  type AuthorizedOp,
  type PrivilegedOpDescriptor,
} from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  h?.cleanup();
});

function manifest(runId = "01J9Z8Q0000000000000000000") {
  return {
    schemaVersion: 1 as const,
    runId,
    state: "integrated" as const,
    createdAt: "2026-07-12T09:00:00.000Z",
    canonicalBaseCommit: "0".repeat(40),
    targets: ["notes/x"],
  };
}

// ---------------------------------------------------------------------------
// Finding 3 — op + intendedEffect binding on advanceProtectedRef
// ---------------------------------------------------------------------------
describe("advanceProtectedRef op/effect binding (finding 3)", () => {
  const RUN = "01J9Z8Q0000000000000000000";
  const GOOD_EFFECT: IntendedEffect = { kind: "integrate", tier: 3, changePlanDigest: "sha256:aa" };

  /** Advance canonical → child, authorized by a challenge minted for `challengeOp`/`challengeEffect`. */
  async function attempt(
    challengeOp: string,
    challengeEffect: IntendedEffect,
    declared: AuthorizedOp,
  ) {
    const tip = h.ref("refs/heads/main");
    const child = h.commitChild(tip, { "notes/a.md": "x\n" });
    const opDesc: PrivilegedOpDescriptor = {
      op: challengeOp,
      runId: RUN,
      targetCommit: child,
      canonicalBaseCommit: tip,
      intendedEffect: challengeEffect,
    };
    const { response } = h.authorize(opDesc, "approver");
    return h.service.advanceProtectedRef({
      ref: "refs/heads/main",
      expectedOld: tip,
      newCommit: child,
      manifest: manifest(RUN),
      authorization: response as never,
      authorizedOp: declared,
      auditEvent: h.boundAuditEvent(0, RUN, child),
    });
  }

  it("accepts when the declared op + effect match the challenge", async () => {
    h = createHarness();
    const res = await attempt("git approve", GOOD_EFFECT, { op: "git approve", intendedEffect: GOOD_EFFECT });
    expect(res.ok).toBe(true);
  });

  it("refuses a challenge minted for a DIFFERENT op (swapped op)", async () => {
    h = createHarness();
    // Challenge is for "git refresh"; the mutation declares "git approve".
    await expect(
      attempt("git refresh", GOOD_EFFECT, { op: "git approve", intendedEffect: GOOD_EFFECT }),
    ).rejects.toMatchObject({ code: "authz.target_mismatch" });
    // The advance was refused during authorization — before any audit append.
    expect(() => h.ref("refs/audit/runs")).toThrow(); // audit ref never came into existence
  });

  it("refuses a challenge minted for a DIFFERENT effect (swapped effect)", async () => {
    h = createHarness();
    const otherEffect: IntendedEffect = { kind: "integrate", tier: 1, changePlanDigest: "sha256:aa" };
    await expect(
      attempt("git approve", otherEffect, { op: "git approve", intendedEffect: GOOD_EFFECT }),
    ).rejects.toMatchObject({ code: "authz.target_mismatch" });
  });

  it("requires authorizedOp whenever an authorization is supplied", async () => {
    h = createHarness();
    const tip = h.ref("refs/heads/main");
    const child = h.commitChild(tip, { "notes/a.md": "x\n" });
    const { response } = h.authorize(
      { op: "git approve", runId: RUN, targetCommit: child, canonicalBaseCommit: tip, intendedEffect: GOOD_EFFECT },
      "approver",
    );
    await expect(
      h.service.advanceProtectedRef({
        ref: "refs/heads/main",
        expectedOld: tip,
        newCommit: child,
        manifest: manifest(RUN),
        authorization: response as never,
        // authorizedOp intentionally omitted
        auditEvent: h.boundAuditEvent(0, RUN, child),
      }),
    ).rejects.toMatchObject({ code: "broker.bad_request" });
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — rewrite-then-append (live chain longer than the anchor)
// ---------------------------------------------------------------------------
describe("WORM anchor rewrite-then-append (finding 4)", () => {
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  function envelopeMessage(signed: ReturnType<Harness["signedAuditEvent"]>): string {
    return JSON.stringify({
      payload: signed.event,
      signature: "ed25519:" + Buffer.from(signed.signature).toString("base64url"),
      signerId: signed.signerId,
      canonicalization: "atlas-jcs-v1",
    });
  }

  it("detects an anchored-suffix rewrite even when a valid event is appended after it", async () => {
    h = createHarness();
    const r0 = await h.service.appendAuditEvent(h.signedAuditEvent(0));
    await h.service.appendAuditEvent(h.signedAuditEvent(1)); // anchored: count 2, head = r1

    // Rewrite position 2 (seq 1) to a DIFFERENT-but-valid event on r0 …
    const alt1 = h.signedAuditEvent(1, { prevAuditHead: r0.head });
    const altCommit = h.git(["commit-tree", EMPTY_TREE, "-p", r0.head, "-m", envelopeMessage(alt1)]);
    // … then APPEND one more valid event (seq 2) on top, so live count (3) > anchor (2).
    const ev2 = h.signedAuditEvent(2, { prevAuditHead: altCommit });
    const thirdCommit = h.git(["commit-tree", EMPTY_TREE, "-p", altCommit, "-m", envelopeMessage(ev2)]);
    h.git(["update-ref", "refs/audit/runs", thirdCommit]);
    expect(h.git(["rev-list", "--count", "refs/audit/runs"])).toBe("3"); // longer than the anchor

    const err = await h.newService().start().catch((e) => e);
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("broker.anchor_truncation");
  });

  it("starts cleanly when appends since the last anchor keep the anchored head in place", async () => {
    h = createHarness();
    await h.service.appendAuditEvent(h.signedAuditEvent(0));
    const r1 = await h.service.appendAuditEvent(h.signedAuditEvent(1)); // anchored count 2, head r1
    // Genuinely append a 3rd event on top of the real chain (anchor still at count 2).
    const ev2 = h.signedAuditEvent(2, { prevAuditHead: r1.head });
    const thirdCommit = h.git(["commit-tree", EMPTY_TREE, "-p", r1.head, "-m", envelopeMessage(ev2)]);
    h.git(["update-ref", "refs/audit/runs", thirdCommit]);
    // The anchored head r1 still sits at position 2 → legitimate; startup succeeds.
    await expect(h.newService().start()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — client rejects malformed success results per method
// ---------------------------------------------------------------------------
describe("client rejects malformed success responses (finding 5)", () => {
  /** A fake broker that answers EVERY request with `{id, ok:true, result}` (garbage). */
  async function fakeServer(result: unknown): Promise<{ socketPath: string }> {
    const dir = mkdtempSync(join(tmpdir(), "atlas-fake-"));
    const socketPath = join(dir, "broker.sock");
    const open = new Set<import("node:net").Socket>();
    const server: Server = createServer((socket) => {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
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
          socket.write(encodeFrame({ id: req.id, ok: true, result }));
        }
      });
    });
    await new Promise<void>((res) => server.listen(socketPath, res));
    cleanups.push(
      () =>
        new Promise<void>((res) => {
          for (const s of open) s.destroy(); // force-close so server.close() resolves
          server.close(() => res());
        }),
      () => rmSync(dir, { recursive: true, force: true }),
    );
    return { socketPath };
  }

  const OP: PrivilegedOpDescriptor = {
    op: "git approve",
    canonicalBaseCommit: "b".repeat(40),
    intendedEffect: { kind: "integrate", tier: 1, changePlanDigest: "sha256:aa" },
  };

  it("rejects a garbage success result for every method", async () => {
    h = createHarness();
    // A single garbage payload that fits NO method's result schema.
    const { socketPath } = await fakeServer({ nonsense: true });
    const client = await BrokerClient.connect(socketPath);
    cleanups.push(() => client.close());

    const ev = h.signedAuditEvent(0);
    const calls: Array<Promise<unknown>> = [
      client.appendAuditEvent(ev),
      client.advanceProtectedRef({
        ref: "refs/heads/main",
        expectedOld: "0".repeat(40),
        newCommit: "a".repeat(40),
        manifest: {
          schemaVersion: 1,
          runId: "01J9Z8Q0000000000000000000",
          state: "integrated",
          createdAt: "2026-07-12T09:00:00.000Z",
          canonicalBaseCommit: "0".repeat(40),
          targets: ["notes/x"],
        },
        auditEvent: ev,
      }),
      client.integrateSourceCapture({
        captureCommit: "a".repeat(40),
        expectedBase: "0".repeat(40),
        manifest: {
          schemaVersion: 1,
          runId: "01J9Z8Q0000000000000000000",
          state: "integrated",
          createdAt: "2026-07-12T09:00:00.000Z",
          canonicalBaseCommit: "0".repeat(40),
          targets: ["notes/x"],
        },
        auditEvent: ev,
      }),
      client.mintChallenge(OP),
      client.execAuthorized(OP, { schemaVersion: 1, challenge: {}, signature: "ed25519:x", signerId: "s" } as never),
    ];
    for (const call of calls) {
      const err = await call.catch((e) => e);
      expect(err).toBeInstanceOf(BrokerRefusal);
      expect((err as BrokerRefusal).code).toBe("broker.bad_request");
    }
  });

  it("does not resolve appendAuditEvent with an object missing `head`", async () => {
    h = createHarness();
    const { socketPath } = await fakeServer({ seq: 0 }); // missing `head`
    const client = await BrokerClient.connect(socketPath);
    cleanups.push(() => client.close());
    const err = await client.appendAuditEvent(h.signedAuditEvent(0)).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("broker.bad_request");
  });
});
