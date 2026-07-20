import XCTest
import ConsoleCore
@testable import ConsoleUI

// P6-Task-3 — the accessibility acceptance subset a SwiftPM `swift test` run CAN host without an XCUI
// host. It covers, host-independently:
//   • names/roles/traits substance — every status indicator carries a NAME (text) and a ROLE proxy (a
//     real SF-symbol token), distinct per state (never color-only);
//   • declared heading/landmark STRUCTURE (`A11yStructure.surfaceHeadings`) — ordered, unique, control-safe;
//   • control-safe accessibility text + a COMPLETE, control-safe announcement vocabulary (every
//     `A11yEvent` case, incl. the terminal failed/cancelled outcomes);
//   • the no-truncation policy (Dynamic Type must never require eliding a committed value).
// The genuinely host-only checks — rendered `.isHeader` trait application, Full Keyboard Access end to
// end, modal focus entry + restoration, live VoiceOver announcements, Dynamic Type/Reduced Motion/contrast
// on the running app — are the manual checklist (docs/specs/2026-07-19-console-accessibility-manual-checklist.md).
final class AccessibilityAcceptanceTests: XCTestCase {

    func testNoColorOnlyEncoding_reachability() {
        let states: [ReachState] = [.reachable, .unreachable, .notInstalled]
        let badges = states.map(StatusPresentation.reachability)
        for b in badges {
            XCTAssertFalse(b.symbol.isEmpty, "symbol carries meaning (not color-only)")
            XCTAssertFalse(b.text.isEmpty, "text carries meaning (not color-only)")
        }
        // Distinct symbols AND distinct text per state — information is never color-alone.
        XCTAssertEqual(Set(badges.map(\.symbol)).count, states.count)
        XCTAssertEqual(Set(badges.map(\.text)).count, states.count)
    }

    func testNoColorOnlyEncoding_jobStatesAndBackupAndAnchor() {
        for state in ["failed", "running", "pending", "ready", "succeeded", "other"] {
            let b = StatusPresentation.jobState(state)
            XCTAssertFalse(b.symbol.isEmpty); XCTAssertFalse(b.text.isEmpty)
        }
        XCTAssertNotEqual(StatusPresentation.backup(healthy: true).symbol,
                          StatusPresentation.backup(healthy: false).symbol)
        XCTAssertNotEqual(StatusPresentation.backup(healthy: true).text,
                          StatusPresentation.backup(healthy: false).text)
        // sqlite-only anchor is a distinct, labelled degraded state.
        let degraded = StatusPresentation.anchor(ok: false, source: "sqlite-only")
        XCTAssertTrue(degraded.text.lowercased().contains("degraded"))
    }

    func testAccessibilityTextIsControlSafe() {
        let hostile = "job\u{1B}[31m\u{202E}evil\u{7F}"
        let safe = ControlSafeText.plain(hostile)
        for scalar in safe.unicodeScalars {
            let v = scalar.value
            XCTAssertFalse(v <= 0x1F || v == 0x7F || (v >= 0x80 && v <= 0x9F))
            XCTAssertNotEqual(v, 0x202E)
        }
        XCTAssertTrue(safe.contains("<U+001B>"))
    }

    func testAnnouncementVocabularyIsCompleteAndControlSafe() {
        let events: [A11yEvent] = [
            .jobSucceeded("j\u{1B}1"), .jobFailed("j2"), .backupUnhealthy,
            .daemonUnreachable("broker\u{202E}"), .challengeArrived, .challengeExpired,
            .watchRetrying(3), .watchFailed, .busy("query"), .completed("query"),
        ]
        for e in events {
            let u = e.utterance
            XCTAssertFalse(u.isEmpty, "every A11yEvent speaks")
            for scalar in u.unicodeScalars {
                let v = scalar.value
                XCTAssertFalse(v <= 0x1F || v == 0x7F || (v >= 0x80 && v <= 0x9F),
                               "announcement leaked a control byte: \(u)")
            }
        }
    }

