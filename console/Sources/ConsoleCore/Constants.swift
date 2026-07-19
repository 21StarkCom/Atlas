import Foundation

/// Named constants that live in exactly one place (plan §Global Constraints).
/// Downstream phases import these; they are never re-derived at a call site.
public enum ConsoleConstants {
    /// Audit rows at or above this seq are the non-run.* ledger-internal space
    /// (db.* + evidence.retry_enqueued). run.* seqs start at 0 and are gapless.
    public static let dbEventSeqBase: Int = 1_000_000_000_000

    /// The watch supervisor gives up after this many consecutive spawn failures.
    public static let watchMaxConsecutiveFailures: Int = 6

    /// The two commands that mint an egress capability (P5 consumes this).
    public static let egressMintingCommands: Set<String> = ["query", "index eval"]

    /// os.Logger subsystem for every Console spawn / state-transition log line.
    public static let logSubsystem: String = "com.atlas.console"

    /// The assembled `.app` bundle identifier.
    public static let bundleIdentifier: String = "com.atlas.console"
}

/// Backoff policy for the watch supervisor (P4). Proposed defaults (open-q #7);
/// defined once here and tuned on the live drive. Kept in Phase 1 so the constant
/// has a single home from the start.
public struct BackoffPolicy: Sendable, Equatable {
    public let initial: Duration
    public let multiplier: Double
    public let cap: Duration
    public let jitterFraction: Double

    public init(initial: Duration, multiplier: Double, cap: Duration, jitterFraction: Double) {
        self.initial = initial
        self.multiplier = multiplier
        self.cap = cap
        self.jitterFraction = jitterFraction
    }

    /// 500 ms initial · ×2 · 30 s cap · ±20 % jitter.
    public static let `default` = BackoffPolicy(
        initial: .milliseconds(500),
        multiplier: 2.0,
        cap: .seconds(30),
        jitterFraction: 0.20
    )
}
