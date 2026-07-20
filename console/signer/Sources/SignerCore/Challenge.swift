import Foundation

/// The `AuthorizationChallenge` shape (security-broker-contract §7.1) as the
/// signer needs it: every committed field, `intendedEffect` kept OPEN
/// (`[String: JSONValue]`) so all nine §7.4 variants decode without a rigid enum.
/// Mirrors the Console's `ConsoleCore.AuthorizationChallenge` (the consumer this
/// output must satisfy), decoded strictly enough to re-derive `signingPayload`.
public struct AuthorizationChallenge: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let op: String
    public let runId: String?
    public let targetCommit: String?
    public let canonicalBaseCommit: String
    public let intendedEffect: [String: JSONValue]
    public let nonce: String
    public let expiresAt: String
    public let payloadCanonicalization: String
    public let signingPayload: String
}

/// A parsed challenge plus the EXACT raw bytes it arrived as, so the emitted
/// `AuthorizationResponse` can echo the challenge **verbatim** (byte-identical) —
/// the strongest guarantee the broker's recompute-and-compare and the Console's
/// recursive echo-equality check both pass, and that the bytes signed are the
/// bytes shown.
public struct ParsedChallenge: Sendable {
    public let challenge: AuthorizationChallenge
    public let rawJSON: Data

    /// Parse + minimally validate a challenge from JSON bytes. Throws a
    /// `SignerError(.malformedChallenge)` (exit 2) on any structural problem —
    /// never a touch prompt for something that cannot verify.
    public init(rawJSON: Data) throws {
        self.rawJSON = rawJSON
        let decoded: AuthorizationChallenge
        do {
            decoded = try JSONDecoder().decode(AuthorizationChallenge.self, from: rawJSON)
        } catch {
            throw SignerError(.malformedChallenge, "challenge failed to decode: \(error)")
        }
        guard decoded.schemaVersion == 1 else {
            throw SignerError(.malformedChallenge, "unsupported schemaVersion \(decoded.schemaVersion) (expected 1)")
        }
        guard decoded.payloadCanonicalization == "atlas-jcs-v1" else {
            throw SignerError(
                .malformedChallenge,
                "unsupported payloadCanonicalization \"\(decoded.payloadCanonicalization)\""
            )
        }
        self.challenge = decoded
    }
}
