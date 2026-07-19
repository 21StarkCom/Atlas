import XCTest
@testable import ConsoleCore

/// Test-plan #3 — the run-space-only audit reducer with adversarial high-space interleavings.
final class MixedSpaceReducerTests: XCTestCase {
    private let base = ConsoleConstants.dbEventSeqBase

    /// (a) timeline holds only run-space rows in seq order; (b) head/cursor never move on a high-space
    /// event; (c) each high-space kind routes to its signal; (d) a later cursor-built resume is unaffected.
    func testHighSpaceRoutedOutInAllAdversarialOrders() {
        // Four high-space kinds, one run-space row each interleaved in an adversarial order:
        // high-space first, interleaved, last, and between a "replay window" and its checkpoint.
        let events: [(AuditPayload, AuditRouting)] = [
            (Fx.audit(seq: base + 1, eventType: "db.backup"), .highSpaceSignal(.backup)),      // high first
            (Fx.audit(seq: 0, eventType: "run.started"), .timeline(inserted: true)),
            (Fx.audit(seq: base + 2, eventType: "db.restore"), .highSpaceSignal(.restore)),    // interleaved
            (Fx.audit(seq: 1, eventType: "run.planned"), .timeline(inserted: true)),
            (Fx.audit(seq: base + 3, eventType: "db.force_unblock"), .highSpaceSignal(.forceUnblock)),
            (Fx.audit(seq: 2, eventType: "run.integrated"), .timeline(inserted: true)),
            (Fx.audit(seq: base + 4, eventType: "evidence.retry_enqueued"), .highSpaceSignal(.evidenceRetry)), // last
        ]

        var reducer = AuditReducer()
        reducer.incorporateHello(baselinePrefix: -1)
        for (payload, expected) in events {
            XCTAssertEqual(reducer.apply(payload), expected, "routing for seq \(payload.seq)")
        }

        // (a) timeline is run-space only, in seq order.
        XCTAssertEqual(reducer.timeline.map(\.seq), [0, 1, 2])
        XCTAssertTrue(reducer.timeline.allSatisfy { $0.seq < base })
        // (b) head advanced only over the contiguous run-space prefix — high-space never moved it.
        XCTAssertEqual(reducer.displayedAuditHead, 2)
        XCTAssertEqual(reducer.safeCheckpointSeq, 2)
    }

    /// Order independence: high-space seqs in any position yield the same run-space head + timeline.
    func testHeadUnaffectedByHighSpacePosition() {
        func run(_ order: [AuditPayload]) -> (head: Int, timeline: [Int]) {
            var r = AuditReducer()
            r.incorporateHello(baselinePrefix: -1)
            for e in order { r.apply(e) }
            return (r.displayedAuditHead, r.timeline.map(\.seq))
        }
        let runs = [Fx.audit(seq: 0, eventType: "run.started"), Fx.audit(seq: 1, eventType: "run.integrated")]
        let high = Fx.audit(seq: base + 9, eventType: "db.backup")
        XCTAssertEqual(run([high] + runs).head, 1)
        XCTAssertEqual(run(runs + [high]).head, 1)
        XCTAssertEqual(run([runs[0], high, runs[1]]).timeline, [0, 1])
    }

    /// A gap in the run-space prefix is a pending intent: the head stops at the gap and jumps once the
    /// missing seq arrives. The timeline retains the out-of-order row (never pruned).
    func testGapIsPendingIntentNotPruned() {
        var r = AuditReducer()
        r.incorporateHello(baselinePrefix: -1)
        r.apply(Fx.audit(seq: 0, eventType: "run.started"))
        r.apply(Fx.audit(seq: 3, eventType: "run.integrated"))   // gap at 1,2
        XCTAssertEqual(r.displayedAuditHead, 0, "head stops before the gap")
        XCTAssertEqual(r.timeline.map(\.seq), [0, 3], "the ahead-of-gap row is retained in seq order")
        r.apply(Fx.audit(seq: 2, eventType: "run.planned"))
        XCTAssertEqual(r.displayedAuditHead, 0, "still gapped at 1")
        r.apply(Fx.audit(seq: 1, eventType: "run.planned"))
        XCTAssertEqual(r.displayedAuditHead, 3, "prefix now contiguous through 3")
        XCTAssertEqual(r.timeline.map(\.seq), [0, 1, 2, 3])
    }

    func testDuplicateSeqIsIdempotent() {
        var r = AuditReducer()
        r.incorporateHello(baselinePrefix: -1)
        r.apply(Fx.audit(seq: 0, eventType: "run.started"))
        r.apply(Fx.audit(seq: 0, eventType: "run.started"))
        XCTAssertEqual(r.timeline.count, 1)
        XCTAssertEqual(r.displayedAuditHead, 0)
    }

    func testUnknownHighSpaceKindStillRoutedOut() {
        var r = AuditReducer()
        r.incorporateHello(baselinePrefix: -1)
        let routing = r.apply(Fx.audit(seq: base + 7, eventType: "db.future_kind"))
        XCTAssertEqual(routing, .highSpaceSignal(.unknown("db.future_kind")))
        XCTAssertTrue(r.timeline.isEmpty)
        XCTAssertEqual(r.displayedAuditHead, -1)
    }
}

/// The phantom-gap-freeze regression: an existing-ledger attach seeds the reducer at the reported
/// prefix (not `-1`), so a live `run.started` above the prefix advances the head with no phantom gap.
final class LiveOnlyExistingLedgerBaselineTests: XCTestCase {
    func testExistingLedgerBaselineAdvancesWithNoPhantomGap() {
        var r = AuditReducer()
        // Existing ledger: live-only baseline at the reported prefix 10 (NOT -1).
        r.incorporateHello(baselinePrefix: 10)
        XCTAssertEqual(r.displayedAuditHead, 10, "seeded at the reported prefix, no phantom gap below it")
        // A live run-space row just above the prefix advances the head.
        XCTAssertEqual(r.apply(Fx.audit(seq: 11, eventType: "run.started")), .timeline(inserted: true))
        XCTAssertEqual(r.displayedAuditHead, 11)
        XCTAssertEqual(r.apply(Fx.audit(seq: 12, eventType: "run.integrated")), .timeline(inserted: true))
        XCTAssertEqual(r.displayedAuditHead, 12)
    }

    func testStartingAtMinusOneWouldFreeze_soBaselineMatters() {
        // Contrast: seeded at -1, a seq-11 row leaves a phantom gap 0..10 and the head cannot advance.
        var frozen = AuditReducer()
        frozen.incorporateHello(baselinePrefix: -1)
        frozen.apply(Fx.audit(seq: 11, eventType: "run.started"))
        XCTAssertEqual(frozen.displayedAuditHead, -1, "the phantom-gap freeze the baseline seed avoids")
    }
}
