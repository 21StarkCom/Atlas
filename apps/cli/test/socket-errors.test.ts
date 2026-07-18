/**
 * `socket-errors` (Phase 1 Task 3a) — the single shared transport-error
 * classifier both the anchor probe and the daemon probe consume. Pins the full
 * connect-failure code matrix, the arbitrary-error negative, and the
 * `AggregateError`-unwrapping Node may apply to connect errors.
 */
import { describe, expect, it } from "vitest";
import { isTransportError } from "../src/health/socket-errors.js";

/** A synthetic Node `SystemError` carrying a `code`. */
function sysError(code: string): Error & { code: string } {
  const e = new Error(`synthetic ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

describe("isTransportError", () => {
  const TRANSPORT = ["ECONNREFUSED", "ENOENT", "EPIPE", "ECONNRESET", "EACCES", "ETIMEDOUT"] as const;

  for (const code of TRANSPORT) {
    it(`classifies ${code} as a transport error`, () => {
      expect(isTransportError(sysError(code))).toBe(true);
    });
  }

  it("returns false for an arbitrary error with no transport code", () => {
    expect(isTransportError(new Error("boom"))).toBe(false);
    expect(isTransportError(sysError("EACCES_NOPE"))).toBe(false);
    expect(isTransportError(sysError("SQLITE_BUSY"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isTransportError(undefined)).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError("ECONNREFUSED")).toBe(false);
    expect(isTransportError(42)).toBe(false);
    expect(isTransportError({})).toBe(false);
  });

  it("unwraps an AggregateError wrapping a transport code", () => {
    const agg = new AggregateError([new Error("first"), sysError("ECONNREFUSED")], "all attempts failed");
    expect(isTransportError(agg)).toBe(true);
  });

  it("returns false for an AggregateError wrapping only non-transport errors", () => {
    const agg = new AggregateError([new Error("a"), sysError("SQLITE_BUSY")], "all failed");
    expect(isTransportError(agg)).toBe(false);
  });
});
