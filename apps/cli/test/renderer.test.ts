/**
 * terminal-renderer.safety — the release-blocking terminal-injection suite.
 *
 * Feeds the committed adversarial fixture (real control bytes) through the single
 * human-output path and asserts every injection vector is neutered while the two
 * whitelisted whitespace controls (tab, newline) survive.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, sanitize, type RenderOpts } from "../src/render/safe.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const FIXTURE = readFileSync(
  join(REPO_ROOT, "fixtures", "inputs", "adversarial-ansi.md"),
  "utf8",
);

/** Any byte that must never reach a terminal after sanitization. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN =
  /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩‎‏؜]/;

/** A capturing stream for assertions on the emitted bytes. */
function capture(): NodeJS.WritableStream & { text: string } {
  let text = "";
  return {
    text: "",
    write(chunk: string | Uint8Array): boolean {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      (this as { text: string }).text = text;
      return true;
    },
  } as NodeJS.WritableStream & { text: string };
}

describe("terminal-renderer.safety", () => {
  const clean = sanitize(FIXTURE);

  it("neuters every ANSI/CSI/OSC/C0/C1/CR/bidi control byte", () => {
    expect(FORBIDDEN.test(FIXTURE)).toBe(true); // fixture really contains the attacks
    expect(FORBIDDEN.test(clean)).toBe(false); // …and none survive
    expect(clean).not.toContain("\x1b");
    expect(clean).not.toContain("\r");
    expect(clean).not.toContain("\x9b");
  });

  it("strips the OSC-8 hyperlink target but keeps the inert visible label", () => {
    expect(clean).not.toContain("evil.example.com");
    expect(clean).not.toContain("]8;;");
    expect(clean).toContain("click-here");
  });

  it("strips the OSC-52 clipboard-write payload entirely", () => {
    expect(clean).not.toContain("]52;");
    expect(clean).not.toContain("ZXZpbC1jbGlwYm9hcmQ=");
  });

  it("removes CSI SGR colour codes, leaving the plain text", () => {
    expect(clean).toContain("RED");
    expect(clean).toContain("BOLD-GREEN");
    expect(clean).not.toContain("[31m");
    expect(clean).not.toContain("[0m");
  });

  it("neutralizes the CR-overwrite so the hidden text cannot mask the safe text", () => {
    // The fixture's `SAFE-TEXT\rHACKED` collapses to visible `SAFE-TEXTHACKED`,
    // with no CR to rewrite the line in place.
    expect(clean).toContain("SAFE-TEXT");
    expect(clean).not.toMatch(/SAFE-TEXT\r/);
  });

  it("removes bidi overrides (no RLO/PDF survive)", () => {
    expect(clean).not.toContain("‮");
    expect(clean).not.toContain("‬");
  });

  it("preserves tab and newline", () => {
    expect(clean).toContain("\t");
    expect(clean).toContain("\n");
  });

  it("render() writes the sanitized text and returns it", () => {
    const out = capture();
    const opts: Partial<RenderOpts> = { stream: out, newline: false };
    const returned = render(FIXTURE, opts);
    expect(returned).toBe(clean);
    expect(out.text).toBe(clean);
    expect(FORBIDDEN.test(out.text)).toBe(false);
  });

  it("suppresses human output in json mode", () => {
    const out = capture();
    render("hello", { mode: "json", stream: out });
    expect(out.text).toBe("");
  });

  it("suppresses output when quiet", () => {
    const out = capture();
    render("hello", { quiet: true, stream: out });
    expect(out.text).toBe("");
  });

  it("is idempotent (sanitizing twice changes nothing)", () => {
    expect(sanitize(clean)).toBe(clean);
  });
});
