import XCTest
@testable import ConsoleCore

/// Test-plan #5, #8 — the dashboard snapshot + live overlay: the replay-double-application guard and the
/// snapshot-only-vs-fabricated distinction.
final class DashboardReducerTests: XCTestCase {

    /// #5 — a replayed `run.started` already reflected in `snapshot.openRuns` does NOT re-apply; only a
    /// genuinely-live post-checkpoint row moves `openRuns`.
    func testReplayedRunStartDoesNotDoubleApply() {
        var d = DashboardReducer()
        // Snapshot says one run already open.
        d.rebaseline(from: Fx.attachedHello(openRuns: ["running": 1], auditHeadSeq: 4, resumeHead: 4,
                                            replay: ReplayInfo(sinceSeq: 0, events: 5)))
        XCTAssertEqual(d.state.openRuns, 1)

        // Replay window: the run.started that produced that open run streams again BEFORE the checkpoint.
        // It must NOT re-increment openRuns (already in the snapshot).
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.started")))
        XCTAssertEqual(d.state.openRuns, 1, "replayed run.start before checkpoint does not double-apply")

        // Checkpoint heartbeat arrives — live overlay begins.
        d.markCheckpointReached()
        XCTAssertEqual(d.state.openRuns, 1)

        // A genuinely-live run.started now DOES move openRuns.
        d.apply(.audit(Fx.audit(seq: 6, eventType: "run.started")))
        XCTAssertEqual(d.state.openRuns, 2, "a live post-checkpoint run.start increments openRuns")

        // A terminal outcome closes one.
        d.apply(.audit(Fx.audit(seq: 7, eventType: "run.integrated")))
        XCTAssertEqual(d.state.openRuns, 1)
    }

