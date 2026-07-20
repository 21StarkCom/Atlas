import Foundation

/// `atlas-signer`'s OWN exit-code table (spec §6) — deliberately NOT the `brain`
/// EXIT map. The SP-2 Console branches on these exact codes
/// (`ConsoleCore/ExitInterpreters.swift` `SignerExit`), so they must never drift.
public enum SignExit: Int32, Sendable, Equatable {
    /// The challenge was signed and the `AuthorizationResponse` emitted.
    case signed = 0
    /// An internal fault (I/O, key custody, unexpected error).
    case internalFault = 1
    /// The challenge is malformed / invalid, OR the re-derived `signingPayload`
    /// disagrees with the one displayed (the bytes shown ≠ bytes to sign).
    case malformedChallenge = 2
    /// `expiresAt` has already passed (checked BEFORE prompting — never burn a
    /// touch on a dead challenge).
    case expired = 3
    /// The user cancelled or biometry failed.
    case cancelled = 4
    /// The key was invalidated by biometry re-enrollment (`.biometryCurrentSet`);
    /// stderr carries the rotation runbook pointer (spec §7.3).
    case keyInvalidated = 5
}

/// A typed failure carrying its exit code + an operator-facing (stderr) message.
public struct SignerError: Error, Sendable {
    public let exit: SignExit
    public let message: String
    public init(_ exit: SignExit, _ message: String) {
        self.exit = exit
        self.message = message
    }
}
