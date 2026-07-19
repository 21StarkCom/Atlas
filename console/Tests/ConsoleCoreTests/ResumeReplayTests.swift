import XCTest
@testable import ConsoleCore

/// Test-plan #5 — resume/replay/cursor selection and the contiguous-prefix cursor rule.
final class ResumeReplayTests: XCTestCase {

    func testCursorSelectionPerResumeMode() {
        // resume: a persisted cursor >= 0 resumes forward; otherwise live-only.
        XCTAssertEqual(ResumePlanner.plan(mode: .resume, persistedCursor: 7), .sinceSeq(7))
        XCTAssertEqual(ResumePlanner.plan(mode: .resume, persistedCursor: 0), .sinceSeq(0))
        XCTAssertEqual(ResumePlanner.plan(mode: .resume, persistedCursor: -1), .liveOnly,
                       "an empty-ledger cursor (-1) resumes live-only")
        XCTAssertEqual(ResumePlanner.plan(mode: .resume, persistedCursor: nil), .liveOnly)
        // replayAll: always -1.
        XCTAssertEqual(ResumePlanner.plan(mode: .replayAll, persistedCursor: 42), .sinceSeq(-1))
        XCTAssertEqual(ResumePlanner.plan(mode: .replayAll, persistedCursor: nil), .sinceSeq(-1))
        // liveOnly: no --since-seq regardless of the cursor (still checkpointed elsewhere).
        XCTAssertEqual(ResumePlanner.plan(mode: .liveOnly, persistedCursor: 9), .liveOnly)
    }

    /// `liveOnly` emits no `--since-seq` argument — the invocation layer adds no flag (and never combines
    /// `--since-seq` with `--once`, which is a disjoint one-shot mode, not a streaming resume).
    func testLiveOnlyEmitsNoSinceSeqArg() {
        guard case .liveOnly = ResumePlanner.plan(mode: .liveOnly, persistedCursor: nil) else {
            return XCTFail("liveOnly must not yield a sinceSeq arg")
        }
    }

    /// A late-arriving lower seq inserts by `seq`, and the safe-to-persist cursor never advances past a
    /// still-open gap (the contiguous-prefix rule that keeps a mid-replay checkpoint safe).
    func testCursorNeverAdvancesPastOpenGap() {
        var r = AuditReducer()
        r.incorporateHello(baselinePrefix: -1)
        r.apply(Fx.audit(seq: 0, eventType: "run.started"))
        r.apply(Fx.audit(seq: 2, eventType: "run.integrated"))   // seq 1 still missing
        XCTAssertEqual(r.safeCheckpointSeq, 0, "cursor holds at the contiguous prefix, not the max seq")
        r.apply(Fx.audit(seq: 1, eventType: "run.planned"))       // the gap fills late, in seq order
        XCTAssertEqual(r.timeline.map(\.seq), [0, 1, 2])
        XCTAssertEqual(r.safeCheckpointSeq, 2, "once contiguous, the cursor advances to the prefix head")
    }

    /// During replay the reducer head reflects only the contiguous prefix; the pre-checkpoint value that a
    /// caller would (wrongly) persist is `min(n, prefix)` — the reducer never reports a head above the
    /// contiguous run-space prefix, so a mid-replay persist can never record a gap.
    func testHeadIsMinOfObservedContiguousPrefix() {
        var r = AuditReducer()
        r.incorporateHello(baselinePrefix: -1)
        // Replay delivers 0,1,3 (a hole at 2). The head/cursor is 1 = min(observed-contiguous, ...).
        for s in [0, 1, 3] { r.apply(Fx.audit(seq: s, eventType: "run.started")) }
        XCTAssertEqual(r.safeCheckpointSeq, 1)
        XCTAssertLessThan(r.safeCheckpointSeq, 3, "never persists above the contiguous prefix")
    }
}

/// Test-plan #6 — stale-cursor re-baseline (cursor-above-head only).
final class StaleCursorRebaselineTests: XCTestCase {
    func testStaleWhenEmptyReplayAndHeadBelowRequested() {
        // replay.events == 0 AND resume.auditHeadSeq < requested ⇒ stale (a re-clone whose head sits below
        // the persisted cursor).
        XCTAssertTrue(ResumePlanner.isStaleCursor(replayEvents: 0, resumeHead: 3, requested: 10))
    }

    func testNotStaleWhenReplayDeliveredEvents() {
        // Events came back ⇒ the cursor was valid, catching up — not stale.
        XCTAssertFalse(ResumePlanner.isStaleCursor(replayEvents: 5, resumeHead: 3, requested: 10))
    }

    func testNotStaleWhenHeadAtOrAboveRequested() {
        XCTAssertFalse(ResumePlanner.isStaleCursor(replayEvents: 0, resumeHead: 10, requested: 10))
        XCTAssertFalse(ResumePlanner.isStaleCursor(replayEvents: 0, resumeHead: 12, requested: 10),
                       "head above the cursor is the accepted catch-up residual, not the stale case")
    }
}

/// Test-plan #7 — any `hello` clears dedup/cursor state and rebuilds the snapshot (full re-baseline).
final class RebaselineOnHelloTests: XCTestCase {

    func testAuditReducerRebaselineClearsState() {
        var r = AuditReducer()
        r.incorporateHello(baselinePrefix: -1)
        r.apply(Fx.audit(seq: 0, eventType: "run.started"))
        r.apply(Fx.audit(seq: 1, eventType: "run.integrated"))
        XCTAssertEqual(r.displayedAuditHead, 1)
        XCTAssertFalse(r.timeline.isEmpty)

        // A fresh hello re-baselines: state cleared, seeded at the new prefix.
        r.incorporateHello(baselinePrefix: 20)
        XCTAssertTrue(r.timeline.isEmpty, "dedup/timeline state cleared on re-baseline")
        XCTAssertEqual(r.displayedAuditHead, 20, "seeded at the new reported prefix")
        // A previously-seen seq (0) below the new baseline no longer advances the head.
        XCTAssertEqual(r.apply(Fx.audit(seq: 0, eventType: "run.started")), .timeline(inserted: true))
        XCTAssertEqual(r.displayedAuditHead, 20)
    }

    func testDashboardReducerRebaselineRebuildsSnapshotAndResetsOverlay() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(openRuns: ["running": 1], quarantine: 3, at: "2026-07-18T10:00:00.000Z"))
        d.markCheckpointReached()
        d.apply(.audit(Fx.audit(seq: 0, eventType: "run.started")))
        XCTAssertEqual(d.state.openRuns, 2)

        // A new hello rebuilds every field from the new snapshot and resets the live overlay.
        d.rebaseline(from: Fx.attachedHello(openRuns: ["running": 5], quarantine: 9, at: "2026-07-18T11:00:00.000Z"))
        XCTAssertEqual(d.state.openRuns, 5, "openRuns rebuilt from the new snapshot")
        XCTAssertEqual(d.state.quarantineCount, 9)
        XCTAssertEqual(d.state.snapshotAsOf, "2026-07-18T11:00:00.000Z")

        // Overlay is inert again until the next checkpoint.
        d.apply(.audit(Fx.audit(seq: 0, eventType: "run.started")))
        XCTAssertEqual(d.state.openRuns, 5, "run deltas inert until the post-rebaseline checkpoint")
    }
}
