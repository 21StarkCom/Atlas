/**
 * `anchor-probe` (console watch SP-1, Phase 1 Task 1) — the typed, TOTAL broker
 * chain-status probe split from the synchronous verdict. Proves resolver
 * totality (transport errors, the RPC timeout, and unexpected throws all yield
 * `unreachable`; only a `broker.bad_request` refusal yields `protocol-error`; a
 * valid result yields `answered`), the `status`-preserving verdict (both
 * `unreachable` and `protocol-error` map to `sqlite-only`), and the drift guard
 * (the `protocol-error` case is pinned to a `BrokerRefusal` produced by
 * `@atlas/broker` itself, so a broker-side code rename fails this test rather
 * than silently reclassifying).
 */
import { describe, expect, it } from "vitest";
import { BrokerRefusal, validateRequest, badRequestRefusal, type AuditChainStatus } from "@atlas/broker";
import { openStore, type Store } from "@atlas/sqlite-store";
import {
  resolveAnchorProbe,
  deriveAnchorVerdict,
  type AnchorProbe,
  type AuditChainProbe,
} from "../src/audit/anchor-check.js";

/** A broker stub whose single read-only RPC is scripted per test. */
function stub(fn: () => Promise<AuditChainStatus>): AuditChainProbe {
  return { getAuditChainStatus: fn };
}

