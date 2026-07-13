import { describe, it, expect } from "vitest";
import {
  normalizeIdentityKey,
  IDENTITY_KEY_ALGORITHM_ID,
  IDENTITY_KEY_VECTORS,
} from "../src/identity.js";

describe("atlas-identity-key-v1", () => {
  it("has a stable versioned algorithm id", () => {
    expect(IDENTITY_KEY_ALGORITHM_ID).toBe("atlas-identity-key-v1");
  });

  it("reproduces every conformance vector exactly", () => {
    for (const v of IDENTITY_KEY_VECTORS) {
      expect(normalizeIdentityKey(v.input), v.note).toBe(v.expected);
    }
  });

  it("is idempotent (folding a folded key is a no-op)", () => {
    for (const v of IDENTITY_KEY_VECTORS) {
      expect(normalizeIdentityKey(v.expected)).toBe(v.expected);
    }
  });

  it("performs full case folding beyond simple toLowerCase()", () => {
    // These are the cases plain `.toLowerCase()` would get wrong.
    expect(normalizeIdentityKey("Straße")).toBe(normalizeIdentityKey("strasse"));
    expect(normalizeIdentityKey("ΣΟΦΟΣ")).toBe(normalizeIdentityKey("Σοφος"));
  });

  it("expands non-simple multi-code-point full folds (ligatures)", () => {
    // toLowerCase leaves these ligatures intact; full folding must expand them.
    expect(normalizeIdentityKey("oﬀice")).toBe("office");
    expect(normalizeIdentityKey("ﬁle")).toBe("file");
    expect(normalizeIdentityKey("eﬃcient")).toBe("efficient");
    expect(normalizeIdentityKey("waﬄe")).toBe("waffle");
    // A ligature and its spelled-out form fold to the same identity key.
    expect(normalizeIdentityKey("eﬀ")).toBe(normalizeIdentityKey("eff"));
    // Armenian ligature (caseless) expands to its two component letters.
    expect(normalizeIdentityKey("և")).toBe("եւ");
  });

  it("is rune-safe on caseless scripts (no surrogate/mark mangling)", () => {
    expect([...normalizeIdentityKey("אריה")].length).toBe(4);
    expect(normalizeIdentityKey("אריה  שטארק")).toBe("אריה שטארק");
  });
});