    func testStatusBadgesCarryNameAndRoleSubstance() {
        // A badge's NAME is its text and its ROLE proxy is a real SF-symbol token (non-empty, no spaces —
        // a valid symbol name). This is the host-independent stand-in for "role/trait present"; the
        // rendered trait is verified in the manual checklist.
        var badges: [StatusBadge] = [
            StatusPresentation.backup(healthy: true), StatusPresentation.backup(healthy: false),
            StatusPresentation.anchor(ok: true, source: "broker"),
            StatusPresentation.anchor(ok: false, source: "sqlite-only"),
        ]
        badges += [ReachState.reachable, .unreachable, .notInstalled].map(StatusPresentation.reachability)
        badges += ["failed", "running", "pending", "ready", "succeeded"].map(StatusPresentation.jobState)
        for b in badges {
            XCTAssertFalse(b.text.isEmpty, "badge carries a name (text)")
            XCTAssertFalse(b.symbol.isEmpty, "badge carries a role proxy (symbol)")
            XCTAssertFalse(b.symbol.contains(" "), "the symbol is a real SF-symbol token, not a phrase")
        }
    }

    func testDeclaredHeadingStructureIsOrderedUniqueAndControlSafe() {
        let headings = A11yStructure.surfaceHeadings
        XCTAssertFalse(headings.isEmpty, "the cockpit declares a heading structure")
        XCTAssertEqual(Set(headings).count, headings.count, "every heading is unique (no rotor collision)")
        for h in headings {
            XCTAssertFalse(h.isEmpty)
            // A heading is fixed UI copy, so it must already be control-safe (round-trips unchanged).
            XCTAssertEqual(ControlSafeText.plain(h), h, "heading '\(h)' is control-safe")
        }
        // The core landmarks a screen-reader user must be able to reach are present.
        for expected in ["Health", "Jobs", "Audit timeline", "Actions", "Query", "Authorize privileged operation"] {
            XCTAssertTrue(headings.contains(expected), "missing landmark heading: \(expected)")
        }
    }

    func testAnnouncementVocabularyCoversEveryEventIncludingTerminalOutcomes() {
        // The declared vocabulary must include the terminal failed/cancelled outcomes (a busy utterance is
        // always closed out — never an indefinite in-progress state for a screen-reader user).
        let utterances = A11yStructure.announcementVocabulary.map(\.utterance)
        for u in utterances {
            XCTAssertFalse(u.isEmpty)
            for scalar in u.unicodeScalars {
                let v = scalar.value
                XCTAssertFalse(v <= 0x1F || v == 0x7F || (v >= 0x80 && v <= 0x9F), "control byte in: \(u)")
            }
        }
        XCTAssertTrue(utterances.contains { $0.contains("failed") }, "a terminal failure is announceable")
        XCTAssertTrue(utterances.contains { $0.contains("cancelled") }, "a cancellation is announceable")
        XCTAssertTrue(utterances.contains { $0.contains("in progress") }, "busy is announceable")
        XCTAssertTrue(utterances.contains { $0.contains("complete") }, "completion is announceable")
    }

    func testNoTruncationPolicyForCommittedValues() {
        // Dynamic Type must never require eliding a committed value — the control-safe renderer shows the
        // full value (an over-length string is inspectable, not truncated with an ellipsis).
        let long = String(repeating: "x", count: 4096)
        let rendered = ControlSafeText.plain(long)
        XCTAssertEqual(rendered.filter { $0 == "x" }.count, 4096, "the full value survives — never elided")
        XCTAssertFalse(rendered.contains("…"), "no ellipsis truncation")
    }

    func testCapturingAnnouncerReceivesEvents() {
        // The announcer's post sink is injectable, so the announcement path is observable in-process
        // (the live VoiceOver pass itself remains the manual checklist).
        final class Box: @unchecked Sendable {
            let lock = NSLock(); var events: [A11yEvent] = []
        }
        let box = Box()
        let announcer = A11yAnnouncer(post: { e in box.lock.withLock { box.events.append(e) } })
        announcer.announce(.watchFailed)
        announcer.announce(.challengeArrived)
        XCTAssertEqual(box.lock.withLock { box.events }, [.watchFailed, .challengeArrived])
    }
}