/** A synthetic Node `SystemError` carrying a transport `code`. */
function transport(code: string): Error & { code: string } {
  const e = new Error(`synthetic ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

const GOOD: AuditChainStatus = { ok: true, head: "a".repeat(40), count: 3 };

/**
 * Obtain a `broker.bad_request` refusal the way the BROKER produces one — drive the
 * package's own `validateRequest` with a malformed frame (params that fail the
 * `getAuditChainStatus` schema), then mint the refusal through the broker-owned
 * `badRequestRefusal` factory (the SAME factory the broker server uses). The CLI
 * test never writes the `"broker.bad_request"` literal, so a broker-side rename of
 * the code breaks this at the source rather than silently invalidating the premise.
 */
function brokerOwnedBadRequest(): BrokerRefusal {
  const parse = validateRequest({ id: 1, method: "getAuditChainStatus", params: 123 });
  if (parse.kind !== "bad") throw new Error("expected validateRequest to reject the malformed frame as bad");
  const refusal = badRequestRefusal(parse.message);
  // Sanity: it IS a broker.bad_request refusal (via the discriminant, not a literal).
  if (refusal.exitCode !== 5) throw new Error("unexpected exit code for the broker refusal");
  return refusal;
}

describe("resolveAnchorProbe — totality", () => {
  it("broker === null ⇒ unreachable", async () => {
    expect(await resolveAnchorProbe(null, {})).toEqual({ kind: "unreachable" });
  });

  it("a connection refusal ⇒ unreachable", async () => {
    const p = await resolveAnchorProbe(stub(() => Promise.reject(transport("ECONNREFUSED"))), {});
    expect(p.kind).toBe("unreachable");
  });

  it("a broker.bad_request refusal ⇒ protocol-error (detail = the code)", async () => {
    // The refusal is produced by the BROKER's own validation path (not a hand-built
    // literal) — the drift guard: a broker-side rename of the code fails HERE at the
    // source rather than silently degrading a protocol fault to unreachable.
    const refusal = brokerOwnedBadRequest();
    const p = await resolveAnchorProbe(stub(() => Promise.reject(refusal)), {});
    // Every field is derived from the broker-produced refusal — the `detail` is its
    // code and the `cause` its message (the legacy thrown-message the degraded reason
    // reproduces), never a copied literal.
    expect(p).toEqual({ kind: "protocol-error", detail: refusal.code, cause: refusal.message });
  });

  it("a never-resolving RPC ⇒ unreachable via the timeout", async () => {
    const p = await resolveAnchorProbe(
      stub(() => new Promise<AuditChainStatus>(() => {})), // never settles (ignored frame)
      { ATLAS_WATCH_PROBE_TIMEOUT_MS: "40" },
    );
    expect(p.kind).toBe("unreachable");
  });

  it("a valid AuditChainStatus ⇒ answered", async () => {
    const p = await resolveAnchorProbe(stub(() => Promise.resolve(GOOD)), {});
    expect(p).toEqual({ kind: "answered", status: GOOD });
  });

  it.each(["ECONNRESET", "EACCES", "ETIMEDOUT"])(
    "transport error %s ⇒ unreachable (socket-set totality)",
    async (code) => {
      const p = await resolveAnchorProbe(stub(() => Promise.reject(transport(code))), {});
      expect(p.kind).toBe("unreachable");
    },
  );

  it("an arbitrary unexpected exception ⇒ unreachable (resolver totality)", async () => {
    const p = await resolveAnchorProbe(stub(() => Promise.reject(new Error("kaboom"))), {});
    expect(p.kind).toBe("unreachable");
  });

  it("a non-broker.bad_request refusal ⇒ unreachable (only bad_request is protocol-error)", async () => {
    const p = await resolveAnchorProbe(stub(() => Promise.reject(new BrokerRefusal("broker.internal"))), {});
    expect(p.kind).toBe("unreachable");
  });
});

describe("deriveAnchorVerdict — status-preserving degradation", () => {
  let store: Store;
  const setup = (): void => {
    store = openStore({ path: ":memory:" });
    store.migrate();
  };
  const teardown = (): void => store.close();

  it("maps a null-broker unreachable to sqlite-only with the legacy 'broker unavailable' reason", () => {
    setup();
    try {
      // A `null`-broker unreachable carries NO cause ⇒ the pre-refactor reason string.
      const r = deriveAnchorVerdict(store.db, "/nonexistent/anchor", {}, { kind: "unreachable" });
      expect(r.source).toBe("sqlite-only");
      expect(r.detail).toContain("git ref unverified (broker unavailable)");
    } finally {
      teardown();
    }
  });

  it("maps a failed-RPC unreachable to sqlite-only, PRESERVING the thrown message (legacy parity)", () => {
    setup();
    try {
      // An unreachable from a failed RPC carries the thrown message on `cause`; the
      // degraded reason must reproduce the pre-refactor `broker RPC failed: <msg>`.
      const probe: AnchorProbe = { kind: "unreachable", cause: "synthetic ECONNRESET" };
      const r = deriveAnchorVerdict(store.db, "/nonexistent/anchor", {}, probe);
      expect(r.source).toBe("sqlite-only");
      expect(r.detail).toContain("git ref unverified (broker RPC failed: synthetic ECONNRESET)");
    } finally {
      teardown();
    }
  });

  it("maps protocol-error to sqlite-only, reproducing the legacy failed-RPC reason from the broker refusal", () => {
    setup();
    try {
      // Build the probe by RESOLVING an ACTUAL broker-produced refusal (not a literal),
      // so `detail`/`cause` come from the broker; a rename fails at the source.
      const refusal = brokerOwnedBadRequest();
      const probe: AnchorProbe = { kind: "protocol-error", detail: refusal.code, cause: refusal.message };
      const r = deriveAnchorVerdict(store.db, "/nonexistent/anchor", {}, probe);
      expect(r.source).toBe("sqlite-only");
      // Pre-refactor, a bad_request refusal was just a thrown RPC error → its message
      // flowed into `broker RPC failed: <message>`. That parity is preserved here.
      expect(r.detail).toContain(`git ref unverified (broker RPC failed: ${refusal.message})`);
    } finally {
      teardown();
    }
  });

  it("an answered probe yields a git-sourced verdict", () => {
    setup();
    try {
      // Empty ledger (count 0) + a GOOD status with count 0 agree; count 3 diverges.
      const empty: AuditChainStatus = { ok: true, head: "", count: 0 };
      const r = deriveAnchorVerdict(store.db, "/nonexistent/anchor", {}, { kind: "answered", status: empty });
      expect(r.source).toBe("git");
      expect(r.ok).toBe(true);
    } finally {
      teardown();
    }
  });

  it("the SQLite cross-check ignores ledger-internal events — an evidence retry raises no false alarm (#291)", () => {
    setup();
    try {
      // Two run events on the chain + one ledger-internal retry event (high seq
      // range, git_head NULL, never on the broker chain). Pre-#291 the cross-check
      // counted the retry event (`NOT LIKE 'db.%'`) ⇒ sqlite count 3 vs git count 2
      // ⇒ a FALSE truncation/divergence alarm after any `brain evidence retry`.
      const head = "b".repeat(40);
      const ins = store.db.prepare(
        `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
         VALUES (?, ?, ?, 'h', ?, '2026-07-20T00:00:00.000Z')`,
      );
      ins.run(0, "r1", "run.started", "a".repeat(40));
      ins.run(1, "r1", "run.integrated", head);
      ins.run(1_000_000_000_000, "retry", "evidence.retry_enqueued", null);

      const git: AuditChainStatus = { ok: true, head, count: 2 };
      const r = deriveAnchorVerdict(store.db, "/nonexistent/anchor", {}, { kind: "answered", status: git });
      expect(r.source).toBe("git");
      expect(r.ok, r.detail).toBe(true);
    } finally {
      teardown();
    }
  });
});