    /// The audit head tracks the contiguous run-space prefix and is recomputed at the checkpoint (replayed
    /// rows included), then live thereafter.
    func testAuditHeadRecomputedAtCheckpointThenLive() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(auditHeadSeq: 4, resumeHead: 4,
                                            replay: ReplayInfo(sinceSeq: 0, events: 2)))
        // Replay rows above the baseline prefix.
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.started")))
        d.apply(.audit(Fx.audit(seq: 6, eventType: "run.planned")))
        XCTAssertEqual(d.state.audit?.headSeq, 4, "pre-checkpoint the head field is still the snapshot value")
        d.markCheckpointReached()
        XCTAssertEqual(d.state.audit?.headSeq, 6, "recomputed to the contiguous head at the checkpoint")
        d.apply(.audit(Fx.audit(seq: 7, eventType: "run.integrated", gitHead: "deadbeef")))
        XCTAssertEqual(d.state.audit?.headSeq, 7)
        XCTAssertEqual(d.state.audit?.head, "deadbeef")
    }

    /// B5 regression — when the new contiguous head row omits the schema-optional `gitHead`, the head
    /// must NOT keep the previous commit against a newer seq: a present head row governs, so an absent
    /// `gitHead` clears it (the contract renders "no head commit" as empty).
    func testAbsentGitHeadOnNewHeadRowClearsStaleHead() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(auditHeadSeq: 4, resumeHead: 4,
                                            replay: ReplayInfo(sinceSeq: 0, events: 0)))
        d.markCheckpointReached()
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.started", gitHead: "deadbeef")))
        XCTAssertEqual(d.state.audit?.headSeq, 5)
        XCTAssertEqual(d.state.audit?.head, "deadbeef")

        // Next contiguous row has NO gitHead (DDL column NULL) — the head advances and the stale commit
        // must not ride along with it.
        d.apply(.audit(Fx.audit(seq: 6, eventType: "run.planned", gitHead: nil)))
        XCTAssertEqual(d.state.audit?.headSeq, 6, "head seq advances")
        XCTAssertEqual(d.state.audit?.head, "", "a present head row with nil gitHead clears the stale commit")
    }

    /// The complement: with NO row for the displayed head seq (a hello-baselined head and a gap that has
    /// not closed), the snapshot's head is preserved rather than blanked.
    func testMissingHeadRowPreservesSnapshotHead() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(auditHeadSeq: 4, resumeHead: 4,
                                            replay: ReplayInfo(sinceSeq: 0, events: 0)))
        let snapshotHead = d.state.audit?.head
        d.markCheckpointReached()
        // A non-contiguous row (gap at 5) does not advance the head, and there is no row at seq 4.
        d.apply(.audit(Fx.audit(seq: 6, eventType: "run.started", gitHead: "cafebabe")))
        XCTAssertEqual(d.state.audit?.headSeq, 4, "the gap keeps the head at the baseline")
        XCTAssertEqual(d.state.audit?.head, snapshotHead, "no head row ⇒ the snapshot baseline head is preserved")
    }

    /// #8 — absent ledger-derived keys render as "as of", never fabricated `0`. A detached hello leaves
    /// every ledger-derived field `nil` with the snapshot `at` label.
    func testDetachedSnapshotFieldsAreNilNotZero() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.detachedHello(at: "2026-07-18T09:00:00.000Z"))
        XCTAssertNil(d.state.openRuns, "absent openRuns is nil, never 0")
        XCTAssertNil(d.state.jobs)
        XCTAssertNil(d.state.quarantineCount)
        XCTAssertNil(d.state.backup)
        XCTAssertNil(d.state.audit)
        XCTAssertEqual(d.state.snapshotAsOf, "2026-07-18T09:00:00.000Z")
        XCTAssertEqual(d.state.daemons.broker, true)

        // Even after a checkpoint + a live run event, a detached openRuns is NOT fabricated.
        d.markCheckpointReached()
        d.apply(.audit(Fx.audit(seq: 0, eventType: "run.started")))
        XCTAssertNil(d.state.openRuns, "a run event never fabricates a count for a detached ledger")
    }

    /// Snapshot-only fields (quarantineCount, backup.coveredSeq, audit.anchorOk/anchorSource) hold at the
    /// hello value across live events; live-updated fields (backup.watermarkSeq/healthy) do move.
    func testSnapshotOnlyFieldsHeldWhileLiveFieldsMove() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(quarantine: 3, backupWatermark: 5, backupCovered: 5, backupHealthy: true))
        d.markCheckpointReached()
        d.apply(.backup(Fx.backup(watermarkSeq: 9, healthy: false)))
        XCTAssertEqual(d.state.backup?.watermarkSeq, 9, "watermarkSeq is live-updated")
        XCTAssertEqual(d.state.backup?.healthy, false, "healthy is live-updated")
        XCTAssertEqual(d.state.backup?.coveredSeq, 5, "coveredSeq is snapshot-only, preserved")
        XCTAssertEqual(d.state.quarantineCount, 3, "quarantineCount is snapshot-only")
        XCTAssertEqual(d.state.audit?.anchorOk, true, "anchorOk is snapshot-only")
        XCTAssertEqual(d.state.audit?.anchorSource, "worm")
    }

    /// Daemon reachability is live-updated per daemon after the checkpoint.
    func testDaemonReachabilityLiveUpdated() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(brokerUp: true, egressUp: true))
        d.markCheckpointReached()
        d.apply(.daemon(Fx.daemon("egress", reachable: false)))
        XCTAssertEqual(d.state.daemons.broker, true)
        XCTAssertEqual(d.state.daemons.egress, false)
    }

    /// A live event before the checkpoint is a no-op for live-updated fields too (overlay begins at the
    /// checkpoint).
    func testLiveFieldsInertBeforeCheckpoint() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(backupWatermark: 5, backupHealthy: true))
        d.apply(.backup(Fx.backup(watermarkSeq: 99, healthy: false)))
        XCTAssertEqual(d.state.backup?.watermarkSeq, 5, "backup overlay is inert until the checkpoint")
        XCTAssertEqual(d.state.backup?.healthy, true)
    }

    /// #4 — a duplicate post-checkpoint `run.started` (at-least-once redelivery) does NOT re-increment
    /// openRuns, and a duplicate terminal does NOT re-decrement.
    func testDuplicateRunLifecycleAppliesOnce() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(openRuns: ["running": 1], auditHeadSeq: 4, resumeHead: 4))
        d.markCheckpointReached()

        // Live run.started at seq 5 opens one; its duplicate must not double-count.
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.started")))
        XCTAssertEqual(d.state.openRuns, 2)
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.started")))
        XCTAssertEqual(d.state.openRuns, 2, "a duplicate run.started seq does not re-increment")

        // Live terminal at seq 6 closes one; its duplicate must not double-decrement.
        d.apply(.audit(Fx.audit(seq: 6, eventType: "run.integrated")))
        XCTAssertEqual(d.state.openRuns, 1)
        d.apply(.audit(Fx.audit(seq: 6, eventType: "run.integrated")))
        XCTAssertEqual(d.state.openRuns, 1, "a duplicate terminal seq does not re-decrement")
    }

    /// #4 — a duplicate audit seq does not re-overlay the git head.
    func testDuplicateAuditDoesNotReapplyGitHead() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(auditHeadSeq: 4, auditHead: "base", resumeHead: 4))
        d.markCheckpointReached()
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.integrated", gitHead: "aaa")))
        XCTAssertEqual(d.state.audit?.head, "aaa")
        // A duplicate seq 5 carrying a different git head must NOT re-overlay (idempotent on seq).
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.integrated", gitHead: "bbb")))
        XCTAssertEqual(d.state.audit?.head, "aaa", "duplicate seq does not re-overlay the git head")
    }

    /// Both audit head fields resolve from the CONTIGUOUS head seq, never from the arriving row. With
    /// seq 6 arriving before seq 5, the head must stay at the baseline (gap still open) with neither
    /// headSeq nor git head jumping to seq 6; when seq 5 closes the gap, headSeq AND git head advance to
    /// seq 6's — never showing headSeq 6 paired with seq 5's git head.
    func testOutOfOrderAuditResolvesBothHeadFieldsFromContiguousPrefix() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(auditHeadSeq: 4, auditHead: "base", resumeHead: 4,
                                            replay: ReplayInfo(sinceSeq: 0, events: 0)))
        d.markCheckpointReached()
        XCTAssertEqual(d.state.audit?.headSeq, 4)
        XCTAssertEqual(d.state.audit?.head, "base")

        // seq 6 arrives first — a gap at seq 5 is still open, so nothing advances.
        d.apply(.audit(Fx.audit(seq: 6, eventType: "run.integrated", gitHead: "head6")))
        XCTAssertEqual(d.state.audit?.headSeq, 4, "out-of-order seq 6 does not advance past the gap at 5")
        XCTAssertEqual(d.state.audit?.head, "base", "git head does not jump to the non-contiguous row")

        // seq 5 closes the gap — head advances to 6, and BOTH fields resolve to seq 6's row.
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.started", gitHead: "head5")))
        XCTAssertEqual(d.state.audit?.headSeq, 6, "closing the gap advances the contiguous head to 6")
        XCTAssertEqual(d.state.audit?.head, "head6",
                       "git head resolves from the contiguous head (seq 6), never seq 5's arriving row")
    }

    /// #5 — run.refreshed / run.rolled_back are NON-deltas: neither moves openRuns. Table-driven lifecycle.
    func testRunLifecycleDeltaClassification() {
        let cases: [(eventType: String, delta: Int)] = [
            ("run.started", +1),
            ("run.integrated", -1),
            ("run.rejected", -1),
            ("run.failed", -1),
            ("run.cancelled", -1),
            ("run.refreshed", 0),     // re-derive, still review-pending — not a closer
            ("run.rolled_back", 0),   // distinct rollback run, no matching start — not a closer
            ("run.planned", 0),
        ]
        var seq = 5
        for c in cases {
            var d = DashboardReducer()
            d.rebaseline(from: Fx.attachedHello(openRuns: ["running": 3], auditHeadSeq: 4, resumeHead: 4))
            d.markCheckpointReached()
            d.apply(.audit(Fx.audit(seq: seq, eventType: c.eventType)))
            XCTAssertEqual(d.state.openRuns, 3 + c.delta, "\(c.eventType) delta")
            seq += 1
        }
    }

    /// #8 stream-coalescing at the reducer: repeated backup events collapse to the latest value; two
    /// distinct-seq audit events each apply (never collapse).
    func testBackupCoalescesWhileDistinctAuditsDoNot() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(openRuns: ["running": 0],
                                            backupWatermark: 5, backupHealthy: true,
                                            auditHeadSeq: 4, resumeHead: 4))
        d.markCheckpointReached()
        d.apply(.backup(Fx.backup(watermarkSeq: 6, healthy: true)))
        d.apply(.backup(Fx.backup(watermarkSeq: 7, healthy: false)))
        XCTAssertEqual(d.state.backup?.watermarkSeq, 7, "repeated backups collapse to the latest")
        XCTAssertEqual(d.state.backup?.healthy, false)

        // Two distinct-seq run.started events each open a run — they do NOT collapse.
        d.apply(.audit(Fx.audit(seq: 5, eventType: "run.started")))
        d.apply(.audit(Fx.audit(seq: 6, eventType: "run.started")))
        XCTAssertEqual(d.state.openRuns, 2, "distinct audit seqs each apply")
    }

    /// A high-space audit event never touches the dashboard (routed out by the embedded audit reducer).
    func testHighSpaceAuditDoesNotAffectDashboard() {
        var d = DashboardReducer()
        d.rebaseline(from: Fx.attachedHello(openRuns: ["running": 1], auditHeadSeq: 4))
        d.markCheckpointReached()
        let before = d.state
        d.apply(.audit(Fx.audit(seq: ConsoleConstants.dbEventSeqBase + 1, eventType: "db.backup")))
        XCTAssertEqual(d.state, before, "a high-space audit is a dashboard no-op")
    }
}
