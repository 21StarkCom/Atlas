/**
 * `reverify-match` (Task 4.7) — unit tests for the DETERMINISTIC quote re-anchor matcher.
 *
 * The matcher is the missing piece the staleness protocol needs: given the exact quoted
 * span an evidence head recorded (recovered + hash-verified from its pinned rendition) and
 * the NEW rendition's normalized text, it decides one of the four `ReanchorMatch` classes
 * that {@link classifyReanchor} maps to a verification verdict. It must be a PURE function
 * of its inputs (no clock/RNG/locale/normalization drift) so the same bump always yields
 * the same verdict — and fail-closed: any uncertainty resolves to a non-`exact` verdict
 * (which routes to review/failed), never a fabricated auto-`valid`.
 */
import { describe, expect, it } from "vitest";
import { matchReanchor, parseLocatorStart } from "../src/workflows/reverify-match.js";

describe("matchReanchor (deterministic quote re-anchor)", () => {
  it("exact — a single occurrence at the same start offset re-anchors as exact", () => {
    expect(matchReanchor({ quote: "Meridian", previousStart: 0, newText: "Meridian rises." })).toBe("exact");
    expect(matchReanchor({ quote: "rises", previousStart: 9, newText: "Meridian rises." })).toBe("exact");
  });

  it("moved — a single occurrence at a DIFFERENT offset re-anchors as moved (never exact)", () => {
    // The quote survived the re-normalization but shifted position ⇒ needs review, not auto-valid.
    expect(matchReanchor({ quote: "rises", previousStart: 0, newText: "Meridian rises." })).toBe("moved");
  });

  it("moved — a single occurrence with an unverifiable previous offset is moved (fail-closed)", () => {
    // A locator scheme with no comparable char offset (page/dom) ⇒ we cannot PROVE the
    // position held, so we refuse to call it exact.
    expect(matchReanchor({ quote: "Meridian", previousStart: null, newText: "Meridian rises." })).toBe("moved");
  });

  it("ambiguous — multiple occurrences are ambiguous regardless of the old offset", () => {
    expect(matchReanchor({ quote: "ab", previousStart: 0, newText: "ab cd ab" })).toBe("ambiguous");
    // Overlap is counted non-overlapping, but two clearly-separate hits still ⇒ ambiguous.
    expect(matchReanchor({ quote: "na", previousStart: 2, newText: "banana banana" })).toBe("ambiguous");
  });

  it("not-found — the quote no longer exists in the new rendition", () => {
    expect(matchReanchor({ quote: "zephyr", previousStart: 0, newText: "Meridian rises." })).toBe("not-found");
  });

  it("not-found — an empty quote cannot be anchored (fail-closed, never exact)", () => {
    expect(matchReanchor({ quote: "", previousStart: 0, newText: "anything" })).toBe("not-found");
  });

  it("does NOT fuzzy-match — a whitespace/casing difference is not-found, not a soft exact", () => {
    // Matching is EXACT substring on the already-normalized text; a re-normalization that
    // collapsed a space is a genuine change the operator must see, so it fails closed.
    expect(matchReanchor({ quote: "hel lo", previousStart: 0, newText: "hello world" })).toBe("not-found");
    expect(matchReanchor({ quote: "Meridian", previousStart: 0, newText: "meridian rises." })).toBe("not-found");
  });

  it("is deterministic — repeated calls on identical inputs yield an identical verdict", () => {
    const input = { quote: "rises", previousStart: 9, newText: "Meridian rises. Meridian rises." };
    const first = matchReanchor(input);
    for (let i = 0; i < 50; i++) expect(matchReanchor(input)).toBe(first);
    expect(first).toBe("ambiguous"); // two occurrences ⇒ ambiguous, stably
  });
});

describe("parseLocatorStart (locator → comparable start offset)", () => {
  it("returns the integer start for the char/byte offset schemes", () => {
    expect(parseLocatorStart("char:0-5")).toBe(0);
    expect(parseLocatorStart("char:12-42")).toBe(12);
    expect(parseLocatorStart("byte:7-9")).toBe(7);
  });

  it("returns null for schemes with no comparable char offset", () => {
    expect(parseLocatorStart("page:1-2")).toBeNull(); // pdf-page-span
    expect(parseLocatorStart("dom:/html/body/p[1]")).toBeNull(); // dom-anchor
  });

  it("returns null for the absent-anchor sentinel and malformed locators", () => {
    expect(parseLocatorStart("(none)")).toBeNull();
    expect(parseLocatorStart("char:x-y")).toBeNull();
    expect(parseLocatorStart("char:")).toBeNull();
    expect(parseLocatorStart("")).toBeNull();
    expect(parseLocatorStart("char:-1-4")).toBeNull(); // negative start is not a valid offset
  });
});
