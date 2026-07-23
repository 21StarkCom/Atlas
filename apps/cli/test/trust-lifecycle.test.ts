/**
 * `trust-lifecycle` — the RESIDUAL fail-closed trust READ surface (v2 #334: the
 * lifecycle — promote/revoke, taint, remediation — is retired with the security
 * architecture; the read surface survives until the #339 source-registry rebase).
 */
import { describe, expect, it } from "vitest";
import { trustStateFor, isTrusted, DEFAULT_TRUST, type TrustState } from "../src/trust/index.js";

const trusted: TrustState = { level: "trusted", suspended: false };
const authoritative: TrustState = { level: "authoritative", suspended: false };
const provisional: TrustState = { level: "provisional", suspended: false };
const untrusted: TrustState = { level: "untrusted", suspended: false };

describe("trust state (fail-closed)", () => {
  it("an unknown/unprojected source is untrusted (never throws)", () => {
    expect(trustStateFor("sha256:x", () => null)).toEqual(DEFAULT_TRUST);
    expect(isTrusted(DEFAULT_TRUST)).toBe(false);
  });
  it("only non-suspended trusted/authoritative levels are trusted for grounding", () => {
    expect(isTrusted(trusted)).toBe(true);
    expect(isTrusted(authoritative)).toBe(true);
    expect(isTrusted(provisional)).toBe(false);
    expect(isTrusted(untrusted)).toBe(false);
    expect(isTrusted({ level: "trusted", suspended: true })).toBe(false); // a suspension drops trust
  });
});
