/**
 * In-broker payload scan (INVARIANT 2, as amended by ADR-0001). The egress broker
 * scans every transmission with the `@atlas/scan` engine, per direction:
 *   - **request** — the EXACT serialized HTTP bytes, before dispatch (a secret
 *     planted in a prompt is caught before it leaves the host);
 *   - **response (final 2xx)** — the canonical serialization of the RELEASED
 *     result, i.e. exactly the bytes that re-enter the host (ADR-0001: provider
 *     envelope fields the adapter discards — Gemini's `thoughtSignature` — never
 *     leave the broker and are not scanned; a secret echoed in the generated
 *     text/object is in the released bytes by definition);
 *   - **error / intermediate-retry bodies** — raw, via the transmit hook (they
 *     are never parsed, so raw is their only form).
 * On a dirty verdict the offending bytes are quarantined (ciphertext-only,
 * CLI-side sink) and the transmission refused. The engine runs the same
 * deterministic versioned ruleset every other boundary uses (D15).
 */
import { scanBytes, type QuarantineSink, type ScanVerdict, type SecretFinding } from "@atlas/scan";
import { EgressRefusal } from "./errors.js";

/** Which direction a scan fired on (diagnostic + the refusal detail). */
export type ScanDirection = "request" | "response";

/**
 * Scan the exact serialized `payload` bytes. On a dirty verdict the bytes are
 * quarantined under `origin` and an {@link EgressRefusal} `egress.secret_detected`
 * is thrown carrying ONLY non-secret finding metadata (rule ids). The caller
 * (server) has already built a refusal receipt so the CLI still writes a
 * `model_calls` row for the blocked transmission (D6).
 */
export async function scanEgressPayload(
  payload: Uint8Array,
  direction: ScanDirection,
  origin: string,
  quarantine: QuarantineSink,
): Promise<void> {
  const verdict: ScanVerdict = scanBytes({
    bytes: payload,
    // The egress payload boundary is a generated artifact leaving the host; the
    // sink is `log`-class metadata only (the bytes themselves never persist).
    context: { origin, boundary: "generated-artifact", sink: "log" },
  });
  if (verdict.clean) return;
  await quarantine.quarantine({ bytes: payload, origin, findings: verdict.findings });
  throw new EgressRefusal(
    "egress.secret_detected",
    `secret-scan blocked the ${direction} payload in-broker for "${origin}"`,
    { direction, ruleIds: verdict.findings.map((f: SecretFinding) => f.ruleId) },
  );
}
