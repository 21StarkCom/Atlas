/**
 * In-broker payload scan (INVARIANT 2). The egress broker scans the EXACT
 * SERIALIZED payload — request AND response — with the `@atlas/scan` engine on
 * every transmission. A secret planted in a prompt is caught here, in-broker,
 * before it leaves the host (request scan) or before a provider echo re-enters
 * (response scan); the offending bytes are quarantined (AEAD, CLI-side sink) and
 * the transmission is refused. The engine runs against the same deterministic
 * versioned ruleset every other boundary uses (D15) — the exact serialized bytes,
 * not a re-parsed view, so nothing hides in serialization.
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
