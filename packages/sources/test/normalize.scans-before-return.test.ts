/**
 * `normalize.scans-before-return.test` (Task 2.4, fixes R4-F3) — `normalize` REQUIRES a
 * `PrePersistenceGuard` and scans RAW bytes before parse AND normalized output before
 * return, so a secret-bearing source yields NO rendition and its bytes land in
 * quarantine.
 *
 * Two proofs:
 *   1. RAW-scan catch — the committed adversarial `fixtures/inputs/secret-bearing.md`
 *      is caught on the pre-parse raw scan: `normalize` throws `SecretDetectedError`
 *      (exit 3), returns no rendition, and the injected quarantine sink captured the
 *      exact offending bytes (quarantine-before-throw).
 *   2. NORMALIZED-scan catch (the load-bearing case) — an HTML document whose only
 *      secret is a live AWS-key shape ENTITY-ENCODED (`&#65;…`) passes the raw scan
 *      (the entities match no rule) but becomes a matchable credential AFTER the HTML
 *      normalizer decodes the entities. The normalized-output scan catches it,
 *      quarantines it, and throws — so no rendition is ever produced. This proves the
 *      second scan is not redundant.
 *
 * The live-format secret is assembled at RUNTIME (never a committed literal) so neither
 * push protection nor this file contains a matchable credential.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { PrePersistenceGuard, SecretDetectedError, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import { normalize, selectBackend } from "../src/index.js";

/**
 * The RAW-scan proof runs everywhere (the secret is caught before the sandbox). The
 * NORMALIZED-scan proof parses inside the sandbox, so it needs a supported host; it
 * SKIPS on an unsupported host (loud on provisioned CI, mirroring `scan-before-persist`).
 */
const BACKEND = selectBackend();
const SANDBOX_SUPPORTED = BACKEND !== null && BACKEND.probe().every((c) => c.available);
const REQUIRE_SUPPORTED =
  process.env.ATLAS_SANDBOX_REQUIRE === "1" || (process.env.CI === "true" && platform() === "darwin");

const SECRET_MD = fileURLToPath(new URL("../../../fixtures/inputs/secret-bearing.md", import.meta.url));

/** A recording sink so the test can assert quarantine-before-throw + captured bytes. */
class RecordingSink implements QuarantineSink {
  readonly entries: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    // Copy the bytes: assert on exactly what was quarantined at call time.
    this.entries.push({ bytes: input.bytes.slice(), origin: input.origin, findings: input.findings });
    return Promise.resolve();
  }
}

