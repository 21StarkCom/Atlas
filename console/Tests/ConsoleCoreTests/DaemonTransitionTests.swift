import XCTest
@testable import ConsoleCore

/// P4-Task-4 — daemon reachability, detach/re-attach, degraded anchor, and the distinct
/// "service not installed" empty state.
final class DaemonTransitionTests: XCTestCase {

    /// A hello with a chosen anchor source + daemon reachabilities (built directly — decoding is proven
    /// in `WatchEventDecoderTests`).
    private func hello(attached: Bool, anchorSource: String = "git",
                       brokerUp: Bool = true, egressUp: Bool = true,
                       brokerSocket: String = "/run/broker.sock",
                       egressSocket: String = "/run/egress.sock") -> WatchEvent {
        let audit = attached ? WatchSnapshot.AuditView(headSeq: 5, head: "abc", anchorOk: true, anchorSource: anchorSource) : nil
        let snap = WatchSnapshot(
            openRuns: attached ? ["running": 1] : nil,
            jobs: attached ? WatchSnapshot.JobsCount(queued: 0, failed: 0) : nil,
            quarantineCount: attached ? 0 : nil,
            backup: attached ? WatchSnapshot.BackupView(watermarkSeq: 5, coveredSeq: 5, healthy: true) : nil,
            audit: audit,
            daemons: WatchSnapshot.Daemons(
                broker: DaemonProbe(socketPath: brokerSocket, reachable: brokerUp),
                egress: DaemonProbe(socketPath: egressSocket, reachable: egressUp)))
        return .hello(HelloPayload(
            at: "2026-07-18T10:00:00.000Z", pid: 1,
            ledger: LedgerInfo(attached: attached, path: "/v/.atlas/x"),
            snapshot: snap, config: WatchConfig(pollMs: 500, heartbeatSeconds: 30),
            resume: nil, replay: nil))
    }

    // MARK: - daemon events flip reachability

    func testDaemonEventsFlipReachability() {
        var router = TransitionRouter(socketExists: { _ in true }) // sockets on disk ⇒ present-but-refusing = unreachable
        // Up: a change from the default-unreachable baseline emits a reachability signal.
        let up = router.apply(.daemon(DaemonPayload(at: "t", daemon: "broker",
                                                    socketPath: "/run/broker.sock", reachable: true, previousReachable: false)))
        XCTAssertTrue(up.contains(.reachability(DaemonReachability(broker: .reachable, egress: .unreachable))))
        XCTAssertEqual(router.currentReachability.broker, .reachable)

        // Down: reachable → unreachable (socket present ⇒ unreachable, not notInstalled).
        let down = router.apply(.daemon(DaemonPayload(at: "t", daemon: "broker",
                                                      socketPath: "/run/broker.sock", reachable: false, previousReachable: true)))
        XCTAssertTrue(down.contains(.reachability(DaemonReachability(broker: .unreachable, egress: .unreachable))))
        XCTAssertEqual(router.currentReachability.broker, .unreachable)

        // A no-op (same state) emits nothing.
        XCTAssertTrue(router.apply(.daemon(DaemonPayload(at: "t", daemon: "broker",
                                                         socketPath: "/run/broker.sock", reachable: false, previousReachable: false))).isEmpty)
    }

    // MARK: - service not installed (derived), distinct from unreachable

    func testNotInstalledIsDerivedAndDistinctFromUnreachable() {
        // No socket on disk + unreachable ⇒ notInstalled + a distinct empty-state signal.
        var router = TransitionRouter(socketExists: { _ in false })
        let signals = router.apply(.daemon(DaemonPayload(at: "t", daemon: "egress",
                                                         socketPath: "/run/egress.sock", reachable: false, previousReachable: true)))
        XCTAssertEqual(router.currentReachability.egress, .notInstalled)
        XCTAssertTrue(signals.contains(.serviceNotInstalled(daemon: "egress")),
                      "not-installed is a distinct empty state, not a fatal error")

        // A present-but-refusing socket (on disk) is unreachable, NOT notInstalled.
        var router2 = TransitionRouter(socketExists: { _ in true })
        _ = router2.apply(.daemon(DaemonPayload(at: "t", daemon: "egress",
                                                socketPath: "/run/egress.sock", reachable: false, previousReachable: true)))
        XCTAssertEqual(router2.currentReachability.egress, .unreachable)
    }

    // MARK: - detached hello/heartbeat → attached hello

    func testDetachThenAttachTransitions() {
        var router = TransitionRouter(socketExists: { _ in true })
        let detached = router.apply(hello(attached: false))
        XCTAssertTrue(detached.contains(.detachedLedger), "a detached hello is not an error")

        // A detached heartbeat keeps the detached state (no duplicate signal).
        let hb = router.apply(.heartbeat(HeartbeatPayload(at: "t", ledger: LedgerInfo(attached: false, path: "/v/.atlas/x"), resume: nil)))
        XCTAssertFalse(hb.contains(.attached))

        let attached = router.apply(hello(attached: true))
        XCTAssertTrue(attached.contains(.attached))
    }

    // MARK: - degraded anchor

    func testSqliteOnlyAnchorSurfacesDegraded() {
        var router = TransitionRouter(socketExists: { _ in true })
        let signals = router.apply(hello(attached: true, anchorSource: "sqlite-only"))
        XCTAssertTrue(signals.contains(.anchorDegraded(source: "sqlite-only")))

        // A healthy anchor ("git"/"worm") does not.
        var router2 = TransitionRouter(socketExists: { _ in true })
        XCTAssertFalse(router2.apply(hello(attached: true, anchorSource: "git")).contains(where: {
            if case .anchorDegraded = $0 { return true }; return false
        }))
    }

    // MARK: - mid-stream ledger fault → re-attach

    func testLedgerErrorEntersReattaching() {
        var router = TransitionRouter(socketExists: { _ in true })
        let signals = router.apply(.watchError(WatchErrorPayload(at: "t", source: "ledger", code: "vault-error", message: "vanished")))
        XCTAssertEqual(signals, [.reattaching])

        // A non-ledger error does not force re-attach.
        XCTAssertTrue(router.apply(.watchError(WatchErrorPayload(at: "t", source: "internal", code: "x", message: "y"))).isEmpty)
    }

    // MARK: - ledger error must not strand the UI: a same-ledger attached hello re-emits .attached

    func testLedgerErrorThenSameLedgerAttachedHelloReEmitsAttached() {
        var router = TransitionRouter(socketExists: { _ in true })
        // Establish an attached ledger first.
        XCTAssertTrue(router.apply(hello(attached: true)).contains(.attached))

        // A ledger fault enters re-attach. The cached attach state is INVALIDATED so the awaited fresh
        // attached hello re-emits .attached (clearing reattaching for consumers).
        XCTAssertEqual(router.apply(.watchError(WatchErrorPayload(at: "t", source: "ledger", code: "vault-error", message: "vanished"))),
                       [.reattaching])

        // The SAME-incarnation attached hello must emit .attached again — without the invalidation this
        // would find attached==true still cached and emit nothing, stranding the UI in reattaching.
        XCTAssertTrue(router.apply(hello(attached: true)).contains(.attached),
                      "a same-ledger re-attach re-emits .attached to clear reattaching")
    }

    // MARK: - backup health banner never blocks

    func testBackupHealthBanner() {
        var router = TransitionRouter()
        let signals = router.apply(.backup(BackupPayload(at: "t", watermarkSeq: 5, healthy: false, updatedAt: "t", lastBackupAt: nil)))
        XCTAssertEqual(signals, [.backupHealth(healthy: false)])
    }
}
