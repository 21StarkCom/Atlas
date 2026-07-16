/**
 * `trust-command` (Task 4.8/4.9) — the promote/revoke execution + projection: a promote raises
 * trust (fail-closed default is untrusted); a non-raising promote is `not-a-promotion`; a revoke
 * suspends + drops to untrusted; a REFUSED ledger advance (forged/replayed authorization) leaves
 * the prior trust state intact (the projection is written only after the advance succeeds).
 */
import { describe, expect, it } from "vitest";
import { openStore, type Store } from "@atlas/sqlite-store";
import { registerWorkflowMigrations } from "../src/workflows/index.js";
import { promoteTrust, revokeTrust, readTrustState, TrustError, type TrustDeps, type TrustTarget } from "../src/trust/index.js";

const TARGET: TrustTarget = { rawContentHash: "a".repeat(64), canonicalMediaType: "text/plain" };
const NOW = () => "2026-07-16T00:00:00.000Z";

function store(): Store {
  const s = openStore({ path: ":memory:" });
  registerWorkflowMigrations(s);
  s.migrate();
  return s;
}

function deps(s: Store, advance: TrustDeps["advanceTrustLedger"]): TrustDeps {
  return { db: s.db, advanceTrustLedger: advance, now: NOW };
}

describe("trust promote/revoke (Task 4.8/4.9)", () => {
  it("promotes untrusted → trusted (fail-closed default is untrusted) and projects it", async () => {
    const s = store();
    try {
      expect(readTrustState(s.db, TARGET)).toEqual({ level: "untrusted", suspended: false });
      const next = await promoteTrust(TARGET, "trusted", "vetted origin", deps(s, async () => {}));
      expect(next).toEqual({ level: "trusted", suspended: false });
      expect(readTrustState(s.db, TARGET)).toEqual({ level: "trusted", suspended: false });
    } finally { s.close(); }
  });

  it("refuses a non-raising promote (not-a-promotion)", async () => {
    const s = store();
    try {
      await promoteTrust(TARGET, "trusted", "r", deps(s, async () => {}));
      await expect(promoteTrust(TARGET, "provisional", "r", deps(s, async () => {}))).rejects.toBeInstanceOf(TrustError);
    } finally { s.close(); }
  });

  it("revokes trust → untrusted + suspended; already-untrusted is refused", async () => {
    const s = store();
    try {
      await promoteTrust(TARGET, "trusted", "r", deps(s, async () => {}));
      const revoked = await revokeTrust(TARGET, "compromised", deps(s, async () => {}));
      expect(revoked).toEqual({ level: "untrusted", suspended: true });
      expect(readTrustState(s.db, TARGET)).toEqual({ level: "untrusted", suspended: true });
      // A fresh untrusted (unsuspended) source cannot be revoked.
      const other: TrustTarget = { rawContentHash: "b".repeat(64), canonicalMediaType: "text/plain" };
      await expect(revokeTrust(other, "x", deps(s, async () => {}))).rejects.toBeInstanceOf(TrustError);
    } finally { s.close(); }
  });

  it("a REFUSED ledger advance (forged/replayed authorization) leaves the prior state intact", async () => {
    const s = store();
    try {
      // The broker refuses the authorization → advance throws → projection must NOT change.
      const refusing: TrustDeps["advanceTrustLedger"] = async () => { throw Object.assign(new Error("forged"), { code: "authz.signature_invalid" }); };
      await expect(promoteTrust(TARGET, "trusted", "r", deps(s, refusing))).rejects.toThrow(/forged/);
      expect(readTrustState(s.db, TARGET)).toEqual({ level: "untrusted", suspended: false }); // unchanged, fail-closed
    } finally { s.close(); }
  });
});
