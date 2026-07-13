/**
 * `contracts.provider-errors.test` — the ProviderError discriminated-union
 * contract (Task 2.0, fixes R3-F1). The schema was a flat permissive object; it
 * is now a discriminated union over `kind` with per-kind retryability, a
 * `partial_batch`-only `succeededIndices`, and `retryAfter` restricted to the two
 * kinds that propagate a provider `Retry-After`. These negative tests pin those
 * invariants so a regression to the permissive shape fails loudly.
 */
import { describe, expect, it } from "vitest";
import { ProviderErrorSchema, PROVIDER_ERROR_KINDS } from "../src/index.js";

describe("ProviderErrorSchema — accepts every well-formed variant", () => {
  const valid = [
    { kind: "validation", retryable: false, message: "bad output" },
    { kind: "authentication", retryable: false },
    { kind: "quota", retryable: true, retryAfter: 60000 },
    { kind: "rate_limit", retryable: true, retryAfter: 2000 },
    { kind: "timeout", retryable: true },
    { kind: "transport", retryable: true },
    { kind: "cancelled", retryable: false },
    { kind: "partial_batch", retryable: true, succeededIndices: [0, 1, 3] },
    { kind: "model_incompatible", retryable: false },
  ];

  for (const v of valid) {
    it(`accepts ${v.kind}`, () => {
      expect(() => ProviderErrorSchema.parse(v)).not.toThrow();
    });
  }

  it("covers every declared kind", () => {
    expect(valid.map((v) => v.kind).sort()).toEqual([...PROVIDER_ERROR_KINDS].sort());
  });
});

describe("ProviderErrorSchema — rejects malformed variants (R3-F1)", () => {
  it("rejects partial_batch WITHOUT succeededIndices", () => {
    expect(() => ProviderErrorSchema.parse({ kind: "partial_batch", retryable: true })).toThrow();
  });

  it("rejects succeededIndices on a non-partial_batch kind", () => {
    expect(() =>
      ProviderErrorSchema.parse({ kind: "timeout", retryable: true, succeededIndices: [0] }),
    ).toThrow();
  });

  it("rejects an invalid retryability combination (authentication must be retryable:false)", () => {
    expect(() => ProviderErrorSchema.parse({ kind: "authentication", retryable: true })).toThrow();
  });

  it("rejects an invalid retryability combination (rate_limit must be retryable:true)", () => {
    expect(() => ProviderErrorSchema.parse({ kind: "rate_limit", retryable: false })).toThrow();
  });

  it("rejects validation with retryable:true", () => {
    expect(() => ProviderErrorSchema.parse({ kind: "validation", retryable: true })).toThrow();
  });

  it("rejects retryAfter on a kind that does not propagate Retry-After (timeout)", () => {
    expect(() =>
      ProviderErrorSchema.parse({ kind: "timeout", retryable: true, retryAfter: 1000 }),
    ).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => ProviderErrorSchema.parse({ kind: "explosion", retryable: false })).toThrow();
  });

  it("rejects a stray field (strict members)", () => {
    expect(() =>
      ProviderErrorSchema.parse({ kind: "timeout", retryable: true, stowaway: true }),
    ).toThrow();
  });

  it("rejects a negative retryAfter", () => {
    expect(() =>
      ProviderErrorSchema.parse({ kind: "quota", retryable: true, retryAfter: -1 }),
    ).toThrow();
  });
});
