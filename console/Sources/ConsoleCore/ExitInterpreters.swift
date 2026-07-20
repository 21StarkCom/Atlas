import Foundation

// Two DISJOINT exit namespaces, kept structurally separate (plan §Global Constraints): a `brain` exit
// code is never read against the `atlas-signer` table or vice-versa. Distinct Swift enums make a
// cross-table lookup a compile error, not a runtime bug.

/// `brain` process exit codes (design SSOT §CLI, plan §2.5). The set caps at 6 for single-command
/// envelopes; the nominal `7` (provider-retryable) is emitted ONLY by the `jobs run` batch aggregate
/// and is interpreted via `interpret(_:)`, never a raw case here.
public enum BrainExit: Int32, Equatable, Sendable {
    case ok = 0
    case validation = 1
    case config = 2
    case secretScan = 3
    case internalErr = 4
    case usage = 5
    case actionRequired = 6
}

/// The result of interpreting a raw `brain` exit code, including the batch-only aggregate `7`.
public enum BrainExitInterpretation: Equatable, Sendable {
    case known(BrainExit)
    /// `7` — the `jobs run` batch aggregate's "transient-but-exhausted" code. For single-command
    /// envelopes it is ignored (retryability rides `retryable`/`retryAfterMs` on the envelope).
    case aggregateRetryExhausted
    case unrecognized(Int32)
}

extension BrainExit {
    /// Interprets a raw `brain` exit code. `0…6` map to a case; `7` is the batch aggregate; anything
    /// else is `.unrecognized`.
    public static func interpret(_ code: Int32) -> BrainExitInterpretation {
        if let e = BrainExit(rawValue: code) { return .known(e) }
        if code == 7 { return .aggregateRetryExhausted }
        return .unrecognized(code)
    }
}

/// `atlas-signer` process exit codes (SP-3 §7.3). A DISJOINT namespace from `BrainExit`.
public enum SignerExit: Int32, Equatable, Sendable {
    case signed = 0
    case internalFault = 1
    case malformed = 2
    case expired = 3
    case cancelled = 4
    case keyInvalidated = 5
}

/// The result of interpreting a raw `atlas-signer` exit code.
public enum SignerExitInterpretation: Equatable, Sendable {
    case known(SignerExit)
    case unrecognized(Int32)
}

extension SignerExit {
    public static func interpret(_ code: Int32) -> SignerExitInterpretation {
        if let e = SignerExit(rawValue: code) { return .known(e) }
        return .unrecognized(code)
    }
}
