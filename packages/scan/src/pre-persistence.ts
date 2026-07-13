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
import { SecretDetectedError, type QuarantineSink, type SecretFinding } from "./types.js";

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

  /**
   * UNCONDITIONALLY quarantine `bytes` for a refusal ALREADY decided upstream — WITHOUT
   * re-scanning. Used when a subordinate scanner (the in-sandbox D15 scan) flagged a secret
   * but the trusted side cannot re-derive the exact offending bytes (the confined worker
   * omitted the payload): a valid non-empty quarantine artifact is still MANDATORY
   * (finding 7), so the trusted RAW snapshot is captured here. Skipping the re-scan is
   * deliberate — the raw bytes may be individually clean (a secret that only becomes
   * matchable AFTER normalization, e.g. entity-decoded HTML), so a re-scan would wave them
   * through; the sandbox verdict is the authority. The caller raises
   * {@link SecretDetectedError} after this resolves (quarantine-before-throw), so a
   * secret-bearing source lands in quarantine and never merely rejects.
   *
   * NON-EMPTY INVARIANT (round-2 finding): the artifact must ALWAYS be non-empty. If the
   * captured bytes are empty (an empty raw source PLUS an absent worker payload), quarantining
   * them would create an empty artifact despite the mandatory-artifact invariant — so we
   * substitute a deterministic non-empty sentinel that records the refusal. The enforcement
   * lives HERE (the single quarantine authority) so no caller can bypass it.
   */
  async quarantineRejection(a: {
    readonly bytes: Uint8Array;
    readonly origin: string;
    readonly findings?: readonly SecretFinding[];
  }): Promise<void> {
    const captured = a.bytes.length > 0 ? a.bytes.slice() : EMPTY_SOURCE_SENTINEL.slice();
    await this.sink.quarantine({ bytes: captured, origin: a.origin, findings: a.findings ?? [] });
  }
}

/**
 * Deterministic non-empty artifact quarantined when a scan-rejection has no offending bytes at
 * all (empty raw source + absent worker payload) — so the mandatory non-empty quarantine
 * invariant holds even in the degenerate empty-input case. Carries no origin/secret content.
 */
const EMPTY_SOURCE_SENTINEL = new TextEncoder().encode(
  "atlas: empty source quarantined on scan rejection (mandatory non-empty artifact)",
);
