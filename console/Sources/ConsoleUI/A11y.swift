import SwiftUI
import ConsoleCore

// P6-Task-3 — the VoiceOver live-region announcer + its event vocabulary.
//
// Every state change a sighted operator sees as a banner/badge is ALSO spoken: job succeeded/failed,
// backup unhealthy, daemon unreachable, challenge arrival/expiry, watch-retry/watch-failed, and in-flight
// subprocess activity (busy/loading + completion — never a silent spinner). The announcer's post is
// injectable so tests capture the vocabulary without a launched app host (a SwiftPM package provides no
// XCUI host, so the live VoiceOver pass itself is the documented manual checklist step).

/// The announceable events. Each maps to a human-readable, control-safe utterance.
public enum A11yEvent: Equatable, Sendable {
    case jobSucceeded(String)
    case jobFailed(String)
    case backupUnhealthy
    case daemonUnreachable(String)
    case challengeArrived
    case challengeExpired
    case watchRetrying(Int)
    case watchFailed
    case busy(String)
    case completed(String)
    /// A terminal FAILURE outcome (e.g. a privileged flow that failed) — closes out a prior `busy` so a
    /// screen-reader user is never left on an indefinite in-progress utterance.
    case failed(String)
    /// A terminal CANCELLED outcome (operator cancel / biometry decline) — likewise closes out `busy`.
    case cancelled(String)

    /// The spoken text. Any interpolated identifier is control-safe-rendered so a hostile job id / daemon
    /// name cannot inject control/ANSI bytes into the announcement (parity with `ControlSafeText`).
    public var utterance: String {
        switch self {
        case .jobSucceeded(let id): return "Job \(ControlSafeText.plain(id)) succeeded"
        case .jobFailed(let id): return "Job \(ControlSafeText.plain(id)) failed"
        case .backupUnhealthy: return "Backup is unhealthy"
        case .daemonUnreachable(let name): return "Daemon \(ControlSafeText.plain(name)) is unreachable"
        case .challengeArrived: return "Authorization challenge ready for review"
        case .challengeExpired: return "Authorization challenge expired"
        case .watchRetrying(let attempt): return "Watch connection retrying, attempt \(attempt)"
        case .watchFailed: return "Watch connection failed"
        case .busy(let what): return "\(ControlSafeText.plain(what)) in progress"
        case .completed(let what): return "\(ControlSafeText.plain(what)) complete"
        case .failed(let what): return "\(ControlSafeText.plain(what)) failed"
        case .cancelled(let what): return "\(ControlSafeText.plain(what)) cancelled"
        }
    }
}

/// The declared heading/landmark structure the cockpit surfaces expose (each rendered with the
/// `.isHeader` accessibility trait so VoiceOver's heading rotor can navigate them). Declared here as data
/// so the STRUCTURE is asserted host-independently (ordering, uniqueness, control-safety); the RENDERED
/// trait application + real rotor navigation are host-only and live in the manual checklist (#254 §2–§3).
public enum A11yStructure {
    /// Every surface/section heading a screen-reader user navigates between, in cockpit tab order.
    public static let surfaceHeadings: [String] = [
        "Health", "Daemons",                    // Dashboard
        "Jobs",                                 // Jobs list
        "Audit timeline",                       // Audit
        "Model calls",                          // Model-call feed
        "Actions",                              // Actions surface
        "Query",                                // Query surface
        "Settings",                             // Settings surface
        "Authorize privileged operation",       // Challenge modal
    ]

    /// The complete set of announceable events — one representative per `A11yEvent` case. The
    /// AccessibilityAcceptanceTests assert this covers every case (so no state change is left silent).
    public static let announcementVocabulary: [A11yEvent] = [
        .jobSucceeded("j"), .jobFailed("j"), .backupUnhealthy, .daemonUnreachable("d"),
        .challengeArrived, .challengeExpired, .watchRetrying(1), .watchFailed,
        .busy("x"), .completed("x"), .failed("x"), .cancelled("x"),
    ]
}

/// Posts VoiceOver live-region announcements. The `post` sink is injectable so tests observe the
/// vocabulary deterministically; the production sink posts a SwiftUI accessibility announcement.
public struct A11yAnnouncer: Sendable {
    private let sink: @Sendable (A11yEvent) -> Void

    public init(post: (@Sendable (A11yEvent) -> Void)? = nil) {
        self.sink = post ?? { event in
            // A live-region announcement — spoken without moving focus. Guarded to the main actor since
            // the SwiftUI announcement API is main-actor-affined.
            let utterance = event.utterance
            Task { @MainActor in
                AccessibilityNotification.Announcement(utterance).post()
            }
        }
    }

    public func announce(_ event: A11yEvent) { sink(event) }
}
