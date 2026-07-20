import Foundation
import CryptoKit

/// The informed-approval display (spec §6 / design SSOT: presence alone "never
/// [counts] as approval of an unseen effect"). Renders — from the challenge
/// itself — the `op`, `runId`/`targetCommit` when present, `canonicalBaseCommit`,
/// every `intendedEffect` field, `expiresAt`, and the SHA-256 of `signingPayload`.
/// The `localizedReason` (what the SYSTEM-owned Touch ID sheet names) carries the
/// op + the digest's first 8 hex. Every challenge-derived value is control-safe.
public struct ApprovalSummary: Sendable {
    public let lines: [String]
    public let localizedReason: String
    public let payloadDigestHex: String

    public init(challenge c: AuthorizationChallenge, signerId: String) {
        let digest = SHA256.hash(data: Data(c.signingPayload.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        self.payloadDigestHex = hex

        func field(_ label: String, _ value: String) -> String {
            "  \(label): \(ControlSafe.render(value))"
        }

        var l: [String] = ["Atlas authorization — approve this exact effect:"]
        l.append(field("op", c.op))
        if let runId = c.runId { l.append(field("runId", runId)) }
        if let target = c.targetCommit { l.append(field("targetCommit", target)) }
        l.append(field("canonicalBaseCommit", c.canonicalBaseCommit))
        // Every intendedEffect field, key-sorted for stable ordering; keys AND
        // values are control-safe (a hostile key cannot rewrite the layout either).
        l.append("  intendedEffect:")
        for key in c.intendedEffect.keys.sorted() {
            let v = c.intendedEffect[key]!
            l.append("    \(ControlSafe.render(key)): \(ControlSafe.render(v.displayValue))")
        }
        l.append(field("expiresAt", c.expiresAt))
        l.append(field("signerId", signerId))
        l.append("  signingPayload sha256: \(hex)")

        self.lines = l
        // op is a registry name (safe), but render it defensively anyway.
        self.localizedReason = "Approve \(ControlSafe.render(c.op)) [\(String(hex.prefix(8)))]"
    }

    /// The full multi-line summary for stderr.
    public var text: String { lines.joined(separator: "\n") }
}