describe("normalize scans before returning a rendition", () => {
  it("RAW scan: the adversarial secret-bearing.md yields NO rendition and is quarantined (exit 3)", async () => {
    const sink = new RecordingSink();
    const guard = new PrePersistenceGuard(sink);

    let thrown: unknown;
    let result: unknown;
    try {
      result = await normalize({ path: SECRET_MD, guard });
    } catch (e) {
      thrown = e;
    }

    // No rendition was produced …
    expect(result).toBeUndefined();
    // … the guard refused with the exit-3 secret error …
    expect(thrown).toBeInstanceOf(SecretDetectedError);
    expect((thrown as SecretDetectedError).exitCode).toBe(3);
    // … and the offending bytes were quarantined (before the throw).
    expect(sink.entries.length).toBeGreaterThanOrEqual(1);
    expect(sink.entries[0]!.origin).toBe(SECRET_MD);
    expect(sink.entries[0]!.findings.length).toBeGreaterThanOrEqual(1);
  });

  it("NORMALIZED scan: an entity-encoded secret is caught only AFTER extraction (no rendition, quarantined)", async () => {
    if (!SANDBOX_SUPPORTED) {
      if (REQUIRE_SUPPORTED) throw new Error("[scans-before-return] provisioned CI host must support the sandbox but does not");
      console.warn("[scans-before-return] SKIP normalized-scan proof: sandbox unsupported on this host");
      return;
    }
    // Live-format AWS access-key id, assembled at runtime — matches the scan ruleset.
    const secret = "AKIA" + "A".repeat(16);
    // Entity-encode every character so the RAW bytes contain no matchable token.
    const encoded = [...secret].map((c) => `&#${c.codePointAt(0)};`).join("");
    const html = `<!doctype html><html><body><p>key: ${encoded}</p></body></html>`;

    const tmp = mkdtempSync(join(tmpdir(), "atlas-scan-return-"));
    try {
      const path = join(tmp, "entity-secret.html");
      writeFileSync(path, html, "utf8");

      const sink = new RecordingSink();
      const guard = new PrePersistenceGuard(sink);

      let thrown: unknown;
      let result: unknown;
      try {
        result = await normalize({ path, guard });
      } catch (e) {
        thrown = e;
      }

      // The raw scan is clean (entities match no rule); the NORMALIZED scan catches it.
      expect(result).toBeUndefined();
      expect(thrown).toBeInstanceOf(SecretDetectedError);
      expect((thrown as SecretDetectedError).exitCode).toBe(3);
      // Exactly one quarantine — from the normalized-output boundary (raw was clean).
      expect(sink.entries.length).toBe(1);
      // The quarantined bytes are the DECODED normalized text (the entities resolved).
      const captured = new TextDecoder().decode(sink.entries[0]!.bytes);
      expect(captured).toContain(secret);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("NORMALIZED scan over 1 MiB: an entity-secret after >1 MiB of clean text is still quarantined (bounded window)", async () => {
    if (!SANDBOX_SUPPORTED) {
      if (REQUIRE_SUPPORTED) throw new Error("[scans-before-return] provisioned CI host must support the sandbox but does not");
      console.warn("[scans-before-return] SKIP >1MiB normalized-scan proof: sandbox unsupported on this host");
      return;
    }
    // Wing round-3 finding 5: a normalized dirty output larger than the control channel's
    // quarantine bound (1 MiB) previously OMITTED the payload, so `normalize` threw WITHOUT
    // quarantining anything. Now the worker ships a bounded window around the match, so the
    // secret still reaches quarantine even past 1 MiB.
    const secret = "AKIA" + "A".repeat(16); // live-format AWS access-key id, assembled at runtime
    // Entity-encode every character so the RAW bytes contain no matchable token.
    const encoded = [...secret].map((c) => `&#${c.codePointAt(0)};`).join("");
    // >1 MiB of raw-clean, low-entropy natural-language filler (no structural/entropy hit),
    // with the entity-encoded secret at the END so it only becomes matchable AFTER decode.
    const filler = "the quick brown fox jumps over the lazy dog. ".repeat(30_000); // ~1.35 MiB
    const html = `<!doctype html><html><body><p>${filler}</p><p>key: ${encoded}</p></body></html>`;

    const tmp = mkdtempSync(join(tmpdir(), "atlas-scan-return-big-"));
    try {
      const path = join(tmp, "entity-secret-large.html");
      writeFileSync(path, html, "utf8");

      const sink = new RecordingSink();
      const guard = new PrePersistenceGuard(sink);

      let thrown: unknown;
      let result: unknown;
      try {
        result = await normalize({ path, guard });
      } catch (e) {
        thrown = e;
      }

      // No rendition; the exit-3 secret refusal fired even though the output exceeds 1 MiB.
      expect(result).toBeUndefined();
      expect(thrown).toBeInstanceOf(SecretDetectedError);
      expect((thrown as SecretDetectedError).exitCode).toBe(3);
      // Exactly one quarantine — from the normalized-output boundary (raw was clean).
      expect(sink.entries.length).toBe(1);
      // The bounded window that was quarantined still contains the decoded secret.
      const captured = new TextDecoder().decode(sink.entries[0]!.bytes);
      expect(captured).toContain(secret);
      // And it is a BOUNDED window, not the whole >1 MiB output.
      expect(sink.entries[0]!.bytes.length).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
