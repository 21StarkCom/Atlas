/**
 * `PrePersistenceGuard` — the first enforcement point of the scan-before-persist
 * safety spine. `normalize` (2.4) and `captureSource` (2.6) require one as a
 * constructor dependency and call {@link PrePersistenceGuard.assertClean} on raw
 * source bytes AND on the normalized output before either can persist or transmit
 * — so no raw or normalized byte is ever written unscanned (fixes R4-F3).
 *
 * On a hit the guard quarantines the offending bytes THROUGH the injected
 * {@link QuarantineSink} (AEAD, ciphertext-only, CLI-side) and only THEN throws
 * {@link SecretDetectedError} (exit 3 at the CLI boundary). Quarantine-before-throw
 * is deliberate: the untrusted bytes are captured before the abort unwinds, and
 * nothing reaches the real sink.
 */
import { scanBytes } from "./engine.js";
import { SecretDetectedError, type QuarantineSink } from "./types.js";

export class PrePersistenceGuard {
  /** @param sink the CLI-side quarantine store (structural — the leaf never imports it). */
  constructor(private readonly sink: QuarantineSink) {}

  /**
   * Scan `bytes`; if clean, return. If a secret is detected, quarantine the bytes
   * and throw {@link SecretDetectedError}. `origin` is an opaque, non-secret label
   * (path / contentId); `kind` distinguishes the raw source bytes from the
   * normalized output.
   */
  async assertClean(a: {
    readonly bytes: Uint8Array;
    readonly origin: string;
    readonly kind?: "raw" | "normalized";
  }): Promise<void> {
    // Snapshot the caller-owned buffer AT ENTRY. The scan is synchronous but the
    // quarantine sink is async, so without a copy a concurrent mutation of the
    // caller's `Uint8Array` could make the quarantined bytes differ from the bytes
    // that were actually scanned — the exact content that flagged the refusal must
    // be what lands in quarantine. `.slice()` returns an independent copy.
    const snapshot = a.bytes.slice();
    const verdict = scanBytes({
      bytes: snapshot,
      context: { origin: a.origin, boundary: "pre-persistence", kind: a.kind ?? "raw" },
    });
    if (verdict.clean) return;
    await this.sink.quarantine({ bytes: snapshot, origin: a.origin, findings: verdict.findings });
    throw new SecretDetectedError(a.origin, verdict.findings, "pre-persistence");
  }
}
